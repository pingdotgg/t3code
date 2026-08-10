import type { StartThreadTurnInput } from "@t3tools/client-runtime/state/threads";
import type {
  MessageId,
  ModelSelection,
  ProjectId,
  ProviderInteractionMode,
  RuntimeMode,
  ThreadId,
} from "@t3tools/contracts";

/**
 * Everything needed to start one thread from scratch: the settings a draft
 * would have carried, plus the prompt its first turn sends. Bulk sends build
 * one spec per placeholder value and share the rest.
 */
export interface ThreadLaunchSpec {
  readonly projectId: ProjectId;
  readonly title: string;
  /** Outgoing message text, already formatted for the selected provider. */
  readonly prompt: string;
  readonly modelSelection: ModelSelection;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
  /** Base branch the thread starts from, or null to inherit the checkout. */
  readonly branch: string | null;
  /**
   * Set to create a dedicated worktree for this thread before the first turn.
   * The server reports the real worktree path back through thread metadata.
   */
  readonly worktree: {
    readonly projectCwd: string;
    readonly baseBranch: string;
    readonly branch: string;
    readonly startFromOrigin: boolean;
  } | null;
}

export interface ThreadLaunchIdentity {
  readonly threadId: ThreadId;
  readonly messageId: MessageId;
  readonly createdAt: string;
}

/**
 * Builds the single command that creates the thread, prepares its worktree and
 * dispatches its first turn. The server only acknowledges it once all three
 * have happened, which is what makes sequential launching real backpressure.
 */
export function buildThreadLaunchInput(
  spec: ThreadLaunchSpec,
  identity: ThreadLaunchIdentity,
): StartThreadTurnInput {
  return {
    threadId: identity.threadId,
    message: {
      messageId: identity.messageId,
      role: "user",
      text: spec.prompt,
      attachments: [],
    },
    modelSelection: spec.modelSelection,
    titleSeed: spec.title,
    runtimeMode: spec.runtimeMode,
    interactionMode: spec.interactionMode,
    bootstrap: {
      createThread: {
        projectId: spec.projectId,
        title: spec.title,
        modelSelection: spec.modelSelection,
        runtimeMode: spec.runtimeMode,
        interactionMode: spec.interactionMode,
        branch: spec.branch,
        worktreePath: null,
        createdAt: identity.createdAt,
      },
      ...(spec.worktree
        ? {
            prepareWorktree: {
              projectCwd: spec.worktree.projectCwd,
              baseBranch: spec.worktree.baseBranch,
              branch: spec.worktree.branch,
              ...(spec.worktree.startFromOrigin ? { startFromOrigin: true } : {}),
            },
            runSetupScript: true,
          }
        : {}),
    },
    createdAt: identity.createdAt,
  };
}
