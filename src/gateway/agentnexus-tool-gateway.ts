type RuntimeToolName =
  | "web_search"
  | "sheets_read_range"
  | "calendar_list_events"
  | "github_public_repo_read"
  | "runtime_skill_execute";

export type AgentNexusRuntimeToolRequest = {
  tool: RuntimeToolName;
  args: Record<string, unknown>;
  intent: "web_search" | "google_sheets_read" | "google_calendar_read" | "github_public_repo_read" | "governed_skill";
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

  const githubRepoUrl = extractPublicGitHubRepoUrl(normalized);
  if (githubRepoUrl) {
    return {
      tool: "github_public_repo_read",
      intent: "github_public_repo_read",
      args: {
        url: githubRepoUrl,
      },
    };
  }

  const spreadsheetId = extractGoogleSheetsSpreadsheetId(normalized);
  if (spreadsheetId && /\b(read|list|access|summarize|summary|review|inspect|sheet|sheets|spreadsheet|googlesheet|google workspace|gws|write)\b/.test(lower)) {
    return {
      tool: "sheets_read_range",
      intent: "google_sheets_read",
      args: {
        spreadsheetId,
        range: "A1:Z20",
        majorDimension: "ROWS",
        requestedWrite: /\b(write|edit|update|append|change|modify)\b/.test(lower),
      },
    };
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
  conversationText?: string;
}): Promise<AgentNexusRuntimeTextReply | null> {
  const channelBoundaryAnswer = buildChannelPublishBoundaryAnswer(options.text);
  if (channelBoundaryAnswer) {
    return {
      adapter: "agentnexus-channel-boundary",
      content: channelBoundaryAnswer,
    };
  }

  const previousSearchSummary = buildPreviousSearchSummaryReply(options.text, options.conversationText);
  if (previousSearchSummary) {
    return {
      adapter: "agentnexus-tool-gateway",
      content: previousSearchSummary,
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

  if (params.request.intent === "google_sheets_read") {
    return formatGoogleSheetsReadAnswer(params.result.body, params.request.args);
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
      "redacted: true",
    ].join("\n");
  }

  if (params.request.intent === "github_public_repo_read") {
    return formatGitHubPublicRepoReadAnswer(params.result.body);
  }

  const citationItems = extractCitationItems(params.result.body);
  return [
    "Cited web search completed through AgentNexus Tool Gateway.",
    "",
    citationItems.length > 0
      ? citationItems.map((item, index) => [
        `${index + 1}. ${item.title}`,
        `brief_summary: ${item.snippet}`,
        `source_url: ${item.url}`,
      ].join("\n")).join("\n\n")
      : "source_urls: none returned",
    "redaction: provider credentials and server-side search keys stay in AgentNexus.",
  ].join("\n");
}

export function extractAgentNexusRuntimeConversationText(messages: unknown[]): string {
  return messages
    .map((message) => {
      if (!message || typeof message !== "object" || Array.isArray(message)) {
        return "";
      }
      const record = message as Record<string, unknown>;
      const role = typeof record.role === "string" ? record.role : "message";
      const text = typeof record.text === "string"
        ? record.text
        : typeof record.message === "string"
          ? record.message
          : extractTextFromContent(record.content);
      return text.trim() ? `${role}: ${text.trim()}` : "";
    })
    .filter(Boolean)
    .slice(-8)
    .join("\n\n")
    .slice(-8_000);
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

function readToolResult(body: Record<string, unknown>) {
  const data = body.data;
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return undefined;
  }
  return (data as { result?: unknown }).result;
}

function extractCitationItems(body: Record<string, unknown>) {
  const result = readToolResult(body);
  const citations = result &&
      typeof result === "object" &&
      Array.isArray((result as { citations?: unknown }).citations)
    ? (result as { citations: unknown[] }).citations
    : [];
  return citations
    .map((citation) => {
      if (!citation || typeof citation !== "object") {
        return null;
      }
      const record = citation as { title?: unknown; url?: unknown; snippet?: unknown };
      if (typeof record.url !== "string" || !/^https?:\/\//.test(record.url)) {
        return null;
      }
      return {
        title: sanitizeOneLine(typeof record.title === "string" && record.title.trim()
          ? record.title
          : record.url, 160),
        url: record.url,
        snippet: sanitizeOneLine(typeof record.snippet === "string" && record.snippet.trim()
          ? record.snippet
          : "No summary returned by the search provider.", 280),
      };
    })
    .filter((item): item is { title: string; url: string; snippet: string } => item !== null)
    .slice(0, 5);
}

function formatGitHubPublicRepoReadAnswer(body: Record<string, unknown>) {
  const result = readToolResult(body);
  const record = result && typeof result === "object" && !Array.isArray(result)
    ? result as Record<string, unknown>
    : {};
  const repo = typeof record.repo === "string" ? record.repo : "unknown";
  const description = typeof record.description === "string" && record.description.trim()
    ? sanitizeOneLine(record.description, 280)
    : "No repository description returned.";
  const readme = record.readme && typeof record.readme === "object" && !Array.isArray(record.readme)
    ? record.readme as Record<string, unknown>
    : {};
  const readmePath = typeof readme.path === "string" ? readme.path : "README.md";
  const readmeExcerpt = typeof readme.excerpt === "string" && readme.excerpt.trim()
    ? readme.excerpt.trim().slice(0, 1_200)
    : "No README excerpt returned.";
  const fileEvidence = Array.isArray(record.fileEvidence)
    ? record.fileEvidence.filter((item): item is string => typeof item === "string").slice(0, 5)
    : [];
  return [
    "Public GitHub repo read completed through AgentNexus Tool Gateway.",
    "",
    `repo: ${repo}`,
    `description: ${description}`,
    `file_evidence: ${fileEvidence.length ? fileEvidence.join(", ") : readmePath}`,
    `readme_excerpt: ${readmeExcerpt}`,
    "redaction: GitHub credentials and runtime-held GitHub tokens are not exposed.",
  ].join("\n");
}

function formatGoogleSheetsReadAnswer(body: Record<string, unknown>, args: Record<string, unknown>) {
  const result = readToolResult(body);
  const record = result && typeof result === "object" && !Array.isArray(result)
    ? result as Record<string, unknown>
    : {};
  const range = typeof record.range === "string" && record.range.trim()
    ? sanitizeOneLine(record.range, 120)
    : typeof args.range === "string"
      ? sanitizeOneLine(args.range, 120)
      : "A1:Z20";
  const rowCount = typeof record.rowCount === "number" ? record.rowCount : 0;
  const columnCount = typeof record.columnCount === "number" ? record.columnCount : 0;
  const headers = Array.isArray(record.headers)
    ? record.headers.filter((item): item is string => typeof item === "string" && item.trim()).slice(0, 8)
    : [];
  const previewRows = Array.isArray(record.previewRows)
    ? record.previewRows
      .filter((row): row is unknown[] => Array.isArray(row))
      .slice(0, 5)
      .map((row) => row
        .filter((item): item is string => typeof item === "string")
        .slice(0, 8)
        .map((item) => sanitizeOneLine(item, 120)))
    : [];
  const requestedWrite = args.requestedWrite === true;
  return [
    "Google Sheets read completed through AgentNexus Tool Gateway.",
    "",
    "source: authorized Google Sheets read",
    `range: ${range}`,
    `row_count: ${rowCount}`,
    `column_count: ${columnCount}`,
    headers.length ? `headers: ${headers.map((item) => sanitizeOneLine(item, 80)).join(", ")}` : "headers: none returned",
    previewRows.length
      ? [
        "preview:",
        ...previewRows.map((row) => `- ${row.join(" | ")}`),
      ].join("\n")
      : "preview: none returned",
    requestedWrite
      ? "Google Sheets write was not executed. Write actions require AgentNexus approval."
      : "write_boundary: read-only runtime request; no write executed",
    "redaction: Google OAuth tokens and raw Google payloads stay in AgentNexus.",
  ].join("\n");
}

function buildPreviousSearchSummaryReply(text: string, conversationText: string | undefined) {
  if (!/\b(summarize|summary|recap|what did (you|we) find|those results|the results|the news)\b/i.test(text)) {
    return null;
  }
  if (!conversationText || !/Cited web search completed through AgentNexus Tool Gateway/i.test(conversationText)) {
    return null;
  }
  const previousSearch = conversationText
    .split(/Cited web search completed through AgentNexus Tool Gateway\./i)
    .at(-1);
  if (!previousSearch) {
    return null;
  }
  const items = extractFormattedSearchItems(previousSearch);
  if (items.length === 0) {
    return null;
  }
  return [
    "Summary of previous Tool Gateway search results:",
    "",
    items.map((item, index) => `${index + 1}. ${item.title}: ${item.summary} (${item.url})`).join("\n"),
    "",
    "source: previous redacted AgentNexus Tool Gateway web_search result",
  ].join("\n");
}

function extractFormattedSearchItems(text: string) {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const items: Array<{ title: string; summary: string; url: string }> = [];
  for (let index = 0; index < lines.length; index += 1) {
    const titleMatch = lines[index]?.match(/^\d+\.\s+(.+)$/);
    if (!titleMatch) continue;
    const summaryLine = lines[index + 1] ?? "";
    const urlLine = lines[index + 2] ?? "";
    const summary = summaryLine.replace(/^brief_summary:\s*/i, "").trim();
    const url = urlLine.replace(/^source_url:\s*/i, "").trim();
    if (!summary || !/^https?:\/\//i.test(url)) continue;
    items.push({
      title: sanitizeOneLine(titleMatch[1], 160),
      summary: sanitizeOneLine(summary, 280),
      url,
    });
  }
  return items.slice(0, 5);
}

function extractPublicGitHubRepoUrl(text: string) {
  const match = text.match(/https:\/\/(?:www\.)?github\.com\/[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}(?:[/?#][^\s)]*)?/i);
  if (!match) {
    return null;
  }
  try {
    const parsed = new URL(match[0].replace(/[.,，。!?！？\])}>]+$/u, ""));
    if (parsed.protocol !== "https:" || !["github.com", "www.github.com"].includes(parsed.hostname.toLowerCase())) {
      return null;
    }
    const [owner, repo] = parsed.pathname.replace(/^\/+|\/+$/g, "").split("/");
    if (!owner || !repo) {
      return null;
    }
    return `https://github.com/${owner}/${repo}`;
  } catch {
    return null;
  }
}

function extractGoogleSheetsSpreadsheetId(text: string) {
  const match = text.match(/https:\/\/docs\.google\.com\/spreadsheets\/d\/([A-Za-z0-9_-]{20,})(?:[/?#][^\s)]*)?/i);
  return match?.[1] ?? null;
}

function extractTextFromContent(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .map((part) => {
      if (!part || typeof part !== "object" || Array.isArray(part)) {
        return "";
      }
      const text = (part as { text?: unknown; input_text?: unknown }).text ??
        (part as { input_text?: unknown }).input_text;
      return typeof text === "string" ? text : "";
    })
    .filter(Boolean)
    .join("\n");
}

function sanitizeOneLine(value: string, limit: number) {
  return value.replace(/\s+/g, " ").trim().slice(0, limit);
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
