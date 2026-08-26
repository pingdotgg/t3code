import type {
  RelayReferralClaimResponse,
  RelayReferralClaimResult,
  RelayReferralSummary,
} from "@t3tools/contracts/relay";
import { normalizeReferralCode } from "@t3tools/shared/referral";
import { and, count, eq, isNotNull, isNull, sql } from "drizzle-orm";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as RelayDb from "../db.ts";
import {
  relayEnvironmentLinks,
  relayReferralAccounts,
  relayReferralPointEntries,
} from "../persistence/schema.ts";

export const REFERRAL_AWARD_POINTS = 67;

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
  }
>()("t3code-relay/referrals/ReferralProgram") {}

function referralCodeFromUuid(uuid: string): string {
  return uuid.replaceAll("-", "").slice(0, 16).toUpperCase();
}

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
      const referralCode = referralCodeFromUuid(
        yield* crypto.randomUUIDv4.pipe(
          Effect.mapError(
            (cause) =>
              new ReferralProgramPersistenceError({
                operation: "create-account",
                userId,
                cause,
              }),
          ),
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
    const account = yield* ensureAccount(input.userId);
    const [pointRows, qualifiedRows, pendingRows] = yield* Effect.all(
      [
        db
          .select({
            points: sql<number>`coalesce(sum(${relayReferralPointEntries.points}), 0)`.mapWith(
              Number,
            ),
          })
          .from(relayReferralPointEntries)
          .where(eq(relayReferralPointEntries.userId, input.userId)),
        db
          .select({ referrals: count() })
          .from(relayReferralAccounts)
          .where(
            and(
              eq(relayReferralAccounts.referrerUserId, input.userId),
              isNotNull(relayReferralAccounts.qualifiedAt),
            ),
          ),
        db
          .select({ referrals: count() })
          .from(relayReferralAccounts)
          .where(
            and(
              eq(relayReferralAccounts.referrerUserId, input.userId),
              isNull(relayReferralAccounts.qualifiedAt),
            ),
          ),
      ],
      { concurrency: "unbounded" },
    ).pipe(
      Effect.mapError(
        (cause) =>
          new ReferralProgramPersistenceError({
            operation: "load-summary",
            userId: input.userId,
            cause,
          }),
      ),
    );

    return {
      points: pointRows[0]?.points ?? 0,
      referralCode: account.referralCode,
      awardPoints: REFERRAL_AWARD_POINTS,
      qualifiedReferrals: qualifiedRows[0]?.referrals ?? 0,
      pendingReferrals: pendingRows[0]?.referrals ?? 0,
      hasClaimedReferral: account.referrerUserId !== null,
    } satisfies RelayReferralSummary;
  });

  const hasEnvironmentLink = Effect.fn("relay.referrals.has_environment_link")(function* (
    userId: string,
    operation: "claim-referral" | "qualify-referral",
  ) {
    const rows = yield* db
      .select({ environmentId: relayEnvironmentLinks.environmentId })
      .from(relayEnvironmentLinks)
      .where(eq(relayEnvironmentLinks.userId, userId))
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
    return rows.length > 0;
  });

  const qualifyInCurrentTransaction = Effect.fn("relay.referrals.qualify_in_current_transaction")(
    function* (input: { readonly userId: string }) {
      if (!(yield* hasEnvironmentLink(input.userId, "qualify-referral"))) return false;

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
        const now = DateTime.formatIso(yield* DateTime.now);
        const claimed = yield* db
          .update(relayReferralAccounts)
          .set({ referrerUserId, referredAt: now, updatedAt: now })
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

        if (claimed.length > 0) {
          result = "claimed";
        } else {
          const current = yield* loadAccount(input.userId);
          result = current?.referrerUserId
            ? "already_claimed"
            : (yield* hasEnvironmentLink(input.userId, "claim-referral"))
              ? "ineligible"
              : "already_claimed";
        }
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

  return ReferralProgram.of({ getSummary, claim, qualify });
});

export const layer = Layer.effect(ReferralProgram, make);
