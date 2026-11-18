import type { OrchestrationV2CommandProgress, ScopedThreadRef } from "@t3tools/contracts";

import { orchestrationEnvironment } from "../../state/orchestration";
import { useEnvironmentQuery } from "../../state/query";

const NO_PROGRESS: ReadonlyArray<OrchestrationV2CommandProgress> = [];

/**
 * Counts the thread's running commands print, such as `24/31` or `42%`. Rows and the
 * scroll-to-end button share one subscription, held only while a caller passes `enabled`.
 */
export function useCommandProgress(
  threadRef: ScopedThreadRef | null,
  enabled: boolean,
): ReadonlyArray<OrchestrationV2CommandProgress> {
  const { data } = useEnvironmentQuery(
    enabled && threadRef
      ? orchestrationEnvironment.v2.commandProgress({
          environmentId: threadRef.environmentId,
          input: { threadId: threadRef.threadId },
        })
      : null,
  );
  return data?.items ?? NO_PROGRESS;
}

export function formatCommandProgress(progress: OrchestrationV2CommandProgress): string {
  return progress.total === 100
    ? `${progress.completed}%`
    : `${progress.completed}/${progress.total}`;
}

const COMMAND_LABEL_MAX_CHARS = 32;

export function truncateCommandLabel(command: string): string {
  const label = command.trim().replace(/\s+/g, " ");
  return label.length > COMMAND_LABEL_MAX_CHARS
    ? `${label.slice(0, COMMAND_LABEL_MAX_CHARS - 1)}…`
    : label;
}
