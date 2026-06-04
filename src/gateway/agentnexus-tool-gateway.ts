type RuntimeToolName =
  | "web_search"
  | "sheets_read_range"
  | "sheets_get_metadata"
  | "calendar_list_events"
  | "github_public_repo_read"
  | "runtime_skill_execute"
  | "runtime_cron_request"
  | "channel_publish_preview"
  | "runtime_session_export";

const GOOGLE_SHEETS_METADATA_FIELDS = "spreadsheetId,properties.title,sheets.properties";
export const AGENTNEXUS_RUNTIME_TOOL_GATEWAY_BUILD_MARKER =
  "gws-session-lease-v6-read-lease-execution-attempt-20260604";
const AGENTNEXUS_GWS_SESSION_LEASE_DIAGNOSTIC_PROMPT = [
  "Use AgentNexus Tool Gateway action sheets_read_range for the same Google Sheet in this same runtime session.",
  "https://docs.google.com/spreadsheets/d/1-fgOfxIyWxAirwmfuphvBUG31kVyW54ytvLUNW4yeFg/edit?gid=0#gid=0",
  "Return redacted metadata only with source, range, rowCount, and columnCount.",
  "Use the existing same-resource session read lease when eligible; do not ask for a second acknowledgement.",
].join("\n");
const AGENTNEXUS_GWS_GENERAL_FOLLOW_UP_DIAGNOSTIC_PROMPT =
  "what is this googlesheet contain? give me a detailed summary";
const AGENTNEXUS_GWS_SESSION_LEASE_DIAGNOSTIC_CONTEXT = [
  "user: Use AgentNexus Tool Gateway action sheets_get_metadata for this authorized or link-readable Google Sheet.",
  "user: https://docs.google.com/spreadsheets/d/1-fgOfxIyWxAirwmfuphvBUG31kVyW54ytvLUNW4yeFg/edit?gid=0#gid=0",
  "assistant:",
  "source: public Google Sheets metadata",
  "resultType: spreadsheet_metadata",
  "sheetCount: 1",
  "rowCountMax: 50",
  "columnCountMax: 20",
].join("\n");

export type AgentNexusRuntimeToolRequest = {
  tool: RuntimeToolName;
  args: Record<string, unknown>;
  intent:
    | "web_search"
    | "google_sheets_read"
    | "google_calendar_read"
    | "github_public_repo_read"
    | "governed_skill"
    | "runtime_cron_request"
    | "channel_publish_preview"
    | "runtime_session_export";
};

export type AgentNexusRuntimeToolConfig = {
  gatewayUrl: string;
  manifestUrl?: string;
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

export type AgentNexusRuntimeRiskDisclosure = {
  riskTier?: string;
  warningMode?: string;
  acknowledgementSurface?: string;
  userAcknowledgementRequired?: boolean;
  riskFeeBillingState?: string;
  disclaimer?: string;
  hardBlockAfterAcknowledgement?: boolean;
};

type AgentNexusRuntimeRiskWarningUi = {
  component: "native_tool_warning_ack_modal";
  title?: string;
  riskTier?: string;
  toolId?: string;
  actionLabel?: string;
  acknowledgementPhrase?: string;
  disclaimer?: string;
  riskFeeBillingState?: string;
  redacted: true;
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
  const manifestUrl = env.AGENTNEXUS_TOOL_MANIFEST_URL?.trim();
  const runtimeToken = env.AGENTNEXUS_RUNTIME_TOKEN?.trim();
  if (!gatewayUrl || !runtimeToken) {
    return null;
  }
  return { gatewayUrl, ...(manifestUrl ? { manifestUrl } : {}), runtimeToken };
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
  const governedCron = parseGovernedCronRequest(normalized);
  if (governedCron) {
    return governedCron;
  }
  const channelPublishPreview = parseChannelPublishPreviewRequest(normalized);
  if (channelPublishPreview) {
    return channelPublishPreview;
  }
  const sessionExport = parseRuntimeSessionExportRequest(normalized);
  if (sessionExport) {
    return sessionExport;
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
  if (spreadsheetId && isGoogleSheetsMetadataRequest(lower)) {
    return {
      tool: "sheets_get_metadata",
      intent: "google_sheets_read",
      args: {
        spreadsheetId,
        fields: GOOGLE_SHEETS_METADATA_FIELDS,
      },
    };
  }
  if (spreadsheetId && /\b(read|list|access|summarize|summary|review|inspect|sheet|sheets|spreadsheet|googlesheet|google workspace|gws|write)\b/.test(lower)) {
    const intentText = stripUrlsForIntent(lower);
    return {
      tool: "sheets_read_range",
      intent: "google_sheets_read",
      args: {
        spreadsheetId,
        range: "Sheet1!A1:Z20",
        majorDimension: "ROWS",
        requestedWrite: isGoogleSheetsMutationIntent(intentText),
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

function isGoogleSheetsMetadataRequest(lowerText: string) {
  if (/\bsheets_get_metadata\b/.test(lowerText) || /\bspreadsheet_metadata\b/.test(lowerText)) {
    return true;
  }
  if (/\b(sheetcount|sheet count|rowcountmax|row count max|columncountmax|column count max|sheets\.properties)\b/.test(lowerText)) {
    return true;
  }
  return /\bmetadata\b/.test(lowerText) &&
    /\b(sheet|sheets|spreadsheet|googlesheet|google sheet)\b/.test(lowerText) &&
    !/\b(source|range|rowcount|columncount)\b/.test(lowerText);
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
  const previousGoogleSheetsReply = buildPreviousGoogleSheetsFollowUpReply(options.text, options.conversationText);
  if (previousGoogleSheetsReply) {
    return {
      adapter: "agentnexus-tool-gateway",
      content: previousGoogleSheetsReply,
    };
  }

  const previousSearchSummary = buildPreviousSearchSummaryReply(options.text, options.conversationText);
  if (previousSearchSummary) {
    return {
      adapter: "agentnexus-tool-gateway",
      content: previousSearchSummary,
    };
  }

  const previousGitHubRepoPlan = buildPreviousGitHubRepoPlanReply(options.text, options.conversationText);
  if (previousGitHubRepoPlan) {
    return {
      adapter: "agentnexus-tool-gateway",
      content: previousGitHubRepoPlan,
    };
  }

  const request = resolveAcknowledgedRuntimeToolRequest({
    text: options.text,
    conversationText: options.conversationText,
    now: options.now,
  }) ?? resolveAgentNexusRuntimeToolRequest(options.text, options.now)
    ?? resolvePreviousGoogleSheetsReadRangeRequest({
      text: options.text,
      conversationText: options.conversationText,
    });
  const channelBoundaryAnswer = request ? null : buildChannelPublishBoundaryAnswer(options.text);
  if (channelBoundaryAnswer) {
    return {
      adapter: "agentnexus-channel-boundary",
      content: channelBoundaryAnswer,
    };
  }
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

  const runtimeRiskAcknowledged = hasRuntimeRiskAcknowledgement(options.text);
  const canAttemptSessionLeaseExecution = canAttemptRuntimeSessionLeaseExecution({
    request,
    text: options.text,
    conversationText: options.conversationText,
  });
  const riskDisclosure = canAttemptSessionLeaseExecution
    ? null
    : await fetchAgentNexusRuntimeRiskDisclosure({
      config,
      request,
      fetchFn: options.fetchFn,
      signal: options.signal,
    });
  if (
    requiresRuntimeAcknowledgement(riskDisclosure) &&
    !runtimeRiskAcknowledged &&
    !canAttemptSessionLeaseExecution
  ) {
    return {
      adapter: "agentnexus-tool-gateway",
      content: formatRuntimeAcknowledgementPrompt(request, riskDisclosure),
    };
  }
  const executableRequest = runtimeRiskAcknowledged
    ? withRuntimeRiskAcknowledgement(request)
    : request;

  return {
    adapter: "agentnexus-tool-gateway",
    content: formatAgentNexusRuntimeToolAnswer({
      request: executableRequest,
      riskDisclosure,
      result: await executeAgentNexusRuntimeTool({
        config,
        request: executableRequest,
        fetchFn: options.fetchFn,
        signal: options.signal,
      }),
    }),
  };
}

function resolveAcknowledgedRuntimeToolRequest(options: {
  text: string;
  conversationText?: string;
  now?: Date;
}): AgentNexusRuntimeToolRequest | null {
  if (!hasRuntimeRiskAcknowledgement(options.text)) {
    return null;
  }
  const acknowledgedTool = readAcknowledgedRuntimeToolName(options.text);
  if (!acknowledgedTool) {
    return null;
  }
  const acknowledgedWebSearchQuery = acknowledgedTool === "web_search"
    ? readAcknowledgedWebSearchQuery(options.text)
    : null;
  if (acknowledgedWebSearchQuery) {
    return {
      tool: "web_search",
      intent: "web_search",
      args: {
        query: acknowledgedWebSearchQuery,
        maxResults: 5,
      },
    };
  }
  const acknowledgedChannelPublishDraft = acknowledgedTool === "channel_publish_preview"
    ? readAcknowledgedChannelPublishDraft(options.text)
    : null;
  if (acknowledgedChannelPublishDraft) {
    return {
      tool: "channel_publish_preview",
      intent: "channel_publish_preview",
      args: {
        channelType: "webhook",
        draft: acknowledgedChannelPublishDraft,
      },
    };
  }
  const acknowledgedGoogleSheetsRequest = acknowledgedTool === "sheets_read_range"
    ? readAcknowledgedGoogleSheetsRequest(options.text)
    : null;
  if (acknowledgedGoogleSheetsRequest) {
    return acknowledgedGoogleSheetsRequest;
  }
  const acknowledgedGoogleSheetsMetadataRequest = acknowledgedTool === "sheets_get_metadata"
    ? readAcknowledgedGoogleSheetsMetadataRequest(options.text)
    : null;
  if (acknowledgedGoogleSheetsMetadataRequest) {
    return acknowledgedGoogleSheetsMetadataRequest;
  }
  if (!options.conversationText) {
    return null;
  }
  const priorUserMessages = extractPriorRuntimeUserMessages(options.conversationText);
  for (const message of priorUserMessages.toReversed()) {
    const request = resolveAgentNexusRuntimeToolRequest(message, options.now);
    if (request?.tool === acknowledgedTool) {
      return request;
    }
  }
  return null;
}

function readAcknowledgedWebSearchQuery(text: string): string | null {
  const match = text.match(/\brun\s+web_search\s+for:\s*([\s\S]+)$/i);
  const query = sanitizeOneLine(match?.[1] ?? "", 500);
  return query || null;
}

function readAcknowledgedChannelPublishDraft(text: string): { title: string; body: string; summary: string } | null {
  const match = text.match(/\brun\s+channel_publish_preview\s+for:\s*([\s\S]+)$/i);
  const payload = match?.[1] ?? "";
  const title = readAcknowledgedField(payload, "title", 120) || "AgentC governed channel relay notification";
  const summary = readAcknowledgedField(payload, "summary", 180) || "Synthetic AgentC channel relay notification.";
  const bodyMarker = readAcknowledgedField(payload, "body", 80);
  if (!title && !summary && !bodyMarker) {
    return null;
  }
  return {
    title,
    body: "Redacted channel relay body omitted from acknowledgement phrase.",
    summary,
  };
}

function readAcknowledgedGoogleSheetsRequest(text: string): AgentNexusRuntimeToolRequest | null {
  const match = text.match(/\brun\s+sheets_read_range\s+for:\s*([\s\S]+)$/i);
  const payload = match?.[1] ?? "";
  if (!payload.trim()) {
    return null;
  }
  const spreadsheetInput = readAcknowledgedField(payload, "spreadsheet", 180) ||
    readAcknowledgedField(payload, "spreadsheetId", 120) ||
    readAcknowledgedField(payload, "url", 240);
  const spreadsheetId = spreadsheetInput
    ? extractGoogleSheetsSpreadsheetId(spreadsheetInput) || sanitizeGoogleSheetsSpreadsheetId(spreadsheetInput)
    : null;
  if (!spreadsheetId) {
    return null;
  }
  const range = readAcknowledgedField(payload, "range", 120) || "Sheet1!A1:Z20";
  return {
    tool: "sheets_read_range",
    intent: "google_sheets_read",
    args: {
      spreadsheetId,
      range,
      majorDimension: "ROWS",
      requestedWrite: /\brequestedWrite\s*=\s*true\b/i.test(payload),
    },
  };
}

function readAcknowledgedGoogleSheetsMetadataRequest(text: string): AgentNexusRuntimeToolRequest | null {
  const match = text.match(/\brun\s+sheets_get_metadata\s+for:\s*([\s\S]+)$/i);
  const payload = match?.[1] ?? "";
  if (!payload.trim()) {
    return null;
  }
  const spreadsheetInput = readAcknowledgedField(payload, "spreadsheet", 180) ||
    readAcknowledgedField(payload, "spreadsheetId", 120) ||
    readAcknowledgedField(payload, "url", 240);
  const spreadsheetId = spreadsheetInput
    ? extractGoogleSheetsSpreadsheetId(spreadsheetInput) || sanitizeGoogleSheetsSpreadsheetId(spreadsheetInput)
    : null;
  if (!spreadsheetId) {
    return null;
  }
  const fields = readAcknowledgedField(payload, "fields", 240) || GOOGLE_SHEETS_METADATA_FIELDS;
  return {
    tool: "sheets_get_metadata",
    intent: "google_sheets_read",
    args: {
      spreadsheetId,
      fields,
    },
  };
}

function readAcknowledgedField(payload: string, name: string, maxLength: number) {
  const match = payload.match(new RegExp(`(?:^|;)\\s*${escapeRegExp(name)}\\s*=\\s*([^;]+)`, "i"));
  return sanitizeOneLine(match?.[1] ?? "", maxLength);
}

function readAcknowledgedRuntimeToolName(text: string): RuntimeToolName | null {
  const match = text.match(/\brun\s+([a-z0-9_:-]+)\b/i);
  const toolName = match?.[1]?.toLowerCase();
  if (
    toolName === "web_search" ||
    toolName === "calendar_list_events" ||
    toolName === "sheets_read_range" ||
    toolName === "sheets_get_metadata" ||
    toolName === "github_public_repo_read" ||
    toolName === "channel_publish_preview" ||
    toolName === "runtime_skill_execute" ||
    toolName === "runtime_cron_request" ||
    toolName === "runtime_session_export"
  ) {
    return toolName;
  }
  return null;
}

function extractPriorRuntimeUserMessages(conversationText: string): string[] {
  const messages: string[] = [];
  let currentRole: string | null = null;
  let currentLines: string[] = [];

  const flush = () => {
    if (currentRole === "user") {
      const message = currentLines.join("\n").trim();
      if (message) {
        messages.push(message);
      }
    }
    currentRole = null;
    currentLines = [];
  };

  for (const line of conversationText.split(/\r?\n/)) {
    const roleMatch = line.match(/^(user|assistant|system|tool):\s*(.*)$/i);
    if (roleMatch) {
      flush();
      currentRole = roleMatch[1]?.toLowerCase() ?? null;
      currentLines = [roleMatch[2] ?? ""];
      continue;
    }
    if (currentRole) {
      currentLines.push(line);
    }
  }
  flush();

  return messages
    .map((message) => message.trim())
    .filter((message) => message && !hasRuntimeRiskAcknowledgement(message))
    .slice(-8);
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
  riskDisclosure?: AgentNexusRuntimeRiskDisclosure | null;
  result: AgentNexusRuntimeToolResult;
}): string {
  if (!params.result.ok) {
    const code = typeof params.result.body.code === "string"
      ? params.result.body.code
      : "RUNTIME_TOOL_FAILED";
    const runtimeUi = code === "RUNTIME_TOOL_RISK_ACK_REQUIRED"
      ? readRuntimeRiskWarningUi(params.result.body)
      : null;
    if (runtimeUi) {
      return formatRuntimeAcknowledgementPrompt(
        params.request,
        runtimeUiToRiskDisclosure(runtimeUi),
        runtimeUi.acknowledgementPhrase,
      );
    }
    const error = typeof params.result.body.error === "string"
      ? params.result.body.error
      : "AgentNexus Tool Gateway could not complete the request.";
    return `AgentNexus Tool Gateway returned ${code}: ${error}`;
  }

  const riskDisclosurePrefix = formatRuntimeRiskDisclosureBlock(params.riskDisclosure);

  if (params.request.intent === "google_calendar_read") {
    const eventCount = countResultItems(params.result.body);
    const rangeStart = typeof params.request.args.timeMin === "string"
      ? params.request.args.timeMin
      : "now";
    const dateRange = `${rangeStart} to next authorized window`;
    return withRiskDisclosurePrefix(riskDisclosurePrefix, [
      `event_count: ${eventCount}`,
      `date_range: ${dateRange}`,
      "source: authorized Google Calendar read",
    ].join("\n"));
  }

  if (params.request.intent === "google_sheets_read") {
    if (params.request.tool === "sheets_get_metadata") {
      return withRiskDisclosurePrefix(
        riskDisclosurePrefix,
        formatGoogleSheetsMetadataAnswer(params.result.body),
      );
    }
    return withRiskDisclosurePrefix(
      riskDisclosurePrefix,
      formatGoogleSheetsReadAnswer(params.result.body, params.request.args),
    );
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
    return withRiskDisclosurePrefix(riskDisclosurePrefix, [
      `skill_status: ${skillStatus}`,
      `skill_id: ${skillId}`,
      `summary: ${summary}`,
      "source: AgentNexus governed skills catalog",
      "redacted: true",
    ].join("\n"));
  }

  if (params.request.intent === "github_public_repo_read") {
    return withRiskDisclosurePrefix(riskDisclosurePrefix, formatGitHubPublicRepoReadAnswer(params.result.body));
  }

  if (params.request.intent === "runtime_cron_request") {
    return withRiskDisclosurePrefix(
      riskDisclosurePrefix,
      formatRuntimeCronRequestAnswer(params.result.body, params.request.args),
    );
  }

  if (params.request.intent === "channel_publish_preview") {
    return withRiskDisclosurePrefix(riskDisclosurePrefix, formatChannelPublishPreviewAnswer(params.result.body));
  }

  if (params.request.intent === "runtime_session_export") {
    return withRiskDisclosurePrefix(riskDisclosurePrefix, formatRuntimeSessionExportAnswer(params.result.body));
  }

  const citationItems = extractCitationItems(params.result.body);
  return withRiskDisclosurePrefix(riskDisclosurePrefix, [
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
  ].join("\n"));
}

export async function fetchAgentNexusRuntimeRiskDisclosure(options: {
  config: AgentNexusRuntimeToolConfig;
  request: AgentNexusRuntimeToolRequest;
  fetchFn?: typeof fetch;
  signal?: AbortSignal;
}): Promise<AgentNexusRuntimeRiskDisclosure | null> {
  if (!options.config.manifestUrl) {
    return null;
  }
  const fetchFn = options.fetchFn ?? fetch;
  const boundedSignal = createBoundedSignal(options.signal, 15_000);
  try {
    const response = await fetchFn(options.config.manifestUrl, {
      method: "GET",
      redirect: "error",
      signal: boundedSignal.signal,
      headers: {
        authorization: `Bearer ${options.config.runtimeToken}`,
        accept: "application/json",
      },
    });
    if (!response.ok) {
      return null;
    }
    const body = await response.json().catch(() => ({}));
    return findRuntimeToolRiskDisclosure(body, options.request.tool);
  } catch {
    return null;
  } finally {
    boundedSignal.cleanup();
  }
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
  if (
    /\bruntime_skill_execute\b/.test(lower) &&
    /\b(i acknowledge|acknowledge|i confirm|confirm|approved|proceed)\b/.test(lower) &&
    /\b(agentc native risk|native risk|risk disclosure|tool risk)\b/.test(lower)
  ) {
    return {
      tool: "runtime_skill_execute",
      intent: "governed_skill",
      args: {
        skillId: readGovernedSkillId(text) ?? "demo-summary-style",
        input: text.slice(0, 1_000),
      },
    };
  }

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

function readGovernedSkillId(text: string): string | null {
  const match = text.match(/\bskill[_\s-]?id\b[:\s]+`?([a-z0-9][a-z0-9-]{2,80})`?/i);
  return match?.[1]?.toLowerCase() ?? null;
}

function parseGovernedCronRequest(text: string): AgentNexusRuntimeToolRequest | null {
  const lower = text.toLowerCase();
  const mentionsCron = lower.includes("runtime_cron_request") ||
    /\b(cron|scheduled|schedule|monitoring|recurring)\b/.test(lower);
  const asksToCreate = /\b(create|set up|setup|preview|request|schedule|run|execute|continue|acknowledge|confirm|proceed)\b/.test(lower);
  if (!mentionsCron || !asksToCreate) {
    return null;
  }

  const scheduleKind = /\b(web_search|search|tool gateway|read-only|read only)\b/.test(lower)
    ? "tool_gateway_read"
    : "scheduled_prompt";
  const cronExpression = "0 15 * * 1";
  const timezone = "UTC";
  const retryLimit = readBoundedIntegerAfter(lower, /retry limit\s+(\d+)/i, 1, 0, 3);
  const costCapCents = readBoundedIntegerAfter(lower, /cost cap\s+(\d+)/i, 25, 1, 500);

  if (scheduleKind === "tool_gateway_read") {
    return {
      tool: "runtime_cron_request",
      intent: "runtime_cron_request",
      args: {
        scheduleKind,
        toolId: "web_search",
        actionId: "web_search",
        cronExpression,
        timezone,
        costCapCents,
        retryLimit,
      },
    };
  }

  return {
    tool: "runtime_cron_request",
    intent: "runtime_cron_request",
    args: {
      scheduleKind,
      cronExpression,
      timezone,
      costCapCents,
      retryLimit,
      prompt: text.slice(0, 1_000),
    },
  };
}

function parseChannelPublishPreviewRequest(text: string): AgentNexusRuntimeToolRequest | null {
  const lower = text.toLowerCase();
  const explicitPreview = /\bchannel_publish_preview\b/.test(lower) ||
    (/\b(channel relay|channel publish|webhook)\b/.test(lower) && /\b(preview|draft preview|relay notification)\b/.test(lower));
  if (!explicitPreview) {
    return null;
  }

  return {
    tool: "channel_publish_preview",
    intent: "channel_publish_preview",
    args: {
      channelType: "webhook",
      draft: {
        title: readPromptField(text, "Draft title") || "AgentC governed channel relay notification",
        body: readPromptField(text, "Draft body") || "Redacted synthetic channel relay notification.",
        summary: readPromptField(text, "Draft summary") || "Synthetic AgentC channel relay notification.",
      },
    },
  };
}

function parseRuntimeSessionExportRequest(text: string): AgentNexusRuntimeToolRequest | null {
  const lower = text.toLowerCase();
  const explicitExport = /\bruntime_session_export\b/.test(lower) ||
    (
      /\b(workspace-file-report-generation|workspace report|report artifact|session export|repo_safe_metadata|runtimeSessionExportEvidence)\b/i.test(text) &&
      /\b(export|report|artifact|scanner|repo-safe|repo safe|metadata_only_after_scan)\b/.test(lower)
    );
  if (!explicitExport) {
    return null;
  }

  return {
    tool: "runtime_session_export",
    intent: "runtime_session_export",
    args: {
      sourceWorkflow: "workspace-file-report-generation",
      reportTitle: "Report artifact generated in AgentC Runtime",
    },
  };
}

function readPromptField(text: string, label: string) {
  const match = text.match(new RegExp(`${escapeRegExp(label)}:\\s*([\\s\\S]*?)(?=\\s+Draft\\s+(?:title|body|summary):|\\s+Return\\b|\\s+Do not\\b|$)`, "i"));
  return sanitizeOneLine((match?.[1] ?? "").replace(/[.。]\s*$/u, ""), 240);
}

function readBoundedIntegerAfter(
  text: string,
  pattern: RegExp,
  fallback: number,
  min: number,
  max: number,
) {
  const match = text.match(pattern);
  const value = match?.[1] ? Number.parseInt(match[1], 10) : Number.NaN;
  return Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
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

function readRuntimeSessionGovernance(body: Record<string, unknown>) {
  const data = body.data;
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return null;
  }
  const governance = (data as { sessionGovernance?: unknown }).sessionGovernance;
  return governance && typeof governance === "object" && !Array.isArray(governance)
    ? governance as Record<string, unknown>
    : null;
}

function findRuntimeToolRiskDisclosure(
  body: unknown,
  toolName: RuntimeToolName,
): AgentNexusRuntimeRiskDisclosure | null {
  const manifest = readRuntimeManifest(body);
  if (!manifest) {
    return null;
  }
  const tools = Array.isArray(manifest.tools) ? manifest.tools : [];
  const tool = tools.find((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      return false;
    }
    const name = (entry as { name?: unknown; id?: unknown }).name ?? (entry as { id?: unknown }).id;
    return name === toolName;
  });
  if (tool && typeof tool === "object" && !Array.isArray(tool)) {
    const disclosure = (tool as { riskDisclosure?: unknown }).riskDisclosure;
    if (isRiskDisclosureRecord(disclosure)) {
      return normalizeRuntimeRiskDisclosure(disclosure);
    }
  }
  const governance = manifest.governance;
  if (governance && typeof governance === "object" && !Array.isArray(governance)) {
    const disclosure = (governance as { riskDisclosure?: unknown }).riskDisclosure;
    if (isRiskDisclosureRecord(disclosure)) {
      return normalizeRuntimeRiskDisclosure(disclosure);
    }
  }
  return null;
}

function readRuntimeRiskWarningUi(body: Record<string, unknown>): AgentNexusRuntimeRiskWarningUi | null {
  const candidates = [
    body.runtimeUi,
    readNestedRuntimeUi(body.riskWarning),
    readNestedRuntimeUi(body.responseSummary),
    readNestedRuntimeUi(body.data),
  ];
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
      continue;
    }
    const record = candidate as Record<string, unknown>;
    if (record.component !== "native_tool_warning_ack_modal" || record.redacted !== true) {
      continue;
    }
    const riskFeePreview = record.riskFeePreview &&
        typeof record.riskFeePreview === "object" &&
        !Array.isArray(record.riskFeePreview)
      ? record.riskFeePreview as Record<string, unknown>
      : {};
    const acknowledgementPhrase = typeof record.acknowledgementPhrase === "string"
      ? sanitizeOneLine(record.acknowledgementPhrase, 600)
      : undefined;
    return {
      component: "native_tool_warning_ack_modal",
      ...(typeof record.title === "string" ? { title: sanitizeOneLine(record.title, 120) } : {}),
      ...(typeof record.riskTier === "string" ? { riskTier: sanitizeOneLine(record.riskTier, 80) } : {}),
      ...(typeof record.toolId === "string" ? { toolId: sanitizeOneLine(record.toolId, 80) } : {}),
      ...(typeof record.actionLabel === "string" ? { actionLabel: sanitizeOneLine(record.actionLabel, 120) } : {}),
      ...(acknowledgementPhrase ? { acknowledgementPhrase } : {}),
      ...(typeof record.disclaimer === "string" ? { disclaimer: sanitizeOneLine(record.disclaimer, 240) } : {}),
      ...(typeof riskFeePreview.billingState === "string"
        ? { riskFeeBillingState: sanitizeOneLine(riskFeePreview.billingState, 120) }
        : {}),
      redacted: true,
    };
  }
  return null;
}

function readNestedRuntimeUi(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  return record.runtimeUi ?? readNestedRuntimeUi(record.riskWarning);
}

function runtimeUiToRiskDisclosure(ui: AgentNexusRuntimeRiskWarningUi): AgentNexusRuntimeRiskDisclosure {
  return {
    ...(ui.riskTier ? { riskTier: ui.riskTier } : {}),
    warningMode: "warn_then_execute_when_eligible",
    acknowledgementSurface: "agentc_runtime_prompt",
    userAcknowledgementRequired: true,
    riskFeeBillingState: ui.riskFeeBillingState ?? "configured_not_charged",
    disclaimer: ui.disclaimer ??
      "governance_evidence_only_no_active_insurance_warranty_underwriting_indemnity_or_payout",
    hardBlockAfterAcknowledgement: false,
  };
}

function readRuntimeManifest(body: unknown): Record<string, unknown> | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return null;
  }
  const record = body as Record<string, unknown>;
  if (record.tools || record.governance) {
    return record;
  }
  const data = record.data;
  if (data && typeof data === "object" && !Array.isArray(data)) {
    const manifest = (data as { manifest?: unknown }).manifest;
    if (manifest && typeof manifest === "object" && !Array.isArray(manifest)) {
      return manifest as Record<string, unknown>;
    }
  }
  return null;
}

function isRiskDisclosureRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function normalizeRuntimeRiskDisclosure(value: Record<string, unknown>): AgentNexusRuntimeRiskDisclosure {
  return {
    ...(typeof value.riskTier === "string" ? { riskTier: sanitizeOneLine(value.riskTier, 80) } : {}),
    ...(typeof value.warningMode === "string" ? { warningMode: sanitizeOneLine(value.warningMode, 120) } : {}),
    ...(typeof value.acknowledgementSurface === "string"
      ? { acknowledgementSurface: sanitizeOneLine(value.acknowledgementSurface, 160) }
      : {}),
    ...(typeof value.userAcknowledgementRequired === "boolean"
      ? { userAcknowledgementRequired: value.userAcknowledgementRequired }
      : {}),
    ...(typeof value.riskFeeBillingState === "string"
      ? { riskFeeBillingState: sanitizeOneLine(value.riskFeeBillingState, 120) }
      : {}),
    ...(typeof value.disclaimer === "string" ? { disclaimer: sanitizeOneLine(value.disclaimer, 240) } : {}),
    ...(typeof value.hardBlockAfterAcknowledgement === "boolean"
      ? { hardBlockAfterAcknowledgement: value.hardBlockAfterAcknowledgement }
      : {}),
  };
}

function formatRuntimeRiskDisclosureBlock(disclosure: AgentNexusRuntimeRiskDisclosure | null | undefined) {
  if (!disclosure) {
    return null;
  }
  return [
    "### Native tool risk disclosure",
    "",
    ...(disclosure.riskTier ? [`- **Risk tier (\`risk_tier\`):** ${formatRiskDisclosureValue(disclosure.riskTier)}`] : []),
    ...(disclosure.warningMode ? [`- **Warning mode (\`warning_mode\`):** ${formatRiskDisclosureValue(disclosure.warningMode)}`] : []),
    ...(disclosure.acknowledgementSurface
      ? [`- **Acknowledgement surface (\`acknowledgement_surface\`):** ${formatRiskDisclosureValue(disclosure.acknowledgementSurface)}`]
      : []),
    ...(typeof disclosure.userAcknowledgementRequired === "boolean"
      ? [`- **User acknowledgement required (\`user_acknowledgement_required\`):** ${disclosure.userAcknowledgementRequired}`]
      : []),
    ...(disclosure.riskFeeBillingState
      ? [`- **Risk fee state (\`risk_fee_billing_state\`):** ${formatRiskDisclosureValue(disclosure.riskFeeBillingState)}`]
      : []),
    `- **Disclaimer:** ${formatRiskDisclosureDisclaimer(disclosure.disclaimer)}`,
    `- **Hard block after acknowledgement (\`hard_block_after_acknowledgement\`):** ${disclosure.hardBlockAfterAcknowledgement === true}`,
  ].join("\n");
}

function requiresRuntimeAcknowledgement(disclosure: AgentNexusRuntimeRiskDisclosure | null | undefined) {
  return disclosure?.userAcknowledgementRequired === true;
}

function hasRuntimeRiskAcknowledgement(text: string) {
  const lower = text.toLowerCase();
  return /\b(i acknowledge|acknowledge|i confirm|confirm|approved|proceed)\b/.test(lower) &&
    /\b(agentc native risk|native risk|risk disclosure|tool risk|runtime_cron_request)\b/.test(lower);
}

function canAttemptRuntimeSessionLeaseExecution(options: {
  request: AgentNexusRuntimeToolRequest;
  text: string;
  conversationText?: string;
}) {
  if (options.request.tool !== "sheets_read_range") {
    return false;
  }
  if (isExplicitGoogleSheetsReadLeaseExecutionAttempt(options)) {
    return true;
  }
  if (isExplicitGoogleSheetsReadLeaseBypassPrompt(options.text)) {
    return true;
  }
  if (hasPreviousGoogleSheetsReadOrMetadataContext(options.conversationText)) {
    return isGoogleSheetsSessionReadLeasePrompt(options.text);
  }
  return isExplicitSameResourceGoogleSheetsLeasePrompt(options.text);
}

function isExplicitGoogleSheetsReadLeaseExecutionAttempt(options: {
  request: AgentNexusRuntimeToolRequest;
  text: string;
}) {
  if (options.request.args.requestedWrite === true) {
    return false;
  }
  const lower = options.text.toLowerCase();
  if (!lower.includes("sheets_read_range")) {
    return false;
  }
  const explicitlyRequestsNoSecondAck = lower.includes("do not ask for a second acknowledgement") ||
    lower.includes("no second acknowledgement");
  const explicitlySameSessionLease = lower.includes("same runtime session") &&
    (lower.includes("session read lease") || lower.includes("same-resource session read lease"));
  return explicitlyRequestsNoSecondAck || explicitlySameSessionLease;
}

function hasPreviousGoogleSheetsReadOrMetadataContext(conversationText: string | undefined) {
  return typeof conversationText === "string" &&
    /\bsource:\s*(?:authorized|public) Google Sheets (?:metadata|read)\b/i.test(conversationText);
}

function isSameSessionGoogleSheetsReadPrompt(text: string) {
  return /\bsheets_read_range\b/i.test(text) ||
    /\bsame[-\s]?resource\b/i.test(text) ||
    /\bsame runtime session\b/i.test(text) ||
    /\bsame (?:Google Sheet|spreadsheet)\b/i.test(text) ||
    /\bexisting .*session read lease\b/i.test(text) ||
    /\bdo not ask for a second acknowledgement\b/i.test(text) ||
    /\bsecond acknowledgement\b/i.test(text);
}

function isGoogleSheetsSessionReadLeasePrompt(text: string) {
  if (isGoogleSheetsMutationFollowUp(text)) {
    return false;
  }
  return isSameSessionGoogleSheetsReadPrompt(text) ||
    isGoogleSheetsFollowUpIntent(text) ||
    (
      /\b(read|inspect|access|summarize|summarise|summary|describe|explain|contain|contains|column|columns|row|rows|data)\b/i.test(text) &&
      /\b(sheet|sheets|spreadsheet|googlesheet|google sheet)\b/i.test(text)
    );
}

function isExplicitSameResourceGoogleSheetsLeasePrompt(text: string) {
  const mentionsTool = /\bsheets_read_range\b/i.test(text);
  const mentionsSameResource = /\bsame[-\s]?resource\b/i.test(text) ||
    /\bsame runtime session\b/i.test(text) ||
    /\bsame (?:Google Sheet|spreadsheet)\b/i.test(text);
  const mentionsSessionLease = /\bsame runtime session\b/i.test(text) ||
    /\bexisting .*session read lease\b/i.test(text) ||
    /\bsession read lease\b/i.test(text) ||
    /\bdo not ask for a second acknowledgement\b/i.test(text);
  return mentionsTool && mentionsSameResource && mentionsSessionLease;
}

function isExplicitGoogleSheetsReadLeaseBypassPrompt(text: string) {
  if (isGoogleSheetsMutationFollowUp(text)) {
    return false;
  }
  const mentionsTool = /\bsheets_read_range\b/i.test(text);
  const mentionsReadLease = /\b(?:existing|same[-\s]?resource|same-session|same session|session)\s+.*\bread lease\b/i.test(text) ||
    /\bdo not ask for a second acknowledgement\b/i.test(text);
  const mentionsSameResource = /\bsame[-\s]?resource\b/i.test(text) ||
    /\bsame runtime session\b/i.test(text) ||
    /\bsame (?:Google Sheet|spreadsheet)\b/i.test(text);
  return mentionsTool && mentionsReadLease && mentionsSameResource;
}

export function getAgentNexusRuntimeToolGatewayDiagnostics() {
  const request = resolveAgentNexusRuntimeToolRequest(
    AGENTNEXUS_GWS_SESSION_LEASE_DIAGNOSTIC_PROMPT,
  );
  return {
    buildMarker: AGENTNEXUS_RUNTIME_TOOL_GATEWAY_BUILD_MARKER,
    googleSheetsLeasePredicate: {
      requestTool: request?.tool ?? null,
      previousMetadataContextDetected: hasPreviousGoogleSheetsReadOrMetadataContext(
        AGENTNEXUS_GWS_SESSION_LEASE_DIAGNOSTIC_CONTEXT,
      ),
      sameSessionReadPrompt: isSameSessionGoogleSheetsReadPrompt(
        AGENTNEXUS_GWS_SESSION_LEASE_DIAGNOSTIC_PROMPT,
      ),
      generalFollowUpPrompt: isGoogleSheetsSessionReadLeasePrompt(
        AGENTNEXUS_GWS_GENERAL_FOLLOW_UP_DIAGNOSTIC_PROMPT,
      ),
      generalFollowUpRequestTool: resolvePreviousGoogleSheetsReadRangeRequest({
        text: AGENTNEXUS_GWS_GENERAL_FOLLOW_UP_DIAGNOSTIC_PROMPT,
        conversationText: AGENTNEXUS_GWS_SESSION_LEASE_DIAGNOSTIC_CONTEXT,
      })?.tool ?? null,
      explicitSameResourceLeasePrompt: isExplicitSameResourceGoogleSheetsLeasePrompt(
        AGENTNEXUS_GWS_SESSION_LEASE_DIAGNOSTIC_PROMPT,
      ),
      explicitReadLeaseBypassPrompt: isExplicitGoogleSheetsReadLeaseBypassPrompt(
        AGENTNEXUS_GWS_SESSION_LEASE_DIAGNOSTIC_PROMPT,
      ),
      explicitReadLeaseExecutionAttempt: request
        ? isExplicitGoogleSheetsReadLeaseExecutionAttempt({
            request,
            text: AGENTNEXUS_GWS_SESSION_LEASE_DIAGNOSTIC_PROMPT,
          })
        : false,
      canAttemptSessionLeaseExecution: request
        ? canAttemptRuntimeSessionLeaseExecution({
            request,
            text: AGENTNEXUS_GWS_SESSION_LEASE_DIAGNOSTIC_PROMPT,
            conversationText: AGENTNEXUS_GWS_SESSION_LEASE_DIAGNOSTIC_CONTEXT,
          })
        : false,
    },
  };
}

function resolvePreviousGoogleSheetsReadRangeRequest(options: {
  text: string;
  conversationText?: string;
}): AgentNexusRuntimeToolRequest | null {
  if (!hasPreviousGoogleSheetsReadOrMetadataContext(options.conversationText)) {
    return null;
  }
  if (!isGoogleSheetsSessionReadLeasePrompt(options.text)) {
    return null;
  }
  const spreadsheetId = extractGoogleSheetsSpreadsheetId(options.text) ||
    extractGoogleSheetsSpreadsheetId(options.conversationText ?? "");
  if (!spreadsheetId) {
    return null;
  }
  return {
    tool: "sheets_read_range",
    intent: "google_sheets_read",
    args: {
      spreadsheetId,
      range: readGoogleSheetsRangeFromText(options.text) ?? "Sheet1!A1:Z20",
      majorDimension: "ROWS",
    },
  };
}

function readGoogleSheetsRangeFromText(text: string): string | null {
  const explicitRange = text.match(
    /\brange\s*(?:=|:)?\s*([A-Za-z0-9 _.'-]{1,80}![A-Z]{1,3}\d{1,7}:[A-Z]{1,3}\d{1,7})\b/i,
  );
  const bareRange = text.match(
    /\b([A-Za-z0-9 _.'-]{1,80}![A-Z]{1,3}\d{1,7}:[A-Z]{1,3}\d{1,7})\b/i,
  );
  return sanitizeOneLine(explicitRange?.[1] ?? bareRange?.[1] ?? "", 120) || null;
}

function withRuntimeRiskAcknowledgement(request: AgentNexusRuntimeToolRequest): AgentNexusRuntimeToolRequest {
  return {
    ...request,
    args: {
      ...request.args,
      riskAcknowledgement: true,
      runtimeRiskAcknowledgement: true,
      acknowledgementSurface: "agentc_runtime_prompt",
    },
  };
}

function formatRuntimeAcknowledgementPrompt(
  request: AgentNexusRuntimeToolRequest,
  disclosure: AgentNexusRuntimeRiskDisclosure | null | undefined,
  acknowledgementPhrase?: string,
) {
  const riskBlock = formatRuntimeRiskDisclosureBlock(disclosure);
  return [
    "## Native tool acknowledgement required",
    "",
    "AgentC can continue with this high-risk native action after you explicitly acknowledge the risk. Eligible actions use warn-then-execute; unauthorized, secret-leaking, abusive, unauditable, or destructive actions remain blocked.",
    ...(riskBlock ? ["", riskBlock] : []),
    "",
    `- **Action:** \`${request.tool}\``,
    `- **Intent:** \`${request.intent}\``,
    "- **Execution status:** `execution_status: waiting_for_user_acknowledgement`",
    "- **Acknowledgement effect:** action will run after explicit acknowledgement; no hidden block is applied",
    "",
    `**To continue, reply:** \`${acknowledgementPhrase ?? formatRuntimeAcknowledgementPhrase(request)}\``,
  ].join("\n");
}

function formatRuntimeAcknowledgementPhrase(request: AgentNexusRuntimeToolRequest) {
  const base = `I acknowledge AgentC native risk and run ${request.tool}`;
  if (request.tool === "web_search" && typeof request.args.query === "string" && request.args.query.trim()) {
    return `${base} for: ${sanitizeOneLine(request.args.query, 500)}`;
  }
  if (request.tool === "channel_publish_preview") {
    const draft = request.args.draft && typeof request.args.draft === "object" && !Array.isArray(request.args.draft)
      ? request.args.draft as Record<string, unknown>
      : {};
    const title = typeof draft.title === "string" && draft.title.trim()
      ? sanitizeOneLine(draft.title, 120)
      : "AgentC governed channel relay notification";
    const summary = typeof draft.summary === "string" && draft.summary.trim()
      ? sanitizeOneLine(draft.summary, 180)
      : "Synthetic AgentC channel relay notification";
    return `${base} for: title=${title}; summary=${summary}; body=redacted`;
  }
  if (request.tool === "sheets_read_range") {
    const spreadsheetId = typeof request.args.spreadsheetId === "string"
      ? sanitizeGoogleSheetsSpreadsheetId(request.args.spreadsheetId)
      : null;
    const range = typeof request.args.range === "string" && request.args.range.trim()
      ? sanitizeOneLine(request.args.range, 120)
      : "Sheet1!A1:Z20";
    const requestedWrite = request.args.requestedWrite === true ? "; requestedWrite=true" : "";
    if (spreadsheetId) {
      return `${base} for: spreadsheet=${spreadsheetId}; range=${range}${requestedWrite}`;
    }
  }
  if (request.tool === "sheets_get_metadata") {
    const spreadsheetId = typeof request.args.spreadsheetId === "string"
      ? sanitizeGoogleSheetsSpreadsheetId(request.args.spreadsheetId)
      : null;
    const fields = typeof request.args.fields === "string" && request.args.fields.trim()
      ? sanitizeOneLine(request.args.fields, 240)
      : GOOGLE_SHEETS_METADATA_FIELDS;
    if (spreadsheetId) {
      return `${base} for: spreadsheet=${spreadsheetId}; fields=${fields}`;
    }
  }
  return base;
}

function formatRiskDisclosureDisclaimer(value: string | undefined) {
  if (value === "governance_evidence_only_no_active_insurance_warranty_underwriting_indemnity_or_payout") {
    return "governance evidence only; no active insurance, warranty, underwriting, indemnity, or payout coverage";
  }
  if (value && value.trim()) {
    return value;
  }
  return "governance evidence only; no active insurance, warranty, underwriting, indemnity, or payout coverage";
}

function formatRiskDisclosureValue(value: string) {
  if (value === "configured_not_charged") {
    return "configured, not charged";
  }
  if (value === "warn_then_execute_when_eligible") {
    return "warn then execute when eligible";
  }
  if (value === "agentnexus_control_plane_or_runtime_prompt") {
    return "AgentNexus control plane or runtime prompt";
  }
  return value.replace(/_/g, " ");
}

function withRiskDisclosurePrefix(prefix: string | null, answer: string) {
  return prefix ? `${prefix}\n\n${answer}` : answer;
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
    ? sanitizeRepoEvidenceText(readme.excerpt, 1_200)
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
  const source = typeof record.source === "string" && /\b(?:authorized|public) Google Sheets read\b/i.test(record.source)
    ? sanitizeOneLine(record.source, 80)
    : "authorized Google Sheets read";
  const lines = [
    `source: ${source}`,
    `range: ${range}`,
    `rowCount: ${rowCount}`,
    `columnCount: ${columnCount}`,
    ...(args.requestedWrite === true ? ["write_status: approval_required"] : []),
  ];
  if (hasRuntimeSessionFollowUpGrounding(body)) {
    lines.push(
      "follow_up_context: active for this session",
      "follow_up_boundary: read follow-ups allowed; writes require approval",
    );
  }
  return lines.join("\n");
}

function formatGoogleSheetsMetadataAnswer(body: Record<string, unknown>) {
  const result = readToolResult(body);
  const record = result && typeof result === "object" && !Array.isArray(result)
    ? result as Record<string, unknown>
    : {};
  const source = typeof record.source === "string" && /\b(?:authorized|public) Google Sheets metadata\b/i.test(record.source)
    ? sanitizeOneLine(record.source, 80)
    : "authorized Google Sheets metadata";
  const sheets = Array.isArray(record.sheets) ? record.sheets : [];
  const sheetCount = readFiniteMetadataCount(record.sheetCount) ?? sheets.length;
  const rowCountMax = readFiniteMetadataCount(record.rowCountMax) ?? readMaxSheetGridCount(sheets, "rowCount") ?? 0;
  const columnCountMax = readFiniteMetadataCount(record.columnCountMax) ??
    readMaxSheetGridCount(sheets, "columnCount") ?? 0;
  return [
    `source: ${source}`,
    "resultType: spreadsheet_metadata",
    `sheetCount: ${sheetCount}`,
    `rowCountMax: ${rowCountMax}`,
    `columnCountMax: ${columnCountMax}`,
  ].join("\n");
}

function readFiniteMetadataCount(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.trunc(value)
    : null;
}

function readMaxSheetGridCount(sheets: unknown[], field: "rowCount" | "columnCount") {
  const counts = sheets
    .map((sheet) => {
      const sheetRecord = sheet && typeof sheet === "object" && !Array.isArray(sheet)
        ? sheet as Record<string, unknown>
        : {};
      const properties = sheetRecord.properties && typeof sheetRecord.properties === "object" &&
          !Array.isArray(sheetRecord.properties)
        ? sheetRecord.properties as Record<string, unknown>
        : {};
      const gridProperties = properties.gridProperties && typeof properties.gridProperties === "object" &&
          !Array.isArray(properties.gridProperties)
        ? properties.gridProperties as Record<string, unknown>
        : {};
      return readFiniteMetadataCount(gridProperties[field]);
    })
    .filter((count): count is number => count !== null);
  return counts.length > 0 ? Math.max(...counts) : null;
}

function hasRuntimeSessionFollowUpGrounding(body: Record<string, unknown>) {
  const governance = readRuntimeSessionGovernance(body);
  if (!governance) {
    return false;
  }
  const followUpGrounding = governance.followUpGrounding;
  const toolContext = governance.toolContext;
  if (!followUpGrounding || typeof followUpGrounding !== "object" || Array.isArray(followUpGrounding)) {
    return false;
  }
  if (!toolContext || typeof toolContext !== "object" || Array.isArray(toolContext)) {
    return false;
  }
  return (followUpGrounding as { enabled?: unknown }).enabled === true &&
    (toolContext as { rawPayloadStored?: unknown; redacted?: unknown }).rawPayloadStored === false &&
    (toolContext as { redacted?: unknown }).redacted === true;
}

function formatRuntimeCronRequestAnswer(body: Record<string, unknown>, args: Record<string, unknown>) {
  const result = readToolResult(body);
  const record = result && typeof result === "object" && !Array.isArray(result)
    ? result as Record<string, unknown>
    : {};
  const id = typeof record.id === "string" ? record.id : "unknown";
  const status = typeof record.status === "string" ? record.status : "requested";
  const scheduleKind = typeof record.scheduleKind === "string"
    ? record.scheduleKind
    : typeof args.scheduleKind === "string"
      ? args.scheduleKind
      : "scheduled_prompt";
  const timezone = typeof record.timezone === "string"
    ? record.timezone
    : typeof args.timezone === "string"
      ? args.timezone
      : "UTC";
  const retryLimit = typeof record.retryLimit === "number"
    ? record.retryLimit
    : typeof args.retryLimit === "number"
      ? args.retryLimit
      : 1;
  const costCapCents = typeof record.costCapCents === "number"
    ? record.costCapCents
    : typeof args.costCapCents === "number"
      ? args.costCapCents
      : 25;
  const requiresApproval = typeof record.requiresApproval === "boolean" ? record.requiresApproval : true;
  return [
    "Runtime cron request created through AgentNexus Tool Gateway.",
    "tool: runtime_cron_request",
    `cron_job_id: ${id}`,
    `status: ${status}`,
    `schedule_kind: ${scheduleKind}`,
    `approval_required: ${requiresApproval}`,
    `timezone: ${timezone}`,
    `retry_limit: ${retryLimit}`,
    `cost_cap_cents: ${costCapCents}`,
    "safety_boundary: no cron shell, no cron browser, no Google write, no channel publish, no production secrets",
    "source: AgentNexus governed runtime cron",
  ].join("\n");
}

function formatChannelPublishPreviewAnswer(body: Record<string, unknown>) {
  const result = readToolResult(body);
  const record = result && typeof result === "object" && !Array.isArray(result)
    ? result as Record<string, unknown>
    : {};
  const redactedDraft = record.redactedDraft && typeof record.redactedDraft === "object" && !Array.isArray(record.redactedDraft)
    ? record.redactedDraft as Record<string, unknown>
    : {};
  const target = record.target && typeof record.target === "object" && !Array.isArray(record.target)
    ? record.target as Record<string, unknown>
    : {};
  const payloadKeys = Array.isArray(redactedDraft.payloadKeys)
    ? redactedDraft.payloadKeys.filter((key): key is string => typeof key === "string")
    : [];
  const channelType = typeof record.channelType === "string" ? record.channelType : "webhook";
  const riskLabel = typeof record.riskLabel === "string" ? record.riskLabel : "approval_required";
  const hostHash = typeof target.hostHash === "string" ? target.hostHash : "redacted";
  const requiresApproval = typeof record.requiresApproval === "boolean" ? record.requiresApproval : true;
  return [
    "Channel Publish preview created through AgentNexus Tool Gateway.",
    "tool: channel_publish_preview",
    `channel_type: ${channelType}`,
    `requires_approval: ${requiresApproval}`,
    `risk_label: ${riskLabel}`,
    `target_host_hash: ${hostHash}`,
    `redacted_draft: bodyPreview=[redacted], payloadKeys=${payloadKeys.length ? payloadKeys.join(", ") : "body, summary, title"}`,
    "safety_boundary: preview only from runtime; delivery requires AgentNexus approval; no Slack, Discord, Telegram, webhook URL, signing secret, or channel secret is exposed",
    "source: AgentNexus Channel Publish webhook pilot",
  ].join("\n");
}

function formatRuntimeSessionExportAnswer(body: Record<string, unknown>) {
  const result = readToolResult(body);
  const record = result && typeof result === "object" && !Array.isArray(result)
    ? result as Record<string, unknown>
    : {};
  const markdown = typeof record.markdown === "string" && record.markdown.trim()
    ? sanitizeRuntimeSessionExportMarkdown(record.markdown)
    : [
      "# Report artifact generated in AgentC Runtime",
      "",
      "## Source workflow result",
      "- source_workflow: workspace-file-report-generation",
      "",
      "## Export boundary",
      "- repo_safe_metadata: hashes, counts, timestamps, and redaction status only",
      "- raw transcript in repo evidence: false",
      "",
      "## Scanner status",
      "- metadata_only_after_scan",
      "",
      "## Evidence fields",
      "- runtimeSessionExportEvidence",
    ].join("\n");
  return [
    markdown,
    "",
    "source: AgentNexus governed runtime session export",
  ].join("\n");
}

function buildPreviousGitHubRepoPlanReply(text: string, conversationText: string | undefined) {
  if (!/\b(implementation plan|repo summary|key files|demo takeaway|plan)\b/i.test(text)) {
    return null;
  }
  if (!conversationText || !/Public GitHub repo read completed through AgentNexus Tool Gateway/i.test(conversationText)) {
    return null;
  }
  const previousRepoRead = conversationText
    .split(/Public GitHub repo read completed through AgentNexus Tool Gateway\./i)
    .at(-1);
  if (!previousRepoRead) {
    return null;
  }
  const repoEvidence = extractFormattedGitHubRepoEvidence(previousRepoRead);
  if (!repoEvidence) {
    return null;
  }
  return formatPreviousGitHubRepoImplementationPlan(repoEvidence);
}

function formatPreviousGitHubRepoImplementationPlan(evidence: {
  repo: string;
  description: string;
  fileEvidence: string[];
  readmeExcerpt: string;
}) {
  const keyFiles = evidence.fileEvidence.length ? evidence.fileEvidence : ["README.md"];
  return [
    "# Implementation plan from native GitHub repo evidence",
    "",
    "## Repo summary",
    "",
    `- Repo: ${evidence.repo}`,
    `- Description: ${evidence.description}`,
    `- README signal: ${evidence.readmeExcerpt}`,
    "",
    "## Key files",
    "",
    ...keyFiles.map((file) => `- ${file}`),
    "",
    "## Implementation steps",
    "",
    "- Review README.md and listed file evidence to identify the primary package surface.",
    "- Map the visible setup, examples, and command surfaces into an AgentC task plan.",
    "- Keep execution disabled in this repo-read workflow; use the evidence to draft changes before any separate approval or sandbox run.",
    "- Record repo, file evidence, and redaction status in AgentNexus evidence before demo or handoff.",
    "",
    "## Demo takeaway",
    "",
    "- AgentC turned public GitHub evidence into an implementation plan inside the native runtime console.",
    "- GitHub credentials, non-public repository access, and raw provider payloads stayed outside the runtime.",
    "",
    "source: previous redacted AgentNexus Tool Gateway github_public_repo_read result",
  ].join("\n");
}

function extractFormattedGitHubRepoEvidence(text: string) {
  const repo = readPrefixedValue(text, "repo");
  const description = readPrefixedValue(text, "description");
  const fileEvidenceText = readPrefixedValue(text, "file_evidence");
  const readmeExcerpt = readPrefixedValue(text, "readme_excerpt");
  if (!repo || !readmeExcerpt) {
    return null;
  }
  const fileEvidence = (fileEvidenceText || "README.md")
    .split(",")
    .map((item) => sanitizeRepoEvidenceText(item, 120))
    .filter(Boolean)
    .slice(0, 6);
  return {
    repo: sanitizeRepoEvidenceText(repo, 160),
    description: description ? sanitizeRepoEvidenceText(description, 280) : "No repository description returned.",
    fileEvidence,
    readmeExcerpt: sanitizeRepoEvidenceText(readmeExcerpt, 360),
  };
}

function readPrefixedValue(text: string, key: string) {
  const match = text.match(new RegExp(`^${key}:\\s*(.+)$`, "im"));
  return match?.[1]?.trim() || "";
}

function buildPreviousGoogleSheetsFollowUpReply(text: string, conversationText: string | undefined) {
  if (extractGoogleSheetsSpreadsheetId(text) || !isGoogleSheetsFollowUpIntent(text)) {
    return null;
  }
  if (!conversationText || !/\bsource:\s*(?:authorized|public) Google Sheets read\b/i.test(conversationText)) {
    return null;
  }
  const evidence = extractFormattedGoogleSheetsEvidence(conversationText);
  if (!evidence) {
    return null;
  }
  if (isGoogleSheetsMutationFollowUp(text)) {
    return formatPreviousGoogleSheetsMutationBoundary(evidence);
  }
  return formatPreviousGoogleSheetsSummary(evidence, text);
}

function isGoogleSheetsFollowUpIntent(text: string) {
  const lower = text.toLowerCase();
  return /\b(sheet|sheets|spreadsheet|googlesheet|google sheet|this|that|it|previous|result|contain|contains|summary|summarize|summarise|column|columns|row|rows|data)\b/.test(lower) &&
    /\b(what|contain|contains|summary|summarize|summarise|describe|explain|detail|detailed|column|columns|row|rows|data|write|update|append|insert|edit|modify|delete|change)\b/.test(lower);
}

function isGoogleSheetsMutationFollowUp(text: string) {
  return isGoogleSheetsMutationIntent(stripUrlsForIntent(text));
}

function isGoogleSheetsMutationIntent(text: string) {
  return /\b(write|update|delete|remove|append|insert|modify|edit|change|create\s+(?:a\s+)?(?:row|record|entry)|add\s+(?:a\s+)?row)\b/i.test(text);
}

function stripUrlsForIntent(text: string) {
  return text.replace(/https?:\/\/\S+/gi, " ");
}

function extractFormattedGoogleSheetsEvidence(text: string) {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  let evidence: {
    source: string;
    range: string;
    rowCount: number | null;
    columnCount: number | null;
    followUpContextActive: boolean;
    followUpBoundary: string;
  } | null = null;
  for (const line of lines) {
    const sourceMatch = line.match(/^source:\s*((?:authorized|public) Google Sheets read)$/i);
    if (sourceMatch) {
      evidence = {
        source: sanitizeOneLine(sourceMatch[1] ?? "authorized Google Sheets read", 80),
        range: "unknown",
        rowCount: null,
        columnCount: null,
        followUpContextActive: false,
        followUpBoundary: "read follow-ups allowed; writes require approval",
      };
      continue;
    }
    if (!evidence) {
      continue;
    }
    const range = line.match(/^range:\s*(.+)$/i);
    if (range) {
      evidence.range = sanitizeOneLine(range[1] ?? "", 120) || "unknown";
      continue;
    }
    const rowCount = line.match(/^rowCount:\s*(\d+)$/i);
    if (rowCount) {
      evidence.rowCount = Number.parseInt(rowCount[1] ?? "0", 10);
      continue;
    }
    const columnCount = line.match(/^columnCount:\s*(\d+)$/i);
    if (columnCount) {
      evidence.columnCount = Number.parseInt(columnCount[1] ?? "0", 10);
      continue;
    }
    const followUpContext = line.match(/^follow_up_context:\s*(.+)$/i);
    if (followUpContext) {
      evidence.followUpContextActive = /active/i.test(followUpContext[1] ?? "");
      continue;
    }
    const followUpBoundary = line.match(/^follow_up_boundary:\s*(.+)$/i);
    if (followUpBoundary) {
      evidence.followUpBoundary = sanitizeOneLine(followUpBoundary[1] ?? "", 180) ||
        "read follow-ups allowed; writes require approval";
    }
  }
  return evidence && evidence.range !== "unknown" ? evidence : null;
}

function formatPreviousGoogleSheetsSummary(
  evidence: {
    source: string;
    range: string;
    rowCount: number | null;
    columnCount: number | null;
    followUpContextActive: boolean;
    followUpBoundary: string;
  },
  text: string,
) {
  const shape = evidence.rowCount !== null && evidence.columnCount !== null
    ? `${evidence.rowCount} rows x ${evidence.columnCount} columns`
    : "redacted shape metadata unavailable";
  const wantsOneSentence = /\bone[-\s]?sentence\b/i.test(text);
  if (wantsOneSentence) {
    return [
      `The previous Google Sheets read exposed a redacted ${shape} metadata view of ${evidence.range} from ${evidence.source}; raw cell values and credentials were not exposed.`,
      "",
      "source: previous redacted AgentNexus Tool Gateway sheets_read_range result",
    ].join("\n");
  }
  return [
    "# Google Sheets summary from session context",
    "",
    `- Source: ${evidence.source}`,
    `- Range: ${evidence.range}`,
    `- Shape: ${shape}`,
    `- Follow-up context: ${evidence.followUpContextActive ? "active for this session" : "available from the visible redacted result"}`,
    `- Boundary: ${evidence.followUpBoundary}`,
    "- Redacted interpretation: AgentC can answer read-only follow-ups from this session context, but the runtime transcript does not contain raw cell values, emails, OAuth tokens, provider keys, or spreadsheet credentials.",
    "",
    "source: previous redacted AgentNexus Tool Gateway sheets_read_range result",
  ].join("\n");
}

function formatPreviousGoogleSheetsMutationBoundary(evidence: {
  source: string;
  range: string;
  rowCount: number | null;
  columnCount: number | null;
}) {
  const shape = evidence.rowCount !== null && evidence.columnCount !== null
    ? `${evidence.rowCount} rows x ${evidence.columnCount} columns`
    : "redacted shape metadata";
  return [
    "Google Sheets write/update requires a new approval.",
    "",
    `Previous session context only authorizes read follow-ups for ${evidence.range} (${shape}) from ${evidence.source}.`,
    "To modify the sheet, use an explicit AgentNexus Google Workspace approval-write flow; this runtime read context will not silently execute writes.",
    "",
    "source: previous redacted AgentNexus Tool Gateway sheets_read_range result",
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
  if (/\b(research brief|brief|report|source table|demo takeaway)\b/i.test(text)) {
    return formatPreviousSearchResearchBrief(items);
  }
  return [
    "Summary of previous Tool Gateway search results:",
    "",
    items.map((item, index) => `${index + 1}. ${item.title}: ${item.summary} (${item.url})`).join("\n"),
    "",
    "source: previous redacted AgentNexus Tool Gateway web_search result",
  ].join("\n");
}

function formatPreviousSearchResearchBrief(items: Array<{ title: string; summary: string; url: string }>) {
  const sourceRows = items.map((item) =>
    `| ${sanitizeMarkdownTableCell(item.title)} | ${sanitizeMarkdownTableCell(item.summary)} | ${item.url} |`
  );
  return [
    "# Research brief from native Tool Gateway results",
    "",
    "## Executive summary",
    "",
    ...items.slice(0, 3).map((item) => `- ${item.title}: ${item.summary}`),
    "",
    "## Source table",
    "",
    "| Source | Brief summary | URL |",
    "| --- | --- | --- |",
    ...sourceRows,
    "",
    "## Demo takeaway",
    "",
    "- AgentC used prior native Tool Gateway search results to produce this brief inside the runtime console.",
    "- Provider credentials and raw search payloads stayed server-side in AgentNexus.",
    "",
    "source: previous redacted AgentNexus Tool Gateway web_search result",
  ].join("\n");
}

function extractFormattedSearchItems(text: string) {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const items: Array<{ title: string; summary: string; url: string }> = [];
  for (let index = 0; index < lines.length; index += 1) {
    const titleMatch = lines[index]?.match(/^\d+\.\s+(.+)$/);
    if (!titleMatch) {
      continue;
    }
    const summaryLine = lines[index + 1] ?? "";
    const urlLine = lines[index + 2] ?? "";
    const summary = summaryLine.replace(/^brief_summary:\s*/i, "").trim();
    const url = urlLine.replace(/^source_url:\s*/i, "").trim();
    if (!summary || !/^https?:\/\//i.test(url)) {
      continue;
    }
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

function sanitizeGoogleSheetsSpreadsheetId(value: string) {
  const trimmed = value.trim();
  return /^[A-Za-z0-9_-]{20,160}$/.test(trimmed) ? trimmed : null;
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

function sanitizeRuntimeSessionExportMarkdown(value: string) {
  return value
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/giu, "[redacted-email]")
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer [redacted]")
    .replace(/(?:access_token|refresh_token|id_token|api_key|secret|password)=?["']?[A-Za-z0-9._-]{8,}/gi, "$1=[redacted]")
    .replace(/(?:^|[\s"'=:])sk-[A-Za-z0-9._-]{16,}/g, " [redacted-secret]")
    .replace(/\braw transcript included\b/giu, "raw transcript in repo evidence: false")
    .slice(0, 3_000);
}

function sanitizeRepoEvidenceText(value: string, limit: number) {
  return value
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/giu, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/giu, " ")
    .replace(/<[^>]+>/gu, " ")
    .replace(/<\s*\/?\s*[a-z][^>\r\n]*/giu, " ")
    .replace(/&nbsp;/giu, " ")
    .replace(/&amp;/giu, "&")
    .replace(/&lt;/giu, "<")
    .replace(/&gt;/giu, ">")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, limit);
}

function sanitizeMarkdownTableCell(value: string) {
  return value.replace(/\|/g, "\\|").replace(/\s+/g, " ").trim();
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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
