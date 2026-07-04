import * as NodeCrypto from "node:crypto";

import {
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ProviderOptionSelections,
  TrimmedNonEmptyString,
  type ModelSelection,
  type ProviderUserInputAnswers,
  type RuntimeMode,
  type TurnId,
  ThreadId,
} from "@t3tools/contracts";
import type { ProjectionTurnRecord } from "@t3tools/plugin-sdk";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";

import type { DispatchId, StepRunId } from "../../../contracts/workflow.ts";
import { readCapturedOutput as readCapturedOutputFromProjection } from "../capturedOutput.ts";
import { resolvePendingRequest, type WorkflowPendingRequest } from "../pendingRequestFilter.ts";
import { WorkflowEventStoreError } from "../Services/Errors.ts";
import {
  WorkflowAgentPort,
  WorkflowAgentsCapability,
  WorkflowProjectionsReadCapability,
  workflowDispatchCommandId,
  type WorkflowAgentPortShape,
  type WorkflowDispatchRequest,
  type WorkflowDispatchTerminalResult,
} from "../Services/WorkflowAgentPort.ts";

const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));
const TERMINAL_WAIT_TIMEOUT = "30 minutes";
const TERMINAL_WAIT_TIMEOUT_MESSAGE = "turn did not reach a terminal state before timeout";
const PROJECTION_LAG_ATTEMPTS = 5;
const PROJECTION_LAG_RETRY_DELAY = "200 millis";

type DispatchStatus = "reserved" | "start_requested" | "projected" | "terminal" | "abandoned";

interface DispatchStatusRow {
  readonly dispatchId: string;
  readonly threadId: string;
  readonly status: DispatchStatus;
  readonly messageId: string | null;
}

interface RecoverDispatchRow extends Omit<
  WorkflowDispatchRequest,
  "options" | "projectId" | "threadTitle" | "runtimeMode" | "messageId"
> {
  readonly status: DispatchStatus;
  readonly messageId: string | null;
  readonly optionsJson: string | null;
  readonly projectId: string | null;
  readonly threadTitle: string | null;
  readonly runtimeMode: string | null;
}

interface StepDispatchRow {
  readonly dispatchId: string;
}

interface DispatchForStepRow {
  readonly threadId: string;
  readonly messageId: string | null;
}

const dispatchOptionsJson = Schema.fromJsonString(ProviderOptionSelections);
const encodeDispatchOptionsJson = Schema.encodeEffect(dispatchOptionsJson);
const decodeDispatchOptionsJson = Schema.decodeEffect(dispatchOptionsJson);

const toDispatchError = (message: string) => (cause: unknown) =>
  new WorkflowEventStoreError({ message, cause });

const wrapSql = <A>(effect: Effect.Effect<A, SqlError>) =>
  effect.pipe(Effect.mapError(toDispatchError("dispatch op failed")));

const nextMessageId = (): MessageId =>
  MessageId.make(`workflow-message:${NodeCrypto.randomUUID()}`);

const normalizeRuntimeMode = (runtimeMode: string | null): RuntimeMode | undefined =>
  runtimeMode === "approval-required" ||
  runtimeMode === "auto-accept-edits" ||
  runtimeMode === "full-access"
    ? runtimeMode
    : undefined;

const recoverDispatchRowToRequest = (
  row: RecoverDispatchRow,
): Effect.Effect<WorkflowDispatchRequest> =>
  Effect.gen(function* () {
    const options =
      row.optionsJson === null || row.optionsJson.length === 0
        ? undefined
        : yield* decodeDispatchOptionsJson(row.optionsJson).pipe(
            Effect.orElseSucceed(() => undefined),
          );
    return {
      dispatchId: row.dispatchId,
      ticketId: row.ticketId,
      stepRunId: row.stepRunId,
      threadId: row.threadId,
      providerInstance: row.providerInstance,
      model: row.model,
      instruction: row.instruction,
      worktreePath: row.worktreePath,
      ...(options === undefined ? {} : { options }),
      ...(row.projectId === null ? {} : { projectId: ProjectId.make(row.projectId) }),
      ...(row.threadTitle === null ? {} : { threadTitle: row.threadTitle }),
      ...(normalizeRuntimeMode(row.runtimeMode) === undefined
        ? {}
        : { runtimeMode: normalizeRuntimeMode(row.runtimeMode) }),
    };
  });

const modelSelectionFromRequest = (req: WorkflowDispatchRequest): ModelSelection => ({
  instanceId: ProviderInstanceId.make(req.providerInstance),
  model: TrimmedNonEmptyString.make(req.model),
  ...(req.options === undefined ? {} : { options: req.options }),
});

const isTerminalProjection = (turn: ProjectionTurnRecord): boolean =>
  turn.state === "completed" || turn.state === "error" || turn.state === "interrupted";

const pendingToTerminalResult = (
  threadId: ThreadId,
  pending: WorkflowPendingRequest,
): WorkflowDispatchTerminalResult =>
  pending.kind === "request"
    ? {
        ok: false,
        awaitingUser: true,
        waitingReason: "Provider is waiting for user input",
        providerThreadId: threadId,
        providerRequestId: pending.requestId,
        providerResponseKind: "request",
      }
    : {
        ok: false,
        awaitingUser: true,
        waitingReason: pending.prompt ?? "Provider is waiting for user input",
        providerThreadId: threadId,
        providerRequestId: pending.requestId,
        providerResponseKind: "user-input",
        ...(pending.questionId === undefined ? {} : { providerQuestionId: pending.questionId }),
      };

const terminalTurnToResult = (turn: {
  readonly state: "completed" | "error" | "interrupted";
  readonly errorMessage?: string | undefined;
  readonly stopReason?: string | undefined;
}): WorkflowDispatchTerminalResult =>
  turn.state === "completed"
    ? { ok: true }
    : { ok: false, error: turn.errorMessage ?? turn.stopReason ?? turn.state };

const terminalProjectionToResult = (turn: ProjectionTurnRecord): WorkflowDispatchTerminalResult =>
  turn.state === "completed" ? { ok: true } : { ok: false, error: turn.state };

const isAwaitingUserResult = (
  result: WorkflowDispatchTerminalResult,
): result is WorkflowDispatchTerminalResult & { readonly awaitingUser: true } =>
  "awaitingUser" in result && result.awaitingUser === true;

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const agents = yield* WorkflowAgentsCapability;
  const projections = yield* WorkflowProjectionsReadCapability;
  const liveTurnIds = new Map<string, TurnId>();

  const getDispatchStatus = (dispatchId: DispatchId) =>
    wrapSql(sql<DispatchStatusRow>`
      SELECT
        dispatch_id AS "dispatchId",
        thread_id AS "threadId",
        status,
        message_id AS "messageId"
      FROM p_workflow_boards_dispatch_outbox
      WHERE dispatch_id = ${String(dispatchId)}
    `).pipe(Effect.map((rows) => rows[0] ?? null));

  const setDispatchStatus = (dispatchId: string, status: DispatchStatus) =>
    wrapSql(sql`
      UPDATE p_workflow_boards_dispatch_outbox
      SET status = ${status}
      WHERE dispatch_id = ${dispatchId}
    `).pipe(Effect.asVoid);

  const markTerminal = (dispatchId: string, status: "terminal" | "abandoned" = "terminal") =>
    nowIso.pipe(
      Effect.flatMap((confirmedAt) =>
        wrapSql(sql`
          UPDATE p_workflow_boards_dispatch_outbox
          SET status = ${status},
              confirmed_at = ${confirmedAt}
          WHERE dispatch_id = ${dispatchId}
        `).pipe(Effect.asVoid),
      ),
    );

  const readCorrelatedTurn = (threadId: ThreadId, messageId: MessageId) =>
    projections.listTurnsByThreadId({ threadId, limit: 2_000 }).pipe(
      Effect.map((turns) => turns.find((turn) => turn.pendingMessageId === messageId) ?? null),
      Effect.mapError(toDispatchError("turn correlation failed")),
    );

  const readPendingRequest = (threadId: ThreadId) =>
    projections
      .listActivitiesByThreadId({ threadId, limit: 2_000 })
      .pipe(
        Effect.map(resolvePendingRequest),
        Effect.mapError(toDispatchError("pending request read failed")),
      );

  const waitForPendingRequest = (
    threadId: ThreadId,
  ): Effect.Effect<WorkflowPendingRequest, WorkflowEventStoreError> =>
    readPendingRequest(threadId).pipe(
      Effect.flatMap((pending) => {
        if (pending !== null) {
          return Effect.succeed(pending);
        }
        return agents.observeThread(threadId).pipe(
          Stream.mapEffect(() => readPendingRequest(threadId)),
          Stream.filter((candidate): candidate is WorkflowPendingRequest => candidate !== null),
          Stream.runHead,
          Effect.flatMap(
            Option.match({
              onNone: () =>
                Effect.never as Effect.Effect<WorkflowPendingRequest, WorkflowEventStoreError>,
              onSome: Effect.succeed,
            }),
          ),
          Effect.mapError(toDispatchError("pending request observe failed")),
        );
      }),
    );

  const isPendingRequestLive: WorkflowAgentPortShape["isPendingRequestLive"] = (input) =>
    readPendingRequest(input.threadId).pipe(
      Effect.map((pending) => {
        if (pending === null) {
          return false;
        }
        if (pending.kind !== input.responseKind || pending.requestId !== input.requestId) {
          return false;
        }
        if (input.responseKind !== "user-input" || pending.kind !== "user-input") {
          return true;
        }
        return input.questionId === undefined || pending.questionId === input.questionId;
      }),
    );

  const cleanupSession: WorkflowAgentPortShape["cleanupSession"] = (threadId) =>
    agents
      .interruptTurn({ threadId })
      .pipe(Effect.ignore, Effect.andThen(agents.stopSession({ threadId }).pipe(Effect.ignore)));

  const readTerminalProjection = (threadId: ThreadId, messageId: MessageId) =>
    readCorrelatedTurn(threadId, messageId).pipe(
      Effect.map((turn) => (turn !== null && isTerminalProjection(turn) ? turn : null)),
    );

  const waitForTerminalProjection = (
    threadId: ThreadId,
    messageId: MessageId,
  ): Effect.Effect<WorkflowDispatchTerminalResult, WorkflowEventStoreError> =>
    readTerminalProjection(threadId, messageId).pipe(
      Effect.flatMap((turn) => {
        if (turn !== null) {
          return Effect.succeed(terminalProjectionToResult(turn));
        }
        return agents.observeThread(threadId).pipe(
          Stream.mapEffect(() => readTerminalProjection(threadId, messageId)),
          Stream.filter((candidate): candidate is ProjectionTurnRecord => candidate !== null),
          Stream.map(terminalProjectionToResult),
          Stream.runHead,
          Effect.flatMap(
            Option.match({
              onNone: () =>
                Effect.never as Effect.Effect<
                  WorkflowDispatchTerminalResult,
                  WorkflowEventStoreError
                >,
              onSome: Effect.succeed,
            }),
          ),
          Effect.mapError(toDispatchError("terminal projection observe failed")),
        );
      }),
    );

  const withTerminalTimeout = (
    threadId: ThreadId,
    effect: Effect.Effect<WorkflowDispatchTerminalResult, WorkflowEventStoreError>,
  ) =>
    effect.pipe(
      Effect.timeoutOption(TERMINAL_WAIT_TIMEOUT),
      Effect.flatMap(
        Option.match({
          onNone: () =>
            cleanupSession(threadId).pipe(
              Effect.as({
                ok: false,
                error: TERMINAL_WAIT_TIMEOUT_MESSAGE,
              } satisfies WorkflowDispatchTerminalResult),
            ),
          onSome: Effect.succeed,
        }),
      ),
    );

  const settleAwaitTerminalResult = (
    dispatchId: DispatchId,
    threadId: ThreadId,
    messageId: MessageId,
    result: WorkflowDispatchTerminalResult,
  ) =>
    Effect.gen(function* () {
      if (isAwaitingUserResult(result)) {
        const turn = yield* readCorrelatedTurn(threadId, messageId);
        if (turn !== null && isTerminalProjection(turn)) {
          yield* markTerminal(String(dispatchId));
          return terminalProjectionToResult(turn);
        }
        return result;
      }
      yield* markTerminal(String(dispatchId));
      return result;
    });

  const readCorrelatedTurnAfterProjectionLag = (threadId: ThreadId, messageId: MessageId) =>
    Effect.gen(function* () {
      for (let attempt = 0; attempt < PROJECTION_LAG_ATTEMPTS; attempt += 1) {
        yield* Effect.sleep(PROJECTION_LAG_RETRY_DELAY);
        const turn = yield* readCorrelatedTurn(threadId, messageId);
        if (turn !== null) {
          return turn;
        }
      }
      return null;
    });

  const startTurnForRequest = (
    req: WorkflowDispatchRequest,
    messageId: MessageId,
  ): Effect.Effect<void, WorkflowEventStoreError> => {
    const modelSelection = modelSelectionFromRequest(req);
    return agents
      .startTurn({
        threadId: req.threadId,
        text: req.instruction,
        messageId,
        commandId: workflowDispatchCommandId(req.dispatchId),
        modelSelection,
        ...(req.projectId === undefined
          ? {}
          : {
              bootstrap: {
                createThread: {
                  projectId: req.projectId,
                  title: req.threadTitle ?? "Workflow dispatch",
                  modelSelection,
                  runtimeMode: req.runtimeMode ?? "full-access",
                  worktreePath: req.worktreePath,
                },
              },
            }),
      })
      .pipe(
        Effect.tap((result) =>
          Effect.sync(() => liveTurnIds.set(String(req.dispatchId), result.turnId)),
        ),
        Effect.asVoid,
        Effect.mapError(toDispatchError("provider start failed")),
      );
  };

  const ensureStarted: WorkflowAgentPortShape["ensureStarted"] = (req) =>
    Effect.gen(function* () {
      const createdAt = yield* nowIso;
      const messageId = nextMessageId();
      const optionsJson =
        req.options === undefined
          ? null
          : yield* encodeDispatchOptionsJson(req.options).pipe(
              Effect.mapError(toDispatchError("dispatch options encode failed")),
            );
      // A3 engine continuity via WorkflowAgentSessionStore.getThreadId chooses req.threadId for continueSession; this port uses the thread it is given.
      yield* wrapSql(sql`
        INSERT INTO p_workflow_boards_dispatch_outbox (
          dispatch_id,
          ticket_id,
          step_run_id,
          thread_id,
          turn_id,
          message_id,
          provider_instance,
          model,
          instruction,
          worktree_path,
          options_json,
          project_id,
          thread_title,
          runtime_mode,
          status,
          created_at
        )
        VALUES (
          ${String(req.dispatchId)},
          ${String(req.ticketId)},
          ${String(req.stepRunId)},
          ${String(req.threadId)},
          NULL,
          ${messageId},
          ${req.providerInstance},
          ${req.model},
          ${req.instruction},
          ${req.worktreePath},
          ${optionsJson},
          ${req.projectId ?? null},
          ${req.threadTitle ?? null},
          ${req.runtimeMode ?? null},
          'reserved',
          ${createdAt}
        )
        ON CONFLICT(dispatch_id) DO NOTHING
      `);

      const status = yield* getDispatchStatus(req.dispatchId);
      if (!status || status.messageId === null) {
        return yield* new WorkflowEventStoreError({
          message: `dispatch ${String(req.dispatchId)} is missing its durable message id`,
        });
      }
      const durableMessageId = MessageId.make(status.messageId);
      if (status.status !== "reserved") {
        return { messageId: durableMessageId };
      }

      yield* startTurnForRequest(req, durableMessageId);
      const startedAt = yield* nowIso;
      yield* wrapSql(sql`
        UPDATE p_workflow_boards_dispatch_outbox
        SET status = 'start_requested',
            started_at = ${startedAt}
        WHERE dispatch_id = ${String(req.dispatchId)}
          AND status = 'reserved'
      `);
      return { messageId: durableMessageId };
    });

  const confirmStep: WorkflowAgentPortShape["confirmStep"] = (stepRunId) =>
    Effect.gen(function* () {
      const confirmedAt = yield* nowIso;
      yield* wrapSql(sql`
        UPDATE p_workflow_boards_dispatch_outbox
        SET status = 'terminal',
            confirmed_at = ${confirmedAt}
        WHERE step_run_id = ${String(stepRunId)}
          AND status NOT IN ('terminal', 'abandoned')
      `);
    });

  const getDispatchForStep: WorkflowAgentPortShape["getDispatchForStep"] = (stepRunId) =>
    wrapSql(sql<DispatchForStepRow>`
      SELECT
        thread_id AS "threadId",
        message_id AS "messageId"
      FROM p_workflow_boards_dispatch_outbox
      WHERE step_run_id = ${String(stepRunId)}
      ORDER BY created_at DESC, dispatch_id DESC
      LIMIT 1
    `).pipe(
      Effect.map((rows) => {
        const row = rows[0];
        if (!row || row.messageId === null) {
          return null;
        }
        return {
          threadId: ThreadId.make(row.threadId),
          messageId: MessageId.make(row.messageId),
        };
      }),
    );

  const awaitTerminal: WorkflowAgentPortShape["awaitTerminal"] = (dispatchId, threadId) =>
    Effect.gen(function* () {
      const row = yield* getDispatchStatus(dispatchId);
      if (!row || row.messageId === null) {
        return yield* new WorkflowEventStoreError({
          message: `dispatch not found for ${String(dispatchId)}`,
        });
      }
      const messageId = MessageId.make(row.messageId);
      const liveTurnId = liveTurnIds.get(String(dispatchId));
      const waitTerminal =
        liveTurnId === undefined
          ? waitForTerminalProjection(threadId, messageId)
          : agents.awaitTurn({ threadId, turnId: liveTurnId, timeout: TERMINAL_WAIT_TIMEOUT }).pipe(
              Effect.map(terminalTurnToResult),
              Effect.catch((cause: unknown) =>
                cleanupSession(threadId).pipe(
                  Effect.as({
                    ok: false,
                    error: cause instanceof Error ? cause.message : TERMINAL_WAIT_TIMEOUT_MESSAGE,
                  } satisfies WorkflowDispatchTerminalResult),
                ),
              ),
            );
      const waitPending = waitForPendingRequest(threadId).pipe(
        Effect.map((pending) => pendingToTerminalResult(threadId, pending)),
      );
      const result =
        liveTurnId === undefined
          ? yield* withTerminalTimeout(threadId, Effect.raceFirst(waitTerminal, waitPending))
          : yield* Effect.raceFirst(waitTerminal, waitPending);
      return yield* settleAwaitTerminalResult(dispatchId, threadId, messageId, result);
    });

  const awaitStepTerminal: WorkflowAgentPortShape["awaitStepTerminal"] = (stepRunId, threadId) =>
    Effect.gen(function* () {
      const rows = yield* wrapSql(sql<StepDispatchRow>`
        SELECT dispatch_id AS "dispatchId"
        FROM p_workflow_boards_dispatch_outbox
        WHERE step_run_id = ${String(stepRunId)}
        ORDER BY created_at DESC, dispatch_id DESC
        LIMIT 1
      `);
      const dispatchId = rows[0]?.dispatchId;
      if (!dispatchId) {
        return yield* new WorkflowEventStoreError({
          message: `dispatch not found for step ${String(stepRunId)}`,
        });
      }
      return yield* awaitTerminal(dispatchId as DispatchId, threadId);
    });

  const hasSupervisingPipeline = (stepRunId: StepRunId) =>
    wrapSql(sql<{ readonly present: number }>`
      SELECT 1 AS present
      FROM p_workflow_boards_projection_step_run AS step
      INNER JOIN p_workflow_boards_projection_pipeline_run AS pipeline
        ON pipeline.pipeline_run_id = step.pipeline_run_id
      INNER JOIN p_workflow_boards_projection_ticket AS ticket
        ON ticket.ticket_id = pipeline.ticket_id
      WHERE step.step_run_id = ${String(stepRunId)}
        AND step.status NOT IN ('completed', 'failed', 'blocked')
        AND pipeline.status = 'running'
        AND (
          ticket.current_lane_entry_token IS NULL
          OR pipeline.lane_entry_token = ticket.current_lane_entry_token
        )
      LIMIT 1
    `).pipe(Effect.map((rows) => rows.length > 0));

  const deleteOrphanDispatches = wrapSql(sql`
    DELETE FROM p_workflow_boards_dispatch_outbox
    WHERE NOT EXISTS (
      SELECT 1
      FROM p_workflow_boards_projection_ticket AS ticket
      INNER JOIN p_workflow_boards_projection_board AS board
        ON board.board_id = ticket.board_id
      WHERE ticket.ticket_id = p_workflow_boards_dispatch_outbox.ticket_id
    )
  `).pipe(Effect.asVoid);

  const tombstoneStaleDispatches = Effect.gen(function* () {
    const confirmedAt = yield* nowIso;
    yield* wrapSql(sql`
      UPDATE p_workflow_boards_dispatch_outbox
      SET status = 'terminal',
          confirmed_at = ${confirmedAt}
      WHERE status NOT IN ('terminal', 'abandoned')
        AND EXISTS (
          SELECT 1
          FROM p_workflow_boards_projection_step_run AS step
          INNER JOIN p_workflow_boards_projection_pipeline_run AS pipeline
            ON pipeline.pipeline_run_id = step.pipeline_run_id
          INNER JOIN p_workflow_boards_projection_ticket AS ticket
            ON ticket.ticket_id = pipeline.ticket_id
          WHERE step.step_run_id = p_workflow_boards_dispatch_outbox.step_run_id
            AND (
              ticket.current_lane_entry_token IS NULL
              OR pipeline.lane_entry_token != ticket.current_lane_entry_token
            )
        )
    `);
  });

  const recoverPending: WorkflowAgentPortShape["recoverPending"] = () =>
    Effect.gen(function* () {
      yield* deleteOrphanDispatches;
      yield* tombstoneStaleDispatches;
      const rows = yield* wrapSql(sql<RecoverDispatchRow>`
        SELECT
          dispatch_id AS "dispatchId",
          ticket_id AS "ticketId",
          step_run_id AS "stepRunId",
          thread_id AS "threadId",
          message_id AS "messageId",
          provider_instance AS "providerInstance",
          model,
          instruction,
          worktree_path AS "worktreePath",
          options_json AS "optionsJson",
          project_id AS "projectId",
          thread_title AS "threadTitle",
          runtime_mode AS "runtimeMode",
          status
        FROM p_workflow_boards_dispatch_outbox
        WHERE status IN ('reserved', 'start_requested', 'projected')
      `);

      for (const row of rows) {
        if (row.messageId === null) {
          yield* markTerminal(String(row.dispatchId), "abandoned");
          continue;
        }
        const messageId = MessageId.make(row.messageId);
        if (row.status === "reserved") {
          const req = yield* recoverDispatchRowToRequest(row);
          yield* startTurnForRequest(req, messageId);
          const startedAt = yield* nowIso;
          yield* wrapSql(sql`
            UPDATE p_workflow_boards_dispatch_outbox
            SET status = 'start_requested',
                started_at = ${startedAt}
            WHERE dispatch_id = ${String(row.dispatchId)}
              AND status = 'reserved'
          `);
          continue;
        }

        const threadId = ThreadId.make(row.threadId);
        const initialTurn = yield* readCorrelatedTurn(threadId, messageId);
        const turn =
          initialTurn ?? (yield* readCorrelatedTurnAfterProjectionLag(threadId, messageId));
        if (turn === null) {
          yield* cleanupSession(threadId);
          yield* markTerminal(String(row.dispatchId), "abandoned");
          continue;
        }
        if (isTerminalProjection(turn)) {
          yield* markTerminal(String(row.dispatchId));
          continue;
        }
        const supervised = yield* hasSupervisingPipeline(row.stepRunId);
        if (!supervised) {
          // A core turn left running is inert for owner-scoped plugin threads; the
          // plugin dispatch row is the authoritative recovery state.
          yield* cleanupSession(threadId);
          yield* markTerminal(String(row.dispatchId), "abandoned");
          continue;
        }
        if (row.status === "start_requested") {
          yield* setDispatchStatus(String(row.dispatchId), "projected");
        }
      }
    });

  const respond: WorkflowAgentPortShape["respond"] = (input) => {
    if (input.responseKind === "request") {
      return agents
        .respondToApproval({
          threadId: input.threadId,
          requestId: input.requestId,
          decision: input.approved ? "accept" : "decline",
        })
        .pipe(Effect.mapError(toDispatchError("provider response failed")));
    }
    if (
      input.text !== undefined &&
      (input.questionId === undefined || input.questionId.trim().length === 0)
    ) {
      return Effect.fail(
        new WorkflowEventStoreError({
          message: "provider user-input text response requires a question id",
        }),
      );
    }
    const answers =
      input.questionId === undefined || input.text === undefined
        ? {}
        : ({ [input.questionId]: input.text } as ProviderUserInputAnswers);
    return agents
      .respondToUserInput({
        threadId: input.threadId,
        requestId: input.requestId,
        answers,
      })
      .pipe(Effect.mapError(toDispatchError("provider response failed")));
  };

  return {
    ensureStarted,
    awaitTerminal,
    awaitStepTerminal,
    getDispatchForStep,
    confirmStep,
    readCapturedOutput: (input) => readCapturedOutputFromProjection(projections, input),
    respond,
    isPendingRequestLive,
    cleanupSession,
    recoverPending,
  } satisfies WorkflowAgentPortShape;
});

export const WorkflowAgentPortLive = Layer.effect(WorkflowAgentPort, make);
