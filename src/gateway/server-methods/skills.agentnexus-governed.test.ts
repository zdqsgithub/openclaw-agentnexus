import { describe, expect, it, vi } from "vitest";

vi.mock("../../config/config.js", () => ({
  loadConfig: () => ({}),
  writeConfigFile: async () => undefined,
}));

vi.mock("../../agents/agent-scope.js", () => ({
  listAgentIds: () => ["main"],
  resolveAgentWorkspaceDir: () => "/tmp/openclaw-agent",
  resolveDefaultAgentId: () => "main",
}));

vi.mock("../../agents/workspace-dirs.js", () => ({
  listAgentWorkspaceDirs: () => ["/tmp/openclaw-agent"],
}));

vi.mock("../../agents/skills-status.js", () => ({
  buildWorkspaceSkillStatus: () => ({
    workspaceDir: "/tmp/openclaw-agent",
    managedSkillsDir: "/tmp/openclaw-skills",
    skills: [],
  }),
}));

vi.mock("../../agents/skills.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../agents/skills.js")>();
  return {
    ...actual,
    loadWorkspaceSkillEntries: () => [],
  };
});

vi.mock("../../agents/exec-defaults.js", () => ({
  canExecRequestNode: () => false,
}));

vi.mock("../../infra/skills-remote.js", () => ({
  getRemoteSkillEligibility: () => ({}),
}));

const { skillsHandlers } = await import("./skills.js");

describe("skills.status AgentNexus governed skills", () => {
  it("appends governed skills from the AgentNexus runtime manifest without exposing runtime credentials", async () => {
    const previousManifestUrl = process.env.AGENTNEXUS_TOOL_MANIFEST_URL;
    const previousToken = process.env.AGENTNEXUS_RUNTIME_TOKEN;
    process.env.AGENTNEXUS_TOOL_MANIFEST_URL = "https://agtnx.ai/api/runtime/tools/manifest";
    process.env.AGENTNEXUS_RUNTIME_TOKEN = "runtime-token-secret";
    const fetchFn = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        data: {
          manifest: {
            governedSkills: [
              {
                id: "demo-summary-style",
                name: "Demo-safe summary style",
                description: "Transform a note into a redacted summary.",
                kind: "prompt_skill",
                enabled: true,
                editable: true,
                version: "1.0.0",
                manifestHash: "sha256:" + "a".repeat(64),
                redacted: true,
              },
            ],
          },
        },
      }),
    })) as unknown as typeof fetch;
    vi.stubGlobal("fetch", fetchFn);

    let result: any = null;
    try {
      await skillsHandlers["skills.status"]({
        params: {},
        req: {} as never,
        client: null as never,
        isWebchatConnect: () => false,
        context: {} as never,
        respond: (success, value, err) => {
          expect(success).toBe(true);
          expect(err).toBeUndefined();
          result = value;
        },
      });
    } finally {
      if (previousManifestUrl === undefined) {
        delete process.env.AGENTNEXUS_TOOL_MANIFEST_URL;
      } else {
        process.env.AGENTNEXUS_TOOL_MANIFEST_URL = previousManifestUrl;
      }
      if (previousToken === undefined) {
        delete process.env.AGENTNEXUS_RUNTIME_TOKEN;
      } else {
        process.env.AGENTNEXUS_RUNTIME_TOKEN = previousToken;
      }
      vi.unstubAllGlobals();
    }

    expect(fetchFn).toHaveBeenCalledWith(
      "https://agtnx.ai/api/runtime/tools/manifest",
      expect.objectContaining({
        method: "GET",
        redirect: "error",
        headers: expect.objectContaining({
          authorization: "Bearer runtime-token-secret",
        }),
      }),
    );
    expect(result.skills).toEqual([
      expect.objectContaining({
        skillKey: "demo-summary-style",
        source: "agentnexus-governed",
        eligible: true,
        disabled: false,
        filePath: "AgentNexus governed catalog",
      }),
    ]);
    expect(JSON.stringify(result)).not.toContain("runtime-token-secret");
  });
});
