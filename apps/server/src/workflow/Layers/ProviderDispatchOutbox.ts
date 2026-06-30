import {
  ProviderInstanceId,
  ProviderOptionSelections,
  TrimmedNonEmptyString,
  type ModelSelection,
  type ProviderSendTurnInput,
  type ProviderSessionStartInput,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";

import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionTurnRepository } from "../../persistence/Services/ProjectionTurns.ts";
import { ProviderService } from "../../provider/Services/ProviderService.ts";
import { WorkflowEventStoreError } from "../Services/Errors.ts";
import {
  ProviderDispatchOutbox,
  ProviderTurnPort,
  type DispatchRequest,
  type ProviderDispatchTerminalResult,
  type ProviderDispatchOutboxShape,
  type ProviderTurnPortShape,
} from "../Services/ProviderDispatchOutbox.ts";
import { TurnStateReader } from "../Services/TurnStateReader.ts";

const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));
const TERMINAL_WAIT_TIMEOUT = Duration.minutes(30);

const toDispatchError = (message: string) => (cause: unknown) =>
  new WorkflowEventStoreError({ message, cause });

const wrapSql = <A>(effect: Effect.Effect<A, SqlError>) =>
  effect.pipe(Effect.mapError(toDispatchError("dispatch op failed")));

interface DispatchStatusRow {
  readonly status: "pending" | "started" | "confirmed";
  readonly turnId: string | null;
}

interface RecoverDispatchRow extends Omit<
  DispatchRequest,
  "options" | "projectId" | "threadTitle" | "runtimeMode"
> {
  readonly status: "pending" | "started" | "confirmed";
  readonly optionsJson: string | null;
  readonly projectId: string | null;
  readonly threadTitle: string | null;
  readonly runtimeMode: string | null;
}

const dispatchOptionsJson = Schema.fromJsonString(ProviderOptionSelections);
const encodeDispatchOptionsJson = Schema.encodeEffect(dispatchOptionsJson);
const decodeDispatchOptionsJson = Schema.decodeEffect(dispatchOptionsJson);

// Tolerant decode: an unparseable/legacy row should not abort recovery of the
// remaining pending dispatches, so a decode failure degrades to "no options".
const recoverDispatchRowToRequest = (row: RecoverDispatchRow): Effect.Effect<DispatchRequest> =>
  Effect.gen(function* () {
    const options =
      row.optionsJson === null || row.optionsJson.length === 0
        ? undefined
        : yield* decodeDispatchOptionsJson(row.optionsJson).pipe(
            Effect.orElseSucceed(() => undefined),
          );
    const runtimeMode =
      row.runtimeMode === "approval-required" ||
      row.runtimeMode === "auto-accept-edits" ||
      row.runtimeMode === "full-access"
        ? row.runtimeMode
        : undefined;
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
      ...(row.projectId === null ? {} : { projectId: row.projectId }),
      ...(row.threadTitle === null ? {} : { threadTitle: row.threadTitle }),
      ...(runtimeMode === undefined ? {} : { runtimeMode }),
    };
  });

interface StepDispatchRow {
  readonly dispatchId: string;
}

interface DispatchForStepRow {
  readonly threadId: string;
  readonly turnId: string | null;
}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const provider = yield* ProviderTurnPort;
  const turns = yield* TurnStateReader;

  const getDispatchStatus = (dispatchId: string) =>
    wrapSql(sql<DispatchStatusRow>`
      SELECT
        status,
        turn_id AS "turnId"
      FROM workflow_dispatch_outbox
      WHERE dispatch_id = ${dispatchId}
    `).pipe(Effect.map((rows) => rows[0] ?? null));

  const confirmStep: ProviderDispatchOutboxShape["confirmStep"] = (stepRunId) =>
    Effect.gen(function* () {
      const confirmedAt = yield* nowIso;
      yield* wrapSql(sql`
        UPDATE workflow_dispatch_outbox
        SET status = 'confirmed',
            confirmed_at = ${confirmedAt}
        WHERE step_run_id = ${stepRunId}
          AND status != 'confirmed'
      `);
    });

  const ensureStarted: ProviderDispatchOutboxShape["ensureStarted"] = (req) =>
    Effect.gen(function* () {
      const createdAt = yield* nowIso;
      const optionsJson =
        req.options === undefined
          ? null
          : yield* encodeDispatchOptionsJson(req.options).pipe(
              Effect.mapError(toDispatchError("dispatch options encode failed")),
            );
      yield* wrapSql(sql`
        INSERT INTO workflow_dispatch_outbox (
          dispatch_id,
          ticket_id,
          step_run_id,
          thread_id,
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
          ${req.dispatchId},
          ${req.ticketId},
          ${req.stepRunId},
          ${req.threadId},
          ${req.providerInstance},
          ${req.model},
          ${req.instruction},
          ${req.worktreePath},
          ${optionsJson},
          ${req.projectId ?? null},
          ${req.threadTitle ?? null},
          ${req.runtimeMode ?? null},
          'pending',
          ${createdAt}
        )
        ON CONFLICT(dispatch_id) DO NOTHING
      `);

      const status = yield* getDispatchStatus(req.dispatchId);
      if (
        (status?.status === "started" || status?.status === "confirmed") &&
        status.turnId !== null
      ) {
        return { turnId: status.turnId as never };
      }

      const { turnId } = yield* provider.ensureTurnStarted(req);
      const startedAt = yield* nowIso;
      yield* wrapSql(sql`
        UPDATE workflow_dispatch_outbox
        SET status = 'started',
            turn_id = ${turnId},
            started_at = ${startedAt}
        WHERE dispatch_id = ${req.dispatchId}
      `);
      return { turnId };
    });

  const getDispatchForStep: ProviderDispatchOutboxShape["getDispatchForStep"] = (stepRunId) =>
    wrapSql(sql<DispatchForStepRow>`
      SELECT
        thread_id AS "threadId",
        turn_id AS "turnId"
      FROM workflow_dispatch_outbox
      WHERE step_run_id = ${stepRunId}
      ORDER BY created_at DESC, dispatch_id DESC
      LIMIT 1
    `).pipe(
      Effect.map((rows) => {
        const row = rows[0];
        if (!row || row.turnId === null) {
          return null;
        }
        return {
          threadId: row.threadId as never,
          turnId: row.turnId as never,
        };
      }),
    );

  const awaitTerminal: ProviderDispatchOutboxShape["awaitTerminal"] = (dispatchId, threadId) => {
    const waitForTerminal: Effect.Effect<ProviderDispatchTerminalResult, WorkflowEventStoreError> =
      Effect.gen(function* () {
        let state = yield* turns.read(threadId);
        while (state._tag === "running") {
          yield* Effect.sleep("500 millis");
          state = yield* turns.read(threadId);
        }
        if (state._tag === "awaiting_user") {
          return {
            ok: false,
            awaitingUser: true,
            waitingReason: state.waitingReason,
            providerThreadId: state.providerThreadId,
            providerRequestId: state.providerRequestId,
            providerResponseKind: state.providerResponseKind,
            ...(state.providerQuestionId === undefined
              ? {}
              : { providerQuestionId: state.providerQuestionId }),
          } satisfies ProviderDispatchTerminalResult;
        }

        const confirmedAt = yield* nowIso;
        yield* wrapSql(sql`
        UPDATE workflow_dispatch_outbox
        SET status = 'confirmed',
            confirmed_at = ${confirmedAt}
        WHERE dispatch_id = ${dispatchId}
      `);

        return state._tag === "completed"
          ? ({ ok: true } satisfies ProviderDispatchTerminalResult)
          : ({ ok: false, error: state.error } satisfies ProviderDispatchTerminalResult);
      });

    return waitForTerminal.pipe(
      Effect.timeoutOption(TERMINAL_WAIT_TIMEOUT),
      Effect.flatMap((result) =>
        Option.match(result, {
          onNone: () =>
            Effect.gen(function* () {
              // The pipeline treats this timeout as the step's terminal
              // failure, so settle the outbox row too — otherwise restart
              // recovery would re-dispatch/re-monitor a step the pipeline
              // already routed on.
              const confirmedAt = yield* nowIso;
              yield* wrapSql(sql`
                UPDATE workflow_dispatch_outbox
                SET status = 'confirmed',
                    confirmed_at = ${confirmedAt}
                WHERE dispatch_id = ${dispatchId}
              `);
              return {
                ok: false,
                error: "turn did not reach a terminal state before timeout",
              } satisfies ProviderDispatchTerminalResult;
            }),
          onSome: Effect.succeed,
        }),
      ),
    );
  };

  const awaitStepTerminal: ProviderDispatchOutboxShape["awaitStepTerminal"] = (
    stepRunId,
    threadId,
  ) =>
    Effect.gen(function* () {
      const rows = yield* wrapSql(sql<StepDispatchRow>`
        SELECT dispatch_id AS "dispatchId"
        FROM workflow_dispatch_outbox
        WHERE step_run_id = ${stepRunId}
        ORDER BY created_at DESC, dispatch_id DESC
        LIMIT 1
      `);
      const dispatchId = rows[0]?.dispatchId;
      if (!dispatchId) {
        return yield* new WorkflowEventStoreError({
          message: `dispatch not found for step ${stepRunId}`,
        });
      }
      return yield* awaitTerminal(dispatchId as never, threadId);
    });

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

  // A dispatch row is only worth restarting while its pipeline still owns the
  // ticket: a manual move (or re-route) hands out a new lane entry token, and
  // restarting the superseded dispatch would let a stale agent mutate the
  // worktree after the user moved on.
  const tombstoneStaleDispatches = Effect.gen(function* () {
    const confirmedAt = yield* nowIso;
    yield* wrapSql(sql`
      UPDATE workflow_dispatch_outbox
      SET status = 'confirmed',
          confirmed_at = ${confirmedAt}
      WHERE status != 'confirmed'
        AND EXISTS (
          SELECT 1
          FROM projection_step_run AS step
          INNER JOIN projection_pipeline_run AS pipeline
            ON pipeline.pipeline_run_id = step.pipeline_run_id
          INNER JOIN projection_ticket AS ticket
            ON ticket.ticket_id = pipeline.ticket_id
          WHERE step.step_run_id = workflow_dispatch_outbox.step_run_id
            AND (
              ticket.current_lane_entry_token IS NULL
              OR pipeline.lane_entry_token != ticket.current_lane_entry_token
            )
        )
    `);
  });

  const recoverPending: ProviderDispatchOutboxShape["recoverPending"] = () =>
    Effect.gen(function* () {
      yield* deleteOrphanDispatches;
      yield* tombstoneStaleDispatches;
      const rows = yield* wrapSql(sql<RecoverDispatchRow>`
        SELECT
          dispatch_id AS "dispatchId",
          ticket_id AS "ticketId",
          step_run_id AS "stepRunId",
          thread_id AS "threadId",
          provider_instance AS "providerInstance",
          model,
          instruction,
          worktree_path AS "worktreePath",
          options_json AS "optionsJson",
          project_id AS "projectId",
          thread_title AS "threadTitle",
          runtime_mode AS "runtimeMode",
          status
        FROM workflow_dispatch_outbox
        WHERE status != 'confirmed'
      `);

      yield* Effect.forEach(
        rows,
        (row) =>
          row.status === "pending"
            ? recoverDispatchRowToRequest(row).pipe(Effect.flatMap(ensureStarted))
            : Effect.void,
        { discard: true },
      );
    });

  return {
    confirmStep,
    ensureStarted,
    getDispatchForStep,
    awaitTerminal,
    awaitStepTerminal,
    recoverPending,
  } satisfies ProviderDispatchOutboxShape;
});

export const ProviderDispatchOutboxLive = Layer.effect(ProviderDispatchOutbox, make);

export const ProviderTurnPortLive = Layer.effect(
  ProviderTurnPort,
  Effect.gen(function* () {
    const providerSvc = yield* ProviderService;
    const turns = yield* ProjectionTurnRepository;
    const orchestration = yield* Effect.serviceOption(OrchestrationEngineService);

    // Provider runtime ingestion (and the orchestration decider behind it)
    // only accepts events for threads that exist in the orchestration domain.
    // Workflow dispatch threads are not user chat threads, so create them as
    // hidden threads through the real command path before the session starts;
    // without this every dispatch turn is invisible and never reaches a
    // terminal state from the workflow's perspective.
    const ensureHiddenThreadShell = (req: DispatchRequest, modelSelection: ModelSelection) =>
      Effect.gen(function* () {
        if (req.projectId === undefined || Option.isNone(orchestration)) {
          return;
        }
        const now = yield* nowIso;
        yield* orchestration.value
          .dispatch({
            type: "thread.create",
            commandId: `workflow-thread-${req.threadId}` as never,
            threadId: req.threadId,
            projectId: req.projectId as never,
            title: req.threadTitle ?? "Workflow dispatch",
            modelSelection,
            runtimeMode: req.runtimeMode ?? "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: req.worktreePath as never,
            createdAt: now as never,
            hidden: true,
          })
          .pipe(
            Effect.catchCause((cause) => {
              // Re-dispatch after recovery hits the already-exists invariant —
              // that one is a benign no-op. Anything else means the provider
              // session would run invisibly, so fail the dispatch loudly.
              if (
                Cause.squash(cause) instanceof Error &&
                String(Cause.squash(cause)).includes("already exists")
              ) {
                return Effect.void;
              }
              return Effect.logWarning("workflow thread create failed", { cause }).pipe(
                Effect.andThen(
                  Effect.fail(
                    new WorkflowEventStoreError({
                      message: "workflow thread create failed",
                      cause: Cause.squash(cause),
                    }),
                  ),
                ),
              );
            }),
          );
      }).pipe(Effect.mapError(toDispatchError("workflow thread create failed")));

    const ensureTurnStarted: ProviderTurnPortShape["ensureTurnStarted"] = (req) =>
      Effect.gen(function* () {
        const existingTurns = yield* turns
          .listByThreadId({ threadId: req.threadId })
          .pipe(Effect.orElseSucceed(() => []));
        const existingTurn = existingTurns.findLast(
          (turn) => turn.turnId !== null && (turn.state === "pending" || turn.state === "running"),
        );
        if (existingTurn?.turnId !== undefined && existingTurn.turnId !== null) {
          return { turnId: existingTurn.turnId };
        }

        const providerInstanceId = ProviderInstanceId.make(req.providerInstance);
        const modelSelection = {
          instanceId: providerInstanceId,
          model: TrimmedNonEmptyString.make(req.model),
          ...(req.options === undefined ? {} : { options: req.options }),
        };
        yield* ensureHiddenThreadShell(req, modelSelection);
        const sessionInput = {
          threadId: req.threadId,
          providerInstanceId,
          cwd: TrimmedNonEmptyString.make(req.worktreePath),
          modelSelection,
          runtimeMode: req.runtimeMode ?? "full-access",
        } satisfies ProviderSessionStartInput;
        const sendInput = {
          threadId: req.threadId,
          input: TrimmedNonEmptyString.make(req.instruction),
          modelSelection,
        } satisfies ProviderSendTurnInput;

        yield* providerSvc.startSession(req.threadId, sessionInput);
        const turn = yield* providerSvc.sendTurn(sendInput);
        return { turnId: turn.turnId };
      }).pipe(Effect.mapError(toDispatchError("provider start failed")));

    return { ensureTurnStarted } satisfies ProviderTurnPortShape;
  }),
);
