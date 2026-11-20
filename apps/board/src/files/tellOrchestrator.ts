import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import { EMPTY_ENVIRONMENT_THREAD_STATE } from "@t3tools/client-runtime/state/threads";
import { type EnvironmentId, MessageId, ThreadId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, type AtomRegistry } from "effect/reactivity";

import { failureText } from "../settings/failureText";
import { newId } from "../state/boards";
import { environmentThreads, startTurn } from "../state/threads";

/** Tells a board's orchestrator that a file changed. Resolves to the failure text, or null once sent. */
export async function tellOrchestrator(
  registry: AtomRegistry.AtomRegistry,
  environmentId: EnvironmentId,
  orchestratorThreadId: string | null,
  absolutePath: string,
): Promise<string | null> {
  if (orchestratorThreadId === null) return "Start this board's orchestrator first.";
  const threadId = ThreadId.make(orchestratorThreadId);
  const { data } = AsyncResult.getOrElse(
    registry.get(environmentThreads.stateAtom(environmentId, threadId)),
    () => EMPTY_ENVIRONMENT_THREAD_STATE,
  );
  const projection = Option.getOrNull(data);
  if (projection === null) return "The orchestrator has not loaded yet. Try again in a moment.";
  const result = await runAtomCommand(
    registry,
    startTurn,
    {
      environmentId,
      input: {
        threadId,
        message: {
          messageId: MessageId.make(newId()),
          role: "user",
          text: `I edited ${absolutePath}. Re-read it.`,
          attachments: [],
        },
        runtimeMode: projection.thread.runtimeMode,
        interactionMode: projection.thread.interactionMode,
      },
    },
    { reportFailure: false },
  );
  return result._tag === "Success" ? null : failureText(result);
}
