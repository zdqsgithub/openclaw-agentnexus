import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveGatewayModelCatalogLoader } from "./server-model-catalog.js";

describe("resolveGatewayModelCatalogLoader", () => {
  it("uses a static configured catalog for managed headless gateways", async () => {
    const fallback = vi.fn(async () => [
      {
        id: "remote-model",
        name: "remote-model",
        provider: "remote",
      },
    ]);
    const cfg = {
      models: {
        providers: {
          openrouter: {
            models: [
              {
                id: "moonshotai/kimi-k2.6",
                name: "Kimi K2.6",
                contextWindow: 131_072,
                input: ["text"],
              },
            ],
          },
        },
      },
    } satisfies OpenClawConfig;

    const loader = resolveGatewayModelCatalogLoader({
      managedHeadlessGateway: true,
      getConfig: () => cfg,
      fallback,
    });

    await expect(loader()).resolves.toEqual([
      {
        id: "moonshotai/kimi-k2.6",
        name: "Kimi K2.6",
        provider: "openrouter",
        contextWindow: 131_072,
        input: ["text"],
      },
    ]);
    expect(fallback).not.toHaveBeenCalled();
  });

  it("uses the full catalog loader for normal gateways", async () => {
    const fallback = vi.fn(async () => [
      {
        id: "remote-model",
        name: "remote-model",
        provider: "remote",
      },
    ]);
    const loader = resolveGatewayModelCatalogLoader({
      managedHeadlessGateway: false,
      getConfig: () => ({}) as OpenClawConfig,
      fallback,
    });

    await expect(loader()).resolves.toEqual([
      {
        id: "remote-model",
        name: "remote-model",
        provider: "remote",
      },
    ]);
    expect(fallback).toHaveBeenCalledTimes(1);
  });
});
