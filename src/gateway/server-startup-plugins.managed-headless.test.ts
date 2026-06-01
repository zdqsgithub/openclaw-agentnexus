import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";

const hoisted = vi.hoisted(() => ({
  applyPluginAutoEnable: vi.fn((params: { config: OpenClawConfig }) => ({
    config: {
      ...params.config,
      plugins: {
        entries: {
          feishu: { enabled: true },
        },
      },
    },
    changes: ["feishu"],
    autoEnabledReasons: {
      feishu: ["feishu configured"],
    },
  })),
  runChannelPluginStartupMaintenance: vi.fn(async () => undefined),
  runStartupSessionMigration: vi.fn(async () => undefined),
  initSubagentRegistry: vi.fn(),
  resolveDefaultAgentId: vi.fn(() => "main"),
  resolveAgentWorkspaceDir: vi.fn(() => "/tmp/openclaw-workspace"),
  resolveConfiguredDeferredChannelPluginIds: vi.fn(() => ["feishu"]),
  resolveGatewayStartupPluginIds: vi.fn(() => ["feishu"]),
  loadGatewayStartupPlugins: vi.fn(() => ({
    pluginRegistry: { plugins: [{ id: "feishu", status: "loaded" }], diagnostics: [] },
    gatewayMethods: ["chat.history", "models.list", "feishu.send"],
  })),
  getActivePluginRegistry: vi.fn(() => undefined),
  setActivePluginRegistry: vi.fn(),
}));

vi.mock("../config/plugin-auto-enable.js", () => ({
  applyPluginAutoEnable: hoisted.applyPluginAutoEnable,
}));

vi.mock("../channels/plugins/lifecycle-startup.js", () => ({
  runChannelPluginStartupMaintenance: hoisted.runChannelPluginStartupMaintenance,
}));

vi.mock("./server-startup-session-migration.js", () => ({
  runStartupSessionMigration: hoisted.runStartupSessionMigration,
}));

vi.mock("../agents/subagent-registry.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../agents/subagent-registry.js")>()),
  initSubagentRegistry: hoisted.initSubagentRegistry,
}));

vi.mock("../agents/agent-scope.js", () => ({
  resolveDefaultAgentId: hoisted.resolveDefaultAgentId,
  resolveAgentWorkspaceDir: hoisted.resolveAgentWorkspaceDir,
}));

vi.mock("../plugins/channel-plugin-ids.js", () => ({
  resolveConfiguredDeferredChannelPluginIds: hoisted.resolveConfiguredDeferredChannelPluginIds,
  resolveGatewayStartupPluginIds: hoisted.resolveGatewayStartupPluginIds,
}));

vi.mock("./server-plugin-bootstrap.js", () => ({
  loadGatewayStartupPlugins: hoisted.loadGatewayStartupPlugins,
}));

vi.mock("../plugins/runtime.js", () => ({
  getActivePluginRegistry: hoisted.getActivePluginRegistry,
  setActivePluginRegistry: hoisted.setActivePluginRegistry,
}));

function createConfig(): OpenClawConfig {
  return {
    gateway: { mode: "local" },
    models: {
      providers: {
        openrouter: {
          baseUrl: "https://openrouter.ai/api/v1",
          models: [{
            id: "moonshotai/kimi-k2.5",
            name: "Kimi K2.5",
            contextWindow: 131_072,
            input: ["text"],
            reasoning: false,
            maxTokens: 8_192,
            cost: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
            },
          }],
        },
      },
    },
    agents: {
      defaults: {
        model: "openrouter/moonshotai/kimi-k2.5",
      },
    },
  } as OpenClawConfig;
}

function createLog() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
}

describe("prepareGatewayPluginBootstrap managed headless", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("bypasses plugin discovery and startup maintenance when background services are disabled", async () => {
    const { prepareGatewayPluginBootstrap } = await import("./server-startup-plugins.js");
    const cfg = createConfig();

    const result = await prepareGatewayPluginBootstrap({
      cfgAtStart: cfg,
      startupRuntimeConfig: cfg,
      minimalTestGateway: false,
      backgroundServicesDisabled: true,
      log: createLog(),
    });

    expect(hoisted.runChannelPluginStartupMaintenance).not.toHaveBeenCalled();
    expect(hoisted.runStartupSessionMigration).not.toHaveBeenCalled();
    expect(hoisted.applyPluginAutoEnable).not.toHaveBeenCalled();
    expect(hoisted.resolveConfiguredDeferredChannelPluginIds).not.toHaveBeenCalled();
    expect(hoisted.resolveGatewayStartupPluginIds).not.toHaveBeenCalled();
    expect(hoisted.loadGatewayStartupPlugins).not.toHaveBeenCalled();
    expect(result.gatewayPluginConfigAtStart).toBe(cfg);
    expect(result.deferredConfiguredChannelPluginIds).toEqual([]);
    expect(result.startupPluginIds).toEqual([]);
    expect(result.pluginRegistry.plugins).toEqual([]);
    expect(result.baseGatewayMethods).toEqual(result.baseMethods);
  });

  it("keeps normal non-headless startup plugin bootstrap behavior", async () => {
    const { prepareGatewayPluginBootstrap } = await import("./server-startup-plugins.js");
    const cfg = createConfig();

    const result = await prepareGatewayPluginBootstrap({
      cfgAtStart: cfg,
      startupRuntimeConfig: cfg,
      minimalTestGateway: false,
      backgroundServicesDisabled: false,
      log: createLog(),
    });

    expect(hoisted.runChannelPluginStartupMaintenance).toHaveBeenCalledTimes(1);
    expect(hoisted.runStartupSessionMigration).toHaveBeenCalledTimes(1);
    expect(hoisted.applyPluginAutoEnable).toHaveBeenCalledTimes(1);
    expect(hoisted.resolveConfiguredDeferredChannelPluginIds).toHaveBeenCalledTimes(1);
    expect(hoisted.resolveGatewayStartupPluginIds).toHaveBeenCalledTimes(1);
    expect(hoisted.loadGatewayStartupPlugins).toHaveBeenCalledTimes(1);
    expect(result.pluginRegistry.plugins).toEqual([{ id: "feishu", status: "loaded" }]);
    expect(result.baseGatewayMethods).toContain("feishu.send");
  });
});
