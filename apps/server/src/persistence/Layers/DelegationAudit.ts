import {
  DelegationAuditBeginResult,
  DelegationAuditError,
  DelegationAuditEvent,
  DelegationAuditEventContext,
  DelegationAuditPage,
  EventId,
  ThreadId,
} from "@t3tools/contracts";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import { Effect, Layer, Option, Schema, Struct } from "effect";

import { toPersistenceDecodeError, toPersistenceSqlError } from "../Errors.ts";
import {
  DelegationAuditRepository,
  type DelegationAuditRepositoryShape,
} from "../Services/DelegationAudit.ts";
import { redactAuditPayload } from "../../orchestration/auditRedaction.ts";

const MAX_AUDIT_PAGE_SIZE = 100;
const isDelegationAuditError = Schema.is(DelegationAuditError);

const InsertAuditEventRequest = Schema.Struct({
  eventId: EventId,
  operationId: Schema.String,
  attemptId: Schema.NullOr(Schema.String),
  sourceThreadId: ThreadId,
  sourceTurnId: DelegationAuditEvent.fields.sourceTurnId,
  sourceMessageId: DelegationAuditEvent.fields.sourceMessageId,
  childThreadId: DelegationAuditEvent.fields.childThreadId,
  eventType: DelegationAuditEvent.fields.eventType,
  occurredAt: DelegationAuditEvent.fields.occurredAt,
  evidenceStatus: DelegationAuditEvent.fields.evidenceStatus,
  redacted: Schema.Boolean,
  contextJson: Schema.String,
  payloadJson: Schema.String,
});

const DelegationAuditEventDbRowSchema = DelegationAuditEvent.mapFields(
  Struct.assign({
    context: Schema.fromJsonString(DelegationAuditEventContext),
    payload: Schema.fromJsonString(Schema.Unknown),
    redacted: Schema.Number,
  }),
);

const PageRequest = Schema.Struct({
  sourceThreadId: Schema.NullOr(ThreadId),
  operationId: Schema.NullOr(Schema.String),
  turnId: Schema.NullOr(DelegationAuditEvent.fields.sourceTurnId),
  beforeSequence: Schema.NullOr(DelegationAuditEvent.fields.sequence),
  limit: Schema.Number,
});

const OperationRequest = Schema.Struct({ operationId: Schema.String });
const ChildThreadRequest = Schema.Struct({ childThreadId: ThreadId });

function persistenceError(operation: string) {
  return (cause: unknown) =>
    isDelegationAuditError(cause)
      ? cause
      : Schema.isSchemaError(cause)
        ? toPersistenceDecodeError(operation)(cause)
        : toPersistenceSqlError(operation)(cause);
}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const insertAuditEvent = SqlSchema.void({
    Request: InsertAuditEventRequest,
    execute: (event) =>
      sql`
        INSERT OR IGNORE INTO delegation_audit_events (
          event_id,
          operation_id,
          attempt_id,
          source_thread_id,
          source_turn_id,
          source_message_id,
          child_thread_id,
          event_type,
          occurred_at,
          evidence_status,
          redacted,
          context_json,
          payload_json
        )
        VALUES (
          ${event.eventId},
          ${event.operationId},
          ${event.attemptId},
          ${event.sourceThreadId},
          ${event.sourceTurnId},
          ${event.sourceMessageId},
          ${event.childThreadId},
          ${event.eventType},
          ${event.occurredAt},
          ${event.evidenceStatus},
          ${event.redacted ? 1 : 0},
          ${event.contextJson},
          ${event.payloadJson}
        )
      `,
  });

  const getContext = SqlSchema.findOneOption({
    Request: OperationRequest,
    Result: Schema.Struct({
      sourceThreadId: ThreadId,
      sourceTurnId: DelegationAuditEvent.fields.sourceTurnId,
      sourceMessageId: DelegationAuditEvent.fields.sourceMessageId,
      context: Schema.fromJsonString(DelegationAuditEventContext),
    }),
    execute: ({ operationId }) =>
      sql`
        SELECT
          source_thread_id AS "sourceThreadId",
          source_turn_id AS "sourceTurnId",
          source_message_id AS "sourceMessageId",
          context_json AS "context"
        FROM delegation_audit_events
        WHERE operation_id = ${operationId}
        ORDER BY sequence ASC
        LIMIT 1
      `,
  });

  const getOperationSourceRow = SqlSchema.findOneOption({
    Request: OperationRequest,
    Result: Schema.Struct({ sourceThreadId: ThreadId }),
    execute: ({ operationId }) =>
      sql`
        SELECT source_thread_id AS "sourceThreadId"
        FROM delegation_audit_events
        WHERE operation_id = ${operationId}
        ORDER BY sequence ASC
        LIMIT 1
      `,
  });

  const getAttemptForChildRow = SqlSchema.findOneOption({
    Request: ChildThreadRequest,
    Result: Schema.Struct({
      operationId: Schema.String,
      attemptId: Schema.String,
      sourceThreadId: ThreadId,
    }),
    execute: ({ childThreadId }) =>
      sql`
        SELECT operation_id AS "operationId",
          attempt_id AS "attemptId",
          source_thread_id AS "sourceThreadId"
        FROM delegation_audit_events
        WHERE child_thread_id = ${childThreadId}
          AND attempt_id IS NOT NULL
        ORDER BY sequence DESC
        LIMIT 1
      `,
  });

  const getAuditEventsPage = SqlSchema.findAll({
    Request: PageRequest,
    Result: DelegationAuditEventDbRowSchema,
    execute: (input) =>
      sql`
        SELECT
          sequence,
          event_id AS "eventId",
          operation_id AS "operationId",
          attempt_id AS "attemptId",
          source_thread_id AS "sourceThreadId",
          source_turn_id AS "sourceTurnId",
          source_message_id AS "sourceMessageId",
          child_thread_id AS "childThreadId",
          event_type AS "eventType",
          occurred_at AS "occurredAt",
          evidence_status AS "evidenceStatus",
          redacted,
          context_json AS "context",
          payload_json AS "payload"
        FROM delegation_audit_events
        WHERE (${input.sourceThreadId} IS NULL OR source_thread_id = ${input.sourceThreadId})
          AND (${input.operationId} IS NULL OR operation_id = ${input.operationId})
          AND (${input.turnId} IS NULL OR source_turn_id = ${input.turnId})
          AND (${input.beforeSequence} IS NULL OR sequence < ${input.beforeSequence})
        ORDER BY sequence DESC
        LIMIT ${input.limit}
      `,
  });

  const insertEvent = (input: {
    readonly eventId: EventId;
    readonly operationId: string;
    readonly attemptId: string | null;
    readonly sourceThreadId: ThreadId;
    readonly sourceTurnId: DelegationAuditEvent["sourceTurnId"];
    readonly sourceMessageId: DelegationAuditEvent["sourceMessageId"];
    readonly childThreadId: DelegationAuditEvent["childThreadId"];
    readonly eventType: DelegationAuditEvent["eventType"];
    readonly occurredAt: DelegationAuditEvent["occurredAt"];
    readonly context: DelegationAuditEventContext;
    readonly payload: unknown;
  }) => {
    const safe = redactAuditPayload(input.payload);
    return insertAuditEvent({
      eventId: input.eventId,
      operationId: input.operationId,
      attemptId: input.attemptId,
      sourceThreadId: input.sourceThreadId,
      sourceTurnId: input.sourceTurnId,
      sourceMessageId: input.sourceMessageId,
      childThreadId: input.childThreadId,
      eventType: input.eventType,
      occurredAt: input.occurredAt,
      evidenceStatus: safe.evidenceStatus,
      redacted: safe.redacted,
      contextJson: JSON.stringify(input.context),
      payloadJson: JSON.stringify(safe.payload),
    });
  };

  const begin: DelegationAuditRepositoryShape["begin"] = (input) => {
    const context: DelegationAuditEventContext = {
      authorization: {
        sourceThreadId: input.sourceThreadId,
        sourceTurnId: input.sourceTurnId,
        initiatingMessageId: input.initiatingMessageId,
        scope: "orchestration:operate",
      },
      toolName: input.toolName,
      toolVersion: input.toolVersion,
      toolCallId: input.toolCallId,
      providerInstanceId: input.providerInstanceId,
      model: input.model,
      workspaceRoot: input.workspaceRoot,
      gitRevision: input.gitRevision,
      buildRevision: input.buildRevision,
    };
    return sql
      .withTransaction(
        Effect.gen(function* () {
          const existing = yield* getContext({ operationId: input.operationId });
          if (Option.isSome(existing)) {
            if (existing.value.sourceThreadId !== input.sourceThreadId)
              return yield* new DelegationAuditError({
                code: "invalid-audit-request",
                message: "The audit operation ID is already bound to another source thread.",
              });
            return;
          }

          yield* insertEvent({
            eventId: EventId.make(`delegation-audit:${input.operationId}:operation.requested`),
            operationId: input.operationId,
            attemptId: null,
            sourceThreadId: input.sourceThreadId,
            sourceTurnId: input.sourceTurnId,
            sourceMessageId: input.sourceMessageId,
            childThreadId: null,
            eventType: "operation.requested",
            occurredAt: input.occurredAt,
            context,
            payload: {
              requestCount: input.requests.length,
              toolArguments: input.requests.map((request) => request.arguments),
            },
          });
          for (const request of input.requests) {
            yield* insertEvent({
              eventId: EventId.make(
                `delegation-audit:${input.operationId}:${request.attemptId}:attempt.requested`,
              ),
              operationId: input.operationId,
              attemptId: request.attemptId,
              sourceThreadId: input.sourceThreadId,
              sourceTurnId: input.sourceTurnId,
              sourceMessageId: input.sourceMessageId,
              childThreadId: null,
              eventType: "attempt.requested",
              occurredAt: input.occurredAt,
              context,
              payload: request.arguments,
            });
          }
        }),
      )
      .pipe(
        Effect.mapError(persistenceError("DelegationAuditRepository.begin")),
        Effect.map(
          () =>
            ({
              operationId: input.operationId,
              sourceThreadId: input.sourceThreadId,
              sourceTurnId: input.sourceTurnId,
              sourceMessageId: input.sourceMessageId,
              initiatingMessageId: input.initiatingMessageId,
            }) satisfies DelegationAuditBeginResult,
        ),
      );
  };

  const append: DelegationAuditRepositoryShape["append"] = (input) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          const existing = yield* getContext({ operationId: input.operationId });
          if (Option.isNone(existing) || existing.value.sourceThreadId !== input.sourceThreadId)
            return yield* new DelegationAuditError({
              code: "operation-not-found",
              message: "The delegation audit operation was not found.",
            });
          if (input.attemptId !== null) {
            const attempt = yield* sql<{ readonly found: number }>`
              SELECT EXISTS(
                SELECT 1
                FROM delegation_audit_events
                WHERE operation_id = ${input.operationId}
                  AND source_thread_id = ${input.sourceThreadId}
                  AND attempt_id = ${input.attemptId}
                  AND event_type = 'attempt.requested'
              ) AS found
            `;
            if (attempt[0]?.found !== 1)
              return yield* new DelegationAuditError({
                code: "invalid-audit-request",
                message: "The delegation audit attempt was not found for this operation.",
              });
          }
          yield* insertEvent({
            ...input,
            sourceTurnId: existing.value.sourceTurnId,
            sourceMessageId: existing.value.sourceMessageId,
            context: existing.value.context,
          });
        }),
      )
      .pipe(Effect.mapError(persistenceError("DelegationAuditRepository.append")));

  const page: DelegationAuditRepositoryShape["page"] = (input) =>
    Effect.gen(function* () {
      if (input.sourceThreadId === undefined && input.operationId === undefined) {
        return yield* new DelegationAuditError({
          code: "invalid-audit-request",
          message: "Delegation audit queries require a source thread or operation ID.",
        });
      }
      let sourceThreadId = input.sourceThreadId;
      if (sourceThreadId === undefined && input.operationId !== undefined) {
        const operationSource = yield* getOperationSourceRow({
          operationId: input.operationId,
        });
        sourceThreadId = Option.isSome(operationSource)
          ? operationSource.value.sourceThreadId
          : undefined;
      }
      if (sourceThreadId === undefined) {
        return yield* new DelegationAuditError({
          code: "operation-not-found",
          message: "The delegation audit operation was not found.",
        });
      }
      const rows = yield* getAuditEventsPage({
        sourceThreadId,
        operationId: input.operationId ?? null,
        turnId: input.turnId ?? null,
        beforeSequence: input.beforeSequence,
        limit: Math.max(1, Math.min(MAX_AUDIT_PAGE_SIZE, input.limit)) + 1,
      });
      const pageSize = Math.max(1, Math.min(MAX_AUDIT_PAGE_SIZE, input.limit));
      const hasMore = rows.length > pageSize;
      const events = rows.slice(0, pageSize).map((row) => ({
        ...row,
        redacted: row.redacted !== 0,
      }));
      const last = events.at(-1);
      const warnings = events.flatMap((event) => {
        const eventWarnings =
          event.evidenceStatus === "truncated"
            ? [`Evidence ${event.eventId} was truncated before persistence.`]
            : event.evidenceStatus === "unavailable" || event.evidenceStatus === "expired"
              ? [`Evidence ${event.eventId} is ${event.evidenceStatus}.`]
              : event.redacted
                ? [`Evidence ${event.eventId} contains redacted credential values.`]
                : [];
        const missingContext = [
          event.context.providerInstanceId === null ? "provider instance" : null,
          event.context.model === null ? "provider model" : null,
          event.context.workspaceRoot === null ? "workspace root" : null,
          event.context.gitRevision === null ? "Git revision" : null,
        ].filter((value): value is string => value !== null);
        return missingContext.length === 0
          ? eventWarnings
          : [
              ...eventWarnings,
              `Evidence ${event.eventId} is missing execution context: ${missingContext.join(", ")}.`,
            ];
      });
      if (hasMore) warnings.push("More audit records are available on the next page.");
      const incomplete = yield* sql<{ readonly attempt_id: string }>`
        SELECT requested.attempt_id
        FROM delegation_audit_events AS requested
        WHERE requested.source_thread_id = ${sourceThreadId}
          AND (${input.operationId ?? null} IS NULL OR requested.operation_id = ${input.operationId ?? null})
          AND (${input.turnId ?? null} IS NULL OR requested.source_turn_id = ${input.turnId ?? null})
          AND requested.event_type = 'attempt.requested'
          AND NOT EXISTS (
            SELECT 1
            FROM delegation_audit_events AS completed
            WHERE completed.operation_id = requested.operation_id
              AND completed.attempt_id = requested.attempt_id
              AND completed.event_type = 'attempt.completed'
          )
        LIMIT 20
      `;
      if (incomplete.length > 0) {
        warnings.push(
          `Attempts without a durable completion record require reconciliation: ${incomplete
            .map((row) => row.attempt_id)
            .join(", ")}.`,
        );
      }
      return {
        sourceThreadId,
        events,
        cleanupStates: [],
        nextBeforeSequence: hasMore && last ? last.sequence : null,
        hasMore,
        warnings,
      } satisfies DelegationAuditPage;
    }).pipe(Effect.mapError(persistenceError("DelegationAuditRepository.page")));

  const getOperationSource: DelegationAuditRepositoryShape["getOperationSource"] = (operationId) =>
    getOperationSourceRow({ operationId }).pipe(
      Effect.map(Option.map((row) => row.sourceThreadId)),
      Effect.mapError(persistenceError("DelegationAuditRepository.getOperationSource")),
    );

  const getAttemptForChild: DelegationAuditRepositoryShape["getAttemptForChild"] = (
    childThreadId,
  ) =>
    getAttemptForChildRow({ childThreadId }).pipe(
      Effect.mapError(persistenceError("DelegationAuditRepository.getAttemptForChild")),
    );

  const deleteBySourceThreadId: DelegationAuditRepositoryShape["deleteBySourceThreadId"] = (
    sourceThreadId,
  ) =>
    sql`
      DELETE FROM delegation_audit_events
      WHERE source_thread_id = ${sourceThreadId}
    `.pipe(Effect.mapError(persistenceError("DelegationAuditRepository.deleteBySourceThreadId")));

  return {
    begin,
    append,
    page,
    getOperationSource,
    getAttemptForChild,
    deleteBySourceThreadId,
  } satisfies DelegationAuditRepositoryShape;
});

export const DelegationAuditRepositoryLive = Layer.effect(DelegationAuditRepository, make);
