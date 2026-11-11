import * as AWS from "@alchemy.run/aws";
import { HostedZone, RecordList } from "@alchemy.run/aws/Route53";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as route53 from "@distilled.cloud/aws/route-53";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: AWS.providers() });

// Deterministic zone (reserved-domain-safe TLD `.alchemy`) — records need no
// public resolution, only CRUD.
const ZONE = "alchemy-route53-recordlist.alchemy";
const CNAME_NAME = `cname.${ZONE}`;
const TXT_NAME = `txt.${ZONE}`;
const A_NAME = `a.${ZONE}`;
const ADDED_NAME = `added.${ZONE}`;

const OURS = "alchemy-recordlist=ours";
const FOREIGN = "alchemy-recordlist=foreign";

const normalizeId = (id: string) => id.replace(/^\/hostedzone\//, "");

/** Live values (TXT unquoted) of the simple record set `(name, type)`, sorted. */
const liveValues = (zoneId: string, name: string, type: "A" | "CNAME" | "TXT") =>
  route53
    .listResourceRecordSets({
      HostedZoneId: normalizeId(zoneId),
      StartRecordName: `${name}.`,
      StartRecordType: type,
      MaxItems: 1,
    })
    .pipe(
      Effect.map((response) => {
        const set = (response.ResourceRecordSets ?? []).find(
          (s) => s.Name === `${name}.` && s.Type === type,
        );
        return (set?.ResourceRecords ?? [])
          .map((r) => r.Value.replace(/^"|"$/g, "").replace(/\.$/, ""))
          .sort();
      }),
    );

const zone = HostedZone("Zone", { name: `${ZONE}.`, forceDestroy: true });

const assertZoneGone = (id: string) =>
  route53.getHostedZone({ Id: normalizeId(id) }).pipe(
    Effect.as("present" as const),
    Effect.catchTag("NoSuchHostedZone", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "publishes, converges, and removes only its own values",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { id: zoneId } = yield* stack.deploy(zone);

      // Someone else's TXT value at a name the list also publishes to.
      yield* route53.changeResourceRecordSets({
        HostedZoneId: normalizeId(zoneId),
        ChangeBatch: {
          Changes: [
            {
              Action: "UPSERT",
              ResourceRecordSet: {
                Name: `${TXT_NAME}.`,
                Type: "TXT",
                TTL: 300,
                ResourceRecords: [{ Value: `"${FOREIGN}"` }],
              },
            },
          ],
        },
      });

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const z = yield* zone;
          return yield* RecordList("Records", {
            hostedZoneId: z.id,
            records: [
              {
                name: CNAME_NAME,
                type: "CNAME",
                value: "target-1.example.net",
              },
              { name: TXT_NAME, type: "TXT", value: OURS },
              { name: A_NAME, type: "A", value: "203.0.113.10" },
              { name: A_NAME, type: "A", value: "203.0.113.11" },
            ],
          });
        }),
      );
      expect(created.records).toHaveLength(4);
      expect(yield* liveValues(zoneId, CNAME_NAME, "CNAME")).toEqual(["target-1.example.net"]);
      expect(yield* liveValues(zoneId, TXT_NAME, "TXT")).toEqual([FOREIGN, OURS]);
      expect(yield* liveValues(zoneId, A_NAME, "A")).toEqual(["203.0.113.10", "203.0.113.11"]);

      // Change the CNAME target, drop an address, add a record.
      yield* stack.deploy(
        Effect.gen(function* () {
          const z = yield* zone;
          return yield* RecordList("Records", {
            hostedZoneId: z.id,
            records: [
              {
                name: CNAME_NAME,
                type: "CNAME",
                value: "target-2.example.net",
              },
              { name: TXT_NAME, type: "TXT", value: OURS },
              { name: A_NAME, type: "A", value: "203.0.113.10" },
              { name: ADDED_NAME, type: "TXT", value: OURS },
            ],
          });
        }),
      );
      expect(yield* liveValues(zoneId, CNAME_NAME, "CNAME")).toEqual(["target-2.example.net"]);
      expect(yield* liveValues(zoneId, A_NAME, "A")).toEqual(["203.0.113.10"]);
      expect(yield* liveValues(zoneId, ADDED_NAME, "TXT")).toEqual([OURS]);
      expect(yield* liveValues(zoneId, TXT_NAME, "TXT")).toEqual([FOREIGN, OURS]);

      // Remove the list (the zone stays): only its own values go.
      yield* stack.deploy(zone);
      expect(yield* liveValues(zoneId, CNAME_NAME, "CNAME")).toEqual([]);
      expect(yield* liveValues(zoneId, A_NAME, "A")).toEqual([]);
      expect(yield* liveValues(zoneId, ADDED_NAME, "TXT")).toEqual([]);
      expect(yield* liveValues(zoneId, TXT_NAME, "TXT")).toEqual([FOREIGN]);

      // `forceDestroy` clears the foreign record with the zone.
      yield* stack.destroy();
      expect(yield* assertZoneGone(zoneId)).toBe("gone");
    }),
  {
    tags: ["provider:aws", "provider:aws:route53", "live"],
    timeout: 240_000,
  },
);
