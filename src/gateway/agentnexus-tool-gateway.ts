type RuntimeToolName = "web_search" | "calendar_list_events" | "runtime_skill_execute";

export type AgentNexusRuntimeToolRequest = {
  tool: RuntimeToolName;
  args: Record<string, unknown>;
  intent: "web_search" | "google_calendar_read" | "governed_skill";
};

export type AgentNexusRuntimeToolConfig = {
  gatewayUrl: string;
  runtimeToken: string;
};

export type AgentNexusRuntimeToolResult = {
  ok: boolean;
  status: number;
  body: Record<string, unknown>;
};

export type AgentNexusRuntimeTextReply = {
  adapter: "agentnexus-tool-gateway" | "agentnexus-channel-boundary" | "agentnexus-direct-openrouter";
  content: string;
};

export type AgentNexusRuntimeDirectChatConfig = {
  apiKey: string;
  apiUrl: string;
  model: string;
};

export function readAgentNexusRuntimeToolConfig(
  env: Record<string, string | undefined> = process.env,
): AgentNexusRuntimeToolConfig | null {
  const gatewayUrl = env.AGENTNEXUS_TOOL_GATEWAY_URL?.trim();
  const runtimeToken = env.AGENTNEXUS_RUNTIME_TOKEN?.trim();
  if (!gatewayUrl || !runtimeToken) {
    return null;
  }
  return { gatewayUrl, runtimeToken };
}

export function readAgentNexusRuntimeDirectChatConfig(
  env: Record<string, string | undefined> = process.env,
): AgentNexusRuntimeDirectChatConfig | null {
  if (!isTruthyEnvValue(env.OPENCLAW_MANAGED_HEADLESS)) {
    return null;
  }
  const apiKey = env.OPENROUTER_API_KEY?.trim();
  if (!apiKey) {
    return null;
  }
  return {
    apiKey,
    apiUrl: env.OPENROUTER_API_URL?.trim() || "https://openrouter.ai/api/v1/chat/completions",
    model: env.OPENROUTER_MODEL?.trim() || "moonshotai/kimi-k2.6",
  };
}

export function resolveAgentNexusRuntimeToolRequest(
  text: string,
  now: Date = new Date(),
): AgentNexusRuntimeToolRequest | null {
  const normalized = text.trim();
  const lower = normalized.toLowerCase();
  if (!normalized) {
    return null;
  }
  const governedSkill = parseGovernedSkillRequest(normalized);
  if (governedSkill) {
    return governedSkill;
  }

  if (
    /\b(gws|google workspace|google calendar|calendar)\b/.test(lower) &&
    /\b(read|list|access|event|events|upcoming)\b/.test(lower)
  ) {
    return {
      tool: "calendar_list_events",
      intent: "google_calendar_read",
      args: {
        timeMin: now.toISOString(),
        maxResults: 3,
        singleEvents: true,
        orderBy: "startTime",
      },
    };
  }

  if (/\b(search|web search|citation|citations|source url|source urls|current public)\b/.test(lower)) {
    return {
      tool: "web_search",
      intent: "web_search",
      args: {
        query: normalized.slice(0, 500),
        maxResults: 5,
      },
    };
  }

  return null;
}

export function buildChannelPublishBoundaryAnswer(text: string): string | null {
  const lower = text.toLowerCase();
  if (!/\b(channel|slack|telegram|discord|publish|webhook)\b/.test(lower)) {
    return null;
  }
  return [
    "Channel access is governed by AgentNexus, not by runtime-held channel secrets.",
    "",
    "Use the AgentNexus workspace Publish tab for Channel Publish Webhook Pilot:",
    "- create a draft preview",
    "- review the approval checkpoint",
    "- deliver only after explicit approval",
    "- keep Slack, Telegram, Discord, webhook URLs, and credentials out of this runtime",
    "",
    "I can help draft the message here, but actual channel setup and delivery evidence should stay in AgentNexus Tool Gateway.",
  ].join("\n");
}

export async function resolveAgentNexusRuntimeTextReply(options: {
  text: string;
  now?: Date;
  env?: Record<string, string | undefined>;
  fetchFn?: typeof fetch;
  signal?: AbortSignal;
}): Promise<AgentNexusRuntimeTextReply | null> {
  const channelBoundaryAnswer = buildChannelPublishBoundaryAnswer(options.text);
  if (channelBoundaryAnswer) {
    return {
      adapter: "agentnexus-channel-boundary",
      content: channelBoundaryAnswer,
    };
  }

  const request = resolveAgentNexusRuntimeToolRequest(options.text, options.now);
  if (!request) {
    const directConfig = readAgentNexusRuntimeDirectChatConfig(options.env);
    if (!directConfig) {
      return null;
    }
    return {
      adapter: "agentnexus-direct-openrouter",
      content: await executeAgentNexusRuntimeDirectChat({
        config: directConfig,
        text: options.text,
        fetchFn: options.fetchFn,
        signal: options.signal,
      }),
    };
  }

  const config = readAgentNexusRuntimeToolConfig(options.env);
  if (!config) {
    return {
      adapter: "agentnexus-tool-gateway",
      content: [
        "AgentNexus Tool Gateway is not configured for this runtime.",
        "",
        "Use the AgentNexus Developer Sandbox for Google Workspace, cited search, and other server-side tool checks until this runtime is provisioned with Tool Gateway access.",
      ].join("\n"),
    };
  }

  return {
    adapter: "agentnexus-tool-gateway",
    content: formatAgentNexusRuntimeToolAnswer({
      request,
      result: await executeAgentNexusRuntimeTool({
        config,
        request,
        fetchFn: options.fetchFn,
        signal: options.signal,
      }),
    }),
  };
}

export async function executeAgentNexusRuntimeTool(options: {
  config: AgentNexusRuntimeToolConfig;
  request: AgentNexusRuntimeToolRequest;
  fetchFn?: typeof fetch;
  signal?: AbortSignal;
}): Promise<AgentNexusRuntimeToolResult> {
  const fetchFn = options.fetchFn ?? fetch;
  const boundedSignal = createBoundedSignal(options.signal, 45_000);
  try {
    const response = await fetchFn(options.config.gatewayUrl, {
      method: "POST",
      redirect: "error",
      signal: boundedSignal.signal,
      headers: {
        authorization: `Bearer ${options.config.runtimeToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        tool: options.request.tool,
        args: options.request.args,
      }),
    });
    const body = await response.json().catch(() => ({}));
    return {
      ok: response.ok,
      status: response.status,
      body: body && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : {},
    };
  } catch {
    return {
      ok: false,
      status: 0,
      body: {
        code: "RUNTIME_TOOL_UNAVAILABLE",
        error: "AgentNexus Tool Gateway did not complete before the runtime safety timeout.",
      },
    };
  } finally {
    boundedSignal.cleanup();
  }
}

export async function executeAgentNexusRuntimeDirectChat(options: {
  config: AgentNexusRuntimeDirectChatConfig;
  text: string;
  fetchFn?: typeof fetch;
  signal?: AbortSignal;
}): Promise<string> {
  const fetchFn = options.fetchFn ?? fetch;
  const boundedSignal = createBoundedSignal(options.signal, 45_000);
  try {
    const response = await fetchFn(options.config.apiUrl, {
      method: "POST",
      redirect: "error",
      signal: boundedSignal.signal,
      headers: {
        authorization: `Bearer ${options.config.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: options.config.model,
        messages: [
          {
            role: "system",
            content: [
              "You are the managed OpenClaw runtime for AgentNexus.",
              "Answer the user directly and concisely.",
              "Do not claim direct access to Google Workspace, web search, Slack, Telegram, Discord, secrets, or runtime shell.",
              "Those capabilities are mediated by AgentNexus Tool Gateway or the AgentNexus workspace approval surfaces.",
            ].join(" "),
          },
          {
            role: "user",
            content: options.text.slice(0, 8_000),
          },
        ],
      }),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      return "The managed OpenClaw runtime model endpoint is unavailable. Use the AgentNexus workspace Developer Sandbox for demo-safe tool checks while runtime diagnostics are reviewed.";
    }
    const content = readOpenRouterContent(body);
    return content ||
      "The managed OpenClaw runtime did not return text. Use the AgentNexus workspace Developer Sandbox for this check.";
  } catch {
    return "The managed OpenClaw runtime did not complete before the safety timeout. Use the AgentNexus workspace Developer Sandbox for this check while runtime diagnostics are reviewed.";
  } finally {
    boundedSignal.cleanup();
  }
}

export function formatAgentNexusRuntimeToolAnswer(params: {
  request: AgentNexusRuntimeToolRequest;
  result: AgentNexusRuntimeToolResult;
}): string {
  if (!params.result.ok) {
    const code = typeof params.result.body.code === "string"
      ? params.result.body.code
      : "RUNTIME_TOOL_FAILED";
    const error = typeof params.result.body.error === "string"
      ? params.result.body.error
      : "AgentNexus Tool Gateway could not complete the request.";
    return `AgentNexus Tool Gateway returned ${code}: ${error}`;
  }

  if (params.request.intent === "google_calendar_read") {
    const eventCount = countResultItems(params.result.body);
    const rangeStart = typeof params.request.args.timeMin === "string"
      ? params.request.args.timeMin
      : "now";
    const dateRange = `${rangeStart} to next authorized window`;
    return [
      `event_count: ${eventCount}`,
      `date_range: ${dateRange}`,
      "source: authorized Google Calendar read",
    ].join("\n");
  }

  if (params.request.intent === "governed_skill") {
    const result = readToolResult(params.result.body);
    const record = result && typeof result === "object" && !Array.isArray(result)
      ? result as Record<string, unknown>
      : {};
    const output = record.output && typeof record.output === "object" && !Array.isArray(record.output)
      ? record.output as Record<string, unknown>
      : {};
    const skillStatus = typeof record.skillStatus === "string" ? record.skillStatus : "unknown";
    const skillId = typeof record.skillId === "string"
      ? record.skillId
      : typeof params.request.args.skillId === "string"
        ? params.request.args.skillId
        : "unknown";
    const summary = typeof output.summary === "string" && output.summary.trim()
      ? output.summary.trim()
      : "Governed skill completed without a text summary.";
    return [
      `skill_status: ${skillStatus}`,
      `skill_id: ${skillId}`,
      `summary: ${summary}`,
      "source: AgentNexus governed skills catalog",
    ].join("\n");
  }

  const urls = extractCitationUrls(params.result.body);
  return [
    "Cited web search completed through AgentNexus Tool Gateway.",
    "",
    urls.length > 0
      ? `source_urls:\n${urls.map((url) => `- ${url}`).join("\n")}`
      : "source_urls: none returned",
    "redaction: provider credentials and server-side search keys stay in AgentNexus.",
  ].join("\n");
}

function parseGovernedSkillRequest(text: string): AgentNexusRuntimeToolRequest | null {
  const slashMatch = text.match(/^\/skill\s+([a-z0-9][a-z0-9-]{2,80})(?:\s+([\s\S]*))?$/i);
  if (slashMatch) {
    return {
      tool: "runtime_skill_execute",
      intent: "governed_skill",
      args: {
        skillId: slashMatch[1]?.toLowerCase(),
        input: (slashMatch[2] ?? "").trim(),
      },
    };
  }

  const lower = text.toLowerCase();
  if (/\b(governed skill|runtime skill|demo-summary-style|summary skill|weather skill)\b/.test(lower)) {
    return {
      tool: "runtime_skill_execute",
      intent: "governed_skill",
      args: {
        skillId: lower.includes("weather skill") ? "tool-gateway-redacted-evidence" : "demo-summary-style",
        input: text.slice(0, 1_000),
      },
    };
  }

  return null;
}

function countResultItems(body: Record<string, unknown>) {
  const result = readToolResult(body);
  if (Array.isArray(result)) {
    return result.length;
  }
  if (result && typeof result === "object") {
    const items = (result as { items?: unknown; files?: unknown; values?: unknown }).items ??
      (result as { items?: unknown; files?: unknown; values?: unknown }).files ??
      (result as { items?: unknown; files?: unknown; values?: unknown }).values;
    if (Array.isArray(items)) {
      return items.length;
    }
  }
  return result === null || result === undefined ? 0 : 1;
}

function extractCitationUrls(body: Record<string, unknown>) {
  const result = readToolResult(body);
  const citations = result &&
      typeof result === "object" &&
      Array.isArray((result as { citations?: unknown }).citations)
    ? (result as { citations: unknown[] }).citations
    : [];
  return citations
    .map((citation) => citation && typeof citation === "object"
      ? (citation as { url?: unknown }).url
      : null)
    .filter((url): url is string => typeof url === "string" && /^https?:\/\//.test(url))
    .slice(0, 5);
}

function readToolResult(body: Record<string, unknown>) {
  const data = body.data;
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return undefined;
  }
  return (data as { result?: unknown }).result;
}

function readOpenRouterContent(body: unknown): string | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return null;
  }
  const choices = (body as { choices?: unknown }).choices;
  if (!Array.isArray(choices)) {
    return null;
  }
  for (const choice of choices) {
    if (!choice || typeof choice !== "object" || Array.isArray(choice)) {
      continue;
    }
    const message = (choice as { message?: unknown }).message;
    if (message && typeof message === "object" && !Array.isArray(message)) {
      const content = (message as { content?: unknown }).content;
      if (typeof content === "string" && content.trim()) {
        return content.trim();
      }
    }
  }
  return null;
}

function createBoundedSignal(parent: AbortSignal | undefined, timeoutMs: number) {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(new Error("AgentNexus runtime request timed out"));
  }, timeoutMs);
  const abort = () => {
    controller.abort(parent?.reason);
  };
  if (parent?.aborted) {
    abort();
  } else {
    parent?.addEventListener("abort", abort, { once: true });
  }
  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timer);
      parent?.removeEventListener("abort", abort);
    },
  };
}

function isTruthyEnvValue(value: string | undefined) {
  return /^(1|true|yes|on)$/i.test(value?.trim() ?? "");
}
