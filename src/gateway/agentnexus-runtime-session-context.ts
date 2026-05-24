import {
  resolveSessionStoreEntry,
  updateSessionStore,
  type SessionEntry,
} from "../config/sessions.js";

export async function ensureAgentNexusRuntimeSessionEntry(params: {
  storePath?: string;
  sessionKey: string;
  sessionId: string;
  sessionFile?: string;
  now: number;
}): Promise<SessionEntry | null> {
  const storePath = params.storePath?.trim();
  const sessionKey = params.sessionKey.trim();
  const sessionId = params.sessionId.trim();
  if (!storePath || !sessionKey || !sessionId) {
    return null;
  }

  return await updateSessionStore(
    storePath,
    (store) => {
      const resolved = resolveSessionStoreEntry({ store, sessionKey });
      const existing = resolved.existing;
      const next: SessionEntry = existing
        ? {
            ...existing,
            updatedAt: params.now,
          }
        : {
            sessionId,
            updatedAt: params.now,
            ...(params.sessionFile ? { sessionFile: params.sessionFile } : {}),
          };

      store[resolved.normalizedKey] = next;
      for (const legacyKey of resolved.legacyKeys) {
        delete store[legacyKey];
      }
      return next;
    },
    { activeSessionKey: sessionKey },
  );
}
