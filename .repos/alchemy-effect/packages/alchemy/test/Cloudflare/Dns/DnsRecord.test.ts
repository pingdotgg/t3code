import { adopt, OwnedBySomeoneElse } from "@/AdoptPolicy";
import * as Cloudflare from "@/Cloudflare";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import { findZoneByName } from "@/Cloudflare/Zone/lookup";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import * as dns from "@distilled.cloud/cloudflare/dns";
import { expect } from "alchemy-test";
import * as Cause from "effect/Cause";
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

// Deterministic per-test record names. Each test owns a disjoint subdomain so
// reruns and parallel runs never collide, and the same name is reused on every
// run (never derive physical names from Date.now()/random).
const NAME_DEFAULT = `alchemy-dnsrecord-default.${zoneName}`;
const NAME_UPDATE = `alchemy-dnsrecord-update.${zoneName}`;
const NAME_REPLACE = `alchemy-dnsrecord-replace.${zoneName}`;
const NAME_ADOPT = `alchemy-dnsrecord-adopt.${zoneName}`;
const NAME_LIST = `alchemy-dnsrecord-list.${zoneName}`;

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
// consistently across Cloudflare's edge — a fresh token intermittently 403s
// with "Unable to authenticate request". Ride out the blips on the test's
// own out-of-band verification calls by retrying the typed `Forbidden` error
// (part of each dns operation's error union via distilled patches).
const forbiddenRetrySchedule = Schedule.exponential("500 millis");

// Server-side `(name, type)` filter (deepObject `name.exact=…`, needs
// distilled >= 0.24.9) plus a client-side match as defense in depth.
const listByNameType = (zoneId: string, name: string, type: string) =>
  dns.listRecords
    .items({
      zoneId,
      name: { exact: name },
      type: type as dns.ListRecordsRequest["type"],
    })
    .pipe(
      Stream.filter((r) => r.name === name && r.type === type),
      Stream.runCollect,
      Effect.map((chunk) => Array.from(chunk)),
      Effect.retry({
        while: (e) => e._tag === "Forbidden",
        schedule: forbiddenRetrySchedule,
        times: 8,
      }),
    );

const findRecord = (zoneId: string, name: string, type: string) =>
  listByNameType(zoneId, name, type).pipe(Effect.map((rs) => rs[0]));

const getRecord = (zoneId: string, dnsRecordId: string) =>
  dns.getRecord({ zoneId, dnsRecordId }).pipe(
    Effect.retry({
      while: (e) => e._tag === "Forbidden",
      schedule: forbiddenRetrySchedule,
      times: 8,
    }),
  );

// Delete every record matching (name, type) — used to purge leftovers from
// interrupted runs so the adoption test starts from a clean slate.
const purgeRecords = (zoneId: string, name: string, type: string) =>
  listByNameType(zoneId, name, type).pipe(
    Effect.flatMap(
      Effect.forEach((r) =>
        dns
          .deleteRecord({ zoneId, dnsRecordId: r.id })
          .pipe(Effect.catch(() => Effect.void)),
      ),
    ),
  );

test.provider("create and delete an A record with default props", (stack) =>
  Effect.gen(function* () {
    const zoneId = yield* resolveZoneId;

    yield* stack.destroy();

    const record = yield* stack.deploy(
      Effect.gen(function* () {
        return yield* Cloudflare.DNS.Record("DefaultA", {
          zoneId,
          name: NAME_DEFAULT,
          type: "A",
          content: "203.0.113.10",
        }).pipe(adopt(true));
      }),
    );

    expect(record.recordId).toBeDefined();
    expect(record.zoneId).toEqual(zoneId);
    expect(record.name).toEqual(NAME_DEFAULT);
    expect(record.type).toEqual("A");
    expect(record.content).toEqual("203.0.113.10");
    // Cloudflare echoes ttl=1 for "automatic" (the default).
    expect(record.ttl).toEqual(1);
    expect(record.proxied).toEqual(false);

    const live = yield* getRecord(zoneId, record.recordId);
    expect(live.id).toEqual(record.recordId);
    expect(live.name).toEqual(NAME_DEFAULT);
    expect(live.type).toEqual("A");
    expect(live.content).toEqual("203.0.113.10");

    yield* stack.destroy();

    const gone = yield* findRecord(zoneId, NAME_DEFAULT, "A");
    expect(gone).toBeUndefined();
  }).pipe(logLevel),
);

test.provider("updating mutable fields patches in place", (stack) =>
  Effect.gen(function* () {
    const zoneId = yield* resolveZoneId;

    yield* stack.destroy();

    const initial = yield* stack.deploy(
      Effect.gen(function* () {
        return yield* Cloudflare.DNS.Record("UpdateA", {
          zoneId,
          name: NAME_UPDATE,
          type: "A",
          content: "203.0.113.20",
          ttl: 300,
          comment: "v1",
        }).pipe(adopt(true));
      }),
    );

    expect(initial.content).toEqual("203.0.113.20");
    expect(initial.ttl).toEqual(300);

    const updated = yield* stack.deploy(
      Effect.gen(function* () {
        return yield* Cloudflare.DNS.Record("UpdateA", {
          zoneId,
          name: NAME_UPDATE,
          type: "A",
          content: "203.0.113.21",
          ttl: 600,
          comment: "v2",
        }).pipe(adopt(true));
      }),
    );

    // Same record patched in place — not a replacement.
    expect(updated.recordId).toEqual(initial.recordId);
    expect(updated.content).toEqual("203.0.113.21");
    expect(updated.ttl).toEqual(600);

    const live = yield* getRecord(zoneId, updated.recordId);
    expect(live.content).toEqual("203.0.113.21");
    expect(live.ttl).toEqual(600);
    expect(live.comment).toEqual("v2");

    yield* stack.destroy();
  }).pipe(logLevel),
);

test.provider("changing the record type triggers replacement", (stack) =>
  Effect.gen(function* () {
    const zoneId = yield* resolveZoneId;

    yield* stack.destroy();

    const initial = yield* stack.deploy(
      Effect.gen(function* () {
        return yield* Cloudflare.DNS.Record("ReplaceRecord", {
          zoneId,
          name: NAME_REPLACE,
          type: "A",
          content: "203.0.113.30",
        }).pipe(adopt(true));
      }),
    );

    expect(initial.type).toEqual("A");

    const replaced = yield* stack.deploy(
      Effect.gen(function* () {
        return yield* Cloudflare.DNS.Record("ReplaceRecord", {
          zoneId,
          name: NAME_REPLACE,
          type: "TXT",
          content: '"alchemy-replace-test"',
        }).pipe(adopt(true));
      }),
    );

    // (name, type) is the record's identity — a new physical record exists.
    expect(replaced.recordId).not.toEqual(initial.recordId);
    expect(replaced.type).toEqual("TXT");

    // The old A record was deleted as part of the replacement.
    const oldRecord = yield* findRecord(zoneId, NAME_REPLACE, "A");
    expect(oldRecord).toBeUndefined();

    const live = yield* getRecord(zoneId, replaced.recordId);
    expect(live.type).toEqual("TXT");

    yield* stack.destroy();
  }).pipe(logLevel),
);

test.provider(
  "adoption — existing record errors without adopt, takes over with adopt(true)",
  (stack) =>
    Effect.gen(function* () {
      const zoneId = yield* resolveZoneId;

      yield* stack.destroy();
      // Purge leftovers from interrupted runs (Cloudflare allows duplicate
      // A records for the same name, so a leaked record would not surface
      // as a create conflict).
      yield* purgeRecords(zoneId, NAME_ADOPT, "A");

      // Create the record out-of-band so the stack has no state of its own
      // for it — exactly the "the record already exists" scenario.
      const pre = yield* dns
        .createRecord({
          zoneId,
          name: NAME_ADOPT,
          type: "A",
          content: "203.0.113.40",
          ttl: 1,
          comment: "pre-existing",
        })
        .pipe(
          Effect.retry({
            while: (e) => e._tag === "Forbidden",
            schedule: forbiddenRetrySchedule,
            times: 8,
          }),
        );
      expect(pre.id).toBeDefined();

      // Without `adopt`: DNS records carry no ownership markers, so the
      // engine cannot prove we created it and refuses to take it over.
      const error = yield* stack
        .deploy(
          Effect.gen(function* () {
            return yield* Cloudflare.DNS.Record("AdoptedRecord", {
              zoneId,
              name: NAME_ADOPT,
              type: "A",
              content: "203.0.113.41",
            });
          }),
        )
        .pipe(
          Effect.as(undefined),
          Effect.catchCause((cause) => Effect.succeed(findOwnedError(cause))),
        );
      expect(error).toBeInstanceOf(OwnedBySomeoneElse);

      // With `adopt(true)`: the engine takes over the pre-existing record
      // (same physical id) and converges it to the desired content.
      const adopted = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.DNS.Record("AdoptedRecord", {
            zoneId,
            name: NAME_ADOPT,
            type: "A",
            content: "203.0.113.41",
          }).pipe(adopt(true));
        }),
      );

      expect(adopted.recordId).toEqual(pre.id);
      expect(adopted.content).toEqual("203.0.113.41");

      const live = yield* getRecord(zoneId, adopted.recordId);
      expect(live.content).toEqual("203.0.113.41");

      yield* stack.destroy();

      const gone = yield* findRecord(zoneId, NAME_ADOPT, "A");
      expect(gone).toBeUndefined();
    }).pipe(logLevel),
);

// Canonical `list()` test (zone-scoped collection): `list()` enumerates every
// zone via `listAllZones`, exhaustively paginates each zone's DNS records, and
// hydrates them into the `read` Attributes shape. Deploy a record and assert it
// appears in the exhaustively-paginated result.
test.provider("list enumerates the deployed DNS record", (stack) =>
  Effect.gen(function* () {
    const zoneId = yield* resolveZoneId;

    yield* stack.destroy();

    const record = yield* stack.deploy(
      Effect.gen(function* () {
        return yield* Cloudflare.DNS.Record("ListedA", {
          zoneId,
          name: NAME_LIST,
          type: "A",
          content: "203.0.113.50",
        }).pipe(adopt(true));
      }),
    );

    const provider = yield* Provider.findProvider(Cloudflare.DNS.Record);
    const all = yield* provider.list();

    expect(all.length).toBeGreaterThan(0);
    expect(all.some((r) => r.recordId === record.recordId)).toBe(true);
    const found = all.find((r) => r.recordId === record.recordId);
    expect(found?.zoneId).toEqual(zoneId);
    expect(found?.name).toEqual(NAME_LIST);
    expect(found?.type).toEqual("A");
    expect(found?.content).toEqual("203.0.113.50");

    yield* stack.destroy();
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
