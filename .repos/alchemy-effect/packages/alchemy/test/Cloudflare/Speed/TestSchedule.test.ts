import { adopt, OwnedBySomeoneElse } from "@/AdoptPolicy";
import * as Cloudflare from "@/Cloudflare";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import type { TestScheduleAttributes } from "@/Cloudflare/Speed/TestSchedule";
import { findZoneByName } from "@/Cloudflare/Zone/lookup";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import * as speed from "@distilled.cloud/cloudflare/speed";
import { expect } from "alchemy-test";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: Cloudflare.providers() });

// Cloudflare counts schedule *creations* against a per-day quota and does NOT
// refund it on delete (Observatory docs: "Deleted tests are still counted as
// part of the quota"), so neither the trailing `stack.destroy()` nor
// `bun nuke` can reclaim budget. These tests each burn 1–2 creations per run
// and exhaust `3/3` after ~1–2 same-day runs, so they are skipped by default.
// Set RUN_SPEED_SCHEDULE_TESTS=1 to run them against an account/zone with
// fresh daily budget.
const runSpeedScheduleTests = !!process.env.RUN_SPEED_SCHEDULE_TESTS;

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const zoneName =
  process.env.CLOUDFLARE_TEST_DNS_ZONE_NAME ?? "alchemy-test-2.us";

// Deterministic per-test URLs. Schedules are keyed per (url, region), so each
// test owns a disjoint page path — reruns and parallel runs never collide and
// the same identity is reused on every run.
//
// NOTE: Cloudflare caps schedule creations per URL at 3 per day
// (`speed.errors.Schedule daily quota reached 3 / 3`, typed as
// `TestScheduleQuotaReached`). Each test tolerates an exhausted quota by
// skipping its assertions gracefully, so same-day reruns stay green.
const URL_CREATE = `${zoneName}/speed-create`;
const URL_FREQ = `${zoneName}/speed-freq`;
const URL_REGION = `${zoneName}/speed-region`;
const URL_TAKEOVER = `${zoneName}/speed-takeover`;
const URL_LIST = `${zoneName}/speed-list`;

const resolveZoneId = Effect.gen(function* () {
  const { accountId } = yield* yield* CloudflareEnvironment;
  const zone = yield* findZoneByName({ accountId, name: zoneName });
  if (!zone) {
    return yield* Effect.die(
      new Error(`zone "${zoneName}" not found in account`),
    );
  }
  return zone.id;
});

// The scoped API token the test harness mints propagates eventually-
// consistently across Cloudflare's edge — a fresh token intermittently 403s.
// Ride out the blips on the test's own out-of-band verification calls by
// retrying the typed `Forbidden` error (part of each speed operation's error
// union via distilled patches).
const forbiddenRetrySchedule = Schedule.exponential("500 millis");

/** Out-of-band read: the live schedule for (url, region), or undefined. */
const findSchedule = (
  zoneId: string,
  url: string,
  region: speed.GetScheduleRequest["region"] = "us-central1",
) =>
  speed.getSchedule({ zoneId, url, region }).pipe(
    Effect.map((s): speed.GetScheduleResponse | undefined => s),
    Effect.catchTag("TestScheduleNotFound", () => Effect.succeed(undefined)),
    Effect.retry({
      while: (e) => e._tag === "Forbidden",
      schedule: forbiddenRetrySchedule,
      times: 8,
    }),
  );

/** Purge a schedule left behind by an interrupted run. */
const purgeSchedule = (
  zoneId: string,
  url: string,
  region: speed.DeleteScheduleRequest["region"] = "us-central1",
) =>
  speed.deleteSchedule({ zoneId, url, region }).pipe(
    Effect.catchTag("TestScheduleNotFound", () => Effect.void),
    Effect.retry({
      while: (e) => e._tag === "Forbidden",
      schedule: forbiddenRetrySchedule,
      times: 8,
    }),
  );

/**
 * Deploy, but converge a `TestScheduleQuotaReached` failure (Cloudflare's
 * per-URL daily schedule-creation cap) to `undefined` so the calling test
 * can skip its assertions gracefully instead of failing on same-day reruns.
 */
const deployUnlessQuotaReached = (
  stack: Test.ScratchStack,
  eff: Effect.Effect<any, any, any>,
): Effect.Effect<TestScheduleAttributes | undefined, any, any> =>
  stack
    .deploy(eff)
    .pipe(
      Effect.catchCause(
        (
          cause,
        ): Effect.Effect<TestScheduleAttributes | undefined, any, never> =>
          findQuotaError(cause)
            ? Effect.succeed(undefined)
            : Effect.failCause(cause),
      ),
    );

const logQuotaSkip = (what: string) =>
  Effect.logWarning(
    `skipping ${what}: Cloudflare's daily schedule-creation quota for this URL is exhausted (TestScheduleQuotaReached)`,
  );

test.provider.skipIf(!runSpeedScheduleTests)(
  "create and delete a scheduled speed test",
  (stack) =>
    Effect.gen(function* () {
      const zoneId = yield* resolveZoneId;

      yield* stack.destroy();
      yield* purgeSchedule(zoneId, URL_CREATE);

      const schedule = yield* deployUnlessQuotaReached(
        stack,
        Effect.gen(function* () {
          return yield* Cloudflare.Speed.TestSchedule("DefaultSchedule", {
            zoneId,
            url: URL_CREATE,
            frequency: "WEEKLY",
          }).pipe(adopt(true));
        }),
      );

      if (schedule === undefined) {
        yield* logQuotaSkip("create/delete assertions");
        yield* stack.destroy();
        return;
      }

      expect(schedule.zoneId).toEqual(zoneId);
      expect(schedule.url).toEqual(URL_CREATE);
      expect(schedule.region).toEqual("us-central1");
      expect(schedule.frequency).toEqual("WEEKLY");

      const live = yield* findSchedule(zoneId, URL_CREATE);
      expect(live).toBeDefined();
      expect(live?.url).toEqual(URL_CREATE);
      expect(live?.frequency).toEqual("WEEKLY");

      yield* stack.destroy();

      const gone = yield* findSchedule(zoneId, URL_CREATE);
      expect(gone).toBeUndefined();
    }).pipe(logLevel),
  { timeout: 120_000 },
);

test.provider.skipIf(!runSpeedScheduleTests)(
  "changing the frequency converges in place",
  (stack) =>
    Effect.gen(function* () {
      const zoneId = yield* resolveZoneId;

      yield* stack.destroy();
      yield* purgeSchedule(zoneId, URL_FREQ);

      const initial = yield* deployUnlessQuotaReached(
        stack,
        Effect.gen(function* () {
          return yield* Cloudflare.Speed.TestSchedule("UpdateSchedule", {
            zoneId,
            url: URL_FREQ,
            frequency: "WEEKLY",
          }).pipe(adopt(true));
        }),
      );
      if (initial === undefined) {
        yield* logQuotaSkip("frequency-update test");
        yield* stack.destroy();
        return;
      }
      expect(initial.frequency).toEqual("WEEKLY");

      const updated = yield* deployUnlessQuotaReached(
        stack,
        Effect.gen(function* () {
          return yield* Cloudflare.Speed.TestSchedule("UpdateSchedule", {
            zoneId,
            url: URL_FREQ,
            frequency: "DAILY",
          }).pipe(adopt(true));
        }),
      );

      if (updated === undefined) {
        yield* logQuotaSkip("frequency-update assertions");
        // The provider restores the previous WEEKLY schedule when the
        // post-delete re-create is quota-rejected (if even the restore was
        // quota-rejected, the schedule is gone — both are acceptable here).
        const restored = yield* findSchedule(zoneId, URL_FREQ);
        if (restored) expect(restored.frequency).toEqual("WEEKLY");
        yield* stack.destroy();
        yield* purgeSchedule(zoneId, URL_FREQ);
        return;
      }

      // Same identity — the schedule was converged, not replaced.
      expect(updated.url).toEqual(URL_FREQ);
      expect(updated.region).toEqual("us-central1");
      expect(updated.frequency).toEqual("DAILY");

      const live = yield* findSchedule(zoneId, URL_FREQ);
      expect(live?.frequency).toEqual("DAILY");

      yield* stack.destroy();

      const gone = yield* findSchedule(zoneId, URL_FREQ);
      expect(gone).toBeUndefined();
    }).pipe(logLevel),
  { timeout: 120_000 },
);

test.provider.skipIf(!runSpeedScheduleTests)(
  "changing the region triggers replacement",
  (stack) =>
    Effect.gen(function* () {
      const zoneId = yield* resolveZoneId;

      yield* stack.destroy();
      yield* purgeSchedule(zoneId, URL_REGION, "us-central1");
      yield* purgeSchedule(zoneId, URL_REGION, "us-east1");

      const initial = yield* deployUnlessQuotaReached(
        stack,
        Effect.gen(function* () {
          return yield* Cloudflare.Speed.TestSchedule("ReplaceSchedule", {
            zoneId,
            url: URL_REGION,
            region: "us-central1",
            frequency: "WEEKLY",
          }).pipe(adopt(true));
        }),
      );
      if (initial === undefined) {
        yield* logQuotaSkip("region-replacement test");
        yield* stack.destroy();
        return;
      }
      expect(initial.region).toEqual("us-central1");

      const replaced = yield* deployUnlessQuotaReached(
        stack,
        Effect.gen(function* () {
          return yield* Cloudflare.Speed.TestSchedule("ReplaceSchedule", {
            zoneId,
            url: URL_REGION,
            region: "us-east1",
            frequency: "WEEKLY",
          }).pipe(adopt(true));
        }),
      );
      if (replaced === undefined) {
        yield* logQuotaSkip("region-replacement assertions");
        yield* stack.destroy();
        yield* purgeSchedule(zoneId, URL_REGION, "us-central1");
        yield* purgeSchedule(zoneId, URL_REGION, "us-east1");
        return;
      }

      // (url, region) is the schedule's identity — a new schedule exists in
      // the new region.
      expect(replaced.region).toEqual("us-east1");

      const live = yield* findSchedule(zoneId, URL_REGION, "us-east1");
      expect(live).toBeDefined();

      // The old region's schedule was deleted as part of the replacement.
      const old = yield* findSchedule(zoneId, URL_REGION, "us-central1");
      expect(old).toBeUndefined();

      yield* stack.destroy();

      const gone = yield* findSchedule(zoneId, URL_REGION, "us-east1");
      expect(gone).toBeUndefined();
    }).pipe(logLevel),
  { timeout: 120_000 },
);

test.provider(
  "adoption — existing schedule errors without adopt, takes over with adopt(true)",
  (stack) =>
    Effect.gen(function* () {
      const zoneId = yield* resolveZoneId;

      yield* stack.destroy();
      yield* purgeSchedule(zoneId, URL_TAKEOVER);

      // Create the schedule out-of-band so the stack has no state of its own
      // for it — exactly the "the schedule already exists" scenario.
      const pre = yield* speed
        .createSchedule({
          zoneId,
          url: URL_TAKEOVER,
          region: "us-central1",
          frequency: "WEEKLY",
        })
        .pipe(
          Effect.map((r): speed.CreateScheduleResponse | undefined => r),
          Effect.catchTag("TestScheduleQuotaReached", () =>
            Effect.succeed(undefined),
          ),
          Effect.retry({
            while: (e) => e._tag === "Forbidden",
            schedule: forbiddenRetrySchedule,
            times: 8,
          }),
        );
      if (pre === undefined) {
        yield* logQuotaSkip("adoption test");
        return;
      }
      expect(pre.schedule?.url).toEqual(URL_TAKEOVER);

      // Without `adopt`: schedules carry no ownership markers, so the engine
      // cannot prove we created it and refuses to take it over.
      // (Frequency stays WEEKLY throughout — converging the frequency is
      // covered by the update test and would burn extra creation quota.)
      const error = yield* stack
        .deploy(
          Effect.gen(function* () {
            return yield* Cloudflare.Speed.TestSchedule("AdoptedSchedule", {
              zoneId,
              url: URL_TAKEOVER,
              frequency: "WEEKLY",
            });
          }),
        )
        .pipe(
          Effect.as(undefined),
          Effect.catchCause((cause) => Effect.succeed(findOwnedError(cause))),
        );
      expect(error).toBeInstanceOf(OwnedBySomeoneElse);

      // With `adopt(true)`: the engine takes over the pre-existing schedule
      // (a no-op reconcile — no extra creation, so no quota concern).
      const adopted = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.Speed.TestSchedule("AdoptedSchedule", {
            zoneId,
            url: URL_TAKEOVER,
            frequency: "WEEKLY",
          }).pipe(adopt(true));
        }),
      );

      expect(adopted.url).toEqual(URL_TAKEOVER);
      expect(adopted.frequency).toEqual("WEEKLY");

      const live = yield* findSchedule(zoneId, URL_TAKEOVER);
      expect(live?.frequency).toEqual("WEEKLY");

      yield* stack.destroy();

      const gone = yield* findSchedule(zoneId, URL_TAKEOVER);
      expect(gone).toBeUndefined();
    }).pipe(logLevel),
  { timeout: 120_000 },
);

test.provider.skipIf(!runSpeedScheduleTests)(
  "list enumerates the deployed schedule across zones",
  (stack) =>
    Effect.gen(function* () {
      const zoneId = yield* resolveZoneId;

      yield* stack.destroy();
      yield* purgeSchedule(zoneId, URL_LIST);

      const schedule = yield* deployUnlessQuotaReached(
        stack,
        Effect.gen(function* () {
          return yield* Cloudflare.Speed.TestSchedule("ListSchedule", {
            zoneId,
            url: URL_LIST,
            frequency: "WEEKLY",
          }).pipe(adopt(true));
        }),
      );

      if (schedule === undefined) {
        yield* logQuotaSkip("list assertions");
        yield* stack.destroy();
        return;
      }

      const provider = yield* Provider.findProvider(
        Cloudflare.Speed.TestSchedule,
      );
      // Ride out fresh-token 403 blips on the account-wide enumeration.
      const all = yield* provider.list().pipe(
        Effect.retry({
          while: (e) => e._tag === "Forbidden",
          schedule: forbiddenRetrySchedule,
          times: 8,
        }),
      );

      // Each element is the exact `read` Attributes shape, usable by delete.
      expect(
        all.some(
          (s) =>
            s.zoneId === schedule.zoneId &&
            s.url === schedule.url &&
            s.region === schedule.region,
        ),
      ).toBe(true);

      yield* stack.destroy();

      const gone = yield* findSchedule(zoneId, URL_LIST);
      expect(gone).toBeUndefined();
    }).pipe(logLevel),
  { timeout: 120_000 },
);

/**
 * Pull the {@link OwnedBySomeoneElse} value out of a Cause regardless of
 * whether the engine raised it as a typed failure or a defect.
 */
const findOwnedError = (
  cause: Cause.Cause<unknown>,
): OwnedBySomeoneElse | undefined =>
  cause.reasons
    .map((reason) =>
      Cause.isFailReason(reason)
        ? reason.error
        : Cause.isDieReason(reason)
          ? reason.defect
          : undefined,
    )
    .find(
      (value): value is OwnedBySomeoneElse =>
        value instanceof OwnedBySomeoneElse,
    );

/**
 * Pull the typed {@link speed.TestScheduleQuotaReached} value out of a Cause
 * regardless of whether the engine raised it as a typed failure or a defect.
 */
const findQuotaError = (
  cause: Cause.Cause<unknown>,
): speed.TestScheduleQuotaReached | undefined =>
  cause.reasons
    .map((reason) =>
      Cause.isFailReason(reason)
        ? reason.error
        : Cause.isDieReason(reason)
          ? reason.defect
          : undefined,
    )
    .find(
      (value): value is speed.TestScheduleQuotaReached =>
        value instanceof speed.TestScheduleQuotaReached,
    );
