import { Action } from "@/Action";
import * as Hetzner from "@/Hetzner";
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
  "ReadWriteDns: get, list, create, update and delete a record set",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const out = yield* stack.deploy(
        Effect.gen(function* () {
          const zone = yield* Hetzner.Zone("DnsBindingZone", {
            ttl: 3600,
          });
          const recordSet = yield* Hetzner.RecordSet("Www", {
            zone,
            name: "www",
            type: "A",
            records: [{ value: "192.0.2.1" }],
            ttl: 300,
          });

          const Probe = Action(
            "Probe",
            Effect.gen(function* () {
              // Capture the record-set Output so Probe waits for Www.
              yield* recordSet.id;
              const dns = yield* Hetzner.ReadWriteDns(zone);
              return Effect.fn(function* () {
                const listed = yield* dns.listRecordSets({
                  name: "www",
                  type: ["A"],
                });
                const got = yield* dns.getRecordSet("www", "A");

                const created = yield* dns.createRecordSet({
                  name: "api",
                  type: "A",
                  records: [{ value: "192.0.2.50" }],
                  ttl: 300,
                });
                yield* Hetzner.waitForZoneAction(created.action);

                const set = yield* dns.setRecordSetRecords("api", "A", {
                  records: [{ value: "192.0.2.51" }],
                });
                yield* Hetzner.waitForZoneAction(set.action);
                const updated = yield* dns.getRecordSet("api", "A");

                const deleted = yield* dns.deleteRecordSet("api", "A");
                yield* Hetzner.waitForZoneAction(deleted.action);

                return {
                  listedCount: listed.rrsets.length,
                  listedValue: listed.rrsets[0]?.records[0]?.value,
                  gotId: got.rrset.id,
                  gotValue: got.rrset.records[0]?.value,
                  createdId: created.rrset.id,
                  updatedValue: updated.rrset.records[0]?.value,
                };
              });
            }),
          );

          return {
            zone,
            recordSet,
            probe: yield* Probe({}),
          };
        }),
      );

      expect(out.recordSet.id).toEqual("www/A");
      expect(out.probe.gotId).toEqual("www/A");
      expect(out.probe.gotValue).toEqual("192.0.2.1");
      expect(out.probe.listedCount).toBeGreaterThan(0);
      expect(out.probe.listedValue).toEqual("192.0.2.1");
      expect(out.probe.createdId).toEqual("api/A");
      expect(out.probe.updatedValue).toEqual("192.0.2.51");

      const fetched = yield* Services.zoneRrsets.getZoneRrset({
        id_or_name: String(out.zone.zoneId),
        rr_name: "www",
        rr_type: "A",
      });
      expect(fetched.rrset.id).toEqual("www/A");
      expect(fetched.rrset.records.map((record) => record.value)).toEqual([
        "192.0.2.1",
      ]);

      const apiGone = yield* Services.zoneRrsets
        .getZoneRrset({
          id_or_name: String(out.zone.zoneId),
          rr_name: "api",
          rr_type: "A",
        })
        .pipe(
          Effect.as("found" as const),
          Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
        );
      expect(apiGone).toEqual("gone");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(out.zone.zoneId, "www", "A");
      expect(gone).toEqual("gone");
      const zoneGone = yield* waitUntilZoneGone(out.zone.zoneId);
      expect(zoneGone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 120_000 },
);
