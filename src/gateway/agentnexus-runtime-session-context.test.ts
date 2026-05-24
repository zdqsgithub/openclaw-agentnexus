import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadSessionStore } from "../config/sessions.js";
import { ensureAgentNexusRuntimeSessionEntry } from "./agentnexus-runtime-session-context.js";

async function createStorePath(prefix: string) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  const storePath = path.join(dir, "sessions.json");
  await fs.writeFile(storePath, "{}", "utf-8");
  return storePath;
}

describe("AgentNexus runtime session context", () => {
  it("creates a stable store entry for Tool Gateway-injected runtime turns", async () => {
    const storePath = await createStorePath("anx-runtime-session-context-");

    await ensureAgentNexusRuntimeSessionEntry({
      storePath,
      sessionKey: "agent:main:qa-followup",
      sessionId: "first-runtime-run",
      now: 1779632496039,
    });

    const store = loadSessionStore(storePath);
    expect(store["agent:main:qa-followup"]).toMatchObject({
      sessionId: "first-runtime-run",
      updatedAt: 1779632496039,
    });
  });

  it("preserves the original session id so follow-up turns read prior results", async () => {
    const storePath = await createStorePath("anx-runtime-session-context-existing-");

    await ensureAgentNexusRuntimeSessionEntry({
      storePath,
      sessionKey: "agent:main:qa-followup",
      sessionId: "first-runtime-run",
      now: 100,
    });
    await ensureAgentNexusRuntimeSessionEntry({
      storePath,
      sessionKey: "agent:main:qa-followup",
      sessionId: "second-runtime-run",
      now: 200,
    });

    const store = loadSessionStore(storePath);
    expect(store["agent:main:qa-followup"]).toMatchObject({
      sessionId: "first-runtime-run",
      updatedAt: 200,
    });
  });
});
