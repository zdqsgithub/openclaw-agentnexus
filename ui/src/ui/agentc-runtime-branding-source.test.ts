import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const root = resolve(__dirname, "../../..");

function read(path: string) {
  return readFileSync(resolve(root, path), "utf8");
}

describe("AgentC Runtime visible branding", () => {
  it("brands the hosted control shell as AgentC Runtime", () => {
    const visibleSources = [
      "ui/index.html",
      "ui/public/manifest.webmanifest",
      "ui/public/sw.js",
      "ui/src/ui/app-render.ts",
      "ui/src/ui/components/dashboard-header.ts",
      "ui/src/ui/views/login-gate.ts",
      "ui/src/ui/views/chat.ts",
      "ui/src/ui/chat/realtime-talk.ts",
      "ui/src/ui/views/config-quick.ts",
      "agentnexus/runtime-manifest.json",
      "agentnexus/README.md",
    ].map(read);

    const combined = visibleSources.join("\n");

    expect(combined).toContain("AgentC Runtime");
    expect(combined).toContain("AgentC");
    expect(combined).not.toContain("OpenClaw Control");
    expect(combined).not.toContain(">OpenClaw<");
    expect(combined).not.toContain("alt=\"OpenClaw\"");
    expect(combined).not.toContain("Asking OpenClaw");
    expect(combined).not.toContain("AgentNexus OpenClaw Runtime");
  });

  it("keeps internal OpenClaw compatibility identifiers intact", () => {
    const manifest = read("agentnexus/runtime-manifest.json");
    const bootstrap = read("ui/src/ui/controllers/control-ui-bootstrap.test.ts");

    expect(manifest).toContain("\"id\": \"openclaw-agentnexus\"");
    expect(manifest).toContain("\"runtime\": \"clawbot\"");
    expect(bootstrap).toContain("/openclaw");
  });
});
