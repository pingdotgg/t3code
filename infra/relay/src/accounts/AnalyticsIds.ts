import { and, eq, isNull } from "drizzle-orm";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as RelayDb from "../db.ts";
import { relayAnalyticsIds, relayEnvironmentLinks } from "../persistence/schema.ts";

export class AnalyticsIdPersistenceError extends Schema.TaggedError<AnalyticsIdPersistenceError>()(
  "AnalyticsIdPersistenceError",
  {
    userId: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to read or create the analytics id for user '${this.userId}'`;
  }
}

/**
 * Issues each Connect account a random id for product analytics, so analytics never carry
 * anything derived from the account id. Account deletion drops the row.
 */
export class AnalyticsIds extends Context.Service<
  AnalyticsIds,
  {
    readonly getOrCreate: (input: {
      readonly userId: string;
    }) => Effect.Effect<string, AnalyticsIdPersistenceError>;
    /** The id of the account that holds an active link to this environment identity, or null. */
    readonly getForLinkedEnvironment: (input: {
      readonly userId: string;
      readonly environmentId: string;
      readonly environmentPublicKey: string;
    }) => Effect.Effect<string | null, AnalyticsIdPersistenceError>;
  }
>()("t3code-relay/accounts/AnalyticsIds") {}

const make = Effect.gen(function* () {
  const db = yield* RelayDb.RelayDb;
  const random = yield* SecureRandom.SecureRandom;

  const read = (userId: string) =>
    db
      .select({ analyticsId: relayAnalyticsIds.analyticsId })
      .from(relayAnalyticsIds)
      .where(eq(relayAnalyticsIds.userId, userId))
      .limit(1);

  const getOrCreate = Effect.fn("relay.analytics_ids.get_or_create")(function* (input: {
    readonly userId: string;
  }) {
    const { userId } = input;
    const fail = (cause: unknown) => new AnalyticsIdPersistenceError({ userId, cause });
    const [existing] = yield* read(userId).pipe(Effect.mapError(fail));
    if (existing) return existing.analyticsId;
    // 32 random bytes in hex: the shape environment servers already accept as an owner id.
    const analyticsId = Hex.encode(yield* random.randomBytes(32));
    yield* db
      .insert(relayAnalyticsIds)
      .values({ userId, analyticsId, createdAt: DateTime.formatIso(yield* DateTime.now) })
      .onConflictDoNothing()
      .pipe(Effect.mapError(fail));
    // A concurrent first request may have won the insert; its id is the one to keep.
    const [created] = yield* read(userId).pipe(Effect.mapError(fail));
    return created?.analyticsId ?? analyticsId;
  });

  const getForLinkedEnvironment = Effect.fn("relay.analytics_ids.get_for_linked_environment")(
    function* (input: {
      readonly userId: string;
      readonly environmentId: string;
      readonly environmentPublicKey: string;
    }) {
      const links = yield* db
        .select({ environmentId: relayEnvironmentLinks.environmentId })
        .from(relayEnvironmentLinks)
        .where(
          and(
            eq(relayEnvironmentLinks.userId, input.userId),
            eq(relayEnvironmentLinks.environmentId, input.environmentId),
            eq(relayEnvironmentLinks.environmentPublicKey, input.environmentPublicKey),
            isNull(relayEnvironmentLinks.revokedAt),
          ),
        )
        .limit(1)
        .pipe(
          Effect.mapError(
            (cause) => new AnalyticsIdPersistenceError({ userId: input.userId, cause }),
          ),
        );
      return links.length > 0 ? yield* getOrCreate({ userId: input.userId }) : null;
    },
  );

  return AnalyticsIds.of({ getOrCreate, getForLinkedEnvironment });
});

export const layer = Layer.effect(AnalyticsIds, make);
