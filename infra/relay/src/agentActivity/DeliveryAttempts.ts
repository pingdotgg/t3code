import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { and, eq, isNull } from "drizzle-orm";
import * as Crypto from "effect/Crypto";
import * as Schema from "effect/Schema";

import * as RelayDb from "../db.ts";
import { relayDeliveryAttempts } from "../persistence/schema.ts";

export class DeliveryAttemptRecordPersistenceError extends Schema.TaggedErrorClass<DeliveryAttemptRecordPersistenceError>()(
  "DeliveryAttemptRecordPersistenceError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Failed to persist APNs delivery attempt";
  }
}

export interface DeliveryAttemptInput {
  readonly userId: string | null;
  readonly environmentId: string | null;
  readonly threadId: string | null;
  readonly deviceId: string | null;
  readonly kind: string;
  readonly sourceJobId?: string | null;
  readonly token: string | null;
  readonly apnsStatus?: number;
  readonly apnsReason?: string;
  readonly apnsId?: string | null;
  readonly transportError?: string;
}

export interface DeliveryAttemptCompletionInput {
  readonly sourceJobId: string;
  readonly apnsStatus?: number;
  readonly apnsReason?: string;
  readonly apnsId?: string | null;
  readonly transportError?: string;
}

export type DeliverySourceJobClaimResult = "claimed" | "completed" | "in_flight";

export interface DeliveryAttemptsShape {
  readonly record: (
    input: DeliveryAttemptInput,
  ) => Effect.Effect<void, DeliveryAttemptRecordPersistenceError>;
  readonly claimSourceJob: (
    input: DeliveryAttemptInput & { readonly sourceJobId: string },
  ) => Effect.Effect<DeliverySourceJobClaimResult, DeliveryAttemptRecordPersistenceError>;
  readonly completeSourceJob: (
    input: DeliveryAttemptCompletionInput,
  ) => Effect.Effect<void, DeliveryAttemptRecordPersistenceError>;
}

export class DeliveryAttempts extends Context.Service<DeliveryAttempts, DeliveryAttemptsShape>()(
  "t3code-relay/agentActivity/DeliveryAttempts",
) {}

const SOURCE_JOB_CLAIM_LEASE_MINUTES = 10;

function insertValues(
  input: DeliveryAttemptInput,
  id: string,
  createdAt: string,
): typeof relayDeliveryAttempts.$inferInsert {
  return {
    id,
    createdAt,
    userId: input.userId,
    environmentId: input.environmentId,
    threadId: input.threadId,
    deviceId: input.deviceId,
    kind: input.kind,
    sourceJobId: input.sourceJobId ?? null,
    tokenSuffix: input.token?.slice(-8) ?? null,
    apnsStatus: input.apnsStatus ?? null,
    apnsReason: input.apnsReason ?? null,
    apnsId: input.apnsId ?? null,
    transportError: input.transportError ?? null,
  };
}

const make = Effect.gen(function* () {
  const db = yield* RelayDb.RelayDb;
  const crypto = yield* Crypto.Crypto;

  const isExpiredClaim = (claimedAt: string | null, now: DateTime.DateTime) => {
    if (claimedAt === null) {
      return true;
    }
    return Option.match(DateTime.make(claimedAt), {
      onNone: () => true,
      onSome: (dateTime) =>
        now.epochMilliseconds - dateTime.epochMilliseconds >=
        SOURCE_JOB_CLAIM_LEASE_MINUTES * 60 * 1_000,
    });
  };

  return DeliveryAttempts.of({
    record: Effect.fn("relay.delivery_attempts.record")(
      function* (input) {
        yield* Effect.annotateCurrentSpan({
          "relay.delivery.kind": input.kind,
          ...(input.sourceJobId ? { "relay.delivery.job_id": input.sourceJobId } : {}),
          ...(input.deviceId ? { "relay.mobile.device_id": input.deviceId } : {}),
          ...(input.environmentId ? { "relay.environment_id": input.environmentId } : {}),
          ...(input.threadId ? { "relay.thread_id": input.threadId } : {}),
        });
        const id = yield* crypto.randomUUIDv4;
        const createdAt = DateTime.formatIso(yield* DateTime.now);
        yield* db.insert(relayDeliveryAttempts).values(insertValues(input, id, createdAt));
      },
      Effect.mapError((cause) => new DeliveryAttemptRecordPersistenceError({ cause })),
    ),
    claimSourceJob: Effect.fn("relay.delivery_attempts.claim_source_job")(
      function* (input) {
        yield* Effect.annotateCurrentSpan({
          "relay.delivery.kind": input.kind,
          "relay.delivery.job_id": input.sourceJobId,
          ...(input.deviceId ? { "relay.mobile.device_id": input.deviceId } : {}),
          ...(input.environmentId ? { "relay.environment_id": input.environmentId } : {}),
          ...(input.threadId ? { "relay.thread_id": input.threadId } : {}),
        });
        const id = yield* crypto.randomUUIDv4;
        const now = yield* DateTime.now;
        const createdAt = DateTime.formatIso(now);
        const inserted = yield* db
          .insert(relayDeliveryAttempts)
          .values(insertValues(input, id, createdAt))
          .onConflictDoNothing({ target: relayDeliveryAttempts.sourceJobId })
          .returning({ id: relayDeliveryAttempts.id });
        if (inserted.length > 0) {
          return "claimed";
        }

        const existing = yield* db
          .select({
            createdAt: relayDeliveryAttempts.createdAt,
            apnsStatus: relayDeliveryAttempts.apnsStatus,
            apnsReason: relayDeliveryAttempts.apnsReason,
            apnsId: relayDeliveryAttempts.apnsId,
            transportError: relayDeliveryAttempts.transportError,
          })
          .from(relayDeliveryAttempts)
          .where(eq(relayDeliveryAttempts.sourceJobId, input.sourceJobId))
          .limit(1);
        const row = existing[0];
        if (!row) {
          return "in_flight";
        }
        if (
          row.apnsStatus !== null ||
          row.apnsReason !== null ||
          row.apnsId !== null ||
          row.transportError !== null
        ) {
          return "completed";
        }
        if (!isExpiredClaim(row.createdAt, now)) {
          return "in_flight";
        }

        const reclaimed = yield* db
          .update(relayDeliveryAttempts)
          .set({
            createdAt,
          })
          .where(
            and(
              eq(relayDeliveryAttempts.sourceJobId, input.sourceJobId),
              eq(relayDeliveryAttempts.createdAt, row.createdAt),
              isNull(relayDeliveryAttempts.apnsStatus),
              isNull(relayDeliveryAttempts.apnsReason),
              isNull(relayDeliveryAttempts.apnsId),
              isNull(relayDeliveryAttempts.transportError),
            ),
          )
          .returning({ id: relayDeliveryAttempts.id });
        return reclaimed.length > 0 ? "claimed" : "in_flight";
      },
      Effect.mapError((cause) => new DeliveryAttemptRecordPersistenceError({ cause })),
    ),
    completeSourceJob: Effect.fn("relay.delivery_attempts.complete_source_job")(
      function* (input) {
        yield* Effect.annotateCurrentSpan({ "relay.delivery.job_id": input.sourceJobId });
        const completedAt = DateTime.formatIso(yield* DateTime.now);
        yield* db
          .update(relayDeliveryAttempts)
          .set({
            createdAt: completedAt,
            apnsStatus: input.apnsStatus ?? null,
            apnsReason: input.apnsReason ?? null,
            apnsId: input.apnsId ?? null,
            transportError: input.transportError ?? null,
          })
          .where(eq(relayDeliveryAttempts.sourceJobId, input.sourceJobId));
      },
      Effect.mapError((cause) => new DeliveryAttemptRecordPersistenceError({ cause })),
    ),
  });
});

export const layer = Layer.effect(DeliveryAttempts, make);
