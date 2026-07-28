import { threadRuntimeHasInterruptibleRun } from "@t3tools/client-runtime/state/thread-execution";
import type { ThreadRuntimeSummary } from "@t3tools/client-runtime/state/models";

/**
 * Archiving may discard queued work, but it must not detach a provider while
 * that provider is still executing a turn.
 */
export function threadCanArchive(runtime: ThreadRuntimeSummary | null | undefined): boolean {
  return !threadRuntimeHasInterruptibleRun(runtime);
}
