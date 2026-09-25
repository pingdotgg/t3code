import * as Hetzner from "@/Hetzner";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import { Services } from "@distilled.cloud/hetzner";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: Hetzner.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const hasHetznerCreds = !!process.env.HCLOUD_TOKEN;

const waitUntilGone = (zoneId: number, name: string, type: string) =>
  Services.zoneRrsets
    .getZoneRrset({
      id_or_name: String(zoneId),
      rr_name: name,
      rr_type: type,
    })
    .pipe(
      Effect.as("found" as const),
      Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
      Effect.repeat({
        schedule: Schedule.spaced("1 second"),
        until: (status) => status === "gone",
        times: 10,
      }),
    );

const waitUntilZoneGone = (zoneId: number) =>
  Services.zones.getZone({ id_or_name: String(zoneId) }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider.skipIf(!hasHetznerCreds)(
  "create, update, and delete a record set",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const zone = yield* Hetzner.Zone("DnsZone", {
            ttl: 3600,
          });
          const recordSet = yield* Hetzner.RecordSet("Www", {
            zone,
            name: "www",
            type: "A",
            records: [{ value: "192.0.2.1" }],
            ttl: 300,
            labels: { env: "test" },
          });
          return { zone, recordSet };
        }),
      );

      expect(created.recordSet.id).toEqual("www/A");
      expect(created.recordSet.zoneId).toEqual(created.zone.zoneId);
      expect(created.recordSet.name).toEqual("www");
      expect(created.recordSet.type).toEqual("A");
      expect(created.recordSet.ttl).toEqual(300);
      expect(created.recordSet.changeProtection).toEqual(false);
      expect(created.recordSet.labels).toMatchObject({ env: "test" });
      expect(created.recordSet.records).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ value: "192.0.2.1" }),
        ]),
      );
      expect(created.recordSet.records).toHaveLength(1);

      const fetched = yield* Services.zoneRrsets.getZoneRrset({
        id_or_name: String(created.zone.zoneId),
        rr_name: "www",
        rr_type: "A",
      });
      expect(fetched.rrset.id).toEqual("www/A");
      expect(fetched.rrset.zone).toEqual(created.zone.zoneId);
      expect(fetched.rrset.ttl).toEqual(300);
      expect(fetched.rrset.protection.change).toEqual(false);
      expect(fetched.rrset.labels.env).toEqual("test");
      expect(
        fetched.rrset.records.map((record) => record.value).sort(),
      ).toEqual(["192.0.2.1"]);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const zone = yield* Hetzner.Zone("DnsZone", {
            name: created.zone.name,
            ttl: 3600,
          });
          const recordSet = yield* Hetzner.RecordSet("Www", {
            zone,
            name: "www",
            type: "A",
            records: [{ value: "192.0.2.1" }, { value: "192.0.2.2" }],
            ttl: 600,
            labels: { env: "prod", role: "dns" },
            changeProtection: true,
          });
          return { zone, recordSet };
        }),
      );

      expect(updated.recordSet.id).toEqual("www/A");
      expect(updated.recordSet.zoneId).toEqual(created.zone.zoneId);
      expect(updated.recordSet.ttl).toEqual(600);
      expect(updated.recordSet.changeProtection).toEqual(true);
      expect(updated.recordSet.labels).toMatchObject({
        env: "prod",
        role: "dns",
      });
      expect(updated.recordSet.records).toHaveLength(2);
      expect(
        updated.recordSet.records.map((record) => record.value).sort(),
      ).toEqual(["192.0.2.1", "192.0.2.2"]);

      const refetched = yield* Services.zoneRrsets.getZoneRrset({
        id_or_name: String(updated.zone.zoneId),
        rr_name: "www",
        rr_type: "A",
      });
      expect(refetched.rrset.ttl).toEqual(600);
      expect(refetched.rrset.protection.change).toEqual(true);
      expect(refetched.rrset.labels.env).toEqual("prod");
      expect(refetched.rrset.labels.role).toEqual("dns");
      expect(
        refetched.rrset.records.map((record) => record.value).sort(),
      ).toEqual(["192.0.2.1", "192.0.2.2"]);

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.zone.zoneId, "www", "A");
      expect(gone).toEqual("gone");
      const zoneGone = yield* waitUntilZoneGone(created.zone.zoneId);
      expect(zoneGone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 120_000 },
);

test.provider.skipIf(!hasHetznerCreds)(
  "replace when name changes",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const zone = yield* Hetzner.Zone("ReplaceZone", {
            ttl: 3600,
          });
          const recordSet = yield* Hetzner.RecordSet("Host", {
            zone,
            name: "www",
            type: "A",
            records: [{ value: "192.0.2.10" }],
            ttl: 300,
          });
          return { zone, recordSet };
        }),
      );

      expect(created.recordSet.id).toEqual("www/A");

      const replaced = yield* stack.deploy(
        Effect.gen(function* () {
          const zone = yield* Hetzner.Zone("ReplaceZone", {
            name: created.zone.name,
            ttl: 3600,
          });
          const recordSet = yield* Hetzner.RecordSet("Host", {
            zone,
            name: "api",
            type: "A",
            records: [{ value: "192.0.2.10" }],
            ttl: 300,
          });
          return { zone, recordSet };
        }),
      );

      expect(replaced.recordSet.id).toEqual("api/A");
      expect(replaced.recordSet.id).not.toEqual(created.recordSet.id);
      expect(replaced.recordSet.zoneId).toEqual(created.zone.zoneId);

      const fetched = yield* Services.zoneRrsets.getZoneRrset({
        id_or_name: String(replaced.zone.zoneId),
        rr_name: "api",
        rr_type: "A",
      });
      expect(fetched.rrset.id).toEqual("api/A");
      expect(fetched.rrset.records.map((record) => record.value)).toEqual([
        "192.0.2.10",
      ]);

      const oldGone = yield* waitUntilGone(created.zone.zoneId, "www", "A");
      expect(oldGone).toEqual("gone");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(replaced.zone.zoneId, "api", "A");
      expect(gone).toEqual("gone");
      const zoneGone = yield* waitUntilZoneGone(created.zone.zoneId);
      expect(zoneGone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 180_000 },
);

test.provider.skipIf(!hasHetznerCreds)(
  "list enumerates the deployed record set",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          const zone = yield* Hetzner.Zone("ListZone", {
            ttl: 3600,
          });
          const recordSet = yield* Hetzner.RecordSet("Www", {
            zone,
            name: "www",
            type: "A",
            records: [{ value: "192.0.2.20" }],
          });
          return { zone, recordSet };
        }),
      );

      const provider = yield* Provider.findProvider(Hetzner.RecordSet);
      const all = yield* provider.list();
      const found = all.find(
        (rrset) =>
          rrset.zoneId === deployed.zone.zoneId && rrset.id === "www/A",
      );
      expect(found).toBeDefined();
      expect(found?.name).toEqual("www");
      expect(found?.type).toEqual("A");
      expect(found?.records.map((record) => record.value)).toEqual([
        "192.0.2.20",
      ]);

      yield* stack.destroy();

      const gone = yield* waitUntilGone(deployed.zone.zoneId, "www", "A");
      expect(gone).toEqual("gone");
      const zoneGone = yield* waitUntilZoneGone(deployed.zone.zoneId);
      expect(zoneGone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 120_000 },
);
