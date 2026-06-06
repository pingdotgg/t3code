import { type CommandId, type OrchestrationCommand, type ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";

import type { GitWorkflowServiceShape } from "../git/GitWorkflowService.ts";
import type {
  ProjectSetupScriptRunnerError,
  ProjectSetupScriptRunnerResultStarted,
  ProjectSetupScriptRunnerShape,
} from "../project/Services/ProjectSetupScriptRunner.ts";
import type { TerminalManagerShape } from "../terminal/Services/Manager.ts";
import type { OrchestrationDispatchError } from "./Errors.ts";
import type { OrchestrationEngineShape } from "./Services/OrchestrationEngine.ts";

type ThreadCreateCommand = Extract<OrchestrationCommand, { type: "thread.create" }>;
type ThreadTurnStartCommand = Extract<OrchestrationCommand, { type: "thread.turn.start" }>;

type ThreadBootstrapWorktree = {
  readonly refName: string;
  readonly path: string;
};

type ThreadBootstrapCommandTags = {
  readonly createThread: string;
  readonly deleteThread: string;
  readonly metaUpdate: string;
};

type ThreadBootstrapSetupScript<SetupFailureError, SetupStartedError> = {
  readonly input: (
    worktreePath: string,
  ) => Parameters<ProjectSetupScriptRunnerShape["runForThread"]>[0];
  readonly onFailure?: (input: {
    readonly error: ProjectSetupScriptRunnerError;
    readonly worktreePath: string;
  }) => Effect.Effect<void, SetupFailureError>;
  readonly onStarted?: (input: {
    readonly result: ProjectSetupScriptRunnerResultStarted;
    readonly worktreePath: string;
  }) => Effect.Effect<void, SetupStartedError>;
};

export type ThreadBootstrapLauncherInput<
  CommandIdError,
  WorktreeCreateError,
  WorktreeMetadataUpdatedError,
  SetupFailureError,
  SetupStartedError,
> = {
  readonly threadId: ThreadId;
  readonly orchestration: Pick<OrchestrationEngineShape, "dispatch">;
  readonly gitWorkflow: Pick<GitWorkflowServiceShape, "removeWorktree">;
  readonly terminalManager: Pick<TerminalManagerShape, "close">;
  readonly setupScripts: Pick<ProjectSetupScriptRunnerShape, "runForThread">;
  readonly nextCommandId: (tag: string) => Effect.Effect<CommandId, CommandIdError>;
  readonly commandTags?: Partial<ThreadBootstrapCommandTags>;
  readonly createThread?: Omit<ThreadCreateCommand, "type" | "commandId">;
  readonly prepareWorktree?: {
    readonly cwd: string;
    readonly create: Effect.Effect<ThreadBootstrapWorktree, WorktreeCreateError>;
    readonly afterMetadataUpdated?: (input: {
      readonly worktree: ThreadBootstrapWorktree;
    }) => Effect.Effect<void, WorktreeMetadataUpdatedError>;
  };
  readonly setupScript?: ThreadBootstrapSetupScript<SetupFailureError, SetupStartedError>;
  readonly turnStart: ThreadTurnStartCommand;
};

const defaultCommandTags: ThreadBootstrapCommandTags = {
  createThread: "thread-create",
  deleteThread: "thread-delete",
  metaUpdate: "thread-meta-update",
};

export function launchThreadBootstrap<
  CommandIdError,
  WorktreeCreateError = never,
  WorktreeMetadataUpdatedError = never,
  SetupFailureError = never,
  SetupStartedError = never,
>(
  input: ThreadBootstrapLauncherInput<
    CommandIdError,
    WorktreeCreateError,
    WorktreeMetadataUpdatedError,
    SetupFailureError,
    SetupStartedError
  >,
): Effect.Effect<
  { readonly sequence: number },
  | CommandIdError
  | WorktreeCreateError
  | WorktreeMetadataUpdatedError
  | SetupFailureError
  | SetupStartedError
  | OrchestrationDispatchError
  | ProjectSetupScriptRunnerError
> {
  const commandTags = { ...defaultCommandTags, ...input.commandTags };
  let shouldDeleteCreatedThread = false;
  let createdWorktree: { readonly cwd: string; readonly path: string } | null = null;
  let activeWorktreePath = input.createThread?.worktreePath ?? null;

  const cleanupCreatedThread = () =>
    shouldDeleteCreatedThread
      ? input.nextCommandId(commandTags.deleteThread).pipe(
          Effect.flatMap((commandId) =>
            input.orchestration.dispatch({
              type: "thread.delete",
              commandId,
              threadId: input.threadId,
            }),
          ),
          Effect.ignoreCause({ log: true }),
        )
      : Effect.void;

  const cleanupThreadTerminals = () =>
    shouldDeleteCreatedThread || createdWorktree !== null
      ? input.terminalManager
          .close({ threadId: input.threadId, deleteHistory: true })
          .pipe(Effect.ignoreCause({ log: true }))
      : Effect.void;

  const cleanupCreatedWorktree = () =>
    createdWorktree === null
      ? Effect.void
      : input.gitWorkflow
          .removeWorktree({
            cwd: createdWorktree.cwd,
            path: createdWorktree.path,
            force: true,
          })
          .pipe(Effect.ignoreCause({ log: true }));

  const cleanupCreatedResources = () =>
    cleanupCreatedThread().pipe(
      Effect.andThen(cleanupThreadTerminals()),
      Effect.andThen(cleanupCreatedWorktree()),
    );

  const runSetupScript = (
    worktreePath: string | null,
  ): Effect.Effect<void, ProjectSetupScriptRunnerError | SetupFailureError | SetupStartedError> => {
    if (!input.setupScript || worktreePath === null) {
      return Effect.void;
    }

    const setupScript = input.setupScript;
    return input.setupScripts.runForThread(setupScript.input(worktreePath)).pipe(
      Effect.matchEffect({
        onFailure: (
          error,
        ): Effect.Effect<void, ProjectSetupScriptRunnerError | SetupFailureError> =>
          setupScript.onFailure
            ? setupScript.onFailure({ error, worktreePath })
            : Effect.fail(error),
        onSuccess: (result) => {
          if (result.status !== "started" || !setupScript.onStarted) {
            return Effect.void;
          }
          return setupScript.onStarted({ result, worktreePath });
        },
      }),
    );
  };

  return Effect.uninterruptibleMask((restore) => {
    const launch = Effect.gen(function* () {
      if (input.createThread) {
        const commandId = yield* input.nextCommandId(commandTags.createThread);
        yield* restore(
          input.orchestration.dispatch({
            type: "thread.create",
            commandId,
            ...input.createThread,
          }),
        );
        shouldDeleteCreatedThread = true;
      }

      if (input.prepareWorktree) {
        const worktree = yield* input.prepareWorktree.create;
        createdWorktree = {
          cwd: input.prepareWorktree.cwd,
          path: worktree.path,
        };
        activeWorktreePath = worktree.path;
        yield* restore(
          input.orchestration.dispatch({
            type: "thread.meta.update",
            commandId: yield* input.nextCommandId(commandTags.metaUpdate),
            threadId: input.threadId,
            branch: worktree.refName,
            worktreePath: worktree.path,
          }),
        );
        if (input.prepareWorktree.afterMetadataUpdated) {
          yield* restore(input.prepareWorktree.afterMetadataUpdated({ worktree }));
        }
      }

      yield* restore(runSetupScript(activeWorktreePath));
      return yield* restore(input.orchestration.dispatch(input.turnStart));
    });

    return launch.pipe(
      Effect.onExit((exit) => (Exit.isFailure(exit) ? cleanupCreatedResources() : Effect.void)),
    );
  });
}
