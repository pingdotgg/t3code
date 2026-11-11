import * as GCP from "@alchemy.run/gcp";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as compute from "@distilled.cloud/gcp/compute_v1";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: GCP.providers() });

const logLevel = Effect.provideService(MinimumLogLevel, process.env.DEBUG ? "Debug" : "Info");

const waitUntilGone = (project: string, region: string, routerName: string) =>
  compute.getRouters({ project, region, router: routerName }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 20,
    }),
  );

test.provider(
  "create, update, replace, and delete a router",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Compute.Router("Edge", {
            network: "default",
            region: "us-central1",
            description: "test router",
            bgp: { asn: 65001, advertiseMode: "DEFAULT" },
          });
        }),
      );

      expect(created.routerName).toEqual(expect.any(String));
      expect(created.region).toEqual("us-central1");
      expect(created.description).toEqual("test router");
      expect(created.encryptedInterconnectRouter).toEqual(false);
      expect(created.bgp?.asn).toEqual(65001);
      expect(created.bgp?.advertiseMode).toEqual("DEFAULT");
      expect(created.network).toEqual(expect.stringContaining("networks/default"));

      const fetched = yield* compute.getRouters({
        project: created.project,
        region: created.region,
        router: created.routerName,
      });
      expect(fetched.name).toEqual(created.routerName);
      expect(fetched.description).toContain("alchemy-id=");
      expect(fetched.description).toContain("test router");
      expect(fetched.bgp?.asn).toEqual(65001);
      expect(fetched.bgp?.advertiseMode).toEqual("DEFAULT");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Compute.Router("Edge", {
            routerName: created.routerName,
            network: "default",
            region: "us-central1",
            description: "updated router",
            bgp: {
              asn: 65001,
              advertiseMode: "CUSTOM",
              advertisedGroups: ["ALL_SUBNETS"],
              advertisedIpRanges: [{ range: "10.0.0.0/8", description: "rfc1918" }],
              keepaliveInterval: 30,
            },
          });
        }),
      );

      expect(updated.routerName).toEqual(created.routerName);
      expect(updated.routerId).toEqual(created.routerId);
      expect(updated.description).toEqual("updated router");
      expect(updated.bgp?.advertiseMode).toEqual("CUSTOM");
      expect(updated.bgp?.advertisedGroups).toEqual(["ALL_SUBNETS"]);
      expect(updated.bgp?.keepaliveInterval).toEqual(30);
      expect(updated.bgp?.advertisedIpRanges).toEqual([
        { range: "10.0.0.0/8", description: "rfc1918" },
      ]);

      const fetchedUpdate = yield* compute.getRouters({
        project: updated.project,
        region: updated.region,
        router: updated.routerName,
      });
      expect(fetchedUpdate.description).toContain("updated router");
      expect(fetchedUpdate.bgp?.advertiseMode).toEqual("CUSTOM");
      expect(fetchedUpdate.bgp?.advertisedGroups).toEqual(["ALL_SUBNETS"]);
      expect(fetchedUpdate.bgp?.keepaliveInterval).toEqual(30);

      const replaced = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Compute.Router("Edge", {
            routerName: created.routerName,
            network: "default",
            region: "us-central1",
            description: "updated router",
            encryptedInterconnectRouter: true,
            bgp: {
              asn: 65001,
              advertiseMode: "CUSTOM",
              advertisedGroups: ["ALL_SUBNETS"],
              advertisedIpRanges: [{ range: "10.0.0.0/8", description: "rfc1918" }],
              keepaliveInterval: 30,
            },
          });
        }),
      );

      expect(replaced.routerName).toEqual(created.routerName);
      expect(replaced.encryptedInterconnectRouter).toEqual(true);
      expect(replaced.routerId).not.toEqual(created.routerId);

      const fetchedReplace = yield* compute.getRouters({
        project: replaced.project,
        region: replaced.region,
        router: replaced.routerName,
      });
      expect(fetchedReplace.encryptedInterconnectRouter).toEqual(true);

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.project, created.region, created.routerName);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:compute", "live"], timeout: 180_000 },
);

test.provider(
  "manages Cloud NAT timeouts, address tier, and endpoint types in place",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const natRouter = (tcpTimeWaitTimeoutSec: number, autoNetworkTier: "PREMIUM" | "STANDARD") =>
        GCP.Compute.Router("NatEdge", {
          network: "default",
          region: "us-central1",
          nats: [
            {
              name: "egress",
              sourceSubnetworkIpRangesToNat: "ALL_SUBNETWORKS_ALL_IP_RANGES",
              natIpAllocateOption: "AUTO_ONLY",
              tcpTimeWaitTimeoutSec,
              autoNetworkTier,
              endpointTypes: ["ENDPOINT_TYPE_VM"],
            },
          ],
        });

      const created = yield* stack.deploy(natRouter(90, "PREMIUM"));
      expect(created.nats).toHaveLength(1);
      expect(created.nats[0]).toMatchObject({
        name: "egress",
        tcpTimeWaitTimeoutSec: 90,
        autoNetworkTier: "PREMIUM",
        endpointTypes: ["ENDPOINT_TYPE_VM"],
      });

      const updated = yield* stack.deploy(natRouter(60, "STANDARD"));
      expect(updated.routerId).toEqual(created.routerId);
      expect(updated.nats[0]).toMatchObject({
        tcpTimeWaitTimeoutSec: 60,
        autoNetworkTier: "STANDARD",
      });

      const fetched = yield* compute.getRouters({
        project: updated.project,
        region: updated.region,
        router: updated.routerName,
      });
      expect(fetched.nats?.[0]).toMatchObject({
        name: "egress",
        tcpTimeWaitTimeoutSec: 60,
        autoNetworkTier: "STANDARD",
        endpointTypes: ["ENDPOINT_TYPE_VM"],
      });

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.project, created.region, created.routerName);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:compute", "live"], timeout: 180_000 },
);
