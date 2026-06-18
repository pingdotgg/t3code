import {
  THREAD_CONVERSATION_MAX_WIDTH_PX,
  THREAD_CONVERSATION_MIN_WIDTH_PX,
} from "@t3tools/contracts/ipc";

export { THREAD_CONVERSATION_MAX_WIDTH_PX, THREAD_CONVERSATION_MIN_WIDTH_PX };

export function normalizeThreadConversationMaxWidth(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }
  return Math.round(
    Math.min(THREAD_CONVERSATION_MAX_WIDTH_PX, Math.max(THREAD_CONVERSATION_MIN_WIDTH_PX, value)),
  );
}
