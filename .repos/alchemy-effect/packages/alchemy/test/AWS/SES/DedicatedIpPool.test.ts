import { adopt, OwnedBySomeoneElse } from "@/AdoptPolicy.ts";
import * as AWS from "@/AWS";
import { AWSEnvironment } from "@/AWS/Environment";
import { DedicatedIpPool } from "@/AWS/SES";
import * as Test from "@/Test/Alchemy";
import * as sesv2 from "@distilled.cloud/aws/sesv2";
import { expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: AWS.providers() });

class PoolStillExists extends Data.TaggedError("PoolStillExists")<{
  readonly name: string;
}> {}

const getPool = (name: string) =>
  sesv2.getDedicatedIpPool({ PoolName: name }).pipe(
    Effect.map((response) => response.DedicatedIpPool),
    Effect.catchTag("NotFoundException", () => Effect.succeed(undefined)),
  );

const assertPoolDeleted = (name: string) =>
  getPool(name).pipe(
    Effect.flatMap((found) =>
      found ? Effect.fail(new PoolStillExists({ name })) : Effect.void,
    ),
    Effect.retry({
      while: (e) => e._tag === "PoolStillExists",
      schedule: Schedule.max([Schedule.exponential(500), Schedule.recurs(8)]),
    }),
  );

// A STANDARD pool holding no dedicated IPs is free — SES bills $24.95/month
// per dedicated IP, not per pool — so the STANDARD lifecycle runs ungated.
test.provider(
  "dedicated IP pool lifecycle: create STANDARD, verify, delete",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const pool = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* DedicatedIpPool("Standard", {
            scalingMode: "STANDARD",
          });
        }),
      );

      expect(pool.poolName).toBeDefined();
      expect(pool.scalingMode).toBe("STANDARD");

      // out-of-band verification via distilled
      const created = yield* getPool(pool.poolName);
      expect(created?.ScalingMode).toBe("STANDARD");

      yield* stack.destroy();
      yield* assertPoolDeleted(pool.poolName);
    }),
  { timeout: 120_000 },
);

// Switching a pool to MANAGED enables managed dedicated IPs, which bill
// $15/month/account from that point on, so every MANAGED case stays gated
// behind AWS_TEST_SES_DEDICATED_IP=1.
test.provider.skipIf(!process.env.AWS_TEST_SES_DEDICATED_IP)(
  "dedicated IP pool lifecycle: create STANDARD, scale to MANAGED, delete",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const pool = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* DedicatedIpPool("Marketing", {
            scalingMode: "STANDARD",
          });
        }),
      );

      expect(pool.poolName).toBeDefined();
      expect(pool.scalingMode).toBe("STANDARD");

      // out-of-band verification via distilled
      const created = yield* getPool(pool.poolName);
      expect(created?.ScalingMode).toBe("STANDARD");

      // STANDARD -> MANAGED is an in-place scaling change (no replacement).
      const scaled = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* DedicatedIpPool("Marketing", {
            scalingMode: "MANAGED",
          });
        }),
      );
      expect(scaled.poolName).toBe(pool.poolName);
      expect(scaled.scalingMode).toBe("MANAGED");
      const observed = yield* getPool(pool.poolName);
      expect(observed?.ScalingMode).toBe("MANAGED");

      yield* stack.destroy();
      yield* assertPoolDeleted(pool.poolName);
    }),
  { timeout: 120_000 },
);

// MANAGED -> STANDARD is not supported by AWS in place, so it replaces the
// pool. Auto-naming gives the replacement a fresh instance suffix.
test.provider.skipIf(!process.env.AWS_TEST_SES_DEDICATED_IP)(
  "downgrading MANAGED -> STANDARD replaces the pool",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const first = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* DedicatedIpPool("Pool", { scalingMode: "MANAGED" });
        }),
      );

      const second = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* DedicatedIpPool("Pool", { scalingMode: "STANDARD" });
        }),
      );

      expect(second.poolName).not.toBe(first.poolName);
      expect(second.scalingMode).toBe("STANDARD");
      yield* assertPoolDeleted(first.poolName);

      yield* stack.destroy();
      yield* assertPoolDeleted(second.poolName);
    }),
  { timeout: 120_000 },
);

// A pool the account already pays for must not be silently taken over just
// because its name matches ours. Free to exercise: a STANDARD pool holding no
// dedicated IPs costs nothing, and create/delete are both fast.
const FOREIGN_POOL = "alchemy-test-foreign-pool";

const deletePoolIfExists = (name: string) =>
  sesv2
    .deleteDedicatedIpPool({ PoolName: name })
    .pipe(Effect.catchTag("NotFoundException", () => Effect.void));

test.provider(
  "a pool without alchemy tags is not adopted without --adopt",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      // Idempotent pre-clean: reclaim a leftover from an interrupted run.
      yield* deletePoolIfExists(FOREIGN_POOL);

      // Someone else's pool: same name, no alchemy tags.
      yield* sesv2.createDedicatedIpPool({
        PoolName: FOREIGN_POOL,
        ScalingMode: "STANDARD",
      });

      const error = yield* stack
        .deploy(
          Effect.gen(function* () {
            return yield* DedicatedIpPool("Foreign", {
              poolName: FOREIGN_POOL,
            });
          }),
        )
        .pipe(Effect.flip);
      expect(error).toBeInstanceOf(OwnedBySomeoneElse);

      // The pool is still there and still untagged — the refusal touched
      // nothing.
      const untouched = yield* getPool(FOREIGN_POOL);
      expect(untouched?.PoolName).toBe(FOREIGN_POOL);

      yield* deletePoolIfExists(FOREIGN_POOL);
      yield* assertPoolDeleted(FOREIGN_POOL);
    }),
  { timeout: 120_000 },
);

test.provider(
  "adopt(true) takes over the pool and brands it",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      yield* deletePoolIfExists(FOREIGN_POOL);

      yield* sesv2.createDedicatedIpPool({
        PoolName: FOREIGN_POOL,
        ScalingMode: "STANDARD",
      });

      const pool = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* DedicatedIpPool("Foreign", {
            poolName: FOREIGN_POOL,
          }).pipe(adopt(true));
        }),
      );
      expect(pool.poolName).toBe(FOREIGN_POOL);

      // Reconcile brands an adopted pool, so a later read owns it outright —
      // without this the resource would need --adopt on every deploy.
      const { accountId, region } = yield* AWSEnvironment.current;
      const { Tags } = yield* sesv2.listTagsForResource({
        ResourceArn: `arn:aws:ses:${region}:${accountId}:dedicated-ip-pool/${FOREIGN_POOL}`,
      });
      const tags = Object.fromEntries(Tags.map((t) => [t.Key, t.Value]));
      expect(tags["alchemy::id"]).toBe("Foreign");

      // Now owned: a plain re-deploy converges with no adopt decoration.
      // Deploying at all proves read no longer returns Unowned — an Unowned
      // read without adopt fails with OwnedBySomeoneElse, as the test above
      // shows — and the brand must still be intact afterwards.
      const readopted = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* DedicatedIpPool("Foreign", { poolName: FOREIGN_POOL });
        }),
      );
      expect(readopted.poolName).toBe(FOREIGN_POOL);
      const { Tags: afterTags } = yield* sesv2.listTagsForResource({
        ResourceArn: `arn:aws:ses:${region}:${accountId}:dedicated-ip-pool/${FOREIGN_POOL}`,
      });
      expect(
        Object.fromEntries(afterTags.map((t) => [t.Key, t.Value]))[
          "alchemy::id"
        ],
      ).toBe("Foreign");

      yield* stack.destroy();
      yield* assertPoolDeleted(FOREIGN_POOL);
    }),
  { timeout: 120_000 },
);

// A STANDARD pool holding no dedicated IPs is free, so the rename path runs
// ungated. Renaming is a replacement — there is no rename API.
test.provider(
  "renaming the pool replaces it",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const first = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* DedicatedIpPool("Renamed", {
            poolName: "alchemy-test-pool-a",
          });
        }),
      );
      expect(first.poolName).toBe("alchemy-test-pool-a");

      const second = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* DedicatedIpPool("Renamed", {
            poolName: "alchemy-test-pool-b",
          });
        }),
      );
      expect(second.poolName).toBe("alchemy-test-pool-b");

      // The old pool is gone, not orphaned.
      yield* assertPoolDeleted("alchemy-test-pool-a");

      yield* stack.destroy();
      yield* assertPoolDeleted("alchemy-test-pool-b");
    }),
  { timeout: 120_000 },
);
