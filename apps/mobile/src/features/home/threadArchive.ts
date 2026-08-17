import type { ThreadRuntimeSummary } from "@t3tools/client-runtime/state/models";

/**
 * Archiving may discard queued work, but it must not detach a provider while
 * that provider is still executing a turn.
 */
export function threadCanArchive(runtime: ThreadRuntimeSummary | null | undefined): boolean {
  if (runtime?.status === "queued") {
    return runtime.activeRunId === null;
  }
  return (
    runtime?.status !== "preparing" &&
    runtime?.status !== "starting" &&
    runtime?.status !== "running"
  );
}
