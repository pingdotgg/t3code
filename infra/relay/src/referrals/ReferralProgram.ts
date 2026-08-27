import type {
  RelayReferralClaimResponse,
  RelayReferralClaimResult,
  RelayReferralSummary,
} from "@t3tools/contracts/relay";
import { normalizeReferralCode, REFERRAL_AWARD_POINTS } from "@t3tools/shared/referral";
import { and, asc, eq, isNotNull, isNull, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Encoding from "effect/Encoding";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as RelayDb from "../db.ts";
import {
  relayEnvironmentLinks,
  relayReferralAccounts,
  relayReferralPointEntries,
} from "../persistence/schema.ts";

type ReferralAccountRecord = typeof relayReferralAccounts.$inferSelect;

export class ReferralProgramPersistenceError extends Schema.TaggedErrorClass<ReferralProgramPersistenceError>()(
  "ReferralProgramPersistenceError",
  {
    operation: Schema.Literals([
      "create-account",
      "load-account",
      "load-summary",
      "claim-referral",
      "qualify-referral",
      "recover-referrals",
    ]),
    userId: Schema.String,
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Referral program persistence failed during '${this.operation}' for user '${this.userId}'`;
  }
}

const isReferralProgramPersistenceError = Schema.is(ReferralProgramPersistenceError);

export class ReferralProgram extends Context.Service<
  ReferralProgram,
  {
    readonly getSummary: (input: {
      readonly userId: string;
    }) => Effect.Effect<RelayReferralSummary, ReferralProgramPersistenceError>;
    readonly claim: (input: {
      readonly userId: string;
      readonly referralCode: string;
    }) => Effect.Effect<RelayReferralClaimResponse, ReferralProgramPersistenceError>;
    readonly qualify: (input: {
      readonly userId: string;
    }) => Effect.Effect<boolean, ReferralProgramPersistenceError>;
    readonly recoverPendingAwards: (input?: {
      readonly referrerUserId?: string;
    }) => Effect.Effect<number, ReferralProgramPersistenceError>;
  }
>()("t3code-relay/referrals/ReferralProgram") {}

export const make = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const db = yield* RelayDb.RelayDb;
  const transactions = yield* RelayDb.RelayTransactions;

  const loadAccount = Effect.fn("relay.referrals.load_account")(function* (userId: string) {
    const rows = yield* db
      .select()
      .from(relayReferralAccounts)
      .where(eq(relayReferralAccounts.userId, userId))
      .limit(1)
      .pipe(
        Effect.mapError(
          (cause) =>
            new ReferralProgramPersistenceError({
              operation: "load-account",
              userId,
              cause,
            }),
        ),
      );
    return rows[0] ?? null;
  });

  const ensureAccount = Effect.fn("relay.referrals.ensure_account")(function* (
    userId: string,
  ): Effect.fn.Return<ReferralAccountRecord, ReferralProgramPersistenceError> {
    const existing = yield* loadAccount(userId);
    if (existing) return existing;

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const now = DateTime.formatIso(yield* DateTime.now);
      const referralCode = yield* crypto.randomBytes(8).pipe(
        Effect.map((bytes) => Encoding.encodeHex(bytes).toUpperCase()),
        Effect.mapError(
          (cause) =>
            new ReferralProgramPersistenceError({
              operation: "create-account",
              userId,
              cause,
            }),
        ),
      );
      const inserted = yield* db
        .insert(relayReferralAccounts)
        .values({
          userId,
          referralCode,
          referrerUserId: null,
          referredAt: null,
          qualifiedAt: null,
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoNothing()
        .returning()
        .pipe(
          Effect.mapError(
            (cause) =>
              new ReferralProgramPersistenceError({
                operation: "create-account",
                userId,
                cause,
              }),
          ),
        );
      if (inserted[0]) return inserted[0];

      const raced = yield* loadAccount(userId);
      if (raced) return raced;
    }

    return yield* new ReferralProgramPersistenceError({
      operation: "create-account",
      userId,
    });
  });

  const getSummary = Effect.fn("relay.referrals.get_summary")(function* (input: {
    readonly userId: string;
  }) {
    yield* ensureAccount(input.userId);
    const account = alias(relayReferralAccounts, "referral_account");
    const rows = yield* db
      .select({
        referralCode: account.referralCode,
        points: sql<number>`(
            select coalesce(sum(point_entries.points), 0)
            from ${relayReferralPointEntries} as point_entries
            where point_entries.user_id = ${input.userId}
          )`.mapWith(Number),
        qualifiedReferrals: sql<number>`(
            select count(*)
            from ${relayReferralAccounts} as referred_accounts
            where referred_accounts.referrer_user_id = ${input.userId}
              and referred_accounts.qualified_at is not null
          )`.mapWith(Number),
        pendingReferrals: sql<number>`(
            select count(*)
            from ${relayReferralAccounts} as referred_accounts
            where referred_accounts.referrer_user_id = ${input.userId}
              and referred_accounts.qualified_at is null
          )`.mapWith(Number),
        canClaimReferral: sql<boolean>`(
          ${account.referrerUserId} is null
          and not exists (
            select 1 from ${relayEnvironmentLinks} as environment_links
            where environment_links.user_id = ${input.userId}
          )
        )`.mapWith(Boolean),
      })
      .from(account)
      .where(eq(account.userId, input.userId))
      .limit(1)
      .pipe(
        Effect.mapError(
          (cause) =>
            new ReferralProgramPersistenceError({
              operation: "load-summary",
              userId: input.userId,
              cause,
            }),
        ),
      );
    const summary = rows[0];
    if (!summary) {
      return yield* new ReferralProgramPersistenceError({
        operation: "load-summary",
        userId: input.userId,
      });
    }

    return {
      points: summary.points,
      referralCode: summary.referralCode,
      awardPoints: REFERRAL_AWARD_POINTS,
      qualifiedReferrals: summary.qualifiedReferrals,
      pendingReferrals: summary.pendingReferrals,
      canClaimReferral: summary.canClaimReferral,
    } satisfies RelayReferralSummary;
  });

  const firstEnvironmentLink = Effect.fn("relay.referrals.first_environment_link")(function* (
    userId: string,
    operation: "claim-referral" | "qualify-referral",
  ) {
    const rows = yield* db
      .select({ environmentId: relayEnvironmentLinks.environmentId })
      .from(relayEnvironmentLinks)
      .where(eq(relayEnvironmentLinks.userId, userId))
      .orderBy(asc(relayEnvironmentLinks.createdAt), asc(relayEnvironmentLinks.environmentId))
      .limit(1)
      .pipe(
        Effect.mapError(
          (cause) =>
            new ReferralProgramPersistenceError({
              operation,
              userId,
              cause,
            }),
        ),
      );
    return rows[0] ?? null;
  });

  const qualifyInCurrentTransaction = Effect.fn("relay.referrals.qualify_in_current_transaction")(
    function* (input: { readonly userId: string }) {
      const environmentLink = yield* firstEnvironmentLink(input.userId, "qualify-referral");
      if (!environmentLink) return false;

      const account = yield* loadAccount(input.userId);
      if (!account?.referrerUserId || account.qualifiedAt !== null) return false;
      const referrerUserId = account.referrerUserId;

      const entryId = yield* crypto.randomUUIDv4.pipe(
        Effect.mapError(
          (cause) =>
            new ReferralProgramPersistenceError({
              operation: "qualify-referral",
              userId: input.userId,
              cause,
            }),
        ),
      );
      const now = DateTime.formatIso(yield* DateTime.now);
      const inserted = yield* db
        .insert(relayReferralPointEntries)
        .values({
          id: entryId,
          userId: referrerUserId,
          points: REFERRAL_AWARD_POINTS,
          reason: "qualified_referral",
          referredUserId: input.userId,
          qualifyingEnvironmentId: environmentLink.environmentId,
          createdAt: now,
        })
        .onConflictDoNothing()
        .returning({ id: relayReferralPointEntries.id })
        .pipe(
          Effect.mapError(
            (cause) =>
              new ReferralProgramPersistenceError({
                operation: "qualify-referral",
                userId: input.userId,
                cause,
              }),
          ),
        );
      if (inserted.length === 0) return false;

      yield* db
        .update(relayReferralAccounts)
        .set({ qualifiedAt: now, updatedAt: now })
        .where(eq(relayReferralAccounts.userId, input.userId))
        .pipe(
          Effect.mapError(
            (cause) =>
              new ReferralProgramPersistenceError({
                operation: "qualify-referral",
                userId: input.userId,
                cause,
              }),
          ),
        );
      return true;
    },
  );

  const qualify = Effect.fn("relay.referrals.qualify")(function* (input: {
    readonly userId: string;
  }) {
    return yield* transactions.withTransaction(qualifyInCurrentTransaction(input)).pipe(
      Effect.mapError((cause) =>
        isReferralProgramPersistenceError(cause)
          ? cause
          : new ReferralProgramPersistenceError({
              operation: "qualify-referral",
              userId: input.userId,
              cause,
            }),
      ),
    );
  });

  const recoverPendingAwards = Effect.fn("relay.referrals.recover_pending_awards")(
    function* (input?: { readonly referrerUserId?: string }) {
      const pending = yield* db
        .select({ userId: relayReferralAccounts.userId })
        .from(relayReferralAccounts)
        .where(
          and(
            isNotNull(relayReferralAccounts.referrerUserId),
            isNull(relayReferralAccounts.qualifiedAt),
            input?.referrerUserId
              ? eq(relayReferralAccounts.referrerUserId, input.referrerUserId)
              : undefined,
            sql`exists (
            select 1 from ${relayEnvironmentLinks}
            where ${relayEnvironmentLinks.userId} = ${relayReferralAccounts.userId}
          )`,
          ),
        )
        .pipe(
          Effect.mapError(
            (cause) =>
              new ReferralProgramPersistenceError({
                operation: "recover-referrals",
                userId: "system",
                cause,
              }),
          ),
        );
      const recovered = yield* Effect.forEach(
        pending,
        ({ userId }) =>
          qualify({ userId }).pipe(
            Effect.tapError((error) =>
              Effect.logWarning("pending referral award recovery failed", {
                errorTag: error._tag,
                operation: error.operation,
                userId,
              }),
            ),
            Effect.orElseSucceed(() => false),
          ),
        { concurrency: 4 },
      );
      return recovered.filter(Boolean).length;
    },
  );

  const claimInCurrentTransaction = Effect.fn("relay.referrals.claim_in_current_transaction")(
    function* (input: { readonly userId: string; readonly referrerUserId: string }) {
      yield* db
        .execute(
          sql`select ${relayReferralAccounts.userId}
            from ${relayReferralAccounts}
            where ${relayReferralAccounts.userId} in (${input.userId}, ${input.referrerUserId})
            order by ${relayReferralAccounts.userId}
            for update`,
        )
        .pipe(
          Effect.mapError(
            (cause) =>
              new ReferralProgramPersistenceError({
                operation: "claim-referral",
                userId: input.userId,
                cause,
              }),
          ),
        );

      const current = yield* loadAccount(input.userId);
      if (current?.referrerUserId !== null) return "already_claimed" as const;
      if (yield* firstEnvironmentLink(input.userId, "claim-referral")) {
        return "ineligible" as const;
      }

      const cycleRows = yield* db
        .select({
          createsCycle: sql<boolean>`exists (
          with recursive referral_chain(user_id, referrer_user_id) as (
            select referral_root.user_id, referral_root.referrer_user_id
            from ${relayReferralAccounts} as referral_root
            where referral_root.user_id = ${input.referrerUserId}
            union
            select referral_ancestor.user_id, referral_ancestor.referrer_user_id
            from ${relayReferralAccounts} as referral_ancestor
            inner join referral_chain
              on referral_ancestor.user_id = referral_chain.referrer_user_id
          )
          select 1 from referral_chain where user_id = ${input.userId}
        )`.mapWith(Boolean),
        })
        .from(relayReferralAccounts)
        .limit(1)
        .pipe(
          Effect.mapError(
            (cause) =>
              new ReferralProgramPersistenceError({
                operation: "claim-referral",
                userId: input.userId,
                cause,
              }),
          ),
        );
      if (cycleRows[0]?.createsCycle) return "self_referral" as const;

      const now = DateTime.formatIso(yield* DateTime.now);
      const claimed = yield* db
        .update(relayReferralAccounts)
        .set({ referrerUserId: input.referrerUserId, referredAt: now, updatedAt: now })
        .where(
          and(
            eq(relayReferralAccounts.userId, input.userId),
            isNull(relayReferralAccounts.referrerUserId),
            sql`not exists (
            select 1 from ${relayEnvironmentLinks}
            where ${relayEnvironmentLinks.userId} = ${input.userId}
          )`,
          ),
        )
        .returning({ userId: relayReferralAccounts.userId })
        .pipe(
          Effect.mapError(
            (cause) =>
              new ReferralProgramPersistenceError({
                operation: "claim-referral",
                userId: input.userId,
                cause,
              }),
          ),
        );
      if (claimed.length > 0) return "claimed" as const;

      const raced = yield* loadAccount(input.userId);
      return raced?.referrerUserId ? ("already_claimed" as const) : ("ineligible" as const);
    },
  );

  const claim = Effect.fn("relay.referrals.claim")(function* (input: {
    readonly userId: string;
    readonly referralCode: string;
  }) {
    const account = yield* ensureAccount(input.userId);
    let result: RelayReferralClaimResult;

    if (account.referrerUserId !== null) {
      result = "already_claimed";
    } else {
      const code = normalizeReferralCode(input.referralCode);
      const referrerRows = yield* db
        .select({ userId: relayReferralAccounts.userId })
        .from(relayReferralAccounts)
        .where(eq(relayReferralAccounts.referralCode, code ?? ""))
        .limit(1)
        .pipe(
          Effect.mapError(
            (cause) =>
              new ReferralProgramPersistenceError({
                operation: "claim-referral",
                userId: input.userId,
                cause,
              }),
          ),
        );
      const referrerUserId = referrerRows[0]?.userId;

      if (!referrerUserId) {
        result = "invalid_code";
      } else if (referrerUserId === input.userId) {
        result = "self_referral";
      } else {
        result = yield* transactions
          .withTransaction(claimInCurrentTransaction({ userId: input.userId, referrerUserId }))
          .pipe(
            Effect.mapError((cause) =>
              isReferralProgramPersistenceError(cause)
                ? cause
                : new ReferralProgramPersistenceError({
                    operation: "claim-referral",
                    userId: input.userId,
                    cause,
                  }),
            ),
          );
      }
    }

    if (result === "claimed" || result === "already_claimed") {
      yield* qualify({ userId: input.userId }).pipe(
        Effect.tapError((error) =>
          Effect.logWarning("referral qualification after claim failed", {
            errorTag: error._tag,
            operation: error.operation,
          }),
        ),
        Effect.ignore,
      );
    }

    return {
      result,
      summary: yield* getSummary({ userId: input.userId }),
    } satisfies RelayReferralClaimResponse;
  });

  return ReferralProgram.of({ getSummary, claim, qualify, recoverPendingAwards });
});

export const layer = Layer.effect(ReferralProgram, make);
