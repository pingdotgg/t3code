import * as AWS from "@/AWS";
import { HealthCheck, HostedZone, Record } from "@/AWS/Route53";
import * as Test from "@/Test/Alchemy";
import * as route53 from "@distilled.cloud/aws/route-53";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";

const { test } = Test.make({ providers: AWS.providers() });

const normalizeId = (id: string) => id.replace(/^\/hostedzone\//, "");

const findSet = (
  sets: route53.ResourceRecordSet[],
  name: string,
  setId: string,
) =>
  sets.find(
    (s) => s.Name === name && s.SetIdentifier === setId && s.Type === "A",
  );

const zoneName = "alchemy-route53-routing.alchemy.";

describe.skipIf(process.env.FAST)("RoutingPolicy", () => {
  test.provider(
    "weighted, failover, and alias routing records",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();

        const result = yield* stack.deploy(
          Effect.gen(function* () {
            const zone = yield* HostedZone("RoutingZone", { name: zoneName });

            // AWS requires a non-alias PRIMARY failover record to have a health
            // check.
            const check = yield* HealthCheck("PrimaryCheck", {
              type: "HTTP",
              ipAddress: "1.1.1.1",
              port: 80,
              resourcePath: "/",
              requestInterval: "30 seconds",
            });

            // Weighted pair — same name/type, distinct setIdentifier + weight.
            yield* Record("Blue", {
              hostedZoneId: zone.id,
              name: `api.${zoneName}`,
              type: "A",
              ttl: "60 seconds",
              records: ["1.2.3.4"],
              setIdentifier: "blue",
              weight: 90,
            });
            yield* Record("Green", {
              hostedZoneId: zone.id,
              name: `api.${zoneName}`,
              type: "A",
              ttl: "60 seconds",
              records: ["5.6.7.8"],
              setIdentifier: "green",
              weight: 10,
            });

            // Failover pair — PRIMARY gated on the health check.
            yield* Record("Primary", {
              hostedZoneId: zone.id,
              name: `app.${zoneName}`,
              type: "A",
              ttl: "60 seconds",
              records: ["1.1.1.1"],
              setIdentifier: "primary",
              failover: "PRIMARY",
              healthCheckId: check.id,
            });
            yield* Record("Secondary", {
              hostedZoneId: zone.id,
              name: `app.${zoneName}`,
              type: "A",
              ttl: "60 seconds",
              records: ["2.2.2.2"],
              setIdentifier: "secondary",
              failover: "SECONDARY",
            });

            return { zoneId: zone.id };
          }),
        );

        const zoneId = normalizeId(result.zoneId);

        // Verify out of band.
        const listed = yield* route53.listResourceRecordSets({
          HostedZoneId: zoneId,
          MaxItems: 100,
        });
        const sets = listed.ResourceRecordSets ?? [];

        const blue = findSet(sets, `api.${zoneName}`, "blue");
        const green = findSet(sets, `api.${zoneName}`, "green");
        expect(blue?.Weight).toBe(90);
        expect(green?.Weight).toBe(10);
        // Duration.Input ttl ("60 seconds") lands on the wire as TTL: 60.
        expect(blue?.TTL).toBe(60);

        const primary = findSet(sets, `app.${zoneName}`, "primary");
        const secondary = findSet(sets, `app.${zoneName}`, "secondary");
        expect(primary?.Failover).toBe("PRIMARY");
        expect(primary?.HealthCheckId).toBeDefined();
        expect(secondary?.Failover).toBe("SECONDARY");

        // Destroy — this exercises the DELETE builder serializing policy fields
        // (Weight, Failover, HealthCheckId). A mismatch would fail with
        // InvalidChangeBatch.
        yield* stack.destroy();

        // The zone must be fully cleaned up (records deleted, then zone deleted).
        const gone = yield* route53.getHostedZone({ Id: zoneId }).pipe(
          Effect.map(() => false),
          Effect.catchTag("NoSuchHostedZone", () => Effect.succeed(true)),
        );
        expect(gone).toBe(true);
      }),
    { timeout: 300_000 },
  );
});
