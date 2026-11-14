import { modelSelectionsEqual } from "@t3tools/shared/model";
import { projectComposerContextForProvider } from "@t3tools/shared/composerContextReferences";
import {
  CommandId,
  latestProviderTurnForAttempt,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ContextHandoff,
  type OrchestrationV2ExecutionNode,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2Run,
  type OrchestrationV2RunAttempt,
  type OrchestrationV2TurnItem,
  isCompactionCommandMessage,
  parseGoalCommand,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../config.ts";
import { withWorkspaceLease } from "../workspace/workspaceLease.ts";
import * as GitWorkflowService from "../git/GitWorkflowService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProviderAuthService from "../provider/ProviderAuthService.ts";
import * as ServerSettings from "../serverSettings.ts";
import { makeIsManagedWorktreePath } from "../worktreesDirectory.ts";
import * as EventSink from "./EventSink.ts";
import * as ProviderUsageAnalytics from "../telemetry/ProviderUsageAnalytics.ts";
import * as ContextHandoffService from "./ContextHandoffService.ts";
import { isActiveRun } from "./CommandPolicy.ts";
import {
  DEFAULT_HANDOFF_TOKEN_CAP,
  handoffTokenCapConfig,
  handoffBudget,
  attachmentTokenAllowance,
  contextUsageForHandoff,
  historicalMessage,
  latestNativeContextUsage,
} from "@t3tools/provider-core/server/handoffBudget";
import { deliverContextHandoffs, withInlineContext } from "./ContextHandoffDelivery.ts";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import {
  ContextHandoffBackgroundWorkError,
  knownProviderFailureMessage,
  makeProviderFailure,
} from "@t3tools/provider-core/server/failure";
import * as RunExecutionService from "./RunExecutionService.ts";
import * as RuntimePolicy from "./RuntimePolicy.ts";
import {
  isRestartNoteContinuation,
  pendingRestartCancelledBackgroundWork,
  restartCancelledBackgroundWorkNote,
} from "./RestartBackgroundNote.ts";

// Moved out of ProviderTurnStartService to keep it under the file-size limit.
export class ProviderTurnStartError extends Schema.TaggedError<ProviderTurnStartError>()(
  "ProviderTurnStartError",
  {
    runId: RunId,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Provider turn start failed for run '${this.runId}'.`;
  }
}

export class WorktreeRecreateError extends Schema.TaggedError<WorktreeRecreateError>()(
  "WorktreeRecreateError",
  {
    worktreePath: Schema.String,
    branch: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Could not recreate the worktree for branch '${this.branch}' at ${this.worktreePath}.`;
  }
}

export class WorktreeRecreateNoBaseError extends Schema.TaggedError<WorktreeRecreateNoBaseError>()(
  "WorktreeRecreateNoBaseError",
  { worktreePath: Schema.String, branch: Schema.String },
) {
  override get message(): string {
    return `Could not recreate branch '${this.branch}' at ${this.worktreePath}: the project workspace has no commit to start it from.`;
  }
}


const PROMPT_REFUSAL_TAGS = [
  "ClaudeBackgroundWorkBlocksQueryReplacementError",
  "ClaudeAppendSystemPromptFileError",
  "ClaudeAppendSystemPromptMissingValueError",
  "ClaudeSettingsLaunchArgError",
  "ClaudeMcpRegistrationTimeoutError",
] as const;

export const refusedBeforePrompt = (error: unknown): boolean =>
  PROMPT_REFUSAL_TAGS.some((tag) => Predicate.isTagged(error, tag)) ||
  (Predicate.hasProperty(error, "cause") && refusedBeforePrompt(error.cause));


export type ProviderTurnStartRunStart = (input: {
  readonly threadId: ThreadId;
  readonly runId: RunId;
  readonly willRetry?: boolean;
}) => Effect.Effect<Effect.Effect<void, unknown> | undefined, unknown>;

export const makeWorktreeTools = Effect.fn("ProviderTurnStartService.makeWorktreeTools")(
  function* () {
    const gitWorkflow = yield* GitWorkflowService.GitWorkflowService;

    const resolveRecreateBase = Effect.fn("ProviderTurnStartService.resolveRecreateBase")(
      function* (cwd: string) {
        // Recovery can follow an external checkout, before the status cache expires.
        yield* gitWorkflow.invalidateLocalStatus(cwd);
        const { refName: currentBranch } = yield* gitWorkflow.localStatus({ cwd });
        if (currentBranch !== null) {
          const refName = `refs/heads/${currentBranch}`;
          return { refName, baseRefName: refName };
        }
        if (yield* gitWorkflow.hasCommit({ cwd, refName: "refs/remotes/origin/HEAD" })) {
          const { commitSha } = yield* gitWorkflow.resolveRemoteTrackingCommit({
            cwd,
            refName: "HEAD",
            fallbackRemoteName: "origin",
          });
          // Start from the commit so the thread branch does not track the default branch.
          return { refName: commitSha, baseRefName: "refs/remotes/origin/HEAD" };
        }
        if (yield* gitWorkflow.hasCommit({ cwd, refName: "HEAD" })) {
          return { refName: "HEAD", baseRefName: undefined };
        }
        return null;
      },
    );

    const recreateMissingWorktree = Effect.fn("ProviderTurnStartService.recreateMissingWorktree")(
      function* (input: {
        readonly cwd: string;
        readonly worktreePath: string;
        readonly branch: string;
      }) {
        const { cwd, worktreePath, branch } = input;
        yield* gitWorkflow.pruneWorktrees({ cwd });
        const localBranchNames = yield* gitWorkflow.listLocalBranchNames(cwd);
        if (localBranchNames.includes(branch)) {
          yield* gitWorkflow.createWorktree({ cwd, refName: branch, path: worktreePath });
          return;
        }
        // Push keeps the tracking ref current, so recovery reads it without fetching.
        const pushedRef = `refs/remotes/origin/${branch}`;
        if (yield* gitWorkflow.hasCommit({ cwd, refName: pushedRef })) {
          yield* gitWorkflow.createWorktree({
            cwd,
            refName: pushedRef,
            newRefName: branch,
            path: worktreePath,
          });
          return;
        }
        const base = yield* resolveRecreateBase(cwd);
        if (base === null) {
          return yield* new WorktreeRecreateNoBaseError({ worktreePath, branch });
        }
        yield* gitWorkflow.createWorktree({
          cwd,
          refName: base.refName,
          newRefName: branch,
          ...(base.baseRefName === undefined ? {} : { baseRefName: base.baseRefName }),
          path: worktreePath,
        });
      },
    );

    return { resolveRecreateBase, recreateMissingWorktree } as const;
  },
);

export type ProviderTurnStartWorktreeToolsShape = Effect.Success<
  ReturnType<typeof makeWorktreeTools>
>;

export const makeRunTools = Effect.fn("ProviderTurnStartService.makeRunTools")(function* () {
  const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
  const idAllocator = yield* IdAllocator.IdAllocatorV2;

    const makeRunControls = (input: {
      readonly threadId: ThreadId;
      readonly runId: RunId;
      readonly attemptId: OrchestrationV2RunAttempt["id"];
      readonly providerThreadId: OrchestrationV2ProviderThread["id"];
      readonly runOrdinal: number;
      readonly inheritedBackgroundTurnItems: ReturnType<
        typeof RunExecutionService.selectInheritedBackgroundTurnItems
      >;
    }) => {
      const isCurrentAttemptInStatus = (expectedStatus: OrchestrationV2Run["status"]) =>
        projectionStore.getRuntimeRecoveryProjection(input.threadId).pipe(
          Effect.map((current) => {
            const run = current.runs.find((candidate) => candidate.id === input.runId);
            return run?.activeAttemptId === input.attemptId && run.status === expectedStatus;
          }),
        );
      return {
        isCurrentAttemptInStatus,
        loadInheritedBackgroundTurnItems: () =>
          projectionStore.getRuntimeRecoveryProjection(input.threadId).pipe(
            Effect.map((current) =>
              RunExecutionService.selectInheritedBackgroundTurnItems({
                threadId: input.threadId,
                currentProviderThreadId: input.providerThreadId,
                currentRunOrdinal: input.runOrdinal,
                runs: current.runs,
                turnItems: current.turnItems,
              }),
            ),
            Effect.catchCause(() => Effect.succeed(input.inheritedBackgroundTurnItems)),
          ),
        shouldStartProviderTurn: () => isCurrentAttemptInStatus("running"),
        shouldFinalizeRun: () =>
          projectionStore.getRuntimeRecoveryProjection(input.threadId).pipe(
            Effect.map((current) => {
              const run = current.runs.find((candidate) => candidate.id === input.runId);
              return (
                run?.activeAttemptId === input.attemptId &&
                (run.status === "starting" || run.status === "running")
              );
            }),
          ),
        hasUnpairedRunInterruptRequest: () =>
          projectionStore
            .hasUnpairedRunInterruptRequest(
              input.threadId,
              idAllocator.derive.runSignalTurnItem({
                runId: input.runId,
                signal: "interrupt-request",
              }),
              idAllocator.derive.runSignalTurnItem({
                runId: input.runId,
                signal: "interrupt-result",
              }),
            )
            .pipe(Effect.catchCause(() => Effect.succeed(false))),
        loadRunInterruptReason: () =>
          projectionStore
            .getThreadRecords(input.threadId, ["turnItems"], {
              turnItemTypes: ["run_interrupt_request"],
              turnItemRunIds: [input.runId],
            })
            .pipe(
              Effect.map(({ turnItems }) => {
                const request = turnItems.find((item) => item.type === "run_interrupt_request");
                return request?.type === "run_interrupt_request" ? request.message : undefined;
              }),
              // @effect-diagnostics-next-line effectSucceedWithVoid:off - This optional result requires undefined, not the wider void type.
              Effect.catchCause(() => Effect.succeed(undefined)),
            ),
      };
    };

    const makeDeliverySession = (
      session: ProviderAdapter.ProviderAdapterV2SessionRuntime,
      startWithHandoffs: (
        input: Parameters<ProviderAdapter.ProviderAdapterV2SessionRuntime["startTurn"]>[0],
        compact?: boolean,
      ) => ReturnType<ProviderAdapter.ProviderAdapterV2SessionRuntime["startTurn"]>,
    ) => {
      let deliver: typeof startWithHandoffs | undefined = startWithHandoffs;
      const start = (
        input: Parameters<ProviderAdapter.ProviderAdapterV2SessionRuntime["startTurn"]>[0],
        compact = false,
      ) =>
        Effect.suspend(() => {
          if (deliver !== undefined) return deliver(input, compact);
          return compact && session.compactThread !== undefined
            ? session.compactThread(input)
            : session.startTurn(input);
        }).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              deliver = undefined;
            }),
          ),
        );
      return {
        ...session,
        startTurn: (input: Parameters<typeof session.startTurn>[0]) => start(input),
        ...(session.compactThread === undefined
          ? {}
          : {
              compactThread: (input: Parameters<typeof session.startTurn>[0]) => start(input, true),
            }),
      };
    };

  return { makeRunControls, makeDeliverySession } as const;
});

export type ProviderTurnStartRunToolsShape = Effect.Success<ReturnType<typeof makeRunTools>>;

export type ProviderTurnStartRunControlsShape = ReturnType<
  ProviderTurnStartRunToolsShape["makeRunControls"]
>;
