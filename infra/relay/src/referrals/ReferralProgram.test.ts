import { PgliteClient } from "@effect/sql-pglite";
import { describe, expect, it } from "@effect/vitest";
import { sql } from "drizzle-orm";
import * as PgDrizzle from "drizzle-orm/effect-pglite";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as RelayDb from "../db.ts";
import { relayReferralAccounts, relayReferralPointEntries } from "../persistence/schema.ts";
import * as ReferralProgram from "./ReferralProgram.ts";

const TEST_SCHEMA = [
  `create table relay_environment_links (
    user_id varchar(191) not null,
    environment_id varchar(191) not null,
    created_at varchar(64) not null,
    primary key (user_id, environment_id)
  )`,
  `create table relay_referral_accounts (
    user_id varchar(191) primary key,
    referral_code varchar(16) not null,
    referrer_user_id varchar(191),
    referred_at varchar(64),
    qualified_at varchar(64),
    created_at varchar(64) not null,
    updated_at varchar(64) not null
  )`,
  `create unique index idx_relay_referral_accounts_code
    on relay_referral_accounts (referral_code)`,
  `create table relay_referral_point_entries (
    id varchar(36) primary key,
    user_id varchar(191) not null,
    points integer not null,
    reason varchar(32) not null,
    referred_user_id varchar(191) not null,
    qualifying_environment_id varchar(191) not null,
    created_at varchar(64) not null
  )`,
  `create unique index idx_relay_referral_point_entries_award
    on relay_referral_point_entries (user_id, reason, referred_user_id)`,
  `create unique index idx_relay_referral_point_entries_environment_award
    on relay_referral_point_entries (reason, qualifying_environment_id)`,
] as const;

function makeTestLayer() {
  let randomByte = 0;
  const crypto = Crypto.make({
    randomBytes: (size) => {
      randomByte += 1;
      return new Uint8Array(size).fill(randomByte);
    },
    digest: (_algorithm, data) => Effect.succeed(data),
  });
  const relayDbLayer = Layer.effect(
    RelayDb.RelayDb,
    PgDrizzle.makeWithDefaults().pipe(
      Effect.map((db) => db as unknown as RelayDb.RelayDb["Service"]),
    ),
  ).pipe(Layer.provide(PgliteClient.layer()));

  return Layer.empty.pipe(
    Layer.provideMerge(ReferralProgram.layer),
    Layer.provideMerge(RelayDb.RelayTransactions.layer),
    Layer.provideMerge(relayDbLayer),
    Layer.provideMerge(Layer.succeed(Crypto.Crypto, crypto)),
  );
}

const setupDatabase = Effect.gen(function* () {
  const db = yield* RelayDb.RelayDb;
  yield* Effect.forEach(TEST_SCHEMA, (statement) => db.execute(sql.raw(statement)), {
    concurrency: 1,
    discard: true,
  });
});

function linkEnvironment(userId: string, environmentId: string, createdAt: string) {
  return Effect.gen(function* () {
    const db = yield* RelayDb.RelayDb;
    yield* db.execute(
      sql`insert into relay_environment_links (user_id, environment_id, created_at)
          values (${userId}, ${environmentId}, ${createdAt})`,
    );
  });
}

function testEffect<A, E>(
  effect: Effect.Effect<A, E, ReferralProgram.ReferralProgram | RelayDb.RelayDb>,
) {
  return Effect.gen(function* () {
    yield* setupDatabase;
    return yield* effect;
  }).pipe(Effect.provide(makeTestLayer()));
}

describe("ReferralProgram with PostgreSQL", () => {
  it.effect("uses all 64 random bits and reports historical link eligibility", () =>
    testEffect(
      Effect.gen(function* () {
        const referrals = yield* ReferralProgram.ReferralProgram;

        expect(yield* referrals.getSummary({ userId: "first" })).toMatchObject({
          referralCode: "0101010101010101",
          canClaimReferral: true,
        });
        expect((yield* referrals.getSummary({ userId: "second" })).referralCode).toBe(
          "0202020202020202",
        );

        yield* linkEnvironment("linked-user", "environment-1", "2026-08-01T00:00:00.000Z");
        expect(yield* referrals.getSummary({ userId: "linked-user" })).toMatchObject({
          canClaimReferral: false,
        });
      }),
    ),
  );

  it.effect("claims once, rejects late claims, and prevents referral-chain cycles", () =>
    testEffect(
      Effect.gen(function* () {
        const referrals = yield* ReferralProgram.ReferralProgram;
        const a = yield* referrals.getSummary({ userId: "account-a" });
        const b = yield* referrals.getSummary({ userId: "account-b" });

        const concurrentClaims = yield* Effect.all(
          [
            referrals.claim({ userId: "account-a", referralCode: b.referralCode }),
            referrals.claim({ userId: "account-b", referralCode: a.referralCode }),
          ],
          { concurrency: "unbounded" },
        );
        expect(concurrentClaims.map((claim) => claim.result).sort()).toEqual([
          "claimed",
          "self_referral",
        ]);

        const referrer = yield* referrals.getSummary({ userId: "referrer" });
        yield* linkEnvironment("linked-user", "environment-2", "2026-08-02T00:00:00.000Z");
        expect(
          (yield* referrals.claim({
            userId: "linked-user",
            referralCode: referrer.referralCode,
          })).result,
        ).toBe("ineligible");
        expect(
          (yield* referrals.claim({
            userId: "referrer",
            referralCode: referrer.referralCode,
          })).result,
        ).toBe("self_referral");
        expect(
          (yield* referrals.claim({
            userId: "fresh-user",
            referralCode: "FFFFFFFFFFFFFFFF",
          })).result,
        ).toBe("invalid_code");
      }),
    ),
  );

  it.effect("awards one account once under concurrent qualification", () =>
    testEffect(
      Effect.gen(function* () {
        const referrals = yield* ReferralProgram.ReferralProgram;
        const referrer = yield* referrals.getSummary({ userId: "referrer" });
        expect(
          (yield* referrals.claim({
            userId: "referred",
            referralCode: referrer.referralCode,
          })).result,
        ).toBe("claimed");
        yield* linkEnvironment("referred", "environment-1", "2026-08-03T00:00:00.000Z");

        const qualificationResults = yield* Effect.all(
          [
            referrals.qualify({ userId: "referred" }),
            referrals.qualify({ userId: "referred" }),
            referrals.qualify({ userId: "referred" }),
          ],
          { concurrency: "unbounded" },
        );
        expect(qualificationResults.filter(Boolean)).toHaveLength(1);
        expect(yield* referrals.getSummary({ userId: "referrer" })).toMatchObject({
          points: 67,
          awardPoints: 67,
          qualifiedReferrals: 1,
          pendingReferrals: 0,
        });
      }),
    ),
  );

  it.effect("allows only one award per physical environment across accounts", () =>
    testEffect(
      Effect.gen(function* () {
        const referrals = yield* ReferralProgram.ReferralProgram;
        const db = yield* RelayDb.RelayDb;
        const referrer = yield* referrals.getSummary({ userId: "referrer" });

        for (const userId of ["referred-a", "referred-b"] as const) {
          expect(
            (yield* referrals.claim({ userId, referralCode: referrer.referralCode })).result,
          ).toBe("claimed");
          yield* linkEnvironment(userId, "shared-environment", "2026-08-04T00:00:00.000Z");
        }

        const results = yield* Effect.all(
          [
            referrals.qualify({ userId: "referred-a" }),
            referrals.qualify({ userId: "referred-b" }),
          ],
          { concurrency: "unbounded" },
        );
        expect(results.filter(Boolean)).toHaveLength(1);
        expect(yield* referrals.getSummary({ userId: "referrer" })).toMatchObject({
          points: 67,
          qualifiedReferrals: 1,
          pendingReferrals: 1,
        });
        const entries = yield* db.select().from(relayReferralPointEntries);
        expect(entries).toHaveLength(1);
        expect(entries[0]?.qualifyingEnvironmentId).toBe("shared-environment");
      }),
    ),
  );

  it.effect("rolls back a partial award and recovers it later", () =>
    testEffect(
      Effect.gen(function* () {
        const referrals = yield* ReferralProgram.ReferralProgram;
        const db = yield* RelayDb.RelayDb;
        const referrer = yield* referrals.getSummary({ userId: "referrer" });
        expect(
          (yield* referrals.claim({
            userId: "referred",
            referralCode: referrer.referralCode,
          })).result,
        ).toBe("claimed");
        yield* linkEnvironment("referred", "environment-1", "2026-08-05T00:00:00.000Z");
        yield* db.execute(
          sql.raw(`
          create function reject_referral_qualification() returns trigger language plpgsql as $$
          begin
            if new.qualified_at is not null then
              raise exception 'qualification update failed';
            end if;
            return new;
          end;
          $$
        `),
        );
        yield* db.execute(
          sql.raw(`
          create trigger reject_referral_qualification
          before update on relay_referral_accounts
          for each row execute function reject_referral_qualification()
        `),
        );

        yield* Effect.flip(referrals.qualify({ userId: "referred" }));
        expect(yield* db.select().from(relayReferralPointEntries)).toHaveLength(0);
        expect(
          (yield* db
            .select({ qualifiedAt: relayReferralAccounts.qualifiedAt })
            .from(relayReferralAccounts)
            .where(sql`${relayReferralAccounts.userId} = ${"referred"}`))[0]?.qualifiedAt,
        ).toBeNull();

        yield* db.execute(
          sql.raw("drop trigger reject_referral_qualification on relay_referral_accounts"),
        );
        expect(yield* referrals.recoverPendingAwards({ referrerUserId: "referrer" })).toBe(1);
        expect(yield* referrals.recoverPendingAwards()).toBe(0);
        expect(yield* referrals.getSummary({ userId: "referrer" })).toMatchObject({
          points: 67,
          qualifiedReferrals: 1,
          pendingReferrals: 0,
        });
      }),
    ),
  );
});
