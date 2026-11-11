import * as Hetzner from "@alchemy.run/hetzner";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as zoneRrsetActions from "@distilled.cloud/hetzner/zone_rrset_actions";
import * as zoneRrsets from "@distilled.cloud/hetzner/zone_rrsets";
import * as zones from "@distilled.cloud/hetzner/zones";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: Hetzner.providers() });

const logLevel = Effect.provideService(MinimumLogLevel, process.env.DEBUG ? "Debug" : "Info");

const hasHetznerCreds = !!process.env.HCLOUD_TOKEN;

const OURS = "alchemy-recordlist=ours";
const FOREIGN = "alchemy-recordlist=foreign";

// The zone name is generated from the stack, stage, and logical id —
// deterministic across runs.
const zone = Hetzner.Zone("Zone", { ttl: 3600 });

/** Live values (TXT unquoted, hostnames without a trailing dot), sorted. */
const liveValues = (zoneId: number, name: string, type: string) =>
  zoneRrsets.getZoneRrset({ id_or_name: String(zoneId), rr_name: name, rr_type: type }).pipe(
    Effect.map(({ rrset }) =>
      rrset.records.map((r) => r.value.replace(/^"|"$/g, "").replace(/\.$/, "")).sort(),
    ),
    Effect.catchTag("NotFound", () => Effect.succeed([] as string[])),
  );

const waitUntilZoneGone = (zoneId: number) =>
  zones.getZone({ id_or_name: String(zoneId) }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider.skipIf(!hasHetznerCreds)(
  "publishes, converges, and removes only its own values",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { zoneId, name: zoneName } = yield* stack.deploy(zone);
      const cnameName = `cname.${zoneName}`;
      const txtName = `txt.${zoneName}`;
      const aName = `a.${zoneName}`;
      const addedName = `added.${zoneName}`;

      // Someone else's TXT value at a name the list also publishes to.
      const { action } = yield* zoneRrsetActions.addZoneRrsetRecords({
        id_or_name: String(zoneId),
        rr_name: "txt",
        rr_type: "TXT",
        records: [{ value: `"${FOREIGN}"` }],
      });
      yield* Hetzner.waitForZoneAction(action.id);

      // Zone omitted — each record's zone is inferred from its name.
      const created = yield* stack.deploy(
        Effect.gen(function* () {
          yield* zone;
          return yield* Hetzner.DNS.RecordList("Records", {
            records: [
              { name: cnameName, type: "CNAME", value: "target-1.example.net" },
              { name: txtName, type: "TXT", value: OURS },
              { name: aName, type: "A", value: "203.0.113.10" },
              { name: aName, type: "A", value: "203.0.113.11" },
            ],
          });
        }),
      );
      expect(created.records).toHaveLength(4);
      expect(created.records.every((r) => r.zoneId === zoneId)).toBe(true);
      expect(yield* liveValues(zoneId, "cname", "CNAME")).toEqual(["target-1.example.net"]);
      expect(yield* liveValues(zoneId, "txt", "TXT")).toEqual([FOREIGN, OURS]);
      expect(yield* liveValues(zoneId, "a", "A")).toEqual(["203.0.113.10", "203.0.113.11"]);

      // Change the CNAME target, drop an address, add a record (zone
      // pinned by name).
      yield* stack.deploy(
        Effect.gen(function* () {
          yield* zone;
          return yield* Hetzner.DNS.RecordList("Records", {
            zone: zoneName,
            records: [
              { name: cnameName, type: "CNAME", value: "target-2.example.net" },
              { name: txtName, type: "TXT", value: OURS },
              { name: aName, type: "A", value: "203.0.113.10" },
              { name: addedName, type: "TXT", value: OURS },
            ],
          });
        }),
      );
      expect(yield* liveValues(zoneId, "cname", "CNAME")).toEqual(["target-2.example.net"]);
      expect(yield* liveValues(zoneId, "a", "A")).toEqual(["203.0.113.10"]);
      expect(yield* liveValues(zoneId, "added", "TXT")).toEqual([OURS]);
      expect(yield* liveValues(zoneId, "txt", "TXT")).toEqual([FOREIGN, OURS]);

      // Remove the list (the zone stays): only its own values go.
      yield* stack.deploy(zone);
      expect(yield* liveValues(zoneId, "cname", "CNAME")).toEqual([]);
      expect(yield* liveValues(zoneId, "a", "A")).toEqual([]);
      expect(yield* liveValues(zoneId, "added", "TXT")).toEqual([]);
      expect(yield* liveValues(zoneId, "txt", "TXT")).toEqual([FOREIGN]);

      yield* stack.destroy();
      expect(yield* waitUntilZoneGone(zoneId)).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:hetzner", "provider:hetzner:dns", "provider:hetzner:zone", "live"],
    timeout: 120_000,
  },
);
