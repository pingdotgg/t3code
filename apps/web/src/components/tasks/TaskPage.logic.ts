import type { OrchestrationTaskShell } from "@t3tools/contracts";
import type { EnvironmentShellStatus } from "@t3tools/client-runtime/state/shell";

/** Only an authoritative shell plus the archive inventory can prove a task is missing. */
export function taskPageAvailability(input: {
  shellStatus: EnvironmentShellStatus;
  disconnected?: boolean;
  supportsTasks: boolean | undefined;
  task: OrchestrationTaskShell | null;
  archivedTask: OrchestrationTaskShell | null;
  archiveLoading: boolean;
  archiveError: string | null;
  hasPrimaryProject: boolean;
}) {
  if (input.supportsTasks === false) return "unsupported";
  if (input.task?.archivedAt || input.archivedTask) return "archived";
  if (input.task) {
    if (input.hasPrimaryProject) return input.shellStatus === "live" ? "ready" : "cached";
    return input.shellStatus === "live" ? "project-missing" : "loading";
  }
  if (input.shellStatus === "cached" || input.disconnected) return "disconnected";
  if (input.shellStatus !== "live" || input.archiveLoading) return "loading";
  return input.archiveError ? "archive-error" : "missing";
}

/** Share an in-flight preparation across effect replay without retaining completed page drafts. */
export function createTaskPageDraftPreparation<T>() {
  let pending: { key: string; promise: Promise<T> } | null = null;
  return (key: string, prepare: () => Promise<T>) => {
    if (pending?.key === key) return pending.promise;
    const promise = prepare();
    pending = { key, promise };
    return promise;
  };
}

/** A foreground promotion never replaces its composer before canonical navigation. */
export function taskPageBackgroundDraftTransition(input: {
  wasBackground: boolean;
  backgroundPending: boolean;
  threadExists: boolean;
}) {
  if (!input.wasBackground || input.backgroundPending) return "keep";
  return input.threadExists ? "next-draft" : "failed";
}
