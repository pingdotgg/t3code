import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";

function firstParam(value: unknown): unknown {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * Settle and Snooze put the open thread away, so a successful one returns to the list, where
 * the undo notice shows. The action lands after a server round trip, so a failure, a newer
 * selection or a covering screen keeps the user where they are. A split view already shows
 * the list and keeps the thread open.
 */
export function shouldLeavePutAwayThread(input: {
  readonly succeeded: boolean;
  readonly usesSplitView: boolean;
  readonly focused: boolean;
  readonly routeParams: object | undefined;
  readonly thread: Pick<EnvironmentThreadShell, "environmentId" | "id">;
}): boolean {
  if (!input.succeeded || input.usesSplitView || !input.focused) return false;
  const params = input.routeParams as
    | { readonly environmentId?: unknown; readonly threadId?: unknown }
    | undefined;
  return (
    firstParam(params?.environmentId) === input.thread.environmentId &&
    firstParam(params?.threadId) === input.thread.id
  );
}
