import { adopt, OwnedBySomeoneElse } from "@/AdoptPolicy";
import * as Cloudflare from "@/Cloudflare";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import { findZoneByName } from "@/Cloudflare/Zone/lookup";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import * as healthchecks from "@distilled.cloud/cloudflare/healthchecks";
import { expect } from "alchemy-test";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";

const { test } = Test.make({ providers: Cloudflare.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const zoneName =
  process.env.CLOUDFLARE_TEST_DNS_ZONE_NAME ?? "alchemy-test-2.us";

// Deterministic per-test names (alphanumeric/hyphen/underscore only). The
// same name is reused on every run — never derive from Date.now()/random.
const NAME_UPDATE = "alchemy-healthcheck-update";
const NAME_UPDATE_V2 = "alchemy-healthcheck-update-v2";
const NAME_TYPE = "alchemy-healthcheck-type";
const NAME_ADOPT = "alchemy-healthcheck-adopt";
const NAME_LIST = "alchemy-healthcheck-list";

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
// consistently across Cloudflare's edge — ride out 403 blips
// (`Forbidden`, declared in the distilled error union via patches) on the
// test's own out-of-band verification calls.
const forbiddenRetrySchedule = Schedule.exponential("500 millis");

const getHealthcheck = (zoneId: string, healthcheckId: string) =>
  healthchecks.getHealthcheck({ zoneId, healthcheckId }).pipe(
    Effect.retry({
      while: (e) => e._tag === "Forbidden",
      schedule: forbiddenRetrySchedule,
      times: 8,
    }),
  );

const findByName = (zoneId: string, name: string) =>
  healthchecks.listHealthchecks.items({ zoneId }).pipe(
    Stream.filter((h) => h.name === name),
    Stream.runHead,
    Effect.map(Option.getOrUndefined),
    Effect.retry({
      while: (e) => e._tag === "Forbidden",
      schedule: forbiddenRetrySchedule,
      times: 8,
    }),
  );

const expectGone = (zoneId: string, healthcheckId: string) =>
  getHealthcheck(zoneId, healthcheckId).pipe(
    Effect.flatMap(() =>
      Effect.fail({ _tag: "HealthcheckNotDeleted" } as const),
    ),
    // A missing health check surfaces as `HealthcheckNotFound` (404) —
    // that's the success condition here.
    Effect.catchTag("HealthcheckNotFound", () => Effect.void),
    Effect.retry({
      while: (e) => e._tag === "HealthcheckNotDeleted",
      schedule: Schedule.max([
        Schedule.exponential("500 millis"),
        Schedule.recurs(10),
      ]),
    }),
  );

// Purge leftovers from interrupted runs so tests start from a clean
// slate (and the Pro-plan quota of 2 checks is never exhausted).
const purgeByName = (zoneId: string, name: string) =>
  findByName(zoneId, name).pipe(
    Effect.flatMap((found) =>
      found?.id
        ? healthchecks
            .deleteHealthcheck({ zoneId, healthcheckId: found.id })
            .pipe(
              Effect.catchTag("HealthcheckNotFound", () => Effect.void),
              Effect.retry({
                while: (e) => e._tag === "Forbidden",
                schedule: forbiddenRetrySchedule,
                times: 8,
              }),
            )
        : Effect.void,
    ),
  );

test.provider(
  "create and delete an HTTP health check with default name",
  (stack) =>
    Effect.gen(function* () {
      const zoneId = yield* resolveZoneId;

      yield* stack.destroy();

      const check = yield* stack.deploy(
        Cloudflare.Healthcheck.Healthcheck("DefaultCheck", {
          zoneId,
          address: "www.cloudflare.com",
        }),
      );

      expect(check.healthcheckId).toBeDefined();
      expect(check.zoneId).toEqual(zoneId);
      expect(check.name).toBeTruthy();
      expect(check.address).toEqual("www.cloudflare.com");
      expect(check.type).toEqual("HTTP");
      expect(check.interval).toEqual(60);
      expect(check.retries).toEqual(2);
      expect(check.timeout).toEqual(5);
      expect(check.suspended).toEqual(false);
      // Status is eventually consistent — new checks start as "unknown",
      // so only assert it is one of the documented values.
      expect(["unknown", "healthy", "unhealthy", "suspended"]).toContain(
        check.status,
      );

      const live = yield* getHealthcheck(zoneId, check.healthcheckId);
      expect(live.id).toEqual(check.healthcheckId);
      expect(live.name).toEqual(check.name);
      expect(live.address).toEqual("www.cloudflare.com");
      expect(live.type).toEqual("HTTP");

      yield* stack.destroy();

      yield* expectGone(zoneId, check.healthcheckId);
    }).pipe(logLevel),
);

test.provider(
  "update mutable props in place (same id), then no-op redeploy",
  (stack) =>
    Effect.gen(function* () {
      const zoneId = yield* resolveZoneId;

      yield* stack.destroy();
      yield* purgeByName(zoneId, NAME_UPDATE);
      yield* purgeByName(zoneId, NAME_UPDATE_V2);

      const initial = yield* stack.deploy(
        Cloudflare.Healthcheck.Healthcheck("UpdateCheck", {
          zoneId,
          name: NAME_UPDATE,
          address: "www.cloudflare.com",
          type: "HTTPS",
          interval: 60,
          httpConfig: { path: "/", port: 443 },
        }),
      );

      expect(initial.name).toEqual(NAME_UPDATE);
      expect(initial.type).toEqual("HTTPS");
      expect(initial.interval).toEqual(60);
      expect(initial.suspended).toEqual(false);

      const updated = yield* stack.deploy(
        Cloudflare.Healthcheck.Healthcheck("UpdateCheck", {
          zoneId,
          name: NAME_UPDATE_V2,
          address: "www.cloudflare.com",
          type: "HTTPS",
          interval: 120,
          suspended: true,
          description: "updated by alchemy test",
          httpConfig: { path: "/cdn-cgi/trace", port: 443 },
        }),
      );

      // Same health check mutated in place — not a replacement.
      expect(updated.healthcheckId).toEqual(initial.healthcheckId);
      expect(updated.name).toEqual(NAME_UPDATE_V2);
      expect(updated.interval).toEqual(120);
      expect(updated.suspended).toEqual(true);

      const live = yield* getHealthcheck(zoneId, updated.healthcheckId);
      expect(live.name).toEqual(NAME_UPDATE_V2);
      expect(live.interval).toEqual(120);
      expect(live.suspended).toEqual(true);
      expect(live.description).toEqual("updated by alchemy test");
      expect(live.httpConfig?.path).toEqual("/cdn-cgi/trace");

      // Redeploying identical props is a no-op (still the same check).
      const noop = yield* stack.deploy(
        Cloudflare.Healthcheck.Healthcheck("UpdateCheck", {
          zoneId,
          name: NAME_UPDATE_V2,
          address: "www.cloudflare.com",
          type: "HTTPS",
          interval: 120,
          suspended: true,
          description: "updated by alchemy test",
          httpConfig: { path: "/cdn-cgi/trace", port: 443 },
        }),
      );
      expect(noop.healthcheckId).toEqual(initial.healthcheckId);

      yield* stack.destroy();

      yield* expectGone(zoneId, initial.healthcheckId);
    }).pipe(logLevel),
);

test.provider(
  "changing type HTTP→TCP updates in place; delete is idempotent",
  (stack) =>
    Effect.gen(function* () {
      const zoneId = yield* resolveZoneId;

      yield* stack.destroy();
      yield* purgeByName(zoneId, NAME_TYPE);

      const initial = yield* stack.deploy(
        Cloudflare.Healthcheck.Healthcheck("TypeCheck", {
          zoneId,
          name: NAME_TYPE,
          address: "www.cloudflare.com",
          type: "HTTP",
        }),
      );

      expect(initial.type).toEqual("HTTP");

      const switched = yield* stack.deploy(
        Cloudflare.Healthcheck.Healthcheck("TypeCheck", {
          zoneId,
          name: NAME_TYPE,
          address: "www.cloudflare.com",
          type: "TCP",
          tcpConfig: { port: 443 },
        }),
      );

      // Type is mutable — same physical check, not a replacement.
      expect(switched.healthcheckId).toEqual(initial.healthcheckId);
      expect(switched.type).toEqual("TCP");

      const live = yield* getHealthcheck(zoneId, switched.healthcheckId);
      expect(live.type).toEqual("TCP");
      expect(live.tcpConfig?.port).toEqual(443);

      // Delete out-of-band, then destroy — the provider must treat the
      // already-gone check as success (idempotent delete).
      yield* healthchecks
        .deleteHealthcheck({
          zoneId,
          healthcheckId: switched.healthcheckId,
        })
        .pipe(
          Effect.retry({
            while: (e) => e._tag === "Forbidden",
            schedule: forbiddenRetrySchedule,
            times: 8,
          }),
        );

      yield* stack.destroy();

      yield* expectGone(zoneId, switched.healthcheckId);
    }).pipe(logLevel),
);

test.provider(
  "adoption — existing check errors without adopt, takes over with adopt(true)",
  (stack) =>
    Effect.gen(function* () {
      const zoneId = yield* resolveZoneId;

      yield* stack.destroy();
      yield* purgeByName(zoneId, NAME_ADOPT);

      // Create the check out-of-band so the stack has no state of its
      // own for it — exactly the "already exists" scenario.
      const pre = yield* healthchecks
        .createHealthcheck({
          zoneId,
          name: NAME_ADOPT,
          address: "www.cloudflare.com",
          type: "HTTP",
        })
        .pipe(
          Effect.retry({
            while: (e) => e._tag === "Forbidden",
            schedule: forbiddenRetrySchedule,
            times: 8,
          }),
        );
      expect(pre.id).toBeDefined();

      // Without `adopt`: health checks carry no ownership markers, so the
      // engine cannot prove we created it and refuses to take it over.
      const error = yield* stack
        .deploy(
          Cloudflare.Healthcheck.Healthcheck("AdoptedCheck", {
            zoneId,
            name: NAME_ADOPT,
            address: "www.cloudflare.com",
            interval: 120,
          }),
        )
        .pipe(
          Effect.as(undefined),
          Effect.catchCause((cause) => Effect.succeed(findOwnedError(cause))),
        );
      expect(error).toBeInstanceOf(OwnedBySomeoneElse);

      // With `adopt(true)`: the engine takes over the pre-existing check
      // (same physical id) and converges it to the desired props.
      const adopted = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.Healthcheck.Healthcheck("AdoptedCheck", {
            zoneId,
            name: NAME_ADOPT,
            address: "www.cloudflare.com",
            interval: 120,
          }).pipe(adopt(true));
        }),
      );

      expect(adopted.healthcheckId).toEqual(pre.id);
      expect(adopted.interval).toEqual(120);

      const live = yield* getHealthcheck(zoneId, adopted.healthcheckId);
      expect(live.interval).toEqual(120);

      yield* stack.destroy();

      const gone = yield* findByName(zoneId, NAME_ADOPT);
      expect(gone).toBeUndefined();
    }).pipe(logLevel),
);

test.provider(
  "list enumerates the deployed health check across zones",
  (stack) =>
    Effect.gen(function* () {
      const zoneId = yield* resolveZoneId;

      yield* stack.destroy();
      yield* purgeByName(zoneId, NAME_LIST);

      const deployed = yield* stack.deploy(
        Cloudflare.Healthcheck.Healthcheck("ListCheck", {
          zoneId,
          name: NAME_LIST,
          address: "www.cloudflare.com",
        }),
      );

      // Resolve the provider with the typed helper so list()'s element type
      // is exactly the resource's Attributes (no `any`).
      const provider = yield* Provider.findProvider(
        Cloudflare.Healthcheck.Healthcheck,
      );
      const all = yield* provider.list();

      // The exhaustively-paginated, all-zones result must contain the check we
      // just deployed in the standing test zone.
      expect(all.some((h) => h.healthcheckId === deployed.healthcheckId)).toBe(
        true,
      );
      const found = all.find((h) => h.healthcheckId === deployed.healthcheckId);
      expect(found?.zoneId).toEqual(zoneId);
      expect(found?.name).toEqual(NAME_LIST);
      expect(found?.address).toEqual("www.cloudflare.com");

      yield* stack.destroy();

      yield* expectGone(zoneId, deployed.healthcheckId);
    }).pipe(logLevel),
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
