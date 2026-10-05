import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as networkconnectivity from "@distilled.cloud/gcp/networkconnectivity_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import { DEFAULT_NETWORK } from "../networkQuota.ts";

const { test } = Test.make({ providers: GCP.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const waitUntilGone = (name: string) =>
  networkconnectivity
    .getProjectsLocationsGlobalPolicyBasedRoutes({ name })
    .pipe(
      Effect.as("found" as const),
      Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
      Effect.repeat({
        schedule: Schedule.spaced("1 second"),
        until: (status) => status === "gone",
        times: 10,
      }),
    );

test.provider.skipIf(!!process.env.FAST)(
  "create, replace, and delete a policy-based route",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const route = yield* GCP.NetworkConnectivity.PolicyBasedRoute(
            "Skip",
            {
              network: DEFAULT_NETWORK,
              filter: {
                protocolVersion: "IPV4",
                ipProtocol: "TCP",
                srcRange: "10.0.0.0/8",
                destRange: "192.0.2.0/24",
              },
              nextHopOtherRoutes: "DEFAULT_ROUTING",
              virtualMachine: { tags: ["alchemy-pbr"] },
              description: "pbr a",
              labels: { env: "test" },
            },
          );
          return { route };
        }),
      );

      expect(created.route.name).toContain("/policyBasedRoutes/");
      expect(created.route.name).toContain("/locations/global/");
      expect(created.route.policyBasedRouteId).toEqual(expect.any(String));
      expect(created.route.location).toEqual("global");
      expect(created.route.network).toContain(`networks/${DEFAULT_NETWORK}`);
      expect(created.route.filter.protocolVersion).toEqual("IPV4");
      expect(created.route.filter.ipProtocol?.toUpperCase()).toEqual("TCP");
      expect(created.route.filter.srcRange).toEqual("10.0.0.0/8");
      expect(created.route.filter.destRange).toEqual("192.0.2.0/24");
      expect(created.route.nextHopOtherRoutes).toEqual("DEFAULT_ROUTING");
      expect(created.route.virtualMachine?.tags).toEqual(["alchemy-pbr"]);
      expect(created.route.priority).toEqual(1000);
      expect(created.route.description).toEqual("pbr a");
      expect(created.route.labels).toMatchObject({ env: "test" });
      expect(created.route.createTime).toEqual(expect.any(String));

      const fetched =
        yield* networkconnectivity.getProjectsLocationsGlobalPolicyBasedRoutes({
          name: created.route.name,
        });
      expect(fetched.name).toEqual(created.route.name);
      expect(fetched.filter?.destRange).toEqual("192.0.2.0/24");
      expect(fetched.nextHopOtherRoutes).toEqual("DEFAULT_ROUTING");
      expect(fetched.virtualMachine?.tags).toEqual(["alchemy-pbr"]);
      expect(fetched.description).toEqual("pbr a");
      expect(fetched.labels?.env).toEqual("test");
      expect(
        Object.keys(fetched.labels ?? {}).some((key) =>
          key.startsWith("alchemy-"),
        ),
      ).toEqual(true);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const route = yield* GCP.NetworkConnectivity.PolicyBasedRoute(
            "Skip",
            {
              policyBasedRouteId: created.route.policyBasedRouteId,
              network: DEFAULT_NETWORK,
              filter: {
                protocolVersion: "IPV4",
                ipProtocol: "TCP",
                srcRange: "10.0.0.0/8",
                destRange: "198.51.100.0/24",
              },
              nextHopOtherRoutes: "DEFAULT_ROUTING",
              virtualMachine: { tags: ["alchemy-pbr"] },
              priority: 900,
              description: "pbr b",
              labels: { env: "prod", role: "pbr" },
            },
          );
          return { route };
        }),
      );

      expect(updated.route.policyBasedRouteId).toEqual(
        created.route.policyBasedRouteId,
      );
      expect(updated.route.filter.destRange).toEqual("198.51.100.0/24");
      expect(updated.route.priority).toEqual(900);
      expect(updated.route.description).toEqual("pbr b");
      expect(updated.route.labels).toMatchObject({ env: "prod", role: "pbr" });

      const refetched =
        yield* networkconnectivity.getProjectsLocationsGlobalPolicyBasedRoutes({
          name: updated.route.name,
        });
      expect(refetched.filter?.destRange).toEqual("198.51.100.0/24");
      expect(refetched.priority).toEqual(900);
      expect(refetched.description).toEqual("pbr b");
      expect(refetched.labels?.env).toEqual("prod");
      expect(refetched.labels?.role).toEqual("pbr");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.route.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:networkconnectivity", "live"],
    timeout: 600_000,
  },
);
