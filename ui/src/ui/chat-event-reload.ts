import type { ChatEventPayload } from "./controllers/chat.ts";

function hasRenderableAssistantMessage(payload: ChatEventPayload): boolean {
  const message = payload.message;
  if (!message || typeof message !== "object") {
    return false;
  }
  const role = "role" in message ? message.role : undefined;
  if (role !== undefined && role !== "assistant") {
    return false;
  }
  if ("content" in message && Array.isArray(message.content)) {
    return message.content.some(
      (part) =>
        part &&
        typeof part === "object" &&
        "text" in part &&
        typeof part.text === "string" &&
        part.text.trim().length > 0,
    );
  }
  return "text" in message && typeof message.text === "string" && message.text.trim().length > 0;
}

export function shouldReloadHistoryForFinalEvent(payload?: ChatEventPayload): boolean {
  return Boolean(payload && payload.state === "final" && !hasRenderableAssistantMessage(payload));
}
