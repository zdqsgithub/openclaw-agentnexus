import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = join(import.meta.dirname, "..");

describe("Dockerfile.agentnexus", () => {
  it("keeps a non-GitHub Bun install fallback for remote builders", () => {
    const source = readFileSync(join(repoRoot, "Dockerfile.agentnexus"), "utf8");

    expect(source).toContain("https://bun.sh/install");
    expect(source).toContain('npm install -g "bun@${BUN_VERSION}"');
    expect(source).toContain("bun --version");
  });

  it("does not hard-fail the AgentNexus runtime image on optional Matrix native addon downloads", () => {
    const source = readFileSync(join(repoRoot, "Dockerfile.agentnexus"), "utf8");

    expect(source).toContain("Matrix native addon unavailable; continuing AgentNexus runtime build");
    expect(source).not.toContain("ERROR: matrix-sdk-crypto native addon missing");
  });
});
