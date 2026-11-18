import { offeredPromptSuggestion } from "@t3tools/client-runtime/state/prompt-suggestion";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";

import { orchestrationEnvironment } from "../../state/orchestration";
import { useEnvironmentQuery } from "../../state/query";
import { useQuietThreadStructure } from "../../state/use-thread-detail";

/** The provider's predicted next prompt for the thread's latest completed run. */
export function usePromptSuggestion(
  thread: EnvironmentThreadShell,
  enabled: boolean,
): string | null {
  const structure = useQuietThreadStructure(
    enabled ? { environmentId: thread.environmentId, threadId: thread.id } : null,
  );
  const { data } = useEnvironmentQuery(
    enabled && thread.latestRun !== null
      ? orchestrationEnvironment.v2.promptSuggestion({
          environmentId: thread.environmentId,
          input: { threadId: thread.id },
        })
      : null,
  );
  return (
    offeredPromptSuggestion(data, thread.latestRun, structure?.projection.runs ?? [])?.text ?? null
  );
}
