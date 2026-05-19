import { describe, expect, it } from "vitest";
import { startGatewayEarlyRuntime } from "./server-startup-early.js";

describe("startGatewayEarlyRuntime", () => {
  function createEarlyRuntimeParams(
    overrides: Partial<Parameters<typeof startGatewayEarlyRuntime>[0]> = {},
  ): Parameters<typeof startGatewayEarlyRuntime>[0] {
    return {
      minimalTestGateway: true,
      cfgAtStart: {} as never,
      port: 18_789,
      gatewayTls: { enabled: false },
      tailscaleMode: "off" as never,
      log: {
        info: () => {},
        warn: () => {},
      },
      logDiscovery: {
        info: () => {},
        warn: () => {},
      },
      nodeRegistry: {} as never,
      broadcast: () => {},
      nodeSendToAllSubscribed: () => {},
      getPresenceVersion: () => 0,
      getHealthVersion: () => 0,
      refreshGatewayHealthSnapshot: async () => ({}) as never,
      logHealth: { error: () => {} },
      dedupe: new Map(),
      chatAbortControllers: new Map(),
      chatRunState: { abortedRuns: new Map() },
      chatRunBuffers: new Map(),
      chatDeltaSentAt: new Map(),
      chatDeltaLastBroadcastLen: new Map(),
      removeChatRun: () => {},
      agentRunSeq: new Map(),
      nodeSendToSession: () => {},
      skillsRefreshDelayMs: 30_000,
      getSkillsRefreshTimer: () => null,
      setSkillsRefreshTimer: () => {},
      loadConfig: () => ({}) as never,
      ...overrides,
    };
  }

  it("does not eagerly start the MCP loopback server", async () => {
    const earlyRuntime = await startGatewayEarlyRuntime(createEarlyRuntimeParams());

    expect(earlyRuntime).not.toHaveProperty("mcpServer");
  });

  it("keeps managed headless gateways from starting discovery and health maintenance", async () => {
    let healthRefreshCount = 0;

    const earlyRuntime = await startGatewayEarlyRuntime(
      createEarlyRuntimeParams({
        minimalTestGateway: false,
        backgroundServicesDisabled: true,
        refreshGatewayHealthSnapshot: async () => {
          healthRefreshCount += 1;
          return {} as never;
        },
      }),
    );

    expect(earlyRuntime.bonjourStop).toBeNull();
    expect(earlyRuntime.maintenance).toBeNull();
    expect(healthRefreshCount).toBe(0);
  });
});
