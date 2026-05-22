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
});
