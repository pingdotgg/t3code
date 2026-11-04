import * as Cloudflare from "@alchemy.run/cloudflare";
import { CloudflareEnvironment } from "@alchemy.run/cloudflare/CloudflareEnvironment";
import { findZoneByName } from "@alchemy.run/cloudflare/Zone/lookup";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as dns from "@distilled.cloud/cloudflare/dns";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { testName } from "../../names.ts";

const { test } = Test.make({ providers: Cloudflare.providers() });

const zoneName = process.env.CLOUDFLARE_TEST_DNS_ZONE_NAME ?? "alchemy-test-2.us";

// Deterministic record names — disjoint from other suites and the same on
// every run.
const CNAME_NAME = `${testName("alchemy-recordlist-cname")}.${zoneName}`;
const TXT_NAME = `${testName("alchemy-recordlist-txt")}.${zoneName}`;
const A_NAME = `${testName("alchemy-recordlist-a")}.${zoneName}`;
const ADDED_NAME = `${testName("alchemy-recordlist-added")}.${zoneName}`;

const TARGET_1 = `${testName("target-1")}.${zoneName}`;
const TARGET_2 = `${testName("target-2")}.${zoneName}`;
const OURS = "alchemy-recordlist=ours";
const FOREIGN = "alchemy-recordlist=foreign";

const resolveZoneId = Effect.gen(function* () {
  const { accountId } = yield* yield* CloudflareEnvironment;
  const zone = yield* findZoneByName({ accountId, name: zoneName });
  if (!zone) {
    return yield* Effect.die(new Error(`zone "${zoneName}" not found in account`));
  }
  return zone.id;
});

const unquote = (content: string | null | undefined) => (content ?? "").replace(/^"|"$/g, "");

// The harness's freshly-minted scoped token intermittently 403s while it
// propagates — ride that out on the out-of-band calls.
const retryForbidden = <A, E extends { readonly _tag: string }, R>(
  effect: Effect.Effect<A, E, R>,
) =>
  effect.pipe(
    Effect.retry({
      while: (e) => e._tag === "Forbidden",
      schedule: Schedule.exponential("500 millis"),
      times: 8,
    }),
  );

/** Live values (TXT unquoted) of `(name, type)`, sorted. */
const liveValues = (zoneId: string, name: string, type: "A" | "CNAME" | "TXT") =>
  retryForbidden(
    dns.listRecords.items({ zoneId, name: { exact: name }, type }).pipe(
      Stream.filter((r) => r.name === name && r.type === type),
      Stream.runCollect,
    ),
  ).pipe(
    Effect.map((chunk) =>
      Array.from(chunk)
        .map((r) => (type === "TXT" ? unquote(r.content) : (r.content ?? "")))
        .sort(),
    ),
  );

/** Publish the out-of-band TXT value (idempotent across crashed runs). */
const ensureForeignTxt = (zoneId: string) =>
  Effect.gen(function* () {
    if ((yield* liveValues(zoneId, TXT_NAME, "TXT")).includes(FOREIGN)) return;
    yield* retryForbidden(
      dns.createRecord({
        zoneId,
        type: "TXT",
        name: TXT_NAME,
        content: `"${FOREIGN}"`,
        ttl: 1,
      }),
    );
  });

const deleteForeignTxt = (zoneId: string) =>
  retryForbidden(
    dns.listRecords
      .items({ zoneId, name: { exact: TXT_NAME }, type: "TXT" })
      .pipe(Stream.runCollect),
  ).pipe(
    Effect.flatMap((chunk) =>
      Effect.forEach(
        Array.from(chunk).filter((r) => unquote(r.content) === FOREIGN),
        (r) => dns.deleteRecord({ zoneId, dnsRecordId: r.id }),
        { discard: true },
      ),
    ),
  );

test.provider(
  "publishes, converges, and removes only its own records",
  (stack) =>
    Effect.gen(function* () {
      const zoneId = yield* resolveZoneId;
      yield* stack.destroy();

      // Someone else's TXT value at a name the list also publishes to.
      yield* ensureForeignTxt(zoneId);

      // Zone omitted — each record's zone is inferred from its name.
      const created = yield* stack.deploy(
        Cloudflare.DNS.RecordList("Records", {
          records: [
            { name: CNAME_NAME, type: "CNAME", value: TARGET_1 },
            { name: TXT_NAME, type: "TXT", value: OURS },
            { name: A_NAME, type: "A", value: "203.0.113.10" },
            { name: A_NAME, type: "A", value: "203.0.113.11" },
          ],
        }),
      );
      expect(created.records).toHaveLength(4);
      expect(created.records.every((r) => r.zoneId === zoneId)).toBe(true);
      expect(yield* liveValues(zoneId, CNAME_NAME, "CNAME")).toEqual([TARGET_1]);
      expect(yield* liveValues(zoneId, TXT_NAME, "TXT")).toEqual([FOREIGN, OURS]);
      expect(yield* liveValues(zoneId, A_NAME, "A")).toEqual(["203.0.113.10", "203.0.113.11"]);

      // Change the CNAME target, drop an address, add a record.
      const updated = yield* stack.deploy(
        Cloudflare.DNS.RecordList("Records", {
          zone: zoneName,
          records: [
            { name: CNAME_NAME, type: "CNAME", value: TARGET_2 },
            { name: TXT_NAME, type: "TXT", value: OURS },
            { name: A_NAME, type: "A", value: "203.0.113.10" },
            { name: ADDED_NAME, type: "TXT", value: OURS },
          ],
        }),
      );
      expect(updated.records).toHaveLength(4);
      expect(yield* liveValues(zoneId, CNAME_NAME, "CNAME")).toEqual([TARGET_2]);
      expect(yield* liveValues(zoneId, A_NAME, "A")).toEqual(["203.0.113.10"]);
      expect(yield* liveValues(zoneId, ADDED_NAME, "TXT")).toEqual([OURS]);
      expect(yield* liveValues(zoneId, TXT_NAME, "TXT")).toEqual([FOREIGN, OURS]);

      yield* stack.destroy();
      expect(yield* liveValues(zoneId, CNAME_NAME, "CNAME")).toEqual([]);
      expect(yield* liveValues(zoneId, A_NAME, "A")).toEqual([]);
      expect(yield* liveValues(zoneId, ADDED_NAME, "TXT")).toEqual([]);
      // The foreign value survives the list's destroy.
      expect(yield* liveValues(zoneId, TXT_NAME, "TXT")).toEqual([FOREIGN]);

      yield* deleteForeignTxt(zoneId);
    }),
  {
    tags: ["provider:cloudflare", "provider:cloudflare:dns", "provider:cloudflare:zone", "live"],
  },
);
