import type { EnvironmentId, OrchestrationV2Run, RunId } from "@t3tools/contracts";
import { useSyncExternalStore } from "react";

import type { Thread } from "../../types";
import { useMediaQuery } from "../../hooks/useMediaQuery";
import { useServerConfigs } from "../../state/entities";
import { orchestrationEnvironment } from "../../state/orchestration";
import { useEnvironmentQuery } from "../../state/query";
import { announcedRun } from "@t3tools/client-runtime/state/thread-activity-announcement";

// Dismissed suggestions, keyed by environment and run, shared by every mounted composer and kept
// across remounts. Run ids derive from thread ids, which can repeat across environments.
let dismissedKeys: ReadonlySet<string> = new Set();
const listeners = new Set<() => void>();
const subscribeDismissed = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};
const readDismissed = () => dismissedKeys;
const dismissKey = (environmentId: EnvironmentId, runId: RunId) => `${environmentId}\u0000${runId}`;

/**
 * The suggestion while the run that produced it is the thread's latest completed run. A message
 * promoted to Steer leaves its queued run cancelled before it started, still the latest run, so
 * the comparison skips to the last run that ran. Detail can lag the shell, so it skips only once
 * the runs include that cancelled run.
 */
export function offeredPromptSuggestion<Suggestion extends { readonly runId: RunId }>(
  suggestion: Suggestion | null | undefined,
  latestRun: Thread["latestRun"] | undefined,
  runs: ReadonlyArray<OrchestrationV2Run>,
): Suggestion | null {
  const run = announcedRun(latestRun ?? null, runs);
  const skippedUnseenRun =
    latestRun != null &&
    run?.runId !== latestRun.runId &&
    !runs.some(
      (candidate) =>
        candidate.id === latestRun.runId &&
        candidate.status === "cancelled" &&
        candidate.startedAt === null,
    );
  return suggestion &&
    !skippedUnseenRun &&
    run?.runId === suggestion.runId &&
    run.status === "completed"
    ? suggestion
    : null;
}

/**
 * The provider's predicted next prompt, while the run that produced it is the thread's latest
 * completed run and Escape has not dismissed it.
 */
export function usePromptSuggestion(
  environmentId: EnvironmentId,
  thread: Thread | undefined,
  runs: ReadonlyArray<OrchestrationV2Run>,
): { readonly suggestion: string | null; readonly dismiss: () => void } {
  // Older servers decode the missing setting as false, so true also proves the method exists.
  const enabled = useServerConfigs().get(environmentId)?.settings.promptSuggestionsEnabled === true;
  // Tab is the only way to accept one, so skip devices with no mouse or trackpad at all.
  const hasFinePointer = useMediaQuery("(any-pointer: fine)");
  const { data } = useEnvironmentQuery(
    // A local draft has no run, and so no suggestion, until its first send.
    enabled && hasFinePointer && thread?.latestRun
      ? orchestrationEnvironment.v2.promptSuggestion({
          environmentId,
          input: { threadId: thread.id },
        })
      : null,
  );
  const dismissed = useSyncExternalStore(subscribeDismissed, readDismissed);
  const offered = offeredPromptSuggestion(data, thread?.latestRun, runs);
  return {
    suggestion:
      offered && !dismissed.has(dismissKey(environmentId, offered.runId)) ? offered.text : null,
    dismiss: () => {
      if (offered === null) return;
      dismissedKeys = new Set(dismissedKeys).add(dismissKey(environmentId, offered.runId));
      for (const listener of listeners) listener();
    },
  };
}
