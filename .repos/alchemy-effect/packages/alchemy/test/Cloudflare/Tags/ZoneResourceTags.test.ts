import { adopt } from "@/AdoptPolicy";
import * as Cloudflare from "@/Cloudflare";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import { findZoneByName } from "@/Cloudflare/Zone/lookup";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import * as resourceTagging from "@distilled.cloud/cloudflare/resource-tagging";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: Cloudflare.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const zoneName =
  process.env.CLOUDFLARE_TEST_DNS_ZONE_NAME ?? "alchemy-test-2.us";

// Deterministic per-test-CASE record names — the same on every run (never
// Date.now()/random). Cases in this file run CONCURRENTLY, so each case that
// creates a DNS record gets its OWN `(name, type)` identity; sharing one name
// makes concurrent creates collide on Cloudflare's
// `An identical record already exists.` (and leaves one stack's `recordId`
// output unresolved). Only this suite creates/tags these records.
const CRUD_RECORD_NAME = `alchemy-zrt-crud-target.${zoneName}`;
const LIST_RECORD_NAME = `alchemy-zrt-list-target.${zoneName}`;

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
// (`Forbidden`, part of the distilled error union via patches) on the
// test's own out-of-band verification calls.
const forbiddenRetry = {
  while: (e: { _tag: string }) => e._tag === "Forbidden",
  schedule: Schedule.exponential("500 millis"),
  times: 8,
} as const;

const getTags = (zoneId: string, resourceId: string, resourceType: string) =>
  resourceTagging.getZoneTag({ zoneId, resourceId, resourceType }).pipe(
    Effect.map((r) => r.tags as Record<string, string>),
    Effect.retry(forbiddenRetry),
  );

// Cloudflare reports untagged (and unknown) resources as an empty tag
// set — poll until the set is empty after destroy.
const expectTagsCleared = (
  zoneId: string,
  resourceId: string,
  resourceType: string,
) =>
  getTags(zoneId, resourceId, resourceType).pipe(
    Effect.repeat({
      schedule: Schedule.exponential("500 millis"),
      until: (tags) => Object.keys(tags).length === 0,
      times: 10,
    }),
    Effect.map((tags) => expect(tags).toEqual({})),
  );

test.provider("create, update, and clear tags on a DNS record", (stack) =>
  Effect.gen(function* () {
    const zoneId = yield* resolveZoneId;

    yield* stack.destroy();

    const v1 = yield* stack.deploy(
      Effect.gen(function* () {
        const record = yield* Cloudflare.DNS.Record("CrudTaggedRecord", {
          zoneId,
          name: CRUD_RECORD_NAME,
          type: "A",
          content: "203.0.113.50",
        }).pipe(adopt(true));
        const tags = yield* Cloudflare.Tags.ZoneResourceTags("CrudRecordTags", {
          zoneId,
          resourceType: "dns_record",
          resourceId: record.recordId,
          tags: { env: "test", team: "alchemy" },
        }).pipe(adopt(true));
        return { record, tags };
      }),
    );

    expect(v1.tags.zoneId).toEqual(zoneId);
    expect(v1.tags.resourceType).toEqual("dns_record");
    expect(v1.tags.resourceId).toEqual(v1.record.recordId);
    expect(v1.tags.tags).toEqual({ env: "test", team: "alchemy" });
    expect(v1.tags.etag).toBeTruthy();

    const live = yield* getTags(zoneId, v1.record.recordId, "dns_record");
    expect(live).toEqual({ env: "test", team: "alchemy" });

    // In-place update — PUT replaces the full set: change `env`, drop
    // `team`, add `owner`.
    const v2 = yield* stack.deploy(
      Effect.gen(function* () {
        const record = yield* Cloudflare.DNS.Record("CrudTaggedRecord", {
          zoneId,
          name: CRUD_RECORD_NAME,
          type: "A",
          content: "203.0.113.50",
        }).pipe(adopt(true));
        const tags = yield* Cloudflare.Tags.ZoneResourceTags("CrudRecordTags", {
          zoneId,
          resourceType: "dns_record",
          resourceId: record.recordId,
          tags: { env: "prod", owner: "qa" },
        }).pipe(adopt(true));
        return { record, tags };
      }),
    );

    // Same target record — the tag set updated in place.
    expect(v2.record.recordId).toEqual(v1.record.recordId);
    expect(v2.tags.tags).toEqual({ env: "prod", owner: "qa" });

    const updated = yield* getTags(zoneId, v2.record.recordId, "dns_record");
    expect(updated).toEqual({ env: "prod", owner: "qa" });

    yield* stack.destroy();

    yield* expectTagsCleared(zoneId, v1.record.recordId, "dns_record");
  }).pipe(logLevel),
);

test.provider("tag the zone itself and clear on destroy", (stack) =>
  Effect.gen(function* () {
    const zoneId = yield* resolveZoneId;

    yield* stack.destroy();
    // Normalize the baseline — clear any leftover zone tags from
    // interrupted runs (only this suite tags the shared test zone).
    yield* resourceTagging
      .deleteZoneTag({ zoneId, resourceId: zoneId, resourceType: "zone" })
      .pipe(Effect.retry(forbiddenRetry));

    const deployed = yield* stack.deploy(
      Effect.gen(function* () {
        return yield* Cloudflare.Tags.ZoneResourceTags("ZoneTags", {
          zoneId,
          resourceType: "zone",
          resourceId: zoneId,
          tags: { "alchemy-zone-probe": "v1" },
        }).pipe(adopt(true));
      }),
    );

    expect(deployed.tags).toEqual({ "alchemy-zone-probe": "v1" });

    const live = yield* getTags(zoneId, zoneId, "zone");
    expect(live).toEqual({ "alchemy-zone-probe": "v1" });

    yield* stack.destroy();

    yield* expectTagsCleared(zoneId, zoneId, "zone");
  }).pipe(logLevel),
);

test.provider("list enumerates tagged zone-scoped resources", (stack) =>
  Effect.gen(function* () {
    const zoneId = yield* resolveZoneId;

    yield* stack.destroy();

    const deployed = yield* stack.deploy(
      Effect.gen(function* () {
        const record = yield* Cloudflare.DNS.Record("ListTaggedRecord", {
          zoneId,
          name: LIST_RECORD_NAME,
          type: "A",
          content: "203.0.113.50",
        }).pipe(adopt(true));
        const tags = yield* Cloudflare.Tags.ZoneResourceTags("ListRecordTags", {
          zoneId,
          resourceType: "dns_record",
          resourceId: record.recordId,
          tags: { env: "test", team: "alchemy" },
        }).pipe(adopt(true));
        return { record, tags };
      }),
    );

    const provider = yield* Provider.findProvider(
      Cloudflare.Tags.ZoneResourceTags,
    );

    // The account-wide tag index is eventually consistent — poll until the
    // freshly-tagged record shows up (bounded so it fails fast).
    const all = yield* provider.list().pipe(
      Effect.repeat({
        schedule: Schedule.exponential("1 second"),
        until: (rows) =>
          rows.some((r) => r.resourceId === deployed.record.recordId),
        times: 8,
      }),
    );

    const found = all.find((r) => r.resourceId === deployed.record.recordId);
    expect(found).toBeDefined();
    expect(found?.zoneId).toEqual(zoneId);
    expect(found?.resourceType).toEqual("dns_record");
    expect(found?.tags).toEqual({ env: "test", team: "alchemy" });
    expect(found?.etag).toBeTruthy();

    yield* stack.destroy();
  }).pipe(logLevel),
);
