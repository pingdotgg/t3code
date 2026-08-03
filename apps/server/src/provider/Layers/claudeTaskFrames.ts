/**
 * Pure decisions for the Claude SDK's `system/task_*` frames.
 *
 * Lives outside `ClaudeAdapter.ts` so the fork's diff inside that file stays at
 * case-body size, and so each rule can be pinned by a named test.
 */

export type ClaudeTaskStatus = "completed" | "failed" | "stopped";

const KNOWN_TASK_STATUSES: ReadonlySet<string> = new Set<ClaudeTaskStatus>([
  "completed",
  "failed",
  "stopped",
]);

/**
 * A `.d.ts` is a declaration, not a validator: a CLI release emitting a fourth
 * status would otherwise flow through unmodelled. Unknown/absent collapses to
 * `failed` — a dead agent must never render as a green check.
 */
export function normalizeClaudeTaskStatus(raw: unknown): ClaudeTaskStatus {
  return typeof raw === "string" && KNOWN_TASK_STATUSES.has(raw)
    ? (raw as ClaudeTaskStatus)
    : "failed";
}

/**
 * Maps a `task_updated.patch.status` to a terminal task status, or `null` when
 * the patch reports a still-live task. `killed` is terminal and counts as a
 * failure; `pending`/`running`/`paused` are not terminal.
 */
export function terminalStatusFromTaskPatch(patch: {
  readonly status?: string | undefined;
  readonly error?: string | undefined;
}): ClaudeTaskStatus | null {
  switch (patch.status) {
    case "completed":
      return "completed";
    case "failed":
    case "killed":
      return "failed";
    default:
      return null;
  }
}

/**
 * The subset of `terminalStatusFromTaskPatch` that the adapter may turn into a
 * synthetic `task.completed`.
 *
 * `completed` and `failed` are always followed by a `task_notification`, which
 * emits its own `task.completed`; synthesizing one for them too persisted TWO
 * activity rows per task. The card is terminal-sticky so it rendered correctly,
 * but the duplicates are permanent in the event store and any other consumer
 * counting completions double-counts. `killed` is the one status that never
 * produces a notification, which is the case the synthesis exists for.
 */
export function syntheticCompletionFromTaskPatch(patch: {
  readonly status?: string | undefined;
  readonly error?: string | undefined;
}): ClaudeTaskStatus | null {
  return patch.status === "killed" ? "failed" : null;
}

/**
 * The SDK types `usage` as `{total_tokens, tool_uses, duration_ms}` but t3's
 * contract carried it as opaque `unknown`. Projects the typed triple, keeping
 * only the keys actually present so optional contract fields stay absent.
 */
export function taskUsageFields(
  usage:
    | {
        readonly total_tokens?: number | undefined;
        readonly tool_uses?: number | undefined;
        readonly duration_ms?: number | undefined;
      }
    | undefined,
): { totalTokens?: number; toolUses?: number; durationMs?: number } {
  if (!usage) {
    return {};
  }
  return {
    ...(isNonNegativeInteger(usage.total_tokens) ? { totalTokens: usage.total_tokens } : {}),
    ...(isNonNegativeInteger(usage.tool_uses) ? { toolUses: usage.tool_uses } : {}),
    ...(isNonNegativeInteger(usage.duration_ms) ? { durationMs: usage.duration_ms } : {}),
  };
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
