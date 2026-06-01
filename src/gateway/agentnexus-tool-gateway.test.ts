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

  it("maps Google Sheets URLs to read-only Sheets Tool Gateway calls before generic Workspace calendar handling", () => {
    const request = resolveAgentNexusRuntimeToolRequest(
      "Can you access google workspace to read and write this googlesheet https://docs.google.com/spreadsheets/d/1-fgOfxIyWxAirwmfuphvBUG31kVyW54ytvLUNW4yeFg/edit?usp=drive_link?",
      new Date("2026-05-21T17:00:00.000Z"),
    );

    expect(request).toEqual({
      tool: "sheets_read_range",
      intent: "google_sheets_read",
      args: {
        spreadsheetId: "1-fgOfxIyWxAirwmfuphvBUG31kVyW54ytvLUNW4yeFg",
        range: "Sheet1!A1:Z20",
        majorDimension: "ROWS",
        requestedWrite: true,
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

  it("maps public GitHub repository URLs to server-side public repo reads", () => {
    const request = resolveAgentNexusRuntimeToolRequest(
      "Can you access this github repo https://github.com/zdqsgithub/openclaw-agentnexus?",
    );

    expect(request).toEqual({
      tool: "github_public_repo_read",
      intent: "github_public_repo_read",
      args: {
        url: "https://github.com/zdqsgithub/openclaw-agentnexus",
      },
    });
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

  it("maps scheduled monitoring cron requests to governed runtime cron requests", () => {
    const request = resolveAgentNexusRuntimeToolRequest(
      "Create a governed scheduled monitoring cron workflow. Use runtime_cron_request for a read-only web_search every Monday at 15:00 UTC with retry limit 1 and cost cap 25 cents.",
    );

    expect(request).toEqual({
      tool: "runtime_cron_request",
      intent: "runtime_cron_request",
      args: {
        scheduleKind: "tool_gateway_read",
        toolId: "web_search",
        actionId: "web_search",
        cronExpression: "0 15 * * 1",
        timezone: "UTC",
        costCapCents: 25,
        retryLimit: 1,
      },
    });
  });

  it("maps explicit channel publish preview requests to AgentNexus Tool Gateway", () => {
    const request = resolveAgentNexusRuntimeToolRequest(
      [
        "Create a governed channel relay notification preview through AgentNexus Tool Gateway.",
        "Use channel_publish_preview.",
        "Channel type webhook.",
        "Draft title: AgentC governed channel relay QA.",
        "Draft body: Redacted synthetic channel relay notification.",
        "Draft summary: Synthetic AgentC channel relay notification.",
        "Do not send the webhook from the runtime.",
      ].join(" "),
    );

    expect(request).toEqual({
      tool: "channel_publish_preview",
      intent: "channel_publish_preview",
      args: {
        channelType: "webhook",
        draft: {
          title: "AgentC governed channel relay QA",
          body: "Redacted synthetic channel relay notification",
          summary: "Synthetic AgentC channel relay notification",
        },
      },
    });
  });

  it("maps workspace report export requests to governed runtime session export", () => {
    const request = resolveAgentNexusRuntimeToolRequest(
      [
        "Create a workspace-file-report-generation report artifact from the previous workflow result.",
        "Use runtime_session_export and include runtimeSessionExportEvidence, repo_safe_metadata, and metadata_only_after_scan.",
      ].join(" "),
    );

    expect(request).toEqual({
      tool: "runtime_session_export",
      intent: "runtime_session_export",
      args: {
        sourceWorkflow: "workspace-file-report-generation",
        reportTitle: "Report artifact generated in AgentC Runtime",
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

  it("formats channel publish previews with approval and redacted target evidence", () => {
    const answer = formatAgentNexusRuntimeToolAnswer({
      request: {
        tool: "channel_publish_preview",
        intent: "channel_publish_preview",
        args: {
          channelType: "webhook",
          draft: {
            title: "AgentC governed channel relay QA",
            body: "Private payload must stay redacted.",
            summary: "Synthetic channel relay notification.",
          },
        },
      },
      result: {
        ok: true,
        status: 200,
        body: {
          data: {
            result: {
              provider: "channel_publish",
              actionId: "webhook_send",
              channelType: "webhook",
              requiresApproval: true,
              riskLabel: "approval_required",
              riskReason: "Channel Publish webhook delivery requires explicit approval.",
              redactedDraft: {
                bodyLength: 35,
                bodyPreview: "[redacted]",
                hasBody: true,
                payloadKeys: ["body", "summary", "title"],
                redacted: true,
              },
              target: {
                hostHash: "abc123hosthash",
                redacted: true,
              },
              redacted: true,
            },
          },
        },
      },
    });

    expect(answer).toBe([
      "Channel Publish preview created through AgentNexus Tool Gateway.",
      "tool: channel_publish_preview",
      "channel_type: webhook",
      "requires_approval: true",
      "risk_label: approval_required",
      "target_host_hash: abc123hosthash",
      "redacted_draft: bodyPreview=[redacted], payloadKeys=body, summary, title",
      "safety_boundary: preview only from runtime; delivery requires AgentNexus approval; no Slack, Discord, Telegram, webhook URL, signing secret, or channel secret is exposed",
      "source: AgentNexus Channel Publish webhook pilot",
    ].join("\n"));
    expect(answer).not.toContain("Private payload");
    expect(answer).not.toMatch(/https:\/\/webhook\.site|signing_secret|SLACK_BOT_TOKEN|discord\.com\/api\/webhooks|api\.telegram\.org|Bearer/i);
  });

  it("formats runtime session export artifacts with repo-safe boundaries", () => {
    const answer = formatAgentNexusRuntimeToolAnswer({
      request: {
        tool: "runtime_session_export",
        intent: "runtime_session_export",
        args: {
          sourceWorkflow: "workspace-file-report-generation",
          reportTitle: "Report artifact generated in AgentC Runtime",
        },
      },
      result: {
        ok: true,
        status: 200,
        body: {
          data: {
            result: {
              reportTitle: "Report artifact generated in AgentC Runtime",
              sourceWorkflow: "workspace-file-report-generation",
              markdown: [
                "# Report artifact generated in AgentC Runtime",
                "",
                "## Source workflow result",
                "- source_workflow: workspace-file-report-generation",
                "",
                "## Export boundary",
                "- repo_safe_metadata: hashes, counts, timestamps, and redaction status only",
                "",
                "## Scanner status",
                "- metadata_only_after_scan",
                "",
                "## Evidence fields",
                "- runtimeSessionExportEvidence",
              ].join("\n"),
              exportBoundary: {
                repoSafeExportMode: "metadata_only_after_scan",
                rawTranscriptInRepoEvidence: false,
              },
              evidence: {
                section: "runtimeSessionExportEvidence",
                redacted: true,
              },
              redacted: true,
            },
          },
        },
      },
    });

    expect(answer).toContain("# Report artifact generated in AgentC Runtime");
    expect(answer).toContain("## Source workflow result");
    expect(answer).toContain("runtimeSessionExportEvidence");
    expect(answer).toContain("repo_safe_metadata");
    expect(answer).toContain("metadata_only_after_scan");
    expect(answer).toContain("source: AgentNexus governed runtime session export");
    expect(answer).not.toMatch(/raw transcript included|customer@example.com|Bearer|access_token|refresh_token|sk-[A-Za-z0-9._-]{16,}/i);
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

  it("formats Google Sheets reads as strict redacted metadata only", () => {
    const answer = formatAgentNexusRuntimeToolAnswer({
      request: {
        tool: "sheets_read_range",
        intent: "google_sheets_read",
        args: {
          spreadsheetId: "1-fgOfxIyWxAirwmfuphvBUG31kVyW54ytvLUNW4yeFg",
          range: "Sheet1!A1:Z20",
          requestedWrite: true,
        },
      },
      result: {
        ok: true,
        status: 200,
        body: {
          data: {
            result: {
              readOnly: true,
              redacted: true,
              resultType: "spreadsheet_values",
              source: "authorized Google Sheets read",
              range: "Sheet1!A1:Z20",
              rowCount: 3,
              columnCount: 2,
              headers: ["Metric", "Status"],
              previewRows: [
                ["GWS read", "Pass"],
                ["Owner", "[redacted]"],
              ],
            },
          },
        },
      },
    });

    expect(answer).toBe([
      "source: authorized Google Sheets read",
      "range: Sheet1!A1:Z20",
      "rowCount: 3",
      "columnCount: 2",
    ].join("\n"));
    expect(answer).not.toContain("Google Sheets read completed through AgentNexus Tool Gateway.");
    expect(answer).not.toContain("row_count");
    expect(answer).not.toContain("column_count");
    expect(answer).not.toContain("headers:");
    expect(answer).not.toContain("preview:");
    expect(answer).not.toContain("GWS read | Pass");
    expect(answer).not.toContain("Google Sheets write was not executed.");
    expect(answer).not.toContain("redaction:");
    expect(answer).not.toContain("1-fgOfxIyWxAirwmfuphvBUG31kVyW54ytvLUNW4yeFg");
    expect(answer).not.toMatch(/person@example.com|access_token|refresh_token|Bearer/i);
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

  it("formats search results with summaries and concrete source URLs", () => {
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
              answer: "FDA updated software medical device guidance.",
              citations: [
                {
                  title: "FDA software as a medical device",
                  url: "https://www.fda.gov/medical-devices/software-medical-device-samd",
                  snippet: "FDA explains software as a medical device policy updates.",
                },
              ],
            },
          },
        },
      },
    });

    expect(answer).toContain("Cited web search completed through AgentNexus Tool Gateway.");
    expect(answer).toContain("1. FDA software as a medical device");
    expect(answer).toContain("brief_summary: FDA explains software as a medical device policy updates.");
    expect(answer).toContain("source_url: https://www.fda.gov/medical-devices/software-medical-device-samd");
    expect(answer).toContain("https://www.fda.gov/medical-devices/software-medical-device-samd");
    expect(answer).not.toMatch(/api[_-]?key|Bearer|tvly-|brave/i);
  });

  it("formats public GitHub repo reads with README evidence and no credentials", () => {
    const answer = formatAgentNexusRuntimeToolAnswer({
      request: {
        tool: "github_public_repo_read",
        intent: "github_public_repo_read",
        args: { url: "https://github.com/zdqsgithub/openclaw-agentnexus" },
      },
      result: {
        ok: true,
        status: 200,
        body: {
          data: {
            result: {
              repo: "zdqsgithub/openclaw-agentnexus",
              description: "AgentNexus-managed OpenClaw runtime fork",
              fileEvidence: ["README.md"],
              readme: {
                path: "README.md",
                excerpt: "<h3>Runtime Tool Gateway client documentation.</h3><p>Do not execute repo code.</p><img src=\"https://img.shields.io/badge/demo",
              },
              sourceUrls: [
                "https://github.com/zdqsgithub/openclaw-agentnexus",
              ],
              redacted: true,
            },
          },
        },
      },
    });

    expect(answer).toContain("Public GitHub repo read completed through AgentNexus Tool Gateway.");
    expect(answer).toContain("repo: zdqsgithub/openclaw-agentnexus");
    expect(answer).toContain("README.md");
    expect(answer).toContain("Runtime Tool Gateway client documentation.");
    expect(answer).not.toContain("<h3>");
    expect(answer).not.toContain("</p>");
    expect(answer).not.toContain("<img");
    expect(answer).not.toContain("img.shields.io");
    expect(answer).not.toMatch(/github_pat|ghp_|Bearer|private repo/i);
  });

  it("summarizes previous redacted Tool Gateway search results for follow-up requests", async () => {
    const reply = await resolveAgentNexusRuntimeTextReply({
      text: "summarize the news for me",
      env: {
        OPENCLAW_MANAGED_HEADLESS: "1",
        OPENROUTER_API_KEY: "openrouter-key",
      },
      fetchFn: vi.fn(async () => {
        throw new Error("direct model path should not be used");
      }) as unknown as typeof fetch,
      conversationText: [
        "Cited web search completed through AgentNexus Tool Gateway.",
        "",
        "1. California storm warning",
        "brief_summary: Officials warned residents about a fast-moving storm.",
        "source_url: https://example.com/california-storm",
      ].join("\n"),
    } as Parameters<typeof resolveAgentNexusRuntimeTextReply>[0] & { conversationText: string });

    expect(reply).toMatchObject({
      adapter: "agentnexus-tool-gateway",
    });
    expect(reply?.content).toContain("Summary of previous Tool Gateway search results");
    expect(reply?.content).toContain("California storm warning");
    expect(reply?.content).toContain("https://example.com/california-storm");
    expect(reply?.content).not.toContain("I can't access live news");
  });

  it("prioritizes previous search result summaries over a fresh search intent", async () => {
    const fetchFn = vi.fn(async () => {
      throw new Error("fresh search should not be executed for search-results follow-up");
    }) as unknown as typeof fetch;

    const reply = await resolveAgentNexusRuntimeTextReply({
      text: "Summarize those search results in 3 bullets and keep the source URLs.",
      env: {
        OPENCLAW_MANAGED_HEADLESS: "1",
        OPENROUTER_API_KEY: "openrouter-key",
        AGENTNEXUS_TOOL_GATEWAY_URL: "https://agtnx.ai/api/runtime/tools/execute",
        AGENTNEXUS_RUNTIME_TOKEN: "runtime-token",
      },
      fetchFn,
      conversationText: [
        "Cited web search completed through AgentNexus Tool Gateway.",
        "",
        "1. California storm warning",
        "brief_summary: Officials warned residents about a fast-moving storm.",
        "source_url: https://example.com/california-storm",
      ].join("\n"),
    } as Parameters<typeof resolveAgentNexusRuntimeTextReply>[0] & { conversationText: string });

    expect(fetchFn).not.toHaveBeenCalled();
    expect(reply).toMatchObject({
      adapter: "agentnexus-tool-gateway",
    });
    expect(reply?.content).toContain("Summary of previous Tool Gateway search results");
    expect(reply?.content).toContain("California storm warning");
    expect(reply?.content).toContain("https://example.com/california-storm");
  });

  it("turns previous redacted Tool Gateway search results into a structured research brief", async () => {
    const fetchFn = vi.fn(async () => {
      throw new Error("fresh search should not be executed for research-brief follow-up");
    }) as unknown as typeof fetch;

    const reply = await resolveAgentNexusRuntimeTextReply({
      text: [
        "Create a concise Markdown research brief from native Tool Gateway results.",
        "Include exactly these headings: Research brief from native Tool Gateway results, Executive summary, Source table, Demo takeaway.",
        "Do not say you cannot browse.",
      ].join(" "),
      env: {
        OPENCLAW_MANAGED_HEADLESS: "1",
        OPENROUTER_API_KEY: "openrouter-key",
        AGENTNEXUS_TOOL_GATEWAY_URL: "https://agtnx.ai/api/runtime/tools/execute",
        AGENTNEXUS_RUNTIME_TOKEN: "runtime-token",
      },
      fetchFn,
      conversationText: [
        "Cited web search completed through AgentNexus Tool Gateway.",
        "",
        "1. AI agent runtime governance guide",
        "brief_summary: A public guide explains lease, audit, and policy controls for agent runtimes.",
        "source_url: https://example.com/runtime-governance",
        "",
        "2. Tool gateway control plane",
        "brief_summary: A product article describes server-side tool mediation and redacted evidence.",
        "source_url: https://example.com/tool-gateway-control",
      ].join("\n"),
    } as Parameters<typeof resolveAgentNexusRuntimeTextReply>[0] & { conversationText: string });

    expect(fetchFn).not.toHaveBeenCalled();
    expect(reply).toMatchObject({
      adapter: "agentnexus-tool-gateway",
    });
    expect(reply?.content).toContain("# Research brief from native Tool Gateway results");
    expect(reply?.content).toContain("## Executive summary");
    expect(reply?.content).toContain("## Source table");
    expect(reply?.content).toContain("## Demo takeaway");
    expect(reply?.content).toContain("| Source | Brief summary | URL |");
    expect(reply?.content).toContain("AI agent runtime governance guide");
    expect(reply?.content).toContain("https://example.com/runtime-governance");
    expect(reply?.content).toContain("https://example.com/tool-gateway-control");
    expect(reply?.content).toContain("source: previous redacted AgentNexus Tool Gateway web_search result");
    expect(reply?.content).not.toMatch(/can't browse|cannot browse|api[_-]?key|Bearer/i);
  });

  it("turns previous redacted GitHub repo evidence into a structured implementation plan", async () => {
    const fetchFn = vi.fn(async () => {
      throw new Error("fresh model or tool request should not be executed for repo-plan follow-up");
    }) as unknown as typeof fetch;

    const reply = await resolveAgentNexusRuntimeTextReply({
      text: [
        "Create a concise Markdown implementation plan from native GitHub repo evidence.",
        "Include exactly these headings: Implementation plan from native GitHub repo evidence, Repo summary, Key files, Implementation steps, Demo takeaway.",
        "Do not say you cannot access GitHub. Do not execute repo code.",
      ].join(" "),
      env: {
        OPENCLAW_MANAGED_HEADLESS: "1",
        OPENROUTER_API_KEY: "openrouter-key",
        AGENTNEXUS_TOOL_GATEWAY_URL: "https://agtnx.ai/api/runtime/tools/execute",
        AGENTNEXUS_RUNTIME_TOKEN: "runtime-token",
      },
      fetchFn,
      conversationText: [
        "Public GitHub repo read completed through AgentNexus Tool Gateway.",
        "",
        "repo: ClawBio/ClawBio",
        "description: The first bioinformatics-native AI agent skill library.",
        "file_evidence: README.md, skills/README.md",
        "readme_excerpt: ClawBio is a bioinformatics-native AI agent skill library built on OpenClaw.",
        "redaction: GitHub credentials and runtime-held GitHub tokens are not exposed.",
      ].join("\n"),
    } as Parameters<typeof resolveAgentNexusRuntimeTextReply>[0] & { conversationText: string });

    expect(fetchFn).not.toHaveBeenCalled();
    expect(reply).toMatchObject({
      adapter: "agentnexus-tool-gateway",
    });
    expect(reply?.content).toContain("# Implementation plan from native GitHub repo evidence");
    expect(reply?.content).toContain("## Repo summary");
    expect(reply?.content).toContain("## Key files");
    expect(reply?.content).toContain("## Implementation steps");
    expect(reply?.content).toContain("## Demo takeaway");
    expect(reply?.content).toContain("ClawBio/ClawBio");
    expect(reply?.content).toContain("README.md");
    expect(reply?.content).toContain("source: previous redacted AgentNexus Tool Gateway github_public_repo_read result");
    expect(reply?.content).not.toMatch(/cannot access GitHub|can't access GitHub|github_pat|ghp_|Bearer|private repo/i);
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
      "redacted: true",
    ].join("\n"));
    expect(answer).not.toContain("private raw input");
    expect(answer).not.toContain("manifestHash");
    expect(answer).not.toContain("Bearer");
  });

  it("formats governed runtime cron request results with approval and safety boundaries", () => {
    const answer = formatAgentNexusRuntimeToolAnswer({
      request: {
        tool: "runtime_cron_request",
        intent: "runtime_cron_request",
        args: {
          scheduleKind: "tool_gateway_read",
          toolId: "web_search",
          actionId: "web_search",
          cronExpression: "0 15 * * 1",
          timezone: "UTC",
          costCapCents: 25,
          retryLimit: 1,
        },
      },
      result: {
        ok: true,
        status: 200,
        body: {
          data: {
            result: {
              id: "runtime-cron-1",
              status: "requested",
              scheduleKind: "tool_gateway_read",
              timezone: "UTC",
              costCapCents: 25,
              retryLimit: 1,
              requiresApproval: true,
              redacted: true,
            },
          },
        },
      },
    });

    expect(answer).toBe([
      "Runtime cron request created through AgentNexus Tool Gateway.",
      "tool: runtime_cron_request",
      "cron_job_id: runtime-cron-1",
      "status: requested",
      "schedule_kind: tool_gateway_read",
      "approval_required: true",
      "timezone: UTC",
      "retry_limit: 1",
      "cost_cap_cents: 25",
      "safety_boundary: no cron shell, no cron browser, no Google write, no channel publish, no production secrets",
      "source: AgentNexus governed runtime cron",
    ].join("\n"));
    expect(answer).not.toMatch(/Bearer|OPENROUTER_API_KEY|OAuth|ya29\.|sk-[A-Za-z0-9._-]+/i);
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
