import { adopt } from "@/AdoptPolicy";
import * as Cloudflare from "@/Cloudflare";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import { normalizeEndpoint } from "@/Cloudflare/ApiShield/Operation";
import * as Provider from "@/Provider";
import { findZoneByName } from "@/Cloudflare/Zone/lookup";
import * as Test from "@/Test/Alchemy";
import * as apiGateway from "@distilled.cloud/cloudflare/api-gateway";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
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

// Deterministic per-test endpoints. Each test owns a disjoint path so reruns
// and parallel runs never collide (never derive identity from Date.now()).
const ENDPOINT_DEFAULT = "/alchemy-apishield/default/{thingId}";
const ENDPOINT_REPLACE = "/alchemy-apishield/replace";
const ENDPOINT_LIST = "/alchemy-apishield/list";

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
// consistently — a fresh token intermittently 403s. Ride out the blips on
// the test's own out-of-band calls by retrying the typed `Forbidden` error.
const forbiddenRetrySchedule = Schedule.exponential("500 millis");

const findOperation = (
  zoneId: string,
  tuple: { method: string; host: string; endpoint: string },
) =>
  apiGateway.listOperations
    .items({ zoneId, host: [tuple.host], method: [tuple.method] })
    .pipe(
      Stream.filter(
        (op) =>
          op.method === tuple.method &&
          op.host === tuple.host &&
          op.endpoint === normalizeEndpoint(tuple.endpoint),
      ),
      Stream.runCollect,
      Effect.map((chunk) => Array.from(chunk)[0]),
      Effect.retry({
        while: (e) => e._tag === "Forbidden",
        schedule: forbiddenRetrySchedule,
        times: 8,
      }),
    );

const getOperation = (zoneId: string, operationId: string) =>
  apiGateway.getOperation({ zoneId, operationId }).pipe(
    Effect.retry({
      while: (e) => e._tag === "Forbidden",
      schedule: forbiddenRetrySchedule,
      times: 8,
    }),
  );

// Purge a tuple left over from interrupted runs so each test starts clean.
const purgeOperation = (
  zoneId: string,
  tuple: { method: string; host: string; endpoint: string },
) =>
  findOperation(zoneId, tuple).pipe(
    Effect.flatMap((op) =>
      op
        ? apiGateway
            .deleteOperation({ zoneId, operationId: op.operationId })
            .pipe(
              Effect.catchTag("OperationNotFound", () => Effect.void),
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
  "create, no-op redeploy, destroy an API Shield operation",
  (stack) =>
    Effect.gen(function* () {
      const zoneId = yield* resolveZoneId;
      const tuple = {
        method: "GET",
        host: zoneName,
        endpoint: ENDPOINT_DEFAULT,
      };

      yield* stack.destroy();
      yield* purgeOperation(zoneId, tuple);

      const op = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.ApiShield.Operation("DefaultOp", {
            zoneId,
            method: "GET",
            host: zoneName,
            endpoint: ENDPOINT_DEFAULT,
          }).pipe(adopt(true));
        }),
      );

      expect(op.operationId).toBeDefined();
      expect(op.zoneId).toEqual(zoneId);
      expect(op.method).toEqual("GET");
      expect(op.host).toEqual(zoneName);
      // Cloudflare normalizes `{thingId}` to `{var1}`.
      expect(op.endpoint).toEqual("/alchemy-apishield/default/{var1}");

      const live = yield* getOperation(zoneId, op.operationId);
      expect(live.operationId).toEqual(op.operationId);
      expect(live.endpoint).toEqual("/alchemy-apishield/default/{var1}");

      // No-op redeploy of the same (raw) endpoint converges on the same
      // physical operation — the normalized forms match.
      const redeployed = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.ApiShield.Operation("DefaultOp", {
            zoneId,
            method: "GET",
            host: zoneName,
            endpoint: ENDPOINT_DEFAULT,
          }).pipe(adopt(true));
        }),
      );
      expect(redeployed.operationId).toEqual(op.operationId);

      yield* stack.destroy();

      const gone = yield* findOperation(zoneId, tuple);
      expect(gone).toBeUndefined();
    }).pipe(logLevel),
);

test.provider("changing the method triggers replacement", (stack) =>
  Effect.gen(function* () {
    const zoneId = yield* resolveZoneId;
    const getTuple = {
      method: "GET",
      host: zoneName,
      endpoint: ENDPOINT_REPLACE,
    };
    const postTuple = { ...getTuple, method: "POST" };

    yield* stack.destroy();
    yield* purgeOperation(zoneId, getTuple);
    yield* purgeOperation(zoneId, postTuple);

    const initial = yield* stack.deploy(
      Effect.gen(function* () {
        return yield* Cloudflare.ApiShield.Operation("ReplaceOp", {
          zoneId,
          method: "GET",
          host: zoneName,
          endpoint: ENDPOINT_REPLACE,
        }).pipe(adopt(true));
      }),
    );
    expect(initial.method).toEqual("GET");

    const replaced = yield* stack.deploy(
      Effect.gen(function* () {
        return yield* Cloudflare.ApiShield.Operation("ReplaceOp", {
          zoneId,
          method: "POST",
          host: zoneName,
          endpoint: ENDPOINT_REPLACE,
        }).pipe(adopt(true));
      }),
    );

    // The tuple is the operation's identity — a new physical operation.
    expect(replaced.operationId).not.toEqual(initial.operationId);
    expect(replaced.method).toEqual("POST");

    // The old GET operation was deleted as part of the replacement.
    const oldOp = yield* findOperation(zoneId, getTuple);
    expect(oldOp).toBeUndefined();

    yield* stack.destroy();

    const gone = yield* findOperation(zoneId, postTuple);
    expect(gone).toBeUndefined();
  }).pipe(logLevel),
);

test.provider("list enumerates the deployed API Shield operation", (stack) =>
  Effect.gen(function* () {
    const zoneId = yield* resolveZoneId;
    const tuple = {
      method: "GET",
      host: zoneName,
      endpoint: ENDPOINT_LIST,
    };

    yield* stack.destroy();
    yield* purgeOperation(zoneId, tuple);

    const op = yield* stack.deploy(
      Effect.gen(function* () {
        return yield* Cloudflare.ApiShield.Operation("ListOp", {
          zoneId,
          method: "GET",
          host: zoneName,
          endpoint: ENDPOINT_LIST,
        }).pipe(adopt(true));
      }),
    );

    const provider = yield* Provider.findProvider(
      Cloudflare.ApiShield.Operation,
    );
    const all = yield* provider.list();

    // The deployed operation appears in the exhaustively-paginated,
    // all-zones result with the exact `read` shape.
    const found = all.find((x) => x.operationId === op.operationId);
    expect(found).toBeDefined();
    expect(found?.zoneId).toEqual(zoneId);
    expect(found?.method).toEqual("GET");
    expect(found?.host).toEqual(zoneName);
    expect(found?.endpoint).toEqual("/alchemy-apishield/list");
    expect(found?.lastUpdated).toBeDefined();

    yield* stack.destroy();

    const gone = yield* findOperation(zoneId, tuple);
    expect(gone).toBeUndefined();
  }).pipe(logLevel),
);
