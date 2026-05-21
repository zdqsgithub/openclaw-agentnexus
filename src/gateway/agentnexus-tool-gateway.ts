type RuntimeToolName = "web_search" | "calendar_list_events";

export type AgentNexusRuntimeToolRequest = {
  tool: RuntimeToolName;
  args: Record<string, unknown>;
  intent: "web_search" | "google_calendar_read";
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

export function resolveAgentNexusRuntimeToolRequest(
  text: string,
  now: Date = new Date(),
): AgentNexusRuntimeToolRequest | null {
  const normalized = text.trim();
  const lower = normalized.toLowerCase();
  if (!normalized) {
    return null;
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

export async function executeAgentNexusRuntimeTool(options: {
  config: AgentNexusRuntimeToolConfig;
  request: AgentNexusRuntimeToolRequest;
  fetchFn?: typeof fetch;
  signal?: AbortSignal;
}): Promise<AgentNexusRuntimeToolResult> {
  const fetchFn = options.fetchFn ?? fetch;
  const response = await fetchFn(options.config.gatewayUrl, {
    method: "POST",
    redirect: "error",
    signal: options.signal,
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
    const dateRange = `${String(params.request.args.timeMin ?? "now")} to next authorized window`;
    return [
      "Authorized Google Calendar read completed through AgentNexus Tool Gateway.",
      "",
      `event_count: ${eventCount}`,
      `date_range: ${dateRange}`,
      "source: authorized Google Calendar read",
      "redaction: event titles, attendees, emails, locations, links, descriptions, and document contents are not shown in runtime chat.",
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
