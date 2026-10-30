import {
  CheckpointId,
  CheckpointScopeId,
  CommandId,
  MessageId,
  NodeId,
  ProviderSessionId,
  RunAttemptId,
  ProviderApprovalDecision,
  ProviderUserInputAnswers,
  ProviderThreadId,
  ProviderTurnId,
  RunId,
  RuntimeRequestId,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { forkParked } from "../serverActivation.ts";

export const OrchestrationEffectRequestV2 = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("provider-runtime.continue"),
    sourceRunId: RunId,
  }),
  Schema.Struct({
    type: Schema.Literal("provider-session.detach"),
    providerSessionId: ProviderSessionId,
    detail: Schema.optional(Schema.String),
    revokeMcpCredential: Schema.optional(Schema.Boolean),
  }),
  Schema.Struct({
    type: Schema.Literal("provider-turn.start"),
    runId: RunId,
  }),
  Schema.Struct({
    type: Schema.Literal("provider-turn.interrupt"),
    providerSessionId: ProviderSessionId,
    providerThreadId: ProviderThreadId,
    providerTurnId: ProviderTurnId,
    subagent: Schema.optional(Schema.Struct({ id: NodeId, nativeTaskId: Schema.String })),
  }),
  Schema.Struct({
    type: Schema.Literal("provider-turn.steer"),
    providerSessionId: ProviderSessionId,
    providerThreadId: ProviderThreadId,
    providerTurnId: ProviderTurnId,
    messageId: MessageId,
  }),
  Schema.Struct({
    type: Schema.Literal("provider-turn.restart"),
    providerSessionId: ProviderSessionId,
    providerThreadId: ProviderThreadId,
    providerTurnId: ProviderTurnId,
    interruptedAttemptId: RunAttemptId,
    runId: RunId,
    sessionTransition: Schema.optional(
      Schema.Union([
        Schema.Struct({
          type: Schema.Literal("replace"),
          replacementProviderSessionId: ProviderSessionId,
        }),
        Schema.Struct({ type: Schema.Literal("detach") }),
      ]),
    ),
  }),
  Schema.Struct({
    type: Schema.Literal("runtime-request.respond"),
    providerSessionId: ProviderSessionId,
    requestId: RuntimeRequestId,
    decision: Schema.optional(ProviderApprovalDecision),
    feedback: Schema.optional(Schema.String),
    answers: Schema.optional(ProviderUserInputAnswers),
  }),
  Schema.Struct({
    type: Schema.Literal("provider-thread.rollback"),
    restoreFiles: Schema.optional(Schema.Boolean),
    providerThreadId: ProviderThreadId,
    checkpointId: CheckpointId,
    scopeId: CheckpointScopeId,
  }),
  Schema.Struct({
    type: Schema.Literal("checkpoint.capture"),
    runId: RunId,
    scopeId: CheckpointScopeId,
  }),
  Schema.Struct({
    type: Schema.Literal("scheduled-tasks.cleanup"),
  }),
  Schema.Struct({
    type: Schema.Literal("terminal.cleanup"),
  }),
  Schema.Struct({
    type: Schema.Literal("preview.cleanup"),
  }),
  Schema.Struct({
    type: Schema.Literal("attachment.cleanup"),
    attachmentIds: Schema.Array(Schema.String),
  }),
  Schema.Struct({
    type: Schema.Literal("thread-title.generate"),
    kind: Schema.Union([
      Schema.Struct({ type: Schema.Literal("initial"), messageId: MessageId }),
      Schema.Struct({ type: Schema.Literal("regenerate") }),
      Schema.Struct({ type: Schema.Literal("source"), text: Schema.String }),
    ]),
  }),
  Schema.Struct({
    type: Schema.Literal("delegated-tasks.stop"),
    reason: Schema.optional(Schema.String),
  }),
]);
export type OrchestrationEffectRequestV2 = typeof OrchestrationEffectRequestV2.Type;
export type ThreadTitleGenerationKind = Extract<
  OrchestrationEffectRequestV2,
  { readonly type: "thread-title.generate" }
>["kind"];

export const REPLAY_SAFE_EFFECT_TYPES_AFTER_PROCESS_LOSS = [
  "provider-runtime.continue",
  "provider-session.detach",
  "provider-thread.rollback",
  "checkpoint.capture",
  "scheduled-tasks.cleanup",
  "terminal.cleanup",
  "preview.cleanup",
  "attachment.cleanup",
  "thread-title.generate",
  "delegated-tasks.stop",
] as const satisfies ReadonlyArray<OrchestrationEffectRequestV2["type"]>;

export const PROCESS_BOUND_EFFECT_TYPES = [
  "provider-turn.start",
  "provider-turn.interrupt",
  "provider-turn.steer",
  "provider-turn.restart",
  "runtime-request.respond",
] as const satisfies ReadonlyArray<OrchestrationEffectRequestV2["type"]>;

export const OrchestrationEffectStatusV2 = Schema.Literals([
  "pending",
  "running",
  "succeeded",
  "failed",
  "cancelled",
]);
export type OrchestrationEffectStatusV2 = typeof OrchestrationEffectStatusV2.Type;

/** Receipts deduplicate retries, and restart re-enqueues need far less than a week. Retain failed rows to keep deleted-thread worktrees. */
export const SETTLED_EFFECT_RETENTION = Duration.days(7);
const PRUNE_BATCH_SIZE = 500;

export interface OrchestrationEffectV2 {
  readonly id: string;
  readonly commandId: CommandId;
  readonly threadId: ThreadId;
  readonly request: OrchestrationEffectRequestV2;
  readonly status: OrchestrationEffectStatusV2;
  readonly attemptCount: number;
  readonly availableAt: string;
  readonly leaseOwner: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly completedAt: string | null;
  readonly lastError: string | null;
}

export interface PendingOrchestrationEffectV2 {
  readonly id: string;
  readonly commandId: CommandId;
  readonly threadId: ThreadId;
  readonly request: OrchestrationEffectRequestV2;
  readonly availableAt?: DateTime.Utc;
}

export class EffectOutboxError extends Schema.TaggedError<EffectOutboxError>()(
  "EffectOutboxError",
  {
    operation: Schema.String,
    effectId: Schema.optional(Schema.String),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Orchestration effect outbox ${this.operation} failed${this.effectId === undefined ? "" : ` for ${this.effectId}`}.`;
  }
}

const isEffectOutboxError = Schema.is(EffectOutboxError);

export interface EffectOutboxV2Shape {
  readonly awaitAvailable: Effect.Effect<void>;
  readonly notifyAvailable: (count?: number) => Effect.Effect<void>;
  /** Persist rows only. Notify workers after the surrounding transaction commits. */
  readonly enqueue: (
    effects: ReadonlyArray<PendingOrchestrationEffectV2>,
  ) => Effect.Effect<void, EffectOutboxError>;
  readonly get: (
    effectId: string,
  ) => Effect.Effect<Option.Option<OrchestrationEffectV2>, EffectOutboxError>;
  readonly listByCommandId: (
    commandId: CommandId,
  ) => Effect.Effect<ReadonlyArray<OrchestrationEffectV2>, EffectOutboxError>;
  readonly cancelUnsettled: (input: {
    readonly threadId: ThreadId;
    readonly effectTypes: ReadonlyArray<OrchestrationEffectRequestV2["type"]>;
    readonly reason: string;
  }) => Effect.Effect<ReadonlyArray<string>, EffectOutboxError>;
  readonly signalCancellations: (effectIds: ReadonlyArray<string>) => Effect.Effect<void>;
  readonly awaitCancellation: (effectId: string) => Effect.Effect<void>;
  readonly clearCancellation: (effectId: string) => Effect.Effect<void>;
  /** Resolves once the effect is neither pending nor running, or right away when it does not exist. */
  readonly awaitSettled: (effectId: string) => Effect.Effect<void, EffectOutboxError>;
  readonly reconcileAfterProcessLoss: Effect.Effect<
    { readonly requeued: number; readonly cancelled: number },
    EffectOutboxError
  >;
  readonly claimNext: (input: {
    readonly workerId: string;
    readonly excludeRestartContinuations?: boolean;
  }) => Effect.Effect<Option.Option<OrchestrationEffectV2>, EffectOutboxError>;
  readonly nextClaimableAt: Effect.Effect<Option.Option<DateTime.Utc>, EffectOutboxError>;
  readonly succeed: (input: {
    readonly effectId: string;
    readonly workerId: string;
  }) => Effect.Effect<boolean, EffectOutboxError>;
  readonly retry: (input: {
    readonly effectId: string;
    readonly workerId: string;
    readonly error: string;
    readonly delayMs: number;
  }) => Effect.Effect<boolean, EffectOutboxError>;
  readonly fail: (input: {
    readonly effectId: string;
    readonly workerId: string;
    readonly error: string;
  }) => Effect.Effect<boolean, EffectOutboxError>;
  readonly pruneSettled: Effect.Effect<number, EffectOutboxError>;
}

export class EffectOutboxV2 extends Context.Service<EffectOutboxV2, EffectOutboxV2Shape>()(
  "t3/orchestration-v2/EffectOutbox/EffectOutboxV2",
) {}

type EffectRow = {
  readonly effect_id: string;
  readonly command_id: string;
  readonly thread_id: string;
  readonly effect_type: string;
  readonly payload_json: string;
  readonly status: string;
  readonly attempt_count: number;
  readonly available_at: string;
  readonly lease_owner: string | null;
  readonly created_at: string;
  readonly updated_at: string;
  readonly completed_at: string | null;
  readonly last_error: string | null;
};

const encodeRequest = Schema.encodeSync(Schema.fromJsonString(OrchestrationEffectRequestV2));
const decodeRequest = Schema.decodeUnknownEffect(
  Schema.fromJsonString(OrchestrationEffectRequestV2),
);

const rowToEffect = (row: EffectRow) =>
  decodeRequest(row.payload_json).pipe(
    Effect.map((request): OrchestrationEffectV2 => ({
      id: row.effect_id,
      commandId: CommandId.make(row.command_id),
      threadId: ThreadId.make(row.thread_id),
      request,
      status: row.status as OrchestrationEffectStatusV2,
      attemptCount: row.attempt_count,
      availableAt: row.available_at,
      leaseOwner: row.lease_owner,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      completedAt: row.completed_at,
      lastError: row.last_error,
    })),
  );

export const layer: Layer.Layer<EffectOutboxV2, never, SqlClient.SqlClient> = Layer.effect(
  EffectOutboxV2,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const available = yield* Queue.dropping<void>(64);
    const cancellationSignals = new Map<string, Deferred.Deferred<void>>();
    const settledSignals = new Map<string, Deferred.Deferred<void>>();
    const signalSettled = (effectIds: ReadonlyArray<string>) =>
      Effect.forEach(
        effectIds,
        (effectId) => {
          const signal = settledSignals.get(effectId);
          if (signal === undefined) return Effect.void;
          settledSignals.delete(effectId);
          return Deferred.succeed(signal, undefined);
        },
        { discard: true },
      );
    const notifyAvailable = (count = 1) =>
      Queue.offerAll(
        available,
        Array.from({ length: Math.min(64, Math.max(0, Math.floor(count))) }, () => undefined),
      ).pipe(Effect.asVoid);
    // Retry backoff must block later effects so turns cannot race a pending rollback.
    const claimableCandidatePredicate = (
      availableBefore?: string,
      excludeRestartContinuations = false,
    ) =>
      sql`
        ${
          availableBefore === undefined
            ? sql`1 = 1`
            : sql`candidate.available_at <= ${availableBefore}`
        }
        AND candidate.status = 'pending'
        AND NOT EXISTS (
          SELECT 1
          FROM orchestration_v2_effect_outbox AS active
          WHERE active.thread_id = candidate.thread_id
            AND (
              active.status = 'running'
              OR (
                active.status = 'pending'
                AND active.rowid < candidate.rowid
                AND ${
                  excludeRestartContinuations
                    ? sql`active.effect_type != 'provider-runtime.continue'`
                    : sql`1 = 1`
                }
              )
            )
            AND (
              (
                candidate.effect_type = 'thread-title.generate'
                AND active.effect_type = 'thread-title.generate'
              )
              OR
              (
                candidate.effect_type != 'thread-title.generate'
                AND active.effect_type != 'thread-title.generate'
              )
            )
        )
      `;

    const cancellationSignal = (effectId: string) => {
      const existing = cancellationSignals.get(effectId);
      if (existing !== undefined) return existing;
      const created = Deferred.makeUnsafe<void>();
      cancellationSignals.set(effectId, created);
      return created;
    };

    const decodeRows = (operation: string, rows: ReadonlyArray<EffectRow>) =>
      Effect.forEach(rows, rowToEffect).pipe(
        Effect.mapError((cause) => new EffectOutboxError({ operation, cause })),
      );

    const service: EffectOutboxV2Shape = {
      enqueue: Effect.fn("EffectOutbox.enqueue")(
        function* (effects) {
          const now = yield* DateTime.now;
          const nowIso = DateTime.formatIso(now);
          yield* Effect.forEach(
            effects,
            (effect) => sql`
              INSERT INTO orchestration_v2_effect_outbox (
                effect_id,
                command_id,
                thread_id,
                effect_type,
                payload_json,
                status,
                attempt_count,
                available_at,
                created_at,
                updated_at
              )
              VALUES (
                ${effect.id},
                ${effect.commandId},
                ${effect.threadId},
                ${effect.request.type},
                ${encodeRequest(effect.request)},
                'pending',
                0,
                ${DateTime.formatIso(effect.availableAt ?? now)},
                ${nowIso},
                ${nowIso}
              )
              ON CONFLICT(effect_id) DO NOTHING
            `,
            { concurrency: 1, discard: true },
          );
          // EventSink owns the corresponding post-commit notification.
        },
        Effect.mapError((cause) => new EffectOutboxError({ operation: "enqueue", cause })),
      ),
      get: (effectId) =>
        sql<EffectRow>`
          SELECT *
          FROM orchestration_v2_effect_outbox
          WHERE effect_id = ${effectId}
          LIMIT 1
        `.pipe(
          NodeSqliteClient.readOnly,
          Effect.flatMap((rows) => {
            const row = rows[0];
            return row === undefined ? Effect.succeedNone : rowToEffect(row).pipe(Effect.asSome);
          }),
          Effect.mapError((cause) => new EffectOutboxError({ operation: "get", effectId, cause })),
        ),
      awaitAvailable: Queue.take(available),
      notifyAvailable,
      listByCommandId: (commandId) =>
        sql<EffectRow>`
          SELECT *
          FROM orchestration_v2_effect_outbox
          WHERE command_id = ${commandId}
          ORDER BY created_at ASC, effect_id ASC
        `.pipe(
          NodeSqliteClient.readOnly,
          Effect.flatMap((rows) => decodeRows("list", rows)),
          Effect.mapError((cause) =>
            isEffectOutboxError(cause)
              ? cause
              : new EffectOutboxError({ operation: "list", cause }),
          ),
        ),
      cancelUnsettled: Effect.fn("EffectOutbox.cancelUnsettled")(
        function* ({ threadId, effectTypes, reason }) {
          if (effectTypes.length === 0) return [];
          const now = DateTime.formatIso(yield* DateTime.now);
          const rows = yield* sql<{ readonly effect_id: string }>`
            UPDATE orchestration_v2_effect_outbox
            SET
              status = 'cancelled',
              lease_owner = NULL,
              completed_at = ${now},
              updated_at = ${now},
              last_error = ${reason}
            WHERE thread_id = ${threadId}
              AND status IN ('pending', 'running')
              AND effect_type IN ${sql.in(effectTypes)}
            RETURNING effect_id
          `;
          return rows.map(({ effect_id }) => effect_id);
        },
        Effect.mapError((cause) => new EffectOutboxError({ operation: "cancel-unsettled", cause })),
      ),
      signalCancellations: Effect.fn("EffectOutbox.signalCancellations")(function* (effectIds) {
        yield* Effect.forEach(
          effectIds,
          (effectId) => {
            const signal = cancellationSignals.get(effectId);
            return signal === undefined ? Effect.void : Deferred.succeed(signal, undefined);
          },
          { discard: true },
        );
        yield* signalSettled(effectIds);
        if (effectIds.length > 0) yield* notifyAvailable(effectIds.length);
      }),
      awaitCancellation: (effectId) => Deferred.await(cancellationSignal(effectId)),
      clearCancellation: (effectId) =>
        Effect.sync(() => {
          cancellationSignals.delete(effectId);
        }),
      awaitSettled: Effect.fn("EffectOutbox.awaitSettled")(function* (effectId) {
        // Registered before the read, so a settle right after it still resolves.
        const signal = settledSignals.get(effectId) ?? Deferred.makeUnsafe<void>();
        settledSignals.set(effectId, signal);
        const effect = yield* service.get(effectId);
        if (Option.exists(effect, ({ status }) => status === "pending" || status === "running")) {
          return yield* Deferred.await(signal);
        }
        yield* signalSettled([effectId]);
      }),
      reconcileAfterProcessLoss: Effect.gen(function* () {
        const now = DateTime.formatIso(yield* DateTime.now);
        const cancelledRows = yield* sql<{ readonly effect_id: string }>`
          UPDATE orchestration_v2_effect_outbox
          SET
            status = 'cancelled',
            lease_owner = NULL,
            completed_at = ${now},
            updated_at = ${now},
            last_error = 'Cancelled because the server process ended before the effect completed.'
          WHERE status IN ('pending', 'running')
            AND effect_type IN ${sql.in(PROCESS_BOUND_EFFECT_TYPES)}
          RETURNING effect_id
        `;
        const requeuedRows = yield* sql<{ readonly effect_id: string }>`
          UPDATE orchestration_v2_effect_outbox
          SET
            status = 'pending',
            lease_owner = NULL,
            available_at = ${now},
            updated_at = ${now},
            last_error = 'Requeued after the previous server process ended.'
          WHERE status = 'running'
            AND effect_type IN ${sql.in(REPLAY_SAFE_EFFECT_TYPES_AFTER_PROCESS_LOSS)}
          RETURNING effect_id
        `;
        if (requeuedRows.length > 0) yield* notifyAvailable(requeuedRows.length);
        return { requeued: requeuedRows.length, cancelled: cancelledRows.length };
      }).pipe(
        Effect.mapError(
          (cause) => new EffectOutboxError({ operation: "reconcile-process-loss", cause }),
        ),
      ),
      // The worker polls for the next effect even when there is no work to claim.
      claimNext: Effect.fnUntraced(
        function* ({ workerId, excludeRestartContinuations = false }) {
          const now = yield* DateTime.now;
          const nowIso = DateTime.formatIso(now);
          // Idle claims return empty; tracing their full SQL on every poll overwhelms useful traces.
          const claimStatement = sql<EffectRow>`
            UPDATE orchestration_v2_effect_outbox
            SET
              status = 'running',
              attempt_count = attempt_count + 1,
              lease_owner = ${workerId},
              updated_at = ${nowIso},
              last_error = NULL
            WHERE effect_id = (
              SELECT candidate.effect_id
              FROM orchestration_v2_effect_outbox AS candidate
              WHERE ${claimableCandidatePredicate(nowIso, excludeRestartContinuations)}
                AND ${excludeRestartContinuations ? sql`candidate.effect_type != 'provider-runtime.continue'` : sql`1 = 1`}
              ORDER BY candidate.available_at ASC, candidate.created_at ASC, candidate.effect_id ASC
              LIMIT 1
            )
            RETURNING *
          `;
          const rows = yield* claimStatement.pipe(Effect.withTracerEnabled(false));
          const row = rows[0];
          if (row === undefined) return Option.none();
          cancellationSignals.set(row.effect_id, Deferred.makeUnsafe<void>());
          return Option.some(yield* rowToEffect(row));
        },
        Effect.mapError((cause) => new EffectOutboxError({ operation: "claim", cause })),
      ),
      nextClaimableAt: Effect.gen(function* () {
        const rows = yield* sql<{ readonly available_at: string | null }>`
          SELECT MIN(candidate.available_at) AS available_at
          FROM orchestration_v2_effect_outbox AS candidate
          WHERE ${claimableCandidatePredicate()}
        `.pipe(NodeSqliteClient.readOnly, Effect.withTracerEnabled(false));
        const availableAt = rows[0]?.available_at;
        if (availableAt === undefined || availableAt === null) return Option.none();
        const parsed = DateTime.make(availableAt);
        if (Option.isNone(parsed)) {
          return yield* new EffectOutboxError({
            operation: "next-claimable",
            cause: `Invalid available_at timestamp: ${availableAt}`,
          });
        }
        return parsed;
      }).pipe(
        Effect.mapError((cause) =>
          isEffectOutboxError(cause)
            ? cause
            : new EffectOutboxError({ operation: "next-claimable", cause }),
        ),
      ),
      succeed: Effect.fn("EffectOutbox.succeed")(
        function* ({ effectId, workerId }) {
          const now = DateTime.formatIso(yield* DateTime.now);
          const rows = yield* sql<{ readonly effect_id: string }>`
            UPDATE orchestration_v2_effect_outbox
            SET
              status = 'succeeded',
              lease_owner = NULL,
              completed_at = ${now},
              updated_at = ${now},
              last_error = NULL
            WHERE effect_id = ${effectId}
              AND status = 'running'
              AND lease_owner = ${workerId}
            RETURNING effect_id
          `;
          if (rows.length === 1) {
            cancellationSignals.delete(effectId);
            yield* signalSettled([effectId]);
            yield* notifyAvailable();
          }
          return rows.length === 1;
        },
        (effect, { effectId }) =>
          effect.pipe(
            Effect.mapError(
              (cause) => new EffectOutboxError({ operation: "succeed", effectId, cause }),
            ),
          ),
      ),
      retry: Effect.fn("EffectOutbox.retry")(
        function* ({ effectId, workerId, error, delayMs }) {
          const now = yield* DateTime.now;
          const nowIso = DateTime.formatIso(now);
          const availableAt = DateTime.formatIso(
            DateTime.add(now, { milliseconds: Math.max(0, delayMs) }),
          );
          const rows = yield* sql<{ readonly effect_id: string }>`
            UPDATE orchestration_v2_effect_outbox
            SET
              status = 'pending',
              available_at = ${availableAt},
              lease_owner = NULL,
              updated_at = ${nowIso},
              last_error = ${error}
            WHERE effect_id = ${effectId}
              AND status = 'running'
              AND lease_owner = ${workerId}
            RETURNING effect_id
          `;
          if (rows.length === 1) {
            cancellationSignals.delete(effectId);
            yield* notifyAvailable();
          }
          return rows.length === 1;
        },
        (effect, { effectId }) =>
          effect.pipe(
            Effect.mapError(
              (cause) => new EffectOutboxError({ operation: "retry", effectId, cause }),
            ),
          ),
      ),
      fail: Effect.fn("EffectOutbox.fail")(
        function* ({ effectId, workerId, error }) {
          const now = DateTime.formatIso(yield* DateTime.now);
          const rows = yield* sql<{ readonly effect_id: string }>`
            UPDATE orchestration_v2_effect_outbox
            SET
              status = 'failed',
              lease_owner = NULL,
              completed_at = ${now},
              updated_at = ${now},
              last_error = ${error}
            WHERE effect_id = ${effectId}
              AND status = 'running'
              AND lease_owner = ${workerId}
            RETURNING effect_id
          `;
          if (rows.length === 1) {
            cancellationSignals.delete(effectId);
            yield* signalSettled([effectId]);
            yield* notifyAvailable();
          }
          return rows.length === 1;
        },
        (effect, { effectId }) =>
          effect.pipe(
            Effect.mapError(
              (cause) => new EffectOutboxError({ operation: "fail", effectId, cause }),
            ),
          ),
      ),
      pruneSettled: Effect.gen(function* () {
        const cutoff = DateTime.formatIso(
          DateTime.subtractDuration(yield* DateTime.now, SETTLED_EFFECT_RETENTION),
        );
        // Separate batch statements release the write lock between batches.
        const deleteBatch = sql<{ readonly effect_id: string }>`
          DELETE FROM orchestration_v2_effect_outbox
          WHERE rowid IN (
            SELECT rowid
            FROM orchestration_v2_effect_outbox
            WHERE status IN ('succeeded', 'cancelled')
              AND completed_at < ${cutoff}
            LIMIT ${PRUNE_BATCH_SIZE}
          )
          RETURNING effect_id
        `;
        let pruned = 0;
        while (true) {
          const deleted = (yield* deleteBatch).length;
          pruned += deleted;
          if (deleted < PRUNE_BATCH_SIZE) return pruned;
          yield* Effect.yieldNow;
        }
      }).pipe(
        Effect.mapError((cause) => new EffectOutboxError({ operation: "prune-settled", cause })),
      ),
    };

    return service;
  }),
);

export const layerPruneWorker = Layer.effectDiscard(
  Effect.gen(function* () {
    const outbox = yield* EffectOutboxV2;
    yield* forkParked(
      outbox.pruneSettled.pipe(
        Effect.catch((cause) => Effect.logWarning("Failed to prune settled effects", { cause })),
        Effect.repeat(Schedule.spaced(Duration.hours(1))),
      ),
    );
  }),
);
