/**
 * Compute the duration-start timestamp for each message in a timeline.
 *
 * For the first assistant response after a user message, this is the user
 * message's `createdAt`.  For subsequent assistant responses within the same
 * turn, it advances to the previous assistant message's `completedAt` so that
 * each response shows its own incremental duration rather than the cumulative
 * time since the user sent the original message.
 */
export function computeMessageDurationStart(
  messages: ReadonlyArray<{
    id: string;
    role: "user" | "assistant" | "system";
    createdAt: string;
    completedAt?: string | undefined;
  }>,
): Map<string, string> {
  const result = new Map<string, string>();
  let lastBoundary: string | null = null;

  for (const message of messages) {
    if (message.role === "user") {
      lastBoundary = message.createdAt;
    }
    result.set(message.id, lastBoundary ?? message.createdAt);
    if (message.role === "assistant" && message.completedAt) {
      lastBoundary = message.completedAt;
    }
  }

  return result;
}
