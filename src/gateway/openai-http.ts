import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { request as httpsRequest } from "node:https";
import type { ImageContent } from "../agents/command/types.js";
import {
  hasNonzeroUsage,
  normalizeUsage,
  toOpenAiChatCompletionsUsage,
  type NormalizedUsage,
} from "../agents/usage.js";
import { createDefaultDeps } from "../cli/deps.js";
import { agentCommandFromIngress } from "../commands/agent.js";
import type { GatewayHttpChatCompletionsConfig } from "../config/types.gateway.js";
import { emitAgentEvent, onAgentEvent } from "../infra/agent-events.js";
import { logWarn } from "../logger.js";
import { estimateBase64DecodedBytes } from "../media/base64.js";
import {
  DEFAULT_INPUT_IMAGE_MAX_BYTES,
  DEFAULT_INPUT_IMAGE_MIMES,
  DEFAULT_INPUT_MAX_REDIRECTS,
  DEFAULT_INPUT_TIMEOUT_MS,
  extractImageContentFromSource,
  normalizeMimeList,
  type InputImageLimits,
  type InputImageSource,
} from "../media/input-files.js";
import { defaultRuntime } from "../runtime.js";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "../shared/string-coerce.js";
import { resolveAssistantStreamDeltaText } from "./agent-event-assistant-text.js";
import {
  buildAgentMessageFromConversationEntries,
  type ConversationEntry,
} from "./agent-prompt.js";
import {
  extractAgentNexusRuntimeConversationText,
  type AgentNexusRuntimeTextReply,
  resolveAgentNexusRuntimeTextReply,
} from "./agentnexus-tool-gateway.js";
import type { AuthRateLimiter } from "./auth-rate-limit.js";
import type { ResolvedGatewayAuth } from "./auth.js";
import { sendJson, setSseHeaders, watchClientDisconnect, writeDone } from "./http-common.js";
import { handleGatewayPostJsonEndpoint } from "./http-endpoint-helpers.js";
import {
  resolveGatewayRequestContext,
  resolveOpenAiCompatModelOverride,
  resolveOpenAiCompatibleHttpOperatorScopes,
  resolveOpenAiCompatibleHttpSenderIsOwner,
} from "./http-utils.js";
import { normalizeInputHostnameAllowlist } from "./input-allowlist.js";

type OpenAiHttpOptions = {
  auth: ResolvedGatewayAuth;
  config?: GatewayHttpChatCompletionsConfig;
  maxBodyBytes?: number;
  trustedProxies?: string[];
  allowRealIpFallback?: boolean;
  rateLimiter?: AuthRateLimiter;
};

type OpenAiChatMessage = {
  role?: unknown;
  content?: unknown;
  name?: unknown;
};

type OpenAiChatCompletionRequest = {
  model?: unknown;
  stream?: unknown;
  // Naming/style reference: src/agents/openai-transport-stream.ts:1262-1273
  stream_options?: unknown;
  messages?: unknown;
  user?: unknown;
};

const AGENTNEXUS_DIRECT_OPENROUTER_CHAT_ENV = "AGENTNEXUS_DIRECT_OPENROUTER_CHAT";
const AGENTNEXUS_OPENROUTER_DEFAULT_MODEL = "moonshotai/kimi-k2.6";
const AGENTNEXUS_OPENROUTER_FALLBACK_MODEL = "moonshotai/kimi-k2.5";
const DEFAULT_OPENAI_CHAT_COMPLETIONS_BODY_BYTES = 20 * 1024 * 1024;
const IMAGE_ONLY_USER_MESSAGE = "User sent image(s) with no text.";
const DEFAULT_OPENAI_MAX_IMAGE_PARTS = 8;
const DEFAULT_OPENAI_MAX_TOTAL_IMAGE_BYTES = 20 * 1024 * 1024;
const DEFAULT_OPENAI_IMAGE_LIMITS: InputImageLimits = {
  allowUrl: false,
  allowedMimes: new Set(DEFAULT_INPUT_IMAGE_MIMES),
  maxBytes: DEFAULT_INPUT_IMAGE_MAX_BYTES,
  maxRedirects: DEFAULT_INPUT_MAX_REDIRECTS,
  timeoutMs: DEFAULT_INPUT_TIMEOUT_MS,
};

type ResolvedOpenAiChatCompletionsLimits = {
  maxBodyBytes: number;
  maxImageParts: number;
  maxTotalImageBytes: number;
  images: InputImageLimits;
};

function resolveOpenAiChatCompletionsLimits(
  config: GatewayHttpChatCompletionsConfig | undefined,
): ResolvedOpenAiChatCompletionsLimits {
  const imageConfig = config?.images;
  return {
    maxBodyBytes: config?.maxBodyBytes ?? DEFAULT_OPENAI_CHAT_COMPLETIONS_BODY_BYTES,
    maxImageParts:
      typeof config?.maxImageParts === "number"
        ? Math.max(0, Math.floor(config.maxImageParts))
        : DEFAULT_OPENAI_MAX_IMAGE_PARTS,
    maxTotalImageBytes:
      typeof config?.maxTotalImageBytes === "number"
        ? Math.max(1, Math.floor(config.maxTotalImageBytes))
        : DEFAULT_OPENAI_MAX_TOTAL_IMAGE_BYTES,
    images: {
      allowUrl: imageConfig?.allowUrl ?? DEFAULT_OPENAI_IMAGE_LIMITS.allowUrl,
      urlAllowlist: normalizeInputHostnameAllowlist(imageConfig?.urlAllowlist),
      allowedMimes: normalizeMimeList(imageConfig?.allowedMimes, DEFAULT_INPUT_IMAGE_MIMES),
      maxBytes: imageConfig?.maxBytes ?? DEFAULT_INPUT_IMAGE_MAX_BYTES,
      maxRedirects: imageConfig?.maxRedirects ?? DEFAULT_INPUT_MAX_REDIRECTS,
      timeoutMs: imageConfig?.timeoutMs ?? DEFAULT_INPUT_TIMEOUT_MS,
    },
  };
}

function writeSse(res: ServerResponse, data: unknown) {
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function buildAgentCommandInput(params: {
  prompt: { message: string; extraSystemPrompt?: string; images?: ImageContent[] };
  modelOverride?: string;
  sessionKey: string;
  runId: string;
  messageChannel: string;
  senderIsOwner: boolean;
  abortSignal?: AbortSignal;
}) {
  return {
    message: params.prompt.message,
    extraSystemPrompt: params.prompt.extraSystemPrompt,
    images: params.prompt.images,
    model: params.modelOverride,
    sessionKey: params.sessionKey,
    runId: params.runId,
    deliver: false as const,
    messageChannel: params.messageChannel,
    bestEffortDeliver: false as const,
    senderIsOwner: params.senderIsOwner,
    allowModelOverride: true as const,
    abortSignal: params.abortSignal,
  };
}

function writeAssistantRoleChunk(res: ServerResponse, params: { runId: string; model: string }) {
  writeSse(res, {
    id: params.runId,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: params.model,
    choices: [{ index: 0, delta: { role: "assistant" } }],
  });
}

function writeAssistantContentChunk(
  res: ServerResponse,
  params: { runId: string; model: string; content: string; finishReason: "stop" | null },
) {
  writeSse(res, {
    id: params.runId,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: params.model,
    choices: [
      {
        index: 0,
        delta: { content: params.content },
        finish_reason: params.finishReason,
      },
    ],
  });
}

function writeAssistantStopChunk(res: ServerResponse, params: { runId: string; model: string }) {
  writeSse(res, {
    id: params.runId,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: params.model,
    choices: [
      {
        index: 0,
        delta: {},
        finish_reason: "stop",
      },
    ],
  });
}

function writeUsageChunk(
  res: ServerResponse,
  params: {
    runId: string;
    model: string;
    usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
  },
) {
  writeSse(res, {
    id: params.runId,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: params.model,
    choices: [],
    usage: params.usage,
  });
}

function shouldUseAgentNexusDirectOpenRouterChat(): boolean {
  return process.env[AGENTNEXUS_DIRECT_OPENROUTER_CHAT_ENV] === "1";
}

function readStringHeader(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name.toLowerCase()];
  if (Array.isArray(value)) {
    return value.find((item) => item.trim().length > 0);
  }
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function normalizeDirectOpenRouterModel(modelOverride?: string): string {
  const trimmed = modelOverride?.trim();
  if (!trimmed || trimmed === "openclaw" || trimmed.startsWith("openclaw/")) {
    return AGENTNEXUS_OPENROUTER_DEFAULT_MODEL;
  }
  return trimmed.startsWith("openrouter/") ? trimmed.slice("openrouter/".length) : trimmed;
}

function parseJsonObject(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function stringifyOpenAiContent(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (!Array.isArray(value)) {
    return "";
  }
  return value
    .map((part) => {
      if (!part || typeof part !== "object") {
        return "";
      }
      const text =
        (part as { text?: unknown; content?: unknown }).text ??
        (part as { text?: unknown; content?: unknown }).content;
      return typeof text === "string" ? text : "";
    })
    .filter(Boolean)
    .join("\n");
}

function extractDirectOpenRouterContent(body: Record<string, unknown>): string {
  const choices = Array.isArray(body.choices) ? body.choices : [];
  const first = choices[0] as
    | {
        message?: { content?: unknown; reasoning?: unknown };
        delta?: { content?: unknown };
        text?: unknown;
      }
    | undefined;
  return (
    stringifyOpenAiContent(first?.message?.content) ||
    stringifyOpenAiContent(first?.message?.reasoning) ||
    stringifyOpenAiContent(first?.delta?.content) ||
    stringifyOpenAiContent(first?.text)
  );
}

function extractLastOpenAiUserMessageText(payload: OpenAiChatCompletionRequest): string {
  const messages = Array.isArray(payload.messages) ? payload.messages : [];
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i] as OpenAiChatMessage | undefined;
    if (!message || message.role !== "user") {
      continue;
    }
    return stringifyOpenAiContent(message.content).trim();
  }
  return "";
}

function sendAgentNexusRuntimeTextResponse(params: {
  res: ServerResponse;
  runId: string;
  model: string;
  content: string;
  stream: boolean;
  streamIncludeUsage: boolean;
  adapter: AgentNexusRuntimeTextReply["adapter"];
}) {
  const usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  if (params.stream) {
    setSseHeaders(params.res);
    writeAssistantRoleChunk(params.res, { runId: params.runId, model: params.model });
    writeAssistantContentChunk(params.res, {
      runId: params.runId,
      model: params.model,
      content: params.content,
      finishReason: null,
    });
    writeAssistantStopChunk(params.res, { runId: params.runId, model: params.model });
    if (params.streamIncludeUsage) {
      writeUsageChunk(params.res, { runId: params.runId, model: params.model, usage });
    }
    writeDone(params.res);
    params.res.end();
    return;
  }

  sendJson(params.res, 200, {
    id: params.runId,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: params.model,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: params.content },
        finish_reason: "stop",
      },
    ],
    usage,
    agentnexus: {
      adapter: params.adapter,
    },
  });
}

async function handleAgentNexusRuntimeToolGatewayChat(params: {
  payload: OpenAiChatCompletionRequest;
  res: ServerResponse;
  runId: string;
  model: string;
  stream: boolean;
  streamIncludeUsage: boolean;
  signal: AbortSignal;
}): Promise<boolean> {
  const userText = extractLastOpenAiUserMessageText(params.payload);
  const reply = await resolveAgentNexusRuntimeTextReply({
    text: userText,
    signal: params.signal,
    conversationText: extractAgentNexusRuntimeConversationText(asMessages(params.payload.messages)),
  });
  if (!reply) {
    return false;
  }

  sendAgentNexusRuntimeTextResponse({
    res: params.res,
    runId: params.runId,
    model: params.model,
    content: reply.content,
    stream: params.stream,
    streamIncludeUsage: params.streamIncludeUsage,
    adapter: reply.adapter,
  });
  return true;
}

function postOpenRouterJson(params: {
  apiKey: string;
  payload: Record<string, unknown>;
  signal: AbortSignal;
}): Promise<{ statusCode: number; text: string }> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(params.payload);
    const req = httpsRequest(
      "https://openrouter.ai/api/v1/chat/completions",
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${params.apiKey}`,
          "content-type": "application/json",
          "content-length": String(Buffer.byteLength(body)),
          "HTTP-Referer": "https://agtnx.ai",
          "X-Title": "AgentNexus",
        },
      },
      (response) => {
        const chunks: string[] = [];
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          chunks.push(String(chunk));
        });
        response.on("end", () => {
          cleanup();
          resolve({
            statusCode: response.statusCode ?? 0,
            text: chunks.join(""),
          });
        });
      },
    );

    const cleanup = () => {
      params.signal.removeEventListener("abort", onAbort);
    };
    const onAbort = () => {
      req.destroy(new Error("OpenRouter request aborted"));
    };

    params.signal.addEventListener("abort", onAbort, { once: true });
    req.setTimeout(55_000, () => {
      req.destroy(new Error("OpenRouter request timed out"));
    });
    req.on("error", (err) => {
      cleanup();
      reject(err);
    });
    req.write(body);
    req.end();
  });
}

async function requestDirectOpenRouterCompletion(params: {
  payload: OpenAiChatCompletionRequest;
  modelOverride?: string;
  signal: AbortSignal;
}): Promise<{ body: Record<string, unknown>; model: string }> {
  const apiKey = process.env.OPENROUTER_API_KEY?.trim();
  if (!apiKey) {
    throw new Error("OPENROUTER_API_KEY is not configured.");
  }

  const requestedModel = normalizeDirectOpenRouterModel(params.modelOverride);
  const models = Array.from(new Set([requestedModel, AGENTNEXUS_OPENROUTER_FALLBACK_MODEL]));
  const payload = params.payload as Record<string, unknown>;
  let lastError = "unknown upstream failure";

  for (const model of models) {
    const response = await postOpenRouterJson({
      apiKey,
      payload: {
        ...payload,
        model,
        stream: false,
      },
      signal: params.signal,
    });
    const body = parseJsonObject(response.text);
    if (response.statusCode >= 200 && response.statusCode < 300) {
      return { body, model };
    }
    lastError = `OpenRouter HTTP ${response.statusCode} for ${model}`;
  }

  throw new Error(lastError);
}

async function handleAgentNexusDirectOpenRouterChat(params: {
  payload: OpenAiChatCompletionRequest;
  res: ServerResponse;
  runId: string;
  model: string;
  modelOverride?: string;
  stream: boolean;
  streamIncludeUsage: boolean;
  signal: AbortSignal;
}): Promise<boolean> {
  try {
    const handledByToolGateway = await handleAgentNexusRuntimeToolGatewayChat({
      payload: params.payload,
      res: params.res,
      runId: params.runId,
      model: params.model,
      stream: params.stream,
      streamIncludeUsage: params.streamIncludeUsage,
      signal: params.signal,
    });
    if (handledByToolGateway) {
      return true;
    }

    const upstream = await requestDirectOpenRouterCompletion({
      payload: params.payload,
      modelOverride: params.modelOverride,
      signal: params.signal,
    });
    const content =
      extractDirectOpenRouterContent(upstream.body) ||
      "OpenClaw direct OpenRouter adapter is online.";
    const usage = upstream.body.usage;

    if (params.stream) {
      setSseHeaders(params.res);
      writeAssistantRoleChunk(params.res, { runId: params.runId, model: params.model });
      writeAssistantContentChunk(params.res, {
        runId: params.runId,
        model: params.model,
        content,
        finishReason: null,
      });
      writeAssistantStopChunk(params.res, { runId: params.runId, model: params.model });
      if (params.streamIncludeUsage && usage && typeof usage === "object") {
        writeUsageChunk(params.res, {
          runId: params.runId,
          model: params.model,
          usage: usage as {
            prompt_tokens: number;
            completion_tokens: number;
            total_tokens: number;
          },
        });
      }
      writeDone(params.res);
      params.res.end();
      return true;
    }

    sendJson(params.res, 200, {
      id: params.runId,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: params.model,
      choices: [
        {
          index: 0,
          message: { role: "assistant", content },
          finish_reason: "stop",
        },
      ],
      usage,
      agentnexus: {
        adapter: "direct-openrouter",
        upstreamModel: upstream.model,
      },
    });
  } catch (err) {
    if (params.signal.aborted) {
      return true;
    }
    logWarn(`openai-compat: AgentNexus direct OpenRouter chat failed: ${String(err)}`);
    sendJson(params.res, 502, {
      error: { message: "upstream model request failed", type: "api_error" },
    });
  }

  return true;
}

function asMessages(val: unknown): OpenAiChatMessage[] {
  return Array.isArray(val) ? (val as OpenAiChatMessage[]) : [];
}

function extractTextContent(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (!part || typeof part !== "object") {
          return "";
        }
        const type = (part as { type?: unknown }).type;
        const text = (part as { text?: unknown }).text;
        const inputText = (part as { input_text?: unknown }).input_text;
        if (type === "text" && typeof text === "string") {
          return text;
        }
        if (type === "input_text" && typeof text === "string") {
          return text;
        }
        if (typeof inputText === "string") {
          return inputText;
        }
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

function resolveImageUrlPart(part: unknown): string | undefined {
  if (!part || typeof part !== "object") {
    return undefined;
  }
  const imageUrl = (part as { image_url?: unknown }).image_url;
  if (typeof imageUrl === "string") {
    const trimmed = imageUrl.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  if (!imageUrl || typeof imageUrl !== "object") {
    return undefined;
  }
  const rawUrl = (imageUrl as { url?: unknown }).url;
  if (typeof rawUrl !== "string") {
    return undefined;
  }
  const trimmed = rawUrl.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function extractImageUrls(content: unknown): string[] {
  if (!Array.isArray(content)) {
    return [];
  }
  const urls: string[] = [];
  for (const part of content) {
    if (!part || typeof part !== "object") {
      continue;
    }
    if ((part as { type?: unknown }).type !== "image_url") {
      continue;
    }
    const url = resolveImageUrlPart(part);
    if (url) {
      urls.push(url);
    }
  }
  return urls;
}

type ActiveTurnContext = {
  activeTurnIndex: number;
  activeUserMessageIndex: number;
  urls: string[];
};

type AgentNexusRuntimeSkillCommand = {
  skillId: string;
  input: string;
};

type AgentNexusRuntimeSkillResult = {
  skillStatus?: unknown;
  skillId?: unknown;
  kind?: unknown;
  version?: unknown;
  output?: unknown;
  redacted?: unknown;
};

function extractLatestUserText(messagesUnknown: unknown): string {
  const messages = asMessages(messagesUnknown);
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const msg = messages[i];
    if (!msg || typeof msg !== "object") {
      continue;
    }
    const role = normalizeOptionalString(msg.role) ?? "";
    if (role !== "user") {
      continue;
    }
    return extractTextContent(msg.content).trim();
  }
  return "";
}

function parseAgentNexusRuntimeSkillCommand(input: string): AgentNexusRuntimeSkillCommand | null {
  const match = /^\s*\/skill\s+([a-z0-9][a-z0-9-]{2,80})(?:\s+([\s\S]*))?$/u.exec(input);
  if (!match) {
    return null;
  }
  return {
    skillId: match[1],
    input: (match[2] ?? "").trim(),
  };
}

function readAgentNexusRuntimeToolGatewayConfig(): { url: string; token: string } | null {
  const url = normalizeOptionalString(process.env.AGENTNEXUS_TOOL_GATEWAY_URL) ?? "";
  const token = normalizeOptionalString(process.env.AGENTNEXUS_RUNTIME_TOKEN) ?? "";
  if (!url || !token) {
    return null;
  }
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" && parsed.hostname !== "localhost") {
      return null;
    }
    return { url: parsed.toString(), token };
  } catch {
    return null;
  }
}

async function executeAgentNexusRuntimeSkillCommand(
  command: AgentNexusRuntimeSkillCommand,
  signal: AbortSignal,
): Promise<AgentNexusRuntimeSkillResult | null> {
  const config = readAgentNexusRuntimeToolGatewayConfig();
  if (!config) {
    return null;
  }
  const response = await fetch(config.url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${config.token}`,
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify({
      tool: "runtime_skill_execute",
      args: {
        skillId: command.skillId,
        input: command.input,
      },
    }),
    signal,
  });
  if (!response.ok) {
    return {
      skillStatus: "unavailable",
      skillId: command.skillId,
      output: {
        status: "tool_gateway_unavailable",
      },
      redacted: true,
    };
  }
  const body = await response.json().catch(() => null);
  const result =
    body && typeof body === "object"
      ? (body as { data?: { result?: unknown } }).data?.result
      : null;
  return result && typeof result === "object" ? (result as AgentNexusRuntimeSkillResult) : null;
}

function formatAgentNexusRuntimeSkillResult(result: AgentNexusRuntimeSkillResult | null): string {
  const output =
    result?.output && typeof result.output === "object"
      ? (result.output as Record<string, unknown>)
      : {};
  const skillStatus = normalizeOptionalString(result?.skillStatus) ?? "unavailable";
  const skillId = normalizeOptionalString(result?.skillId) ?? "unknown";
  const kind = normalizeOptionalString(result?.kind) ?? "runtime_skill";
  const version = normalizeOptionalString(result?.version) ?? "unknown";
  const summary =
    normalizeOptionalString(output.summary) ??
    normalizeOptionalString(output.status) ??
    "Governed runtime skill returned no summary.";
  return [
    `skill_status: ${skillStatus}`,
    `skill_id: ${skillId}`,
    `kind: ${kind}`,
    `version: ${version}`,
    "source: AgentNexus governed skills catalog",
    `summary: ${summary}`,
    "redacted: true",
  ].join("\n");
}

function writeAgentNexusRuntimeSkillResponse(params: {
  res: ServerResponse;
  runId: string;
  model: string;
  content: string;
  stream: boolean;
  streamIncludeUsage: boolean;
}) {
  if (params.stream) {
    setSseHeaders(params.res);
    writeAssistantRoleChunk(params.res, { runId: params.runId, model: params.model });
    writeAssistantContentChunk(params.res, {
      runId: params.runId,
      model: params.model,
      content: params.content,
      finishReason: null,
    });
    writeAssistantStopChunk(params.res, { runId: params.runId, model: params.model });
    if (params.streamIncludeUsage) {
      writeUsageChunk(params.res, {
        runId: params.runId,
        model: params.model,
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      });
    }
    writeDone(params.res);
    params.res.end();
    return;
  }
  sendJson(params.res, 200, {
    id: params.runId,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: params.model,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: params.content },
        finish_reason: "stop",
      },
    ],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  });
}

async function handleAgentNexusRuntimeSkillChat(params: {
  command: AgentNexusRuntimeSkillCommand;
  res: ServerResponse;
  runId: string;
  model: string;
  stream: boolean;
  streamIncludeUsage: boolean;
  signal: AbortSignal;
}): Promise<boolean> {
  try {
    const result = await executeAgentNexusRuntimeSkillCommand(params.command, params.signal);
    writeAgentNexusRuntimeSkillResponse({
      res: params.res,
      runId: params.runId,
      model: params.model,
      stream: params.stream,
      streamIncludeUsage: params.streamIncludeUsage,
      content: formatAgentNexusRuntimeSkillResult(result),
    });
  } catch (err) {
    if (params.signal.aborted) {
      return true;
    }
    logWarn(`openai-compat: AgentNexus runtime skill failed: ${String(err)}`);
    writeAgentNexusRuntimeSkillResponse({
      res: params.res,
      runId: params.runId,
      model: params.model,
      stream: params.stream,
      streamIncludeUsage: params.streamIncludeUsage,
      content: formatAgentNexusRuntimeSkillResult({
        skillStatus: "unavailable",
        skillId: params.command.skillId,
        output: { status: "tool_gateway_unavailable" },
        redacted: true,
      }),
    });
  }
  return true;
}

function parseImageUrlToSource(url: string): InputImageSource {
  const dataUriMatch = /^data:([^,]*?),(.*)$/is.exec(url);
  if (dataUriMatch) {
    const metadata = normalizeOptionalString(dataUriMatch[1]) ?? "";
    const data = dataUriMatch[2] ?? "";
    const metadataParts = metadata
      .split(";")
      .map((part) => normalizeOptionalString(part) ?? "")
      .filter(Boolean);
    const isBase64 = metadataParts.some(
      (part) => normalizeLowercaseStringOrEmpty(part) === "base64",
    );
    if (!isBase64) {
      throw new Error("image_url data URI must be base64 encoded");
    }
    if (!(normalizeOptionalString(data) ?? "")) {
      throw new Error("image_url data URI is missing payload data");
    }
    const mediaTypeRaw = metadataParts.find((part) => part.includes("/"));
    return {
      type: "base64",
      mediaType: mediaTypeRaw,
      data,
    };
  }
  return { type: "url", url };
}

function resolveActiveTurnContext(messagesUnknown: unknown): ActiveTurnContext {
  const messages = asMessages(messagesUnknown);
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const msg = messages[i];
    if (!msg || typeof msg !== "object") {
      continue;
    }
    const role = normalizeOptionalString(msg.role) ?? "";
    const normalizedRole = role === "function" ? "tool" : role;
    if (normalizedRole !== "user" && normalizedRole !== "tool") {
      continue;
    }
    return {
      activeTurnIndex: i,
      activeUserMessageIndex: normalizedRole === "user" ? i : -1,
      urls: normalizedRole === "user" ? extractImageUrls(msg.content) : [],
    };
  }
  return { activeTurnIndex: -1, activeUserMessageIndex: -1, urls: [] };
}

async function resolveImagesForRequest(
  activeTurnContext: Pick<ActiveTurnContext, "urls">,
  limits: ResolvedOpenAiChatCompletionsLimits,
): Promise<ImageContent[]> {
  const urls = activeTurnContext.urls;
  if (urls.length === 0) {
    return [];
  }
  if (urls.length > limits.maxImageParts) {
    throw new Error(`Too many image_url parts (${urls.length}; limit ${limits.maxImageParts})`);
  }

  const images: ImageContent[] = [];
  let totalBytes = 0;
  for (const url of urls) {
    const source = parseImageUrlToSource(url);
    if (source.type === "base64") {
      const sourceBytes = estimateBase64DecodedBytes(source.data);
      if (totalBytes + sourceBytes > limits.maxTotalImageBytes) {
        throw new Error(
          `Total image payload too large (${totalBytes + sourceBytes}; limit ${limits.maxTotalImageBytes})`,
        );
      }
    }

    const image = await extractImageContentFromSource(source, limits.images);
    totalBytes += estimateBase64DecodedBytes(image.data);
    if (totalBytes > limits.maxTotalImageBytes) {
      throw new Error(
        `Total image payload too large (${totalBytes}; limit ${limits.maxTotalImageBytes})`,
      );
    }
    images.push(image);
  }
  return images;
}

export const __testOnlyOpenAiHttp = {
  formatAgentNexusRuntimeSkillResult,
  parseAgentNexusRuntimeSkillCommand,
  resolveImagesForRequest,
  resolveOpenAiChatCompletionsLimits,
  resolveChatCompletionUsage,
};

function buildAgentPrompt(
  messagesUnknown: unknown,
  activeUserMessageIndex: number,
): {
  message: string;
  extraSystemPrompt?: string;
} {
  const messages = asMessages(messagesUnknown);

  const systemParts: string[] = [];
  const conversationEntries: ConversationEntry[] = [];

  for (const [i, msg] of messages.entries()) {
    if (!msg || typeof msg !== "object") {
      continue;
    }
    const role = normalizeOptionalString(msg.role) ?? "";
    const content = extractTextContent(msg.content).trim();
    const hasImage = extractImageUrls(msg.content).length > 0;
    if (!role) {
      continue;
    }
    if (role === "system" || role === "developer") {
      if (content) {
        systemParts.push(content);
      }
      continue;
    }

    const normalizedRole = role === "function" ? "tool" : role;
    if (normalizedRole !== "user" && normalizedRole !== "assistant" && normalizedRole !== "tool") {
      continue;
    }

    // Keep the image-only placeholder scoped to the active user turn so we don't
    // mention historical image-only turns whose bytes are intentionally not replayed.
    const messageContent =
      normalizedRole === "user" && !content && hasImage && i === activeUserMessageIndex
        ? IMAGE_ONLY_USER_MESSAGE
        : content;
    if (!messageContent) {
      continue;
    }

    const name = normalizeOptionalString(msg.name) ?? "";
    const sender =
      normalizedRole === "assistant"
        ? "Assistant"
        : normalizedRole === "user"
          ? "User"
          : name
            ? `Tool:${name}`
            : "Tool";

    conversationEntries.push({
      role: normalizedRole,
      entry: { sender, body: messageContent },
    });
  }

  const message = buildAgentMessageFromConversationEntries(conversationEntries);

  return {
    message,
    extraSystemPrompt: systemParts.length > 0 ? systemParts.join("\n\n") : undefined,
  };
}

function coerceRequest(val: unknown): OpenAiChatCompletionRequest {
  if (!val || typeof val !== "object") {
    return {};
  }
  return val as OpenAiChatCompletionRequest;
}

function resolveAgentResponseText(result: unknown): string {
  const payloads = (result as { payloads?: Array<{ text?: string }> } | null)?.payloads;
  if (!Array.isArray(payloads) || payloads.length === 0) {
    return "No response from OpenClaw.";
  }
  const content = payloads
    .map((p) => (typeof p.text === "string" ? p.text : ""))
    .filter(Boolean)
    .join("\n\n");
  return content || "No response from OpenClaw.";
}

type AgentUsageMeta = {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  total?: number;
};

function resolveAgentRunUsage(result: unknown): NormalizedUsage | undefined {
  const agentMeta = (
    result as {
      meta?: {
        agentMeta?: {
          usage?: AgentUsageMeta;
          lastCallUsage?: AgentUsageMeta;
        };
      };
    } | null
  )?.meta?.agentMeta;
  const primary = normalizeUsage(agentMeta?.usage);
  if (hasNonzeroUsage(primary)) {
    return primary;
  }
  const fallback = normalizeUsage(agentMeta?.lastCallUsage);
  if (hasNonzeroUsage(fallback)) {
    return fallback;
  }
  return primary ?? fallback;
}

function resolveChatCompletionUsage(result: unknown): {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
} {
  return toOpenAiChatCompletionsUsage(resolveAgentRunUsage(result));
}

function resolveIncludeUsageForStreaming(payload: OpenAiChatCompletionRequest): boolean {
  // Keep parsing aligned with OpenAI wire-format field names.
  // Flow reference: src/agents/openai-transport-stream.ts:1262-1273
  const streamOptions = payload.stream_options;
  if (!streamOptions || typeof streamOptions !== "object" || Array.isArray(streamOptions)) {
    return false;
  }
  return (streamOptions as { include_usage?: unknown }).include_usage === true;
}

export async function handleOpenAiHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  opts: OpenAiHttpOptions,
): Promise<boolean> {
  const limits = resolveOpenAiChatCompletionsLimits(opts.config);
  const handled = await handleGatewayPostJsonEndpoint(req, res, {
    pathname: "/v1/chat/completions",
    requiredOperatorMethod: "chat.send",
    // Compat HTTP uses a different scope model from generic HTTP helpers:
    // shared-secret bearer auth is treated as full operator access here.
    resolveOperatorScopes: resolveOpenAiCompatibleHttpOperatorScopes,
    auth: opts.auth,
    trustedProxies: opts.trustedProxies,
    allowRealIpFallback: opts.allowRealIpFallback,
    rateLimiter: opts.rateLimiter,
    maxBodyBytes: opts.maxBodyBytes ?? limits.maxBodyBytes,
  });
  if (handled === false) {
    return false;
  }
  if (!handled) {
    return true;
  }
  // On the compat surface, shared-secret bearer auth is also treated as an
  // owner sender so owner-only tool policy matches the documented contract.
  const senderIsOwner = resolveOpenAiCompatibleHttpSenderIsOwner(req, handled.requestAuth);

  const payload = coerceRequest(handled.body);
  const stream = Boolean(payload.stream);
  const streamIncludeUsage = stream && resolveIncludeUsageForStreaming(payload);
  const model = typeof payload.model === "string" ? payload.model : "openclaw";
  const user = typeof payload.user === "string" ? payload.user : undefined;
  const runId = `chatcmpl_${randomUUID()}`;
  const abortController = new AbortController();
  const runtimeSkillCommand = parseAgentNexusRuntimeSkillCommand(
    extractLatestUserText(payload.messages),
  );
  if (runtimeSkillCommand) {
    return await handleAgentNexusRuntimeSkillChat({
      command: runtimeSkillCommand,
      res,
      runId,
      model,
      stream,
      streamIncludeUsage,
      signal: abortController.signal,
    });
  }

  if (shouldUseAgentNexusDirectOpenRouterChat()) {
    return await handleAgentNexusDirectOpenRouterChat({
      payload,
      res,
      runId,
      model,
      modelOverride: readStringHeader(req, "x-openclaw-model"),
      stream,
      streamIncludeUsage,
      signal: abortController.signal,
    });
  }

  const { agentId, sessionKey, messageChannel } = resolveGatewayRequestContext({
    req,
    model,
    user,
    sessionPrefix: "openai",
    defaultMessageChannel: "webchat",
    useMessageChannelHeader: true,
  });
  const { modelOverride, errorMessage: modelError } = await resolveOpenAiCompatModelOverride({
    req,
    agentId,
    model,
  });
  if (modelError) {
    sendJson(res, 400, {
      error: { message: modelError, type: "invalid_request_error" },
    });
    return true;
  }
  const activeTurnContext = resolveActiveTurnContext(payload.messages);
  const prompt = buildAgentPrompt(payload.messages, activeTurnContext.activeUserMessageIndex);
  let images: ImageContent[] = [];
  try {
    images = await resolveImagesForRequest(activeTurnContext, limits);
  } catch (err) {
    logWarn(`openai-compat: invalid image_url content: ${String(err)}`);
    sendJson(res, 400, {
      error: {
        message: "Invalid image_url content in `messages`.",
        type: "invalid_request_error",
      },
    });
    return true;
  }

  if (!prompt.message && images.length === 0) {
    sendJson(res, 400, {
      error: {
        message: "Missing user message in `messages`.",
        type: "invalid_request_error",
      },
    });
    return true;
  }

  const deps = createDefaultDeps();
  const commandInput = buildAgentCommandInput({
    prompt: {
      message: prompt.message,
      extraSystemPrompt: prompt.extraSystemPrompt,
      images: images.length > 0 ? images : undefined,
    },
    modelOverride,
    sessionKey,
    runId,
    messageChannel,
    abortSignal: abortController.signal,
    senderIsOwner,
  });

  if (!stream) {
    const stopWatchingDisconnect = watchClientDisconnect(req, res, abortController);
    try {
      const result = await agentCommandFromIngress(commandInput, defaultRuntime, deps);

      if (abortController.signal.aborted) {
        return true;
      }

      const content = resolveAgentResponseText(result);
      const usage = resolveChatCompletionUsage(result);

      sendJson(res, 200, {
        id: runId,
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [
          {
            index: 0,
            message: { role: "assistant", content },
            finish_reason: "stop",
          },
        ],
        usage,
      });
    } catch (err) {
      if (abortController.signal.aborted) {
        return true;
      }
      logWarn(`openai-compat: chat completion failed: ${String(err)}`);
      sendJson(res, 500, {
        error: { message: "internal error", type: "api_error" },
      });
    } finally {
      stopWatchingDisconnect();
    }
    return true;
  }

  setSseHeaders(res);

  let wroteRole = false;
  let wroteStopChunk = false;
  let sawAssistantDelta = false;
  let finalUsage:
    | {
        prompt_tokens: number;
        completion_tokens: number;
        total_tokens: number;
      }
    | undefined;
  let finalizeRequested = false;
  let closed = false;
  let stopWatchingDisconnect = () => {};

  const maybeFinalize = () => {
    if (closed || !finalizeRequested) {
      return;
    }
    if (streamIncludeUsage && !finalUsage) {
      return;
    }
    closed = true;
    stopWatchingDisconnect();
    unsubscribe();
    if (!wroteStopChunk) {
      writeAssistantStopChunk(res, { runId, model });
      wroteStopChunk = true;
    }
    if (streamIncludeUsage && finalUsage) {
      writeUsageChunk(res, { runId, model, usage: finalUsage });
    }
    writeDone(res);
    res.end();
  };

  const requestFinalize = () => {
    finalizeRequested = true;
    maybeFinalize();
  };

  const unsubscribe = onAgentEvent((evt) => {
    if (evt.runId !== runId) {
      return;
    }
    if (closed) {
      return;
    }

    if (evt.stream === "assistant") {
      const content = resolveAssistantStreamDeltaText(evt) ?? "";
      if (!content) {
        return;
      }

      if (!wroteRole) {
        wroteRole = true;
        writeAssistantRoleChunk(res, { runId, model });
      }

      sawAssistantDelta = true;
      writeAssistantContentChunk(res, {
        runId,
        model,
        content,
        finishReason: null,
      });
      return;
    }

    if (evt.stream === "lifecycle") {
      const phase = evt.data?.phase;
      if (phase === "end" || phase === "error") {
        requestFinalize();
      }
    }
  });

  stopWatchingDisconnect = watchClientDisconnect(req, res, abortController, () => {
    closed = true;
    unsubscribe();
  });

  void (async () => {
    try {
      const result = await agentCommandFromIngress(commandInput, defaultRuntime, deps);

      if (closed) {
        return;
      }

      finalUsage = resolveChatCompletionUsage(result);

      if (!sawAssistantDelta) {
        if (!wroteRole) {
          wroteRole = true;
          writeAssistantRoleChunk(res, { runId, model });
        }

        const content = resolveAgentResponseText(result);

        sawAssistantDelta = true;
        writeAssistantContentChunk(res, {
          runId,
          model,
          content,
          finishReason: null,
        });
      }
      requestFinalize();
    } catch (err) {
      if (closed || abortController.signal.aborted) {
        return;
      }
      logWarn(`openai-compat: streaming chat completion failed: ${String(err)}`);
      writeAssistantContentChunk(res, {
        runId,
        model,
        content: "Error: internal error",
        finishReason: "stop",
      });
      wroteStopChunk = true;
      finalUsage = {
        prompt_tokens: 0,
        completion_tokens: 0,
        total_tokens: 0,
      };
      emitAgentEvent({
        runId,
        stream: "lifecycle",
        data: { phase: "error" },
      });
      requestFinalize();
    } finally {
      if (!closed) {
        emitAgentEvent({
          runId,
          stream: "lifecycle",
          data: { phase: "end" },
        });
      }
    }
  })();

  return true;
}
