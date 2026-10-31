import type { EnvironmentId, OrchestrationV2PromptSuggestion } from "@t3tools/contracts";

import type { Thread } from "../../types";
import { useServerConfigs } from "../../state/entities";
import { orchestrationEnvironment } from "../../state/orchestration";
import { useEnvironmentQuery } from "../../state/query";

/** The provider's predicted next prompt, while the run that produced it is the thread's latest completed run. */
export function usePromptSuggestion(
  environmentId: EnvironmentId,
  thread: Thread | undefined,
): string | null {
  const supported =
    useServerConfigs().get(environmentId)?.environment.capabilities.promptSuggestions === true;
  const { data } = useEnvironmentQuery<OrchestrationV2PromptSuggestion, unknown>(
    supported && thread
      ? orchestrationEnvironment.v2.promptSuggestion({
          environmentId,
          input: { threadId: thread.id },
        })
      : null,
  );
  const latestRun = thread?.latestRun;
  return data && latestRun?.runId === data.runId && latestRun.status === "completed"
    ? data.text
    : null;
}
