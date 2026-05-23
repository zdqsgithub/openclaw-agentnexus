import { describe, expect, it } from "vitest";
import { __testOnlyOpenAiHttp } from "./openai-http.js";

const {
  formatAgentNexusRuntimeSkillResult,
  parseAgentNexusRuntimeSkillCommand,
  resolveChatCompletionUsage,
} = __testOnlyOpenAiHttp;

describe("resolveChatCompletionUsage", () => {
  it("maps agentMeta.usage to OpenAI prompt/completion/total fields", () => {
    const result = {
      meta: {
        agentMeta: {
          usage: { input: 120, output: 42, cacheRead: 10, total: 172 },
        },
      },
    };

    expect(resolveChatCompletionUsage(result)).toEqual({
      prompt_tokens: 130,
      completion_tokens: 42,
      total_tokens: 172,
    });
  });

  it("falls back to agentMeta.lastCallUsage when agentMeta.usage is missing", () => {
    const result = {
      meta: {
        agentMeta: {
          lastCallUsage: { input: 80, output: 20, total: 100 },
        },
      },
    };

    expect(resolveChatCompletionUsage(result)).toEqual({
      prompt_tokens: 80,
      completion_tokens: 20,
      total_tokens: 100,
    });
  });

  it("falls back to agentMeta.lastCallUsage when agentMeta.usage is all zero", () => {
    const result = {
      meta: {
        agentMeta: {
          usage: { input: 0, output: 0, total: 0 },
          lastCallUsage: { input: 55, output: 7, total: 62 },
        },
      },
    };

    expect(resolveChatCompletionUsage(result)).toEqual({
      prompt_tokens: 55,
      completion_tokens: 7,
      total_tokens: 62,
    });
  });

  it("returns zeros when both agentMeta.usage and lastCallUsage are absent", () => {
    const result = { meta: { agentMeta: {} } };

    expect(resolveChatCompletionUsage(result)).toEqual({
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
    });
  });

  it("returns zeros when the result has no meta at all", () => {
    expect(resolveChatCompletionUsage({})).toEqual({
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
    });
    expect(resolveChatCompletionUsage(null)).toEqual({
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
    });
  });
});

describe("AgentNexus runtime skill command helpers", () => {
  it("parses governed skill slash commands without accepting arbitrary text", () => {
    expect(parseAgentNexusRuntimeSkillCommand("/skill demo-summary-style summarize this")).toEqual({
      skillId: "demo-summary-style",
      input: "summarize this",
    });
    expect(parseAgentNexusRuntimeSkillCommand(" /skill runtime-session-qa ")).toEqual({
      skillId: "runtime-session-qa",
      input: "",
    });
    expect(parseAgentNexusRuntimeSkillCommand("please use a skill")).toBeNull();
    expect(parseAgentNexusRuntimeSkillCommand("/skill ../../etc/passwd nope")).toBeNull();
  });

  it("formats governed skill results without exposing raw payload envelopes", () => {
    const text = formatAgentNexusRuntimeSkillResult({
      skillStatus: "executed",
      skillId: "demo-summary-style",
      kind: "prompt_skill",
      version: "1.0.0",
      output: {
        summary: "Redacted summary",
        ignoredRaw: "do not print",
      },
      redacted: true,
    });

    expect(text).toContain("skill_status: executed");
    expect(text).toContain("skill_id: demo-summary-style");
    expect(text).toContain("source: AgentNexus governed skills catalog");
    expect(text).toContain("summary: Redacted summary");
    expect(text).not.toContain("ignoredRaw");
  });
});
