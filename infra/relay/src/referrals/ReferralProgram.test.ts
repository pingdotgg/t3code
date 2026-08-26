import { describe, expect, it } from "@effect/vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as RelayDb from "../db.ts";
import {
  relayEnvironmentLinks,
  relayReferralAccounts,
  relayReferralPointEntries,
} from "../persistence/schema.ts";
import * as ReferralProgram from "./ReferralProgram.ts";

type ReferralAccount = typeof relayReferralAccounts.$inferSelect;
type ReferralPointEntry = typeof relayReferralPointEntries.$inferSelect;

interface FakeReferralState {
  readonly accounts: Map<string, ReferralAccount>;
  readonly claimUpdateSql: Array<string>;
  readonly environmentUsers: Set<string>;
  readonly pointEntries: Array<ReferralPointEntry>;
  beforeClaimUpdate?: () => void;
}

const hasSelection = (selection: unknown, key: string): boolean =>
  typeof selection === "object" && selection !== null && key in selection;

function sqlQuery(condition: unknown) {
  return new PgDialect().sqlToQuery(condition as never);
}

function makeFakeDb(state: FakeReferralState) {
  return {
    select: (selection?: unknown) => ({
      from: (table: unknown) => {
        if (table === relayReferralPointEntries) {
          return {
            where: (condition: unknown) => {
              const userId = String(sqlQuery(condition).params[0]);
              const points = state.pointEntries
                .filter((entry) => entry.userId === userId)
                .reduce((sum, entry) => sum + entry.points, 0);
              return Effect.succeed([{ points }]);
            },
          };
        }

        if (table === relayEnvironmentLinks) {
          return {
            where: (condition: unknown) => ({
              limit: () => {
                const userId = String(sqlQuery(condition).params[0]);
                return Effect.succeed(
                  state.environmentUsers.has(userId) ? [{ environmentId: "environment-1" }] : [],
                );
              },
            }),
          };
        }

        expect(table).toBe(relayReferralAccounts);
        return {
          where: (condition: unknown) => {
            const query = sqlQuery(condition);
            const value = String(query.params[0]);

            if (hasSelection(selection, "referrals")) {
              const wantsQualified = query.sql.includes('"qualified_at" is not null');
              const referrals = [...state.accounts.values()].filter(
                (account) =>
                  account.referrerUserId === value &&
                  (wantsQualified ? account.qualifiedAt !== null : account.qualifiedAt === null),
              ).length;
              return Effect.succeed([{ referrals }]);
            }

            const account = hasSelection(selection, "userId")
              ? [...state.accounts.values()].find((row) => row.referralCode === value)
              : state.accounts.get(value);
            return {
              limit: () => Effect.succeed(account ? [account] : []),
            };
          },
        };
      },
    }),
    insert: (table: unknown) => ({
      values: (value: ReferralAccount | ReferralPointEntry) => ({
        onConflictDoNothing: () => ({
          returning: () => {
            if (table === relayReferralAccounts) {
              const account = value as ReferralAccount;
              const conflict =
                state.accounts.has(account.userId) ||
                [...state.accounts.values()].some(
                  (existing) => existing.referralCode === account.referralCode,
                );
              if (conflict) return Effect.succeed([]);
              state.accounts.set(account.userId, account);
              return Effect.succeed([account]);
            }

            expect(table).toBe(relayReferralPointEntries);
            const entry = value as ReferralPointEntry;
            const conflict = state.pointEntries.some(
              (existing) =>
                existing.userId === entry.userId &&
                existing.reason === entry.reason &&
                existing.referredUserId === entry.referredUserId,
            );
            if (conflict) return Effect.succeed([]);
            state.pointEntries.push(entry);
            return Effect.succeed([{ id: entry.id }]);
          },
        }),
      }),
    }),
    update: (table: unknown) => {
      expect(table).toBe(relayReferralAccounts);
      return {
        set: (values: Partial<ReferralAccount>) => ({
          where: (condition: unknown) => {
            const query = sqlQuery(condition);
            const userId = String(query.params[0]);
            const account = state.accounts.get(userId);

            if (values.referrerUserId !== undefined) {
              state.claimUpdateSql.push(query.sql);
              return {
                returning: () => {
                  const eligible =
                    account !== undefined &&
                    account.referrerUserId === null &&
                    !state.environmentUsers.has(userId);
                  state.beforeClaimUpdate?.();
                  if (!eligible || !account) return Effect.succeed([]);
                  state.accounts.set(userId, { ...account, ...values });
                  return Effect.succeed([{ userId }]);
                },
              };
            }

            if (account) state.accounts.set(userId, { ...account, ...values });
            return Effect.void;
          },
        }),
      };
    },
  } as unknown as RelayDb.RelayDb["Service"];
}

function makeTestLayer(state: FakeReferralState) {
  let randomByte = 0;
  const crypto = Crypto.make({
    randomBytes: (size) => {
      randomByte += 1;
      return new Uint8Array(size).fill(randomByte);
    },
    digest: (_algorithm, data) => Effect.succeed(data),
  });
  const db = makeFakeDb(state);
  return ReferralProgram.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(RelayDb.RelayDb, db),
        Layer.succeed(
          RelayDb.RelayTransactions,
          RelayDb.RelayTransactions.of({ withTransaction: (effect) => effect }),
        ),
        Layer.succeed(Crypto.Crypto, crypto),
      ),
    ),
  );
}

function makeState(): FakeReferralState {
  return {
    accounts: new Map(),
    claimUpdateSql: [],
    environmentUsers: new Set(),
    pointEntries: [],
  };
}

describe("ReferralProgram", () => {
  it.effect("awards 67 account points once when the referred account links", () => {
    const state = makeState();
    return Effect.gen(function* () {
      const referrals = yield* ReferralProgram.ReferralProgram;
      const referrer = yield* referrals.getSummary({ userId: "referrer" });
      const claim = yield* referrals.claim({
        userId: "referred",
        referralCode: referrer.referralCode.toLowerCase(),
      });

      expect(claim.result).toBe("claimed");
      expect((yield* referrals.getSummary({ userId: "referrer" })).pendingReferrals).toBe(1);
      state.environmentUsers.add("referred");
      expect(yield* referrals.qualify({ userId: "referred" })).toBe(true);
      expect(yield* referrals.qualify({ userId: "referred" })).toBe(false);

      expect(yield* referrals.getSummary({ userId: "referrer" })).toMatchObject({
        points: 67,
        awardPoints: 67,
        qualifiedReferrals: 1,
        pendingReferrals: 0,
      });
      expect(state.pointEntries).toHaveLength(1);
    }).pipe(Effect.provide(makeTestLayer(state)));
  });

  it.effect("rejects self-referrals and accounts that already linked an environment", () => {
    const state = makeState();
    state.environmentUsers.add("linked-user");
    return Effect.gen(function* () {
      const referrals = yield* ReferralProgram.ReferralProgram;
      const referrer = yield* referrals.getSummary({ userId: "referrer" });

      expect(
        (yield* referrals.claim({
          userId: "referrer",
          referralCode: referrer.referralCode,
        })).result,
      ).toBe("self_referral");
      expect(
        (yield* referrals.claim({
          userId: "linked-user",
          referralCode: referrer.referralCode,
        })).result,
      ).toBe("ineligible");
    }).pipe(Effect.provide(makeTestLayer(state)));
  });

  it.effect("awards a referral when the first link commits during the claim write", () => {
    const state = makeState();
    return Effect.gen(function* () {
      const referrals = yield* ReferralProgram.ReferralProgram;
      const referrer = yield* referrals.getSummary({ userId: "referrer" });
      state.beforeClaimUpdate = () => state.environmentUsers.add("referred");

      expect(
        (yield* referrals.claim({
          userId: "referred",
          referralCode: referrer.referralCode,
        })).result,
      ).toBe("claimed");
      expect(state.claimUpdateSql[0]).toContain("not exists");
      expect(state.claimUpdateSql[0]).toContain('from "relay_environment_links"');
      expect(yield* referrals.getSummary({ userId: "referrer" })).toMatchObject({
        points: 67,
        qualifiedReferrals: 1,
        pendingReferrals: 0,
      });
    }).pipe(Effect.provide(makeTestLayer(state)));
  });
});
