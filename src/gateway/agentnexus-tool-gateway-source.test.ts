import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const source = fs.readFileSync(path.join(import.meta.dirname, "openai-http.ts"), "utf-8");

describe("AgentNexus runtime Tool Gateway source wiring", () => {
  it("checks AgentNexus Tool Gateway intents before direct OpenRouter fallback", () => {
    const toolGatewayIndex = source.indexOf("handleAgentNexusRuntimeToolGatewayChat");
    const directOpenRouterIndex = source.indexOf("requestDirectOpenRouterCompletion");

    expect(toolGatewayIndex).toBeGreaterThanOrEqual(0);
    expect(directOpenRouterIndex).toBeGreaterThanOrEqual(0);
    expect(toolGatewayIndex).toBeLessThan(directOpenRouterIndex);
  });

  it("does not expose runtime tokens in response metadata", () => {
    expect(source).toContain("agentnexus-tool-gateway");
    expect(source).not.toContain("runtimeToken:");
    expect(source).not.toContain("AGENTNEXUS_RUNTIME_TOKEN,");
  });
});
