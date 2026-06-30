import type {
  BoardId,
  MessageId,
  ProjectId,
  ScriptRunId,
  StepRunId,
  ThreadId,
  TicketId,
  TurnId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";

import { DurableApprovalResume } from "../Services/DurableApprovalResume.ts";
import { BoardRegistry } from "../Services/BoardRegistry.ts";
import { WorkflowEventStoreError } from "../Services/Errors.ts";
import {
  ProviderDispatchOutbox,
  type ProviderDispatchTerminalResult,
} from "../Services/ProviderDispatchOutbox.ts";
import { ProjectWorkspaceResolver } from "../Services/ProjectWorkspaceResolver.ts";
import { TurnStateReader } from "../Services/TurnStateReader.ts";
import { WorkflowBoardSaveLocks } from "../Services/WorkflowBoardSaveLocks.ts";
import { WorkflowBoardVersionStore } from "../Services/WorkflowBoardVersionStore.ts";
import { WorkflowFileLoader } from "../Services/WorkflowFileLoader.ts";
import { WorkflowEventCommitter } from "../Services/WorkflowEventCommitter.ts";
import type { PersistedWorkflowEvent, WorkflowEventInput } from "../Services/WorkflowEventStore.ts";
import { WorkflowEventStore } from "../Services/WorkflowEventStore.ts";
import { WorkflowEngine } from "../Services/WorkflowEngine.ts";
import { WorkflowIds } from "../Services/WorkflowIds.ts";
import { WorkflowReadModel } from "../Services/WorkflowReadModel.ts";
import { WorkflowWebhook } from "../Services/WorkflowWebhook.ts";
import { WorkflowRecovery, type WorkflowRecoveryShape } from "../Services/WorkflowRecovery.ts";
import { MergeGitPort } from "../Services/TicketMergeService.ts";
import { GitHubPort } from "../Services/GitHubPort.ts";
import type { RecoveredStepResult } from "../Services/WorkflowEngine.ts";
import { WorktreeLeaseService } from "../Services/WorktreeLeaseService.ts";
import { WorkflowWorktreeJanitor } from "../Services/WorkflowWorktreeJanitor.ts";
import { WorkflowAgentSessionStore } from "../Services/WorkflowAgentSessionStore.ts";
import { ProviderService } from "../../provider/Services/ProviderService.ts";
import { deleteWorkflowBoardOwnedState } from "../boardDeletion.ts";
import { truncateTicketMessageBody } from "../ticketMessageBody.ts";

interface DispatchRecoveryRow {
  readonly dispatchId: string;
  readonly ticketId: TicketId;
  readonly stepRunId: StepRunId;
  readonly threadId: string;
  readonly turnId: string | null;
  readonly status: "pending" | "started" | "confirmed";
}

interface LeaseRecoveryRow {
  readonly worktreeRef: string;
  readonly ownerId: string;
  readonly fenceToken: number;
}

interface ScriptRecoveryRow {
  readonly scriptRunId: ScriptRunId;
  readonly ticketId: TicketId;
  readonly stepRunId: StepRunId;
}

interface PersistedBoardRecoveryRow {
  readonly boardId: BoardId;
  readonly projectId: ProjectId;
  readonly workflowFilePath: string;
}

const SCRIPT_RESTART_ERROR = "script interrupted by server restart";
const MERGE_RESTART_ERROR = "merge interrupted by server restart";
const STEP_RESTART_ERROR = "step interrupted by server restart";
const PR_OPEN_RESTART_ERROR = "PR open interrupted by restart";
const PR_LAND_RESTART_ERROR = "land interrupted by restart";

interface MergeRecoveryRow {
  readonly ticketId: TicketId;
  readonly stepRunId: StepRunId;
  readonly repoRoot: string | null;
}

interface StrandedPipelineRow {
  readonly stepRunId: StepRunId;
  readonly status: "completed" | "failed" | "blocked";
  readonly error: string | null;
  readonly retryable: number | null;
  readonly outputJson: string | null;
}

const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));

const toRecoveryError = (message: string) => (cause: unknown) =>
  new WorkflowEventStoreError({ message, cause });

const wrapSql = <A>(effect: Effect.Effect<A, SqlError>) =>
  effect.pipe(Effect.mapError(toRecoveryError("workflow recovery sql failed")));

const hasNotFoundReason = (cause: unknown): boolean => {
  if (typeof cause !== "object" || cause === null) {
    return false;
  }
  if ("reason" in cause) {
    const reason = (cause as { readonly reason?: unknown }).reason;
    if (
      typeof reason === "object" &&
      reason !== null &&
      "_tag" in reason &&
      (reason as { readonly _tag?: unknown })._tag === "NotFound"
    ) {
      return true;
    }
  }
  if ("cause" in cause) {
    return hasNotFoundReason((cause as { readonly cause?: unknown }).cause);
  }
  return false;
};

const isMissingWorkflowFileError = (cause: unknown): boolean =>
  typeof cause === "object" &&
  cause !== null &&
  "message" in cause &&
  String((cause as { readonly message?: unknown }).message).includes("workflow file read failed") &&
  hasNotFoundReason(cause);

type TerminalStepEvent = Extract<
  PersistedWorkflowEvent,
  { readonly type: "StepCompleted" | "StepFailed" | "StepBlocked" }
>;

const isTerminalStepEvent = (event: PersistedWorkflowEvent): event is TerminalStepEvent =>
  event.type === "StepCompleted" || event.type === "StepFailed" || event.type === "StepBlocked";

// Shared mapping from a step's stored terminal outcome to the recovered
// result: a step that already reached a terminal state must be recovered
// with that state, never a synthesized restart failure.
const toRecoveredStepResult = (terminal: {
  readonly status: "completed" | "failed" | "blocked";
  readonly error: string | null;
  readonly retryable: boolean;
  readonly output: unknown;
}): RecoveredStepResult =>
  terminal.status === "completed"
    ? { _tag: "completed", ...(terminal.output === undefined ? {} : { output: terminal.output }) }
    : terminal.status === "blocked"
      ? { _tag: "blocked", reason: terminal.error ?? "step blocked" }
      : {
          _tag: "failed",
          error: terminal.error ?? "step failed",
          ...(terminal.retryable ? {} : { retryable: false }),
        };

const recoveredResultFromTerminalEvent = (event: TerminalStepEvent): RecoveredStepResult =>
  event.type === "StepCompleted"
    ? toRecoveredStepResult({
        status: "completed",
        error: null,
        retryable: true,
        output: event.payload.output,
      })
    : event.type === "StepBlocked"
      ? toRecoveredStepResult({
          status: "blocked",
          error: event.payload.reason,
          retryable: true,
          output: undefined,
        })
      : toRecoveredStepResult({
          status: "failed",
          error: event.payload.error,
          retryable: event.payload.retryable !== false,
          output: undefined,
        });

const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const sql = yield* SqlClient.SqlClient;
  const outbox = yield* ProviderDispatchOutbox;
  const turns = yield* TurnStateReader;
  const approvals = yield* DurableApprovalResume;
  const committer = yield* WorkflowEventCommitter;
  const engine = yield* WorkflowEngine;
  const ids = yield* WorkflowIds;
  const store = yield* WorkflowEventStore;
  const leases = yield* WorktreeLeaseService;
  const boardRegistry = yield* BoardRegistry;
  const readModel = yield* WorkflowReadModel;
  const saveLocks = yield* WorkflowBoardSaveLocks;
  const versionStore = yield* WorkflowBoardVersionStore;
  const worktreeJanitor = Context.getOption(
    (yield* Effect.context<never>()) as Context.Context<WorkflowWorktreeJanitor>,
    WorkflowWorktreeJanitor,
  );
  const mergeGit = Context.getOption(
    (yield* Effect.context<never>()) as Context.Context<MergeGitPort>,
    MergeGitPort,
  );
  // PR recovery inspects external state through gh. Trimmed test layers without
  // a GitHubPort fall back to "not found" → failed, never crash recovery.
  const gitHub = Context.getOption(
    (yield* Effect.context<never>()) as Context.Context<GitHubPort>,
    GitHubPort,
  );
  const webhook = Context.getOption(
    (yield* Effect.context<never>()) as Context.Context<WorkflowWebhook>,
    WorkflowWebhook,
  );
  const agentSessions = Context.getOption(
    (yield* Effect.context<never>()) as Context.Context<WorkflowAgentSessionStore>,
    WorkflowAgentSessionStore,
  );
  const providerService = Context.getOption(
    (yield* Effect.context<never>()) as Context.Context<ProviderService>,
    ProviderService,
  );
  // Spread into both board-deletion cascade calls so a missing-file board's
  // per-agent sessions are torn down (A8).
  const agentSessionDeletionDeps = {
    ...(Option.isSome(agentSessions) ? { agentSessions: agentSessions.value } : {}),
    ...(Option.isSome(providerService) ? { provider: providerService.value } : {}),
  };

  const getOptionalBoardLoaders = Effect.context<never>().pipe(
    Effect.map((context) => ({
      fileLoader: Context.getOption(
        context as Context.Context<WorkflowFileLoader>,
        WorkflowFileLoader,
      ),
      projectWorkspaceResolver: Context.getOption(
        context as Context.Context<ProjectWorkspaceResolver>,
        ProjectWorkspaceResolver,
      ),
    })),
  );

  const ticketEvents = (ticketId: TicketId) =>
    Stream.runCollect(store.readByTicket(ticketId)).pipe(Effect.map((chunk) => Array.from(chunk)));

  const hasTerminalStepEvent = (
    events: ReadonlyArray<PersistedWorkflowEvent>,
    stepRunId: StepRunId,
  ) => events.some((event) => isTerminalStepEvent(event) && event.payload.stepRunId === stepRunId);

  const latestTerminalStepEvent = (
    events: ReadonlyArray<PersistedWorkflowEvent>,
    stepRunId: StepRunId,
  ): TerminalStepEvent | null =>
    events.reduce<TerminalStepEvent | null>(
      (latest, event) =>
        isTerminalStepEvent(event) && event.payload.stepRunId === stepRunId ? event : latest,
      null,
    );

  const latestAwaitingStepEvent = (
    events: ReadonlyArray<PersistedWorkflowEvent>,
    stepRunId: StepRunId,
  ) =>
    events.reduce<Extract<PersistedWorkflowEvent, { readonly type: "StepAwaitingUser" }> | null>(
      (latest, event) => {
        if (event.type === "StepAwaitingUser" && event.payload.stepRunId === stepRunId) {
          return event;
        }
        if (event.type === "StepUserResolved" && event.payload.stepRunId === stepRunId) {
          return null;
        }
        return latest;
      },
      null,
    );

  const hasScriptExitedEvent = (
    events: ReadonlyArray<PersistedWorkflowEvent>,
    scriptRunId: ScriptRunId,
  ) =>
    events.some(
      (event) => event.type === "ScriptStepExited" && event.payload.scriptRunId === scriptRunId,
    );

  const commitAwaitingTerminalStep = (
    row: DispatchRecoveryRow,
    result: Extract<ProviderDispatchTerminalResult, { readonly awaitingUser: true }>,
  ) =>
    Effect.gen(function* () {
      const events = yield* ticketEvents(row.ticketId);
      if (hasTerminalStepEvent(events, row.stepRunId)) {
        return;
      }
      const latestAwait = latestAwaitingStepEvent(events, row.stepRunId);
      if (
        latestAwait !== null &&
        latestAwait.payload.waitingReason === result.waitingReason &&
        latestAwait.payload.providerThreadId === result.providerThreadId &&
        latestAwait.payload.providerRequestId === result.providerRequestId &&
        latestAwait.payload.providerResponseKind === result.providerResponseKind &&
        latestAwait.payload.providerQuestionId === result.providerQuestionId
      ) {
        return;
      }

      const eventId = yield* ids.eventId();
      const occurredAt = yield* nowIso;
      const awaitEvent = {
        type: "StepAwaitingUser",
        eventId,
        ticketId: row.ticketId,
        occurredAt,
        payload: {
          stepRunId: row.stepRunId,
          waitingReason: result.waitingReason,
          providerThreadId: result.providerThreadId,
          providerRequestId: result.providerRequestId,
          providerResponseKind: result.providerResponseKind,
          ...(result.providerQuestionId === undefined
            ? {}
            : { providerQuestionId: result.providerQuestionId }),
        },
      } satisfies WorkflowEventInput;
      if (result.providerResponseKind !== "user-input") {
        yield* committer.commit(awaitEvent);
        return;
      }
      yield* committer.commitMany([
        awaitEvent,
        {
          type: "TicketMessagePosted",
          eventId: yield* ids.eventId(),
          ticketId: row.ticketId,
          occurredAt,
          payload: {
            messageId: (yield* ids.messageId()) as MessageId,
            stepRunId: row.stepRunId,
            author: "agent",
            body: truncateTicketMessageBody(result.waitingReason),
            attachments: [],
            createdAt: occurredAt,
          },
        } satisfies WorkflowEventInput,
      ]);
    });

  const completeTerminalPipeline = (
    row: DispatchRecoveryRow,
    result: ProviderDispatchTerminalResult,
  ) =>
    "awaitingUser" in result
      ? Effect.void
      : engine.completeRecoveredStep(
          row.stepRunId,
          result.ok
            ? { _tag: "completed" }
            : { _tag: "failed", error: result.error ?? "turn failed" },
          row.turnId === null
            ? undefined
            : { threadId: row.threadId as ThreadId, turnId: row.turnId as TurnId },
        );

  const interruptProjectedTurn = (row: DispatchRecoveryRow) =>
    row.turnId === null
      ? Effect.void
      : nowIso.pipe(
          Effect.flatMap((interruptedAt) =>
            wrapSql(sql`
              UPDATE projection_turns
              SET state = 'interrupted',
                  completed_at = ${interruptedAt}
              WHERE thread_id = ${row.threadId}
                AND turn_id = ${row.turnId}
                AND state IN ('pending', 'running')
            `),
          ),
        );

  const deleteOrphanDispatches = wrapSql(sql`
    DELETE FROM workflow_dispatch_outbox
    WHERE NOT EXISTS (
      SELECT 1
      FROM projection_ticket AS ticket
      INNER JOIN projection_board AS board
        ON board.board_id = ticket.board_id
      WHERE ticket.ticket_id = workflow_dispatch_outbox.ticket_id
    )
  `).pipe(Effect.asVoid);

  const recoverTerminalDispatches = Effect.gen(function* () {
    yield* deleteOrphanDispatches;
    const rows = yield* wrapSql(sql<DispatchRecoveryRow>`
      SELECT
        dispatch_id AS "dispatchId",
        ticket_id AS "ticketId",
        step_run_id AS "stepRunId",
        thread_id AS "threadId",
        turn_id AS "turnId",
        status
      FROM workflow_dispatch_outbox
      WHERE status != 'confirmed'
    `);

    for (const row of rows) {
      if (row.status === "pending") {
        continue;
      }
      // Interrupted panels are settled by settleInterruptedPanelDispatches
      // before this stage runs; any panel row still unconfirmed here must
      // not be recovered single-dispatch (one member's terminal turn would
      // decide the whole panel) nor reset for re-dispatch.
      if (yield* isPanelStep(row.stepRunId as string)) {
        continue;
      }
      const state = yield* turns.read(row.threadId as never);
      if (state._tag === "running") {
        if (row.status === "started") {
          yield* interruptProjectedTurn(row);
          yield* wrapSql(sql`
            UPDATE workflow_dispatch_outbox
            SET status = 'pending',
                started_at = NULL,
                turn_id = NULL
            WHERE dispatch_id = ${row.dispatchId}
              AND status = 'started'
          `);
        }
        continue;
      }
      const result = yield* outbox.awaitTerminal(row.dispatchId as never, row.threadId as never);
      if ("awaitingUser" in result) {
        yield* commitAwaitingTerminalStep(row, result);
      }
      yield* completeTerminalPipeline(row, result);
    }
  });

  const releaseTerminalStepLeases = Effect.gen(function* () {
    const rows = yield* wrapSql(sql<LeaseRecoveryRow>`
      SELECT
        leases.worktree_ref AS "worktreeRef",
        leases.owner_id AS "ownerId",
        leases.fence_token AS "fenceToken"
      FROM worktree_lease AS leases
      WHERE leases.owner_kind = 'step'
        AND EXISTS (
          SELECT 1
          FROM workflow_events AS events
          WHERE events.event_type IN ('StepCompleted', 'StepFailed', 'StepBlocked')
            AND json_extract(events.payload_json, '$.stepRunId') = leases.owner_id
        )
    `);
    for (const row of rows) {
      yield* leases.release(row.worktreeRef, row.fenceToken);
    }
  });

  const recoverRunningScriptRuns = Effect.gen(function* () {
    const rows = yield* wrapSql(sql<ScriptRecoveryRow>`
      SELECT
        script_run_id AS "scriptRunId",
        ticket_id AS "ticketId",
        step_run_id AS "stepRunId"
      FROM workflow_script_run
      WHERE status = 'running'
    `);

    for (const row of rows) {
      const events = yield* ticketEvents(row.ticketId);
      if (!hasScriptExitedEvent(events, row.scriptRunId)) {
        yield* committer.commit({
          type: "ScriptStepExited",
          eventId: yield* ids.eventId(),
          ticketId: row.ticketId,
          occurredAt: yield* nowIso,
          payload: {
            scriptRunId: row.scriptRunId,
            exitCode: null,
            signal: null,
            outcome: "cancelled",
          },
        } satisfies WorkflowEventInput);
      }
      // Same crash window as merge recovery: a stored terminal event means
      // the step already finished — recover its outcome, don't fail it.
      const terminal = latestTerminalStepEvent(events, row.stepRunId);
      if (terminal !== null) {
        yield* engine.completeRecoveredStep(
          row.stepRunId,
          recoveredResultFromTerminalEvent(terminal),
        );
        continue;
      }
      yield* committer.commit({
        type: "StepFailed",
        eventId: yield* ids.eventId(),
        ticketId: row.ticketId,
        occurredAt: yield* nowIso,
        payload: {
          stepRunId: row.stepRunId,
          error: SCRIPT_RESTART_ERROR,
        },
      } satisfies WorkflowEventInput);
      yield* engine.completeRecoveredStep(row.stepRunId, {
        _tag: "failed",
        error: SCRIPT_RESTART_ERROR,
      });
    }
  });

  // Decide what a crash mid-merge actually did to the repo: the merge may
  // have landed (commit created before the event commit), be sitting half
  // done with MERGE_HEAD set, or never have started. Without git access we
  // conservatively report failure.
  const inspectInterruptedMerge = (
    repoRoot: string | null,
    ticketId: TicketId,
  ): Effect.Effect<RecoveredStepResult> =>
    Effect.gen(function* () {
      const failed: RecoveredStepResult = { _tag: "failed", error: MERGE_RESTART_ERROR };
      if (repoRoot === null || Option.isNone(mergeGit)) {
        return failed;
      }
      const git = mergeGit.value;
      const worktreeRef = `workflow/${ticketId}`;

      const mergeHead = yield* git.run({
        cwd: repoRoot,
        args: ["rev-parse", "-q", "--verify", "MERGE_HEAD"],
        allowNonZeroExit: true,
      });
      if (mergeHead.exitCode === 0) {
        const refTip = yield* git.run({
          cwd: repoRoot,
          args: ["rev-parse", "-q", "--verify", `refs/heads/${worktreeRef}`],
          allowNonZeroExit: true,
        });
        if (refTip.exitCode === 0 && refTip.stdout.trim() === mergeHead.stdout.trim()) {
          // The half-finished merge is ours: clean the repo up and let a
          // human re-run the lane.
          yield* git
            .run({ cwd: repoRoot, args: ["merge", "--abort"], allowNonZeroExit: true })
            .pipe(Effect.ignore);
          return {
            _tag: "blocked",
            reason: "Merge interrupted by server restart; the in-progress merge was aborted.",
          } satisfies RecoveredStepResult;
        }
        // Someone else's merge — leave the repo alone.
        return {
          _tag: "blocked",
          reason:
            "Merge interrupted by server restart and the repo has an unrelated in-progress merge.",
        } satisfies RecoveredStepResult;
      }

      const ancestor = yield* git.run({
        cwd: repoRoot,
        args: ["merge-base", "--is-ancestor", worktreeRef, "HEAD"],
        allowNonZeroExit: true,
      });
      if (ancestor.exitCode === 0) {
        // The ticket branch is fully contained in HEAD: the merge landed
        // before the crash (or there was nothing to merge).
        return { _tag: "completed" } satisfies RecoveredStepResult;
      }
      return failed;
    }).pipe(
      Effect.orElseSucceed(
        (): RecoveredStepResult => ({ _tag: "failed", error: MERGE_RESTART_ERROR }),
      ),
    );

  const recoverRunningMergeSteps = Effect.gen(function* () {
    const rows = yield* wrapSql(sql<MergeRecoveryRow>`
      SELECT
        step.ticket_id AS "ticketId",
        step.step_run_id AS "stepRunId",
        (
          SELECT projects.workspace_root
          FROM projection_ticket AS ticket
          INNER JOIN projection_board AS board
            ON board.board_id = ticket.board_id
          INNER JOIN projection_projects AS projects
            ON projects.project_id = board.project_id
          WHERE ticket.ticket_id = step.ticket_id
        ) AS "repoRoot"
      FROM projection_step_run AS step
      WHERE step.step_type = 'merge'
        AND step.status IN ('running', 'dispatch_requested')
    `);

    for (const row of rows) {
      const events = yield* ticketEvents(row.ticketId);
      // A crash between the terminal event append and its projection leaves
      // the step 'running' even though it already finished — recover the
      // stored outcome instead of synthesizing a failure.
      const terminal = latestTerminalStepEvent(events, row.stepRunId);
      if (terminal !== null) {
        yield* engine.completeRecoveredStep(
          row.stepRunId,
          recoveredResultFromTerminalEvent(terminal),
        );
        continue;
      }
      const result = yield* inspectInterruptedMerge(row.repoRoot, row.ticketId);
      yield* engine.completeRecoveredStep(row.stepRunId, result);
    }
  });

  // Resolve a pullRequest step's `action` ("open" | "land") from its board
  // definition. Returns null when the step def is no longer resolvable (board
  // edited/unloaded) — the caller then fails the step honestly.
  const resolvePullRequestAction = (boardId: BoardId, stepKey: string) =>
    Effect.gen(function* () {
      const definition = yield* boardRegistry.getDefinition(boardId);
      const step = definition?.lanes
        .flatMap((lane) => lane.pipeline ?? [])
        .find((candidate) => candidate.key === stepKey);
      return step !== undefined && step.type === "pullRequest" ? step.action : null;
    });

  // Recovery is by inspection (no retry budget), mirroring merge recovery. A PR
  // step left 'running' after a crash is settled by checking external state:
  //  - open : getTicketPrState is the authority. A recorded row means
  //    TicketPrOpened already committed → completed. No row means the open
  //    never committed; if a PR was nonetheless created on the remote
  //    (crash-after-create-before-commit) findPrForBranch adopts it, committing
  //    the missing TicketPrOpened. No PR found → failed.
  //  - land : prDetail on the recorded PR. state "merged" → completed; anything
  //    else (or no recorded PR) → failed (a land cannot have succeeded without a
  //    recorded PR to merge).
  const recoverRunningPullRequestSteps = Effect.gen(function* () {
    const rows = yield* wrapSql(sql<{
      readonly ticketId: TicketId;
      readonly stepRunId: StepRunId;
      readonly stepKey: string;
      readonly boardId: BoardId;
      readonly repoRoot: string | null;
    }>`
      SELECT
        step.ticket_id AS "ticketId",
        step.step_run_id AS "stepRunId",
        step.step_key AS "stepKey",
        ticket.board_id AS "boardId",
        (
          SELECT projects.workspace_root
          FROM projection_board AS board
          INNER JOIN projection_projects AS projects
            ON projects.project_id = board.project_id
          WHERE board.board_id = ticket.board_id
        ) AS "repoRoot"
      FROM projection_step_run AS step
      INNER JOIN projection_ticket AS ticket
        ON ticket.ticket_id = step.ticket_id
      WHERE step.step_type = 'pullRequest'
        AND step.status IN ('running', 'dispatch_requested')
    `);

    for (const row of rows) {
      const events = yield* ticketEvents(row.ticketId);
      // Same crash window as merge recovery: a stored terminal event means the
      // step already finished — recover its outcome.
      const terminal = latestTerminalStepEvent(events, row.stepRunId);
      if (terminal !== null) {
        yield* engine.completeRecoveredStep(
          row.stepRunId,
          recoveredResultFromTerminalEvent(terminal),
        );
        continue;
      }

      const action = yield* resolvePullRequestAction(row.boardId, row.stepKey);
      const prState = yield* readModel.getTicketPrState(row.ticketId);

      if (action === "land") {
        // A land cannot have landed without a recorded PR to merge.
        if (prState === null || Option.isNone(gitHub) || row.repoRoot === null) {
          yield* engine.completeRecoveredStep(row.stepRunId, {
            _tag: "failed",
            error: PR_LAND_RESTART_ERROR,
          });
          continue;
        }
        // A transient prDetail failure (network/rate-limit/auth blip during
        // startup) must NOT be conflated with a confirmed not-merged state: the
        // PR may have actually merged before the crash. Swallowing the error to
        // null and synthesizing a retryable failure would re-run `land`, whose
        // mergePr on the already-merged PR returns not-ok and blocks the ticket.
        // So: only the success channel decides merged-vs-failed (and a confirmed
        // not-merged is retryable — re-running land legitimately retries the
        // merge that never happened). On the error channel we cannot confirm
        // merge, so fail NON-retryably and leave it for honest manual recovery
        // rather than auto-driving an already-merged PR into 'blocked'.
        const recovered = yield* gitHub.value
          .prDetail({ cwd: row.repoRoot, prNumber: prState.prNumber })
          .pipe(
            Effect.matchEffect({
              onSuccess: (detail) =>
                Effect.succeed(
                  detail.state === "merged"
                    ? ({ _tag: "completed" } satisfies RecoveredStepResult)
                    : ({
                        _tag: "failed",
                        error: PR_LAND_RESTART_ERROR,
                      } satisfies RecoveredStepResult),
                ),
              onFailure: (cause) =>
                Effect.logWarning("workflow.recovery.land-pr-detail-failed", {
                  ticketId: row.ticketId,
                  stepRunId: row.stepRunId,
                  prNumber: prState.prNumber,
                  cause,
                }).pipe(
                  Effect.as({
                    _tag: "failed",
                    error: PR_LAND_RESTART_ERROR,
                    retryable: false,
                  } satisfies RecoveredStepResult),
                ),
            }),
          );
        yield* engine.completeRecoveredStep(row.stepRunId, recovered);
        continue;
      }

      // action === "open" (or an unresolvable step def — treat as open).
      if (prState !== null) {
        // TicketPrOpened already committed: the PR exists and was recorded.
        yield* engine.completeRecoveredStep(row.stepRunId, {
          _tag: "completed",
          output: { prNumber: prState.prNumber, url: prState.prUrl },
        });
        continue;
      }

      // No recorded PR. A PR may still have been created on the remote before
      // the crash; adopt it by branch, committing the missing TicketPrOpened.
      // Without a gh port or a repo root there is no way to look one up.
      if (Option.isNone(gitHub) || row.repoRoot === null) {
        yield* engine.completeRecoveredStep(row.stepRunId, {
          _tag: "failed",
          error: PR_OPEN_RESTART_ERROR,
        });
        continue;
      }
      const github = gitHub.value;
      const repoRoot = row.repoRoot;
      const branch = `workflow/${row.ticketId}`;
      const found = yield* github
        .findPrForBranch({ cwd: repoRoot, branch })
        .pipe(Effect.orElseSucceed(() => null));
      if (found === null) {
        yield* engine.completeRecoveredStep(row.stepRunId, {
          _tag: "failed",
          error: PR_OPEN_RESTART_ERROR,
        });
        continue;
      }

      // The remote PR is real but unrecorded: commit TicketPrOpened so the
      // PR-state projection is consistent, then complete the step. resolveRemote
      // backfills the remote/repo metadata the open action would have recorded.
      const remote = yield* github.resolveRemote(repoRoot).pipe(Effect.orElseSucceed(() => null));
      yield* committer.commit({
        type: "TicketPrOpened",
        eventId: yield* ids.eventId(),
        ticketId: row.ticketId,
        occurredAt: yield* nowIso,
        payload: {
          stepRunId: row.stepRunId,
          prNumber: found.number,
          url: found.url,
          branch,
          remoteName: remote?.remoteName ?? "origin",
          repo: remote?.repo ?? "",
        },
      } as WorkflowEventInput);
      yield* engine.completeRecoveredStep(row.stepRunId, {
        _tag: "completed",
        output: { prNumber: found.number, url: found.url },
      });
    }
  });

  // A crash between a step's terminal event and the next step (or the
  // PipelineCompleted commit) leaves the pipeline run 'running' with no live
  // fiber: nothing would ever route the ticket or release its WIP slot.
  // Resume those pipelines from their latest terminal step. Pipelines with a
  // pending/started dispatch are owned by the outbox monitors, and pipelines
  // whose ticket has already moved lanes are excluded by the token match.
  const resumeStrandedPipelines = Effect.gen(function* () {
    const rows = yield* wrapSql(sql<StrandedPipelineRow>`
      SELECT
        step.step_run_id AS "stepRunId",
        step.status,
        step.error,
        step.retryable,
        step.output_json AS "outputJson"
      FROM projection_pipeline_run AS pipeline
      INNER JOIN projection_step_run AS step
        ON step.rowid = (
          SELECT candidate.rowid
          FROM projection_step_run AS candidate
          WHERE candidate.pipeline_run_id = pipeline.pipeline_run_id
          ORDER BY candidate.started_at DESC, candidate.rowid DESC
          LIMIT 1
        )
      WHERE pipeline.status = 'running'
        AND step.status IN ('completed', 'failed', 'blocked')
        AND pipeline.lane_entry_token = (
          SELECT ticket.current_lane_entry_token
          FROM projection_ticket AS ticket
          WHERE ticket.ticket_id = pipeline.ticket_id
        )
        AND NOT EXISTS (
          SELECT 1
          FROM workflow_dispatch_outbox AS outbox
          WHERE outbox.ticket_id = pipeline.ticket_id
            AND outbox.status IN ('pending', 'started')
        )
    `);

    const parseOutput = (outputJson: string | null): unknown => {
      if (outputJson === null) {
        return undefined;
      }
      try {
        return JSON.parse(outputJson) as unknown;
      } catch {
        return undefined;
      }
    };

    for (const row of rows) {
      yield* engine.completeRecoveredStep(
        row.stepRunId,
        toRecoveredStepResult({
          status: row.status,
          error: row.error,
          retryable: row.retryable !== 0,
          output: parseOutput(row.outputJson),
        }),
      );
    }
  });

  // Panel detection must not depend on outbox row status: a sequential panel
  // crashed mid-member leaves earlier members 'confirmed' (and later members
  // not yet dispatched), so the started-row group can shrink to a single row
  // even though the step is a panel. Resolve the step definition instead.
  const isPanelStep = (stepRunId: string) =>
    Effect.gen(function* () {
      const stepRows = yield* wrapSql(sql<{
        readonly stepKey: string;
        readonly boardId: BoardId;
      }>`
        SELECT
          step.step_key AS "stepKey",
          ticket.board_id AS "boardId"
        FROM projection_step_run AS step
        INNER JOIN projection_ticket AS ticket
          ON ticket.ticket_id = step.ticket_id
        WHERE step.step_run_id = ${stepRunId}
      `);
      const stepRow = stepRows[0];
      if (stepRow !== undefined) {
        const definition = yield* boardRegistry.getDefinition(stepRow.boardId);
        const step = definition?.lanes
          .flatMap((lane) => lane.pipeline ?? [])
          .find((candidate) => candidate.key === stepRow.stepKey);
        if (step !== undefined) {
          // Mirrors the executor's panel gate (RealStepExecutor): a panel
          // only fans out when captureOutput is set.
          return step.type === "agent" && (step.panel ?? 0) >= 2 && step.captureOutput === true;
        }
      }
      // The step definition is not resolvable (board edited or unloaded);
      // fall back to counting every outbox row for the step regardless of
      // status — a panel fans out several dispatches under one stepRunId.
      const counts = yield* wrapSql(sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count
        FROM workflow_dispatch_outbox
        WHERE step_run_id = ${stepRunId}
      `);
      return (counts[0]?.count ?? 0) > 1;
    });

  // An interrupted panel cannot be resumed member-by-member: settle every
  // member row and fail the step honestly (retryable) instead.
  const settleInterruptedPanel = (stepRunId: string) =>
    Effect.gen(function* () {
      const confirmedAt = yield* nowIso;
      yield* wrapSql(sql`
        UPDATE workflow_dispatch_outbox
        SET status = 'confirmed',
            confirmed_at = ${confirmedAt}
        WHERE step_run_id = ${stepRunId}
      `);
      yield* engine.completeRecoveredStep(stepRunId as never, {
        _tag: "failed",
        error: "review panel interrupted by restart",
        retryable: true,
      });
    }).pipe(Effect.ignoreCause({ log: true }));

  // Panel rows must be settled before any single-dispatch stage touches the
  // outbox: recoverTerminalDispatches would complete the whole panel from one
  // member's terminal turn, and its row reset would let recoverPending start
  // a fresh provider turn for a dead panel member that nothing ever stops.
  const settleInterruptedPanelDispatches = Effect.gen(function* () {
    yield* deleteOrphanDispatches;
    const rows = yield* wrapSql(sql<{ readonly stepRunId: StepRunId }>`
      SELECT DISTINCT step_run_id AS "stepRunId"
      FROM workflow_dispatch_outbox
      WHERE status != 'confirmed'
    `);
    for (const row of rows) {
      if (yield* isPanelStep(row.stepRunId as string)) {
        yield* settleInterruptedPanel(row.stepRunId as string);
      }
    }
  });

  // Crash window: awaitTerminal (or the panel settlement) confirmed a step's
  // outbox rows but the process died before the engine committed the step's
  // terminal event. Every dispatch stage keys off non-confirmed rows and
  // resumeStrandedPipelines keys off projection-terminal steps, so nothing
  // else would ever settle the step — the ticket would stick 'running'
  // forever. Steps awaiting user input are excluded twice over: their
  // projection status is 'awaiting_user' and their dispatch row stays
  // 'started' until the wait resolves.
  //
  // No provider-session cleanup happens here (or anywhere in recovery):
  // recovery runs once at server startup, when every adapter session
  // registry is empty — interruptTurn/stopSession would only fail with
  // session-not-found. An agent child process orphaned by a hard-killed
  // server is unreachable through the provider API entirely; reining those
  // in would take OS-level lifecycle tracking, not a recovery-time call.
  const recoverConfirmedRunningSteps = Effect.gen(function* () {
    const rows = yield* wrapSql(sql<{
      readonly stepRunId: StepRunId;
      readonly ticketId: TicketId;
    }>`
      SELECT
        step.step_run_id AS "stepRunId",
        step.ticket_id AS "ticketId"
      FROM projection_step_run AS step
      WHERE step.status = 'running'
        AND EXISTS (
          SELECT 1
          FROM workflow_dispatch_outbox AS outbox
          WHERE outbox.step_run_id = step.step_run_id
        )
        AND NOT EXISTS (
          SELECT 1
          FROM workflow_dispatch_outbox AS outbox
          WHERE outbox.step_run_id = step.step_run_id
            AND outbox.status != 'confirmed'
        )
    `);
    for (const row of rows) {
      const events = yield* ticketEvents(row.ticketId);
      const terminal = latestTerminalStepEvent(events, row.stepRunId);
      yield* engine.completeRecoveredStep(
        row.stepRunId,
        terminal !== null
          ? recoveredResultFromTerminalEvent(terminal)
          : { _tag: "failed", error: STEP_RESTART_ERROR },
      );
    }
  });

  const monitorStartedDispatches = Effect.gen(function* () {
    yield* deleteOrphanDispatches;
    const allRows = yield* wrapSql(sql<DispatchRecoveryRow>`
      SELECT
        dispatch_id AS "dispatchId",
        ticket_id AS "ticketId",
        step_run_id AS "stepRunId",
        thread_id AS "threadId",
        turn_id AS "turnId",
        status
      FROM workflow_dispatch_outbox
      WHERE status = 'started'
    `);

    // Review-panel steps fan out several dispatches under one stepRunId.
    // Single-dispatch recovery would let the first member's terminal state
    // complete the whole step without a majority, so an interrupted panel
    // fails honestly (retryable) and its member rows are settled instead.
    const rowsByStep = new Map<string, DispatchRecoveryRow[]>();
    for (const row of allRows) {
      const group = rowsByStep.get(row.stepRunId as string) ?? [];
      group.push(row);
      rowsByStep.set(row.stepRunId as string, group);
    }
    const rows: DispatchRecoveryRow[] = [];
    for (const [stepRunId, group] of rowsByStep) {
      if (group.length === 1 && group[0] !== undefined && !(yield* isPanelStep(stepRunId))) {
        rows.push(group[0]);
        continue;
      }
      yield* settleInterruptedPanel(stepRunId);
    }

    yield* Effect.forEach(
      rows,
      (row) =>
        Effect.gen(function* () {
          const result = yield* outbox.awaitTerminal(
            row.dispatchId as never,
            row.threadId as never,
          );
          if ("awaitingUser" in result) {
            yield* commitAwaitingTerminalStep(row, result);
          }
          yield* completeTerminalPipeline(row, result);
          yield* releaseTerminalStepLeases;
        }).pipe(
          // Recovery monitors must not block startup. These continuations are not
          // registered as live pipeline fibers, so manual moves cannot interrupt
          // this narrow restart window.
          Effect.ignoreCause({ log: true }),
          Effect.forkDetach({ startImmediately: true }),
          Effect.asVoid,
        ),
      { discard: true },
    );
  });

  const preloadPersistedBoards = Effect.gen(function* () {
    const rows = yield* wrapSql(sql<PersistedBoardRecoveryRow>`
      SELECT
        board_id AS "boardId",
        project_id AS "projectId",
        workflow_file_path AS "workflowFilePath"
      FROM projection_board
      ORDER BY board_id ASC
    `);

    const { fileLoader, projectWorkspaceResolver } = yield* getOptionalBoardLoaders;
    const staleBoardIds = new Set<string>();
    if (Option.isSome(fileLoader) && Option.isSome(projectWorkspaceResolver)) {
      for (const row of rows) {
        yield* saveLocks.withSaveLock(
          row.boardId,
          Effect.gen(function* () {
            const currentBoard = yield* readModel.getBoard(row.boardId);
            if (currentBoard === null) {
              staleBoardIds.add(row.boardId as string);
              return;
            }

            const workspaceRoot = yield* projectWorkspaceResolver.value
              .resolve(currentBoard.projectId as ProjectId)
              .pipe(Effect.mapError(toRecoveryError("workflow recovery project resolve failed")));
            const workflowFilePath = currentBoard.workflowFilePath;
            const fileExists = yield* fileSystem
              .exists(path.resolve(workspaceRoot, workflowFilePath))
              .pipe(Effect.mapError(toRecoveryError("workflow recovery board file check failed")));

            if (!fileExists) {
              yield* deleteWorkflowBoardOwnedState(
                {
                  boardRegistry,
                  engine,
                  eventStore: store,
                  readModel,
                  versionStore,
                  sql,
                  ...(Option.isSome(worktreeJanitor)
                    ? { worktreeJanitor: worktreeJanitor.value }
                    : {}),
                  ...(Option.isSome(webhook) ? { webhook: webhook.value } : {}),
                  ...agentSessionDeletionDeps,
                },
                row.boardId,
              ).pipe(Effect.mapError(toRecoveryError("workflow recovery board cascade failed")));
              staleBoardIds.add(row.boardId as string);
              return;
            }

            yield* fileLoader.value
              .loadAndRegister({
                boardId: row.boardId,
                projectId: currentBoard.projectId as ProjectId,
                workspaceRoot,
                relativePath: workflowFilePath,
              })
              .pipe(
                Effect.catch((cause) =>
                  isMissingWorkflowFileError(cause)
                    ? deleteWorkflowBoardOwnedState(
                        {
                          boardRegistry,
                          engine,
                          eventStore: store,
                          readModel,
                          versionStore,
                          sql,
                          ...(Option.isSome(worktreeJanitor)
                            ? { worktreeJanitor: worktreeJanitor.value }
                            : {}),
                          ...(Option.isSome(webhook) ? { webhook: webhook.value } : {}),
                          ...agentSessionDeletionDeps,
                        },
                        row.boardId,
                      ).pipe(
                        Effect.tap(() =>
                          Effect.sync(() => staleBoardIds.add(row.boardId as string)),
                        ),
                        Effect.mapError(toRecoveryError("workflow recovery board cascade failed")),
                      )
                    : Effect.fail(toRecoveryError("workflow recovery board preload failed")(cause)),
                ),
              );
          }),
        );
      }
    }

    return rows
      .filter((row) => !staleBoardIds.has(row.boardId as string))
      .map((row) => row.boardId);
  });

  const recoverWorkflowWip = Effect.gen(function* () {
    const boardIds = yield* preloadPersistedBoards;
    for (const boardId of boardIds) {
      yield* engine.recoverBoardWip(boardId);
    }
  });

  const recover: WorkflowRecoveryShape["recover"] = () =>
    Effect.gen(function* () {
      yield* recoverWorkflowWip;
      yield* approvals.resume();
      yield* settleInterruptedPanelDispatches;
      yield* recoverTerminalDispatches;
      yield* recoverRunningScriptRuns;
      yield* recoverRunningMergeSteps;
      yield* recoverRunningPullRequestSteps;
      // Must run before recoverPending: tombstoneStaleDispatches also
      // confirms rows, and those superseded steps are not this sweep's
      // target (completeRecoveredStep's token guard handles them anyway).
      yield* recoverConfirmedRunningSteps;
      yield* outbox.recoverPending();
      yield* monitorStartedDispatches;
      yield* resumeStrandedPipelines;
      yield* releaseTerminalStepLeases;
    });

  return { recover } satisfies WorkflowRecoveryShape;
});

export const WorkflowRecoveryLive = Layer.effect(WorkflowRecovery, make);
