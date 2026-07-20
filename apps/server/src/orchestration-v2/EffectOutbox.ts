import {
  CheckpointId,
  CheckpointScopeId,
  CommandId,
  MessageId,
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
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export const OrchestrationEffectRequestV2 = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("provider-session.detach"),
    providerSessionId: ProviderSessionId,
    detail: Schema.optional(Schema.String),
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
    answers: Schema.optional(ProviderUserInputAnswers),
  }),
  Schema.Struct({
    type: Schema.Literal("provider-thread.rollback"),
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
    type: Schema.Literal("terminal.cleanup"),
  }),
  Schema.Struct({
    type: Schema.Literal("attachment.cleanup"),
    attachmentIds: Schema.Array(Schema.String),
  }),
]);
export type OrchestrationEffectRequestV2 = typeof OrchestrationEffectRequestV2.Type;

export const REPLAY_SAFE_EFFECT_TYPES_AFTER_PROCESS_LOSS = [
  "provider-session.detach",
  "provider-thread.rollback",
  "checkpoint.capture",
  "terminal.cleanup",
  "attachment.cleanup",
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

export interface OrchestrationEffectV2 {
  readonly id: string;
  readonly commandId: CommandId;
  readonly threadId: ThreadId;
  readonly request: OrchestrationEffectRequestV2;
  readonly status: OrchestrationEffectStatusV2;
  readonly attemptCount: number;
  readonly availableAt: string;
  readonly leaseOwner: string | null;
  readonly leaseExpiresAt: string | null;
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

export class EffectOutboxError extends Schema.TaggedErrorClass<EffectOutboxError>()(
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
  readonly notifyAvailable: Effect.Effect<void>;
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
  readonly reconcileAfterProcessLoss: Effect.Effect<
    { readonly requeued: number; readonly cancelled: number },
    EffectOutboxError
  >;
  readonly claimNext: (input: {
    readonly workerId: string;
    readonly leaseDurationMs: number;
  }) => Effect.Effect<Option.Option<OrchestrationEffectV2>, EffectOutboxError>;
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
  readonly lease_expires_at: string | null;
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
    Effect.map(
      (request): OrchestrationEffectV2 => ({
        id: row.effect_id,
        commandId: CommandId.make(row.command_id),
        threadId: ThreadId.make(row.thread_id),
        request,
        status: row.status as OrchestrationEffectStatusV2,
        attemptCount: row.attempt_count,
        availableAt: row.available_at,
        leaseOwner: row.lease_owner,
        leaseExpiresAt: row.lease_expires_at,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        completedAt: row.completed_at,
        lastError: row.last_error,
      }),
    ),
  );

export const layer: Layer.Layer<EffectOutboxV2, never, SqlClient.SqlClient> = Layer.effect(
  EffectOutboxV2,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    // Availability is only a bounded latency hint; durable rows remain
    // authoritative. Retaining a small burst lets multiple worker slots wake
    // for distinct threads without allowing notifications to grow unbounded.
    const available = yield* Queue.dropping<void>(64);
    const cancellationSignals = new Map<string, Deferred.Deferred<void>>();

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
      enqueue: (effects) =>
        Effect.gen(function* () {
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
          if (effects.length > 0) {
            yield* Queue.offerAll(
              available,
              Array.from({ length: Math.min(effects.length, 64) }, () => undefined),
            );
          }
        }).pipe(Effect.mapError((cause) => new EffectOutboxError({ operation: "enqueue", cause }))),
      get: (effectId) =>
        sql<EffectRow>`
          SELECT *
          FROM orchestration_v2_effect_outbox
          WHERE effect_id = ${effectId}
          LIMIT 1
        `.pipe(
          Effect.flatMap((rows) => {
            const row = rows[0];
            return row === undefined
              ? Effect.succeed(Option.none())
              : rowToEffect(row).pipe(Effect.map(Option.some));
          }),
          Effect.mapError((cause) => new EffectOutboxError({ operation: "get", effectId, cause })),
        ),
      awaitAvailable: Queue.take(available),
      notifyAvailable: Queue.offer(available, undefined).pipe(Effect.asVoid),
      listByCommandId: (commandId) =>
        sql<EffectRow>`
          SELECT *
          FROM orchestration_v2_effect_outbox
          WHERE command_id = ${commandId}
          ORDER BY created_at ASC, effect_id ASC
        `.pipe(
          Effect.flatMap((rows) => decodeRows("list", rows)),
          Effect.mapError((cause) =>
            isEffectOutboxError(cause)
              ? cause
              : new EffectOutboxError({ operation: "list", cause }),
          ),
        ),
      cancelUnsettled: ({ threadId, effectTypes, reason }) =>
        Effect.gen(function* () {
          if (effectTypes.length === 0) return [];
          const now = DateTime.formatIso(yield* DateTime.now);
          const rows = yield* sql<{ readonly effect_id: string }>`
            UPDATE orchestration_v2_effect_outbox
            SET
              status = 'cancelled',
              lease_owner = NULL,
              lease_expires_at = NULL,
              completed_at = ${now},
              updated_at = ${now},
              last_error = ${reason}
            WHERE thread_id = ${threadId}
              AND status IN ('pending', 'running')
              AND effect_type IN ${sql.in(effectTypes)}
            RETURNING effect_id
          `;
          return rows.map(({ effect_id }) => effect_id);
        }).pipe(
          Effect.mapError(
            (cause) => new EffectOutboxError({ operation: "cancel-unsettled", cause }),
          ),
        ),
      signalCancellations: (effectIds) =>
        Effect.forEach(
          effectIds,
          (effectId) => {
            const signal = cancellationSignals.get(effectId);
            return signal === undefined ? Effect.void : Deferred.succeed(signal, undefined);
          },
          { discard: true },
        ),
      awaitCancellation: (effectId) => Deferred.await(cancellationSignal(effectId)),
      clearCancellation: (effectId) =>
        Effect.sync(() => {
          cancellationSignals.delete(effectId);
        }),
      reconcileAfterProcessLoss: Effect.gen(function* () {
        const now = DateTime.formatIso(yield* DateTime.now);
        const cancelledRows = yield* sql<{ readonly effect_id: string }>`
          UPDATE orchestration_v2_effect_outbox
          SET
            status = 'cancelled',
            lease_owner = NULL,
            lease_expires_at = NULL,
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
            lease_expires_at = NULL,
            available_at = ${now},
            updated_at = ${now},
            last_error = 'Requeued after the previous server process ended.'
          WHERE status = 'running'
            AND effect_type IN ${sql.in(REPLAY_SAFE_EFFECT_TYPES_AFTER_PROCESS_LOSS)}
          RETURNING effect_id
        `;
        if (requeuedRows.length > 0) yield* Queue.offer(available, undefined);
        return { requeued: requeuedRows.length, cancelled: cancelledRows.length };
      }).pipe(
        Effect.mapError(
          (cause) => new EffectOutboxError({ operation: "reconcile-process-loss", cause }),
        ),
      ),
      claimNext: ({ workerId, leaseDurationMs }) =>
        Effect.gen(function* () {
          const now = yield* DateTime.now;
          const nowIso = DateTime.formatIso(now);
          const leaseExpiresAt = DateTime.formatIso(
            DateTime.add(now, { milliseconds: Math.max(1, leaseDurationMs) }),
          );
          const rows = yield* sql<EffectRow>`
            UPDATE orchestration_v2_effect_outbox
            SET
              status = 'running',
              attempt_count = attempt_count + 1,
              lease_owner = ${workerId},
              lease_expires_at = ${leaseExpiresAt},
              updated_at = ${nowIso},
              last_error = NULL
            WHERE effect_id = (
              SELECT candidate.effect_id
              FROM orchestration_v2_effect_outbox AS candidate
              WHERE candidate.available_at <= ${nowIso}
                AND candidate.status = 'pending'
                AND NOT EXISTS (
                  SELECT 1
                  FROM orchestration_v2_effect_outbox AS active
                  WHERE active.thread_id = candidate.thread_id
                    AND active.status = 'running'
                )
              ORDER BY candidate.available_at ASC, candidate.created_at ASC, candidate.effect_id ASC
              LIMIT 1
            )
            RETURNING *
          `;
          const row = rows[0];
          if (row === undefined) return Option.none();
          cancellationSignals.set(row.effect_id, Deferred.makeUnsafe<void>());
          return Option.some(yield* rowToEffect(row));
        }).pipe(Effect.mapError((cause) => new EffectOutboxError({ operation: "claim", cause }))),
      succeed: ({ effectId, workerId }) =>
        Effect.gen(function* () {
          const now = DateTime.formatIso(yield* DateTime.now);
          const rows = yield* sql<{ readonly effect_id: string }>`
            UPDATE orchestration_v2_effect_outbox
            SET
              status = 'succeeded',
              lease_owner = NULL,
              lease_expires_at = NULL,
              completed_at = ${now},
              updated_at = ${now},
              last_error = NULL
            WHERE effect_id = ${effectId}
              AND status = 'running'
              AND lease_owner = ${workerId}
            RETURNING effect_id
          `;
          if (rows.length === 1) cancellationSignals.delete(effectId);
          return rows.length === 1;
        }).pipe(
          Effect.mapError(
            (cause) => new EffectOutboxError({ operation: "succeed", effectId, cause }),
          ),
        ),
      retry: ({ effectId, workerId, error, delayMs }) =>
        Effect.gen(function* () {
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
              lease_expires_at = NULL,
              updated_at = ${nowIso},
              last_error = ${error}
            WHERE effect_id = ${effectId}
              AND status = 'running'
              AND lease_owner = ${workerId}
            RETURNING effect_id
          `;
          if (rows.length === 1) cancellationSignals.delete(effectId);
          return rows.length === 1;
        }).pipe(
          Effect.mapError(
            (cause) => new EffectOutboxError({ operation: "retry", effectId, cause }),
          ),
        ),
      fail: ({ effectId, workerId, error }) =>
        Effect.gen(function* () {
          const now = DateTime.formatIso(yield* DateTime.now);
          const rows = yield* sql<{ readonly effect_id: string }>`
            UPDATE orchestration_v2_effect_outbox
            SET
              status = 'failed',
              lease_owner = NULL,
              lease_expires_at = NULL,
              completed_at = ${now},
              updated_at = ${now},
              last_error = ${error}
            WHERE effect_id = ${effectId}
              AND status = 'running'
              AND lease_owner = ${workerId}
            RETURNING effect_id
          `;
          if (rows.length === 1) cancellationSignals.delete(effectId);
          return rows.length === 1;
        }).pipe(
          Effect.mapError((cause) => new EffectOutboxError({ operation: "fail", effectId, cause })),
        ),
    };

    return service;
  }),
);
