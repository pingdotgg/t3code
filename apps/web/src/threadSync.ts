import type { EnvironmentThreadStatus } from "@t3tools/client-runtime/state/threads";
import { msg } from "gt-react";

import { m, type MessageResolver } from "./i18n/messages";

export type ThreadSyncPhase = "loading" | "syncing" | "failed";

export function resolveThreadSyncPhase(input: {
  readonly detailExists: boolean;
  readonly shellExists: boolean;
  readonly status: EnvironmentThreadStatus;
  readonly hasError: boolean;
}): ThreadSyncPhase | null {
  if (!input.shellExists) {
    return null;
  }

  switch (input.status) {
    case "empty":
    case "cached":
    case "synchronizing":
      if (!input.detailExists) return "loading";
      return input.hasError ? "failed" : "syncing";
    case "deleted":
    case "live":
      return null;
  }
}

/**
 * A thread showing a cached copy that may be behind the server, so anything that sends waits
 * until it is live. A failed sync does not hold, so a broken sync never locks the person out,
 * and an unreachable environment keeps its own notice and send rules.
 */
export function isThreadCatchingUp(
  phase: ThreadSyncPhase | null,
  environmentUnavailable: boolean,
): boolean {
  return phase === "syncing" && !environmentUnavailable;
}

export function threadSyncLabel(phase: ThreadSyncPhase, resolve: MessageResolver = m): string {
  switch (phase) {
    case "loading":
      return resolve(msg("Loading messages..."));
    case "syncing":
      return resolve(msg("Syncing messages..."));
    case "failed":
      return resolve(msg("Could not sync messages"));
  }
}
