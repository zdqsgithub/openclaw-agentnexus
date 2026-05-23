import { describe, expect, it, vi } from "vitest";
import {
  buildChannelPublishBoundaryAnswer,
  executeAgentNexusRuntimeTool,
  formatAgentNexusRuntimeToolAnswer,
  readAgentNexusRuntimeToolConfig,
  resolveAgentNexusRuntimeTextReply,
  resolveAgentNexusRuntimeToolRequest,
} from "./agentnexus-tool-gateway.js";

describe("AgentNexus runtime Tool Gateway client", () => {
  it("requires both the Tool Gateway URL and runtime token", () => {
    expect(readAgentNexusRuntimeToolConfig({})).toBeNull();
    expect(
      readAgentNexusRuntimeToolConfig({
        AGENTNEXUS_TOOL_GATEWAY_URL: "https://agtnx.ai/api/runtime/tools/execute",
        AGENTNEXUS_RUNTIME_TOKEN: "runtime-token",
      }),
    ).toEqual({
      gatewayUrl: "https://agtnx.ai/api/runtime/tools/execute",
      runtimeToken: "runtime-token",
    });
  });

  it("maps Google Workspace calendar requests to redacted read-only tool calls", () => {
    const request = resolveAgentNexusRuntimeToolRequest(
      "Can you access GWS and list my next Google Calendar events?",
      new Date("2026-05-21T17:00:00.000Z"),
    );

    expect(request).toEqual({
      tool: "calendar_list_events",
      intent: "google_calendar_read",
      args: {
        timeMin: "2026-05-21T17:00:00.000Z",
        maxResults: 3,
        singleEvents: true,
        orderBy: "startTime",
      },
    });
  });

  it("maps citation requests to server-side web search calls", () => {
    const request = resolveAgentNexusRuntimeToolRequest(
      "Search current public FDA AI device guidance and include citation URLs.",
    );

    expect(request?.tool).toBe("web_search");
    expect(request?.intent).toBe("web_search");
    expect(request?.args.query).toContain("FDA AI device guidance");
  });

  it("maps governed skill requests to AgentNexus runtime skill execution", () => {
    const request = resolveAgentNexusRuntimeToolRequest(
      "/skill demo-summary-style Summarize a launch note for a VC demo.",
    );

    expect(request).toEqual({
      tool: "runtime_skill_execute",
      intent: "governed_skill",
      args: {
        skillId: "demo-summary-style",
        input: "Summarize a launch note for a VC demo.",
      },
    });
  });

  it("keeps channel publish setup in the AgentNexus governed Publish path", () => {
    const answer = buildChannelPublishBoundaryAnswer(
      "I want to set up Slack or Telegram channel access.",
    );

    expect(answer).toContain("AgentNexus workspace Publish tab");
    expect(answer).toContain("draft preview");
    expect(answer).toContain("approval checkpoint");
    expect(answer).toContain("credentials out of this runtime");
  });

  it("calls the runtime execute endpoint without following redirects", async () => {
    const fetchFn = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ data: { result: { citations: [{ url: "https://example.com/a" }] } } }),
    })) as unknown as typeof fetch;

    const result = await executeAgentNexusRuntimeTool({
      config: {
        gatewayUrl: "https://agtnx.ai/api/runtime/tools/execute",
        runtimeToken: "runtime-token",
      },
      request: {
        tool: "web_search",
        intent: "web_search",
        args: { query: "demo" },
      },
      fetchFn,
    });

    expect(result.ok).toBe(true);
    expect(fetchFn).toHaveBeenCalledWith(
      "https://agtnx.ai/api/runtime/tools/execute",
      expect.objectContaining({
        method: "POST",
        redirect: "error",
        headers: expect.objectContaining({
          authorization: "Bearer runtime-token",
          "content-type": "application/json",
        }),
      }),
    );
  });

  it("formats Google Workspace results without raw event data", () => {
    const answer = formatAgentNexusRuntimeToolAnswer({
      request: {
        tool: "calendar_list_events",
        intent: "google_calendar_read",
        args: { timeMin: "2026-05-21T17:00:00.000Z" },
      },
      result: {
        ok: true,
        status: 200,
        body: {
          data: {
            result: {
              items: [
                { summary: "Happy birthday!", attendees: [{ email: "person@example.com" }] },
                { summary: "Private FDA call", location: "redacted room" },
              ],
            },
          },
        },
      },
    });

    expect(answer).toBe([
      "event_count: 2",
      "date_range: 2026-05-21T17:00:00.000Z to next authorized window",
      "source: authorized Google Calendar read",
    ].join("\n"));
    expect(answer).not.toContain("Happy birthday");
    expect(answer).not.toContain("person@example.com");
    expect(answer).not.toContain("Private FDA call");
    expect(answer).not.toContain("redaction:");
    expect(answer).not.toContain("AgentNexus Tool Gateway");
  });

  it("does not stringify non-text Calendar range arguments into runtime output", () => {
    const answer = formatAgentNexusRuntimeToolAnswer({
      request: {
        tool: "calendar_list_events",
        intent: "google_calendar_read",
        args: { timeMin: { raw: "2026-05-21T17:00:00.000Z" } },
      },
      result: {
        ok: true,
        status: 200,
        body: {
          data: {
            result: { items: [] },
          },
        },
      },
    });

    expect(answer).toContain("date_range: now to next authorized window");
    expect(answer).not.toContain("[object Object]");
    expect(answer).not.toContain("raw");
  });

  it("formats search results with concrete source URLs", () => {
    const answer = formatAgentNexusRuntimeToolAnswer({
      request: {
        tool: "web_search",
        intent: "web_search",
        args: { query: "AgentNexus" },
      },
      result: {
        ok: true,
        status: 200,
        body: {
          data: {
            result: {
              citations: [
                { url: "https://www.fda.gov/medical-devices/software-medical-device-samd" },
              ],
            },
          },
        },
      },
    });

    expect(answer).toContain("https://www.fda.gov/medical-devices/software-medical-device-samd");
  });

  it("formats governed skill results without leaking raw skill metadata", () => {
    const answer = formatAgentNexusRuntimeToolAnswer({
      request: {
        tool: "runtime_skill_execute",
        intent: "governed_skill",
        args: { skillId: "demo-summary-style", input: "private raw input" },
      },
      result: {
        ok: true,
        status: 200,
        body: {
          data: {
            result: {
              skillStatus: "executed",
              skillId: "demo-summary-style",
              output: {
                format: "demo_safe_summary",
                summary: "Demo-safe summary with private values redacted.",
                redacted: true,
              },
              redacted: true,
            },
          },
        },
      },
    });

    expect(answer).toBe([
      "skill_status: executed",
      "skill_id: demo-summary-style",
      "summary: Demo-safe summary with private values redacted.",
      "source: AgentNexus governed skills catalog",
    ].join("\n"));
    expect(answer).not.toContain("private raw input");
    expect(answer).not.toContain("manifestHash");
    expect(answer).not.toContain("Bearer");
  });

  it("resolves runtime text replies through the same Tool Gateway path used by native chat", async () => {
    const fetchFn = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        data: {
          result: {
            items: [
              { summary: "Private event title", attendees: [{ email: "person@example.com" }] },
              { summary: "Board review" },
            ],
          },
        },
      }),
    })) as unknown as typeof fetch;

    const reply = await resolveAgentNexusRuntimeTextReply({
      text: "Can you access Google Calendar and list events?",
      now: new Date("2026-05-21T17:00:00.000Z"),
      env: {
        AGENTNEXUS_TOOL_GATEWAY_URL: "https://agtnx.ai/api/runtime/tools/execute",
        AGENTNEXUS_RUNTIME_TOKEN: "runtime-token",
      },
      fetchFn,
    });

    expect(reply).toMatchObject({
      adapter: "agentnexus-tool-gateway",
    });
    expect(reply?.content).toBe([
      "event_count: 2",
      "date_range: 2026-05-21T17:00:00.000Z to next authorized window",
      "source: authorized Google Calendar read",
    ].join("\n"));
    expect(reply?.content).not.toContain("Private event title");
    expect(reply?.content).not.toContain("person@example.com");
    expect(reply?.content).not.toContain("Board review");
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("answers generic managed-headless runtime chat through the direct model path", async () => {
    const fetchFn = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        choices: [
          {
            message: {
              content: "Hello from the managed OpenClaw runtime.",
            },
          },
        ],
      }),
    })) as unknown as typeof fetch;

    const reply = await resolveAgentNexusRuntimeTextReply({
      text: "Hi, introduce yourself",
      env: {
        OPENCLAW_MANAGED_HEADLESS: "1",
        OPENROUTER_API_KEY: "openrouter-key",
        OPENROUTER_MODEL: "moonshotai/kimi-k2.6",
      },
      fetchFn,
    });

    expect(reply).toMatchObject({
      adapter: "agentnexus-direct-openrouter",
      content: "Hello from the managed OpenClaw runtime.",
    });
    expect(fetchFn).toHaveBeenCalledWith(
      "https://openrouter.ai/api/v1/chat/completions",
      expect.objectContaining({
        method: "POST",
        redirect: "error",
        headers: expect.objectContaining({
          authorization: "Bearer openrouter-key",
          "content-type": "application/json",
        }),
      }),
    );
    const requestBody = JSON.parse(String(fetchFn.mock.calls[0]?.[1]?.body));
    expect(requestBody).toMatchObject({
      model: "moonshotai/kimi-k2.6",
      messages: [
        expect.objectContaining({
          role: "system",
        }),
        {
          role: "user",
          content: "Hi, introduce yourself",
        },
      ],
    });
  });

  it("returns a bounded Tool Gateway setup answer when runtime token is missing", async () => {
    const reply = await resolveAgentNexusRuntimeTextReply({
      text: "Can you access Google Calendar and list events?",
      env: {
        AGENTNEXUS_TOOL_GATEWAY_URL: "https://agtnx.ai/api/runtime/tools/execute",
      },
    });

    expect(reply).toMatchObject({
      adapter: "agentnexus-tool-gateway",
    });
    expect(reply?.content).toContain("AgentNexus Tool Gateway is not configured");
    expect(reply?.content).toContain("Developer Sandbox");
  });
});
