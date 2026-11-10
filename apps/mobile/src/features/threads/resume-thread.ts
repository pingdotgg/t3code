import type {
  ResumeThreadQueueInput,
  SetThreadInteractionModeInput,
  SetThreadRuntimeModeInput,
  StartThreadTurnInput,
} from "@t3tools/client-runtime/operations";
import type { AtomCommandResult } from "@t3tools/client-runtime/state/runtime";
import type {
  EnvironmentId,
  MessageId,
  ModelSelection,
  ProviderInteractionMode,
  RunId,
  RuntimeMode,
  ThreadId,
} from "@t3tools/contracts";

type Command<Input, E> = (request: {
  readonly environmentId: EnvironmentId;
  readonly input: Input;
}) => Promise<AtomCommandResult<unknown, E>>;

/** Resolves to the first failed command's result, or the last successful one. */
export async function resumeThread<E>(input: {
  readonly thread: {
    readonly environmentId: EnvironmentId;
    readonly id: ThreadId;
    readonly runtimeMode: RuntimeMode;
    readonly interactionMode: ProviderInteractionMode;
  };
  readonly resumableRunId: RunId | null;
  readonly queueHeld: boolean;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
  readonly modelSelection: ModelSelection | null;
  readonly messageId: MessageId;
  readonly createdAt: string;
  readonly setRuntimeMode: Command<SetThreadRuntimeModeInput, E>;
  readonly setInteractionMode: Command<SetThreadInteractionModeInput, E>;
  readonly startTurn: Command<StartThreadTurnInput, E>;
  readonly resumeQueue: Command<ResumeThreadQueueInput, E>;
}): Promise<AtomCommandResult<unknown, E>> {
  const { thread, runtimeMode, interactionMode, createdAt } = input;
  const environmentId = thread.environmentId;
  // The server holds the queue behind a stopped or usage-limited run until that run is continued.
  if (input.resumableRunId !== null) {
    // A turn on an existing thread runs with the thread's saved modes, not the turn's.
    if (runtimeMode !== thread.runtimeMode) {
      const saved = await input.setRuntimeMode({
        environmentId,
        input: { threadId: thread.id, runtimeMode, createdAt },
      });
      if (saved._tag === "Failure") return saved;
    }
    if (interactionMode !== thread.interactionMode) {
      const saved = await input.setInteractionMode({
        environmentId,
        input: { threadId: thread.id, interactionMode, createdAt },
      });
      if (saved._tag === "Failure") return saved;
    }
    const continued = await input.startTurn({
      environmentId,
      input: {
        creationSource: "mobile",
        threadId: thread.id,
        manualContinuationOfRunId: input.resumableRunId,
        ...(input.modelSelection ? { modelSelection: input.modelSelection } : {}),
        message: {
          messageId: input.messageId,
          role: "user",
          text: "Continue where you left off.",
          attachments: [],
        },
        runtimeMode,
        interactionMode,
        dispatchMode: "start",
      },
    });
    if (continued._tag === "Failure" || !input.queueHeld) return continued;
  }
  return input.resumeQueue({ environmentId, input: { threadId: thread.id } });
}
