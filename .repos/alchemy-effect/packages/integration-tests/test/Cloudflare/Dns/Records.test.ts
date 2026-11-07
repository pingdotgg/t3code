import * as Cloudflare from "@alchemy.run/cloudflare";
import { CloudflareEnvironment } from "@alchemy.run/cloudflare/CloudflareEnvironment";
import { findZoneByName } from "@alchemy.run/cloudflare/Zone/lookup";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as dns from "@distilled.cloud/cloudflare/dns";
import { adopt, OwnedBySomeoneElse } from "alchemy/AdoptPolicy";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { testName } from "../../names.ts";

const { test } = Test.make({ providers: Cloudflare.providers() });

const zoneName = process.env.CLOUDFLARE_TEST_DNS_ZONE_NAME ?? "alchemy-test-2.us";

// Deterministic per-test record names — disjoint from other suites and the
// same on every run.
const NAME_A = `${testName("alchemy-dnsrecords-a")}.${zoneName}`;
const NAME_B = `${testName("alchemy-dnsrecords-b")}.${zoneName}`;
const NAME_C = `${testName("alchemy-dnsrecords-c")}.${zoneName}`;
const NAME_BOUND = `${testName("alchemy-dnsrecords-bound")}.${zoneName}`;
const NAME_FOREIGN = `${testName("alchemy-dnsrecords-foreign")}.${zoneName}`;
const NAME_TYPED = `${testName("alchemy-dnsrecords-typed")}.${zoneName}`;

const TARGET_1 = `${testName("target-1")}.${zoneName}`;
const TARGET_2 = `${testName("target-2")}.${zoneName}`;

const resolveZoneId = Effect.gen(function* () {
  const { accountId } = yield* yield* CloudflareEnvironment;
  const zone = yield* findZoneByName({ accountId, name: zoneName });
  if (!zone) {
    return yield* Effect.die(new Error(`zone "${zoneName}" not found in account`));
  }
  return zone.id;
});

// The harness's freshly-minted scoped token intermittently 403s while it
// propagates — ride that out on the out-of-band verification calls.
const listByType = (zoneId: string, name: string, type: "A" | "CNAME") =>
  dns.listRecords.items({ zoneId, name: { exact: name }, type }).pipe(
    Stream.filter((r) => r.name === name && r.type === type),
    Stream.runCollect,
    Effect.map((chunk) => Array.from(chunk)),
    Effect.retry({
      while: (e) => e._tag === "Forbidden",
      schedule: Schedule.exponential("500 millis"),
      times: 8,
    }),
  );

const listCnames = (zoneId: string, name: string) => listByType(zoneId, name, "CNAME");

const purge = (zoneId: string, name: string) =>
  listCnames(zoneId, name).pipe(
    Effect.flatMap(Effect.forEach((r) => dns.deleteRecord({ zoneId, dnsRecordId: r.id }))),
  );

const tags = ["provider:cloudflare", "provider:cloudflare:dns", "provider:cloudflare:zone", "live"];

test.provider(
  "creates, updates, garbage-collects and deletes a CNAME set",
  (stack) =>
    Effect.gen(function* () {
      const zoneId = yield* resolveZoneId;
      yield* stack.destroy();

      // Zone omitted — inferred from the first name.
      const initial = yield* stack.deploy(
        Cloudflare.DNS.Records("CnameSet", {
          type: "CNAME",
          content: TARGET_1,
          names: [NAME_A, NAME_B],
        }),
      );
      expect(initial.zoneId).toEqual(zoneId);
      expect(initial.names).toEqual([NAME_A, NAME_B]);
      for (const name of [NAME_A, NAME_B]) {
        const [live, ...extra] = yield* listCnames(zoneId, name);
        expect(extra).toHaveLength(0);
        expect(live?.content).toEqual(TARGET_1);
        expect(live?.proxied).toEqual(false);
      }

      // Drop A, keep B (content + proxied change in place), add C.
      const updated = yield* stack.deploy(
        Cloudflare.DNS.Records("CnameSet", {
          type: "CNAME",
          content: TARGET_2,
          proxied: true,
          names: [NAME_B, NAME_C],
        }),
      );
      expect(updated.names).toEqual([NAME_B, NAME_C]);
      expect(yield* listCnames(zoneId, NAME_A)).toHaveLength(0);
      for (const name of [NAME_B, NAME_C]) {
        const [live] = yield* listCnames(zoneId, name);
        expect(live?.content).toEqual(TARGET_2);
        expect(live?.proxied).toEqual(true);
      }

      yield* stack.destroy();
      for (const name of [NAME_A, NAME_B, NAME_C]) {
        expect(yield* listCnames(zoneId, name)).toHaveLength(0);
      }
    }),
  { tags },
);

test.provider(
  "manages names contributed through the binding contract",
  (stack) =>
    Effect.gen(function* () {
      const zoneId = yield* resolveZoneId;
      yield* stack.destroy();

      // An empty set (like an `AWS.Website.Router`'s) that a composite
      // binds a hostname onto.
      const records = yield* stack.deploy(
        Effect.gen(function* () {
          const set = yield* Cloudflare.DNS.Records("BoundSet", {
            zone: zoneName,
            type: "CNAME",
            content: TARGET_1,
          });
          yield* set.bind`BoundSite`({ names: [NAME_BOUND] });
          return set;
        }),
      );
      expect(records.zoneId).toEqual(zoneId);
      expect(records.names).toEqual([NAME_BOUND]);
      const [live] = yield* listCnames(zoneId, NAME_BOUND);
      expect(live?.content).toEqual(TARGET_1);

      // Unbinding removes the record again.
      const unbound = yield* stack.deploy(
        Cloudflare.DNS.Records("BoundSet", {
          zone: zoneName,
          type: "CNAME",
          content: TARGET_1,
        }),
      );
      expect(unbound.names).toEqual([]);
      expect(yield* listCnames(zoneId, NAME_BOUND)).toHaveLength(0);

      yield* stack.destroy();
    }),
  { tags },
);

/**
 * Pull the {@link OwnedBySomeoneElse} value out of a Cause regardless of
 * whether the engine raised it as a typed failure or a defect.
 */
const findOwnedError = (cause: Cause.Cause<unknown>) =>
  cause.reasons
    .map((reason) =>
      Cause.isFailReason(reason)
        ? reason.error
        : Cause.isDieReason(reason)
          ? reason.defect
          : undefined,
    )
    .find((value): value is OwnedBySomeoneElse => value instanceof OwnedBySomeoneElse);

test.provider(
  "adoption — an existing record errors without adopt, is taken over with adopt(true)",
  (stack) =>
    Effect.gen(function* () {
      const zoneId = yield* resolveZoneId;
      yield* stack.destroy();
      yield* purge(zoneId, NAME_FOREIGN);

      // A record the set did not create — e.g. published by hand.
      yield* dns.createRecord({
        zoneId,
        type: "CNAME",
        name: NAME_FOREIGN,
        content: TARGET_2,
        ttl: 1,
      });
      const foreignSet = Cloudflare.DNS.Records("ForeignSet", {
        type: "CNAME",
        content: TARGET_1,
        names: [NAME_FOREIGN],
      });

      // Without `adopt`: DNS records carry no ownership marker, so the
      // engine refuses to overwrite it.
      const error = yield* stack.deploy(foreignSet).pipe(
        Effect.as(undefined),
        Effect.catchCause((cause) => Effect.succeed(findOwnedError(cause))),
      );
      expect(error).toBeInstanceOf(OwnedBySomeoneElse);
      const [untouched] = yield* listCnames(zoneId, NAME_FOREIGN);
      expect(untouched?.content).toEqual(TARGET_2);

      // With `adopt(true)`: taken over and converged.
      const adopted = yield* stack.deploy(foreignSet.pipe(adopt(true)));
      expect(adopted.names).toEqual([NAME_FOREIGN]);
      const [live, ...extra] = yield* listCnames(zoneId, NAME_FOREIGN);
      expect(extra).toHaveLength(0);
      expect(live?.content).toEqual(TARGET_1);

      // Adopted means owned — destroy removes it.
      yield* stack.destroy();
      expect(yield* listCnames(zoneId, NAME_FOREIGN)).toHaveLength(0);
    }),
  { tags },
);

test.provider(
  "changing the record type replaces the set",
  (stack) =>
    Effect.gen(function* () {
      const zoneId = yield* resolveZoneId;
      yield* stack.destroy();

      yield* stack.deploy(
        Cloudflare.DNS.Records("TypedSet", {
          type: "CNAME",
          content: TARGET_1,
          names: [NAME_TYPED],
        }),
      );
      expect(yield* listCnames(zoneId, NAME_TYPED)).toHaveLength(1);

      const replaced = yield* stack.deploy(
        Cloudflare.DNS.Records("TypedSet", {
          type: "A",
          content: "203.0.113.20",
          names: [NAME_TYPED],
        }),
      );
      expect(replaced.type).toEqual("A");
      // The old CNAME set is gone; the name now carries the A record.
      expect(yield* listCnames(zoneId, NAME_TYPED)).toHaveLength(0);
      const [a] = yield* listByType(zoneId, NAME_TYPED, "A");
      expect(a?.content).toEqual("203.0.113.20");

      yield* stack.destroy();
      expect(yield* listByType(zoneId, NAME_TYPED, "A")).toHaveLength(0);
    }),
  { tags },
);
