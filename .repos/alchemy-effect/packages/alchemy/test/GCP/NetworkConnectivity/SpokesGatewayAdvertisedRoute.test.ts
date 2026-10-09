import * as GCP from "@/GCP";
import * as Output from "@/Output";
import * as Test from "@/Test/Alchemy";
import * as networkconnectivity from "@distilled.cloud/gcp/networkconnectivity_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import { GcpEnvironment } from "@/GCP/Environment";

const { test } = Test.make({ providers: GCP.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

// Gateway spokes provision managed routers and take well over 5 minutes.
const runLifecycle = !!process.env.GCP_TEST_SLOW && !process.env.FAST;

const waitUntilGone = (name: string) =>
  networkconnectivity
    .getProjectsLocationsSpokesGatewayAdvertisedRoutes({ name })
    .pipe(
      Effect.as("found" as const),
      Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
      Effect.repeat({
        schedule: Schedule.spaced("2 seconds"),
        until: (status) => status === "gone",
        times: 10,
      }),
    );

test.provider(
  "getProjectsLocationsSpokesGatewayAdvertisedRoutes on a missing route fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      yield* stack.destroy();

      const error = yield* Effect.flip(
        networkconnectivity.getProjectsLocationsSpokesGatewayAdvertisedRoutes({
          name: `projects/${project}/locations/us-central1/spokes/alchemy-missing/gatewayAdvertisedRoutes/alchemy-missing`,
        }),
      );
      expect(error._tag).toEqual("NotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:networkconnectivity", "live"],
    timeout: 90_000,
  },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete a gateway advertised route",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const hub = yield* GCP.NetworkConnectivity.Hub("Mesh", {
            description: "ncc hub for gateway route",
            policyMode: "PRESET",
            presetTopology: "HYBRID_INSPECTION",
          });
          const spoke = yield* GCP.NetworkConnectivity.Spoke("Gw", {
            location: "us-central1",
            hub: hub.name,
            group: Output.interpolate`${hub.name}/groups/gateways`,
            gateway: {
              capacity: "CAPACITY_1_GBPS",
              ipRangeReservations: [{ ipRange: "10.200.0.0/23" }],
            },
          });
          const route =
            yield* GCP.NetworkConnectivity.SpokesGatewayAdvertisedRoute(
              "OnPrem",
              {
                parent: spoke.name,
                ipRange: "192.168.0.0/16",
                recipient: "ADVERTISE_TO_HUB",
                description: "route a",
                labels: { env: "test" },
              },
            );
          return { hub, spoke, route };
        }),
      );

      expect(created.route.name).toContain("/gatewayAdvertisedRoutes/");
      expect(created.route.parent).toEqual(created.spoke.name);
      expect(created.route.ipRange).toEqual("192.168.0.0/16");
      expect(created.route.labels).toMatchObject({ env: "test" });

      const fetched =
        yield* networkconnectivity.getProjectsLocationsSpokesGatewayAdvertisedRoutes(
          { name: created.route.name },
        );
      expect(fetched.name).toEqual(created.route.name);
      expect(fetched.ipRange).toEqual("192.168.0.0/16");
      expect(fetched.labels?.env).toEqual("test");
      expect(
        Object.keys(fetched.labels ?? {}).some((key) =>
          key.startsWith("alchemy-"),
        ),
      ).toEqual(true);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const hub = yield* GCP.NetworkConnectivity.Hub("Mesh", {
            hubId: created.hub.hubId,
            description: "ncc hub for gateway route",
            policyMode: "PRESET",
            presetTopology: "HYBRID_INSPECTION",
          });
          const spoke = yield* GCP.NetworkConnectivity.Spoke("Gw", {
            spokeId: created.spoke.spokeId,
            location: "us-central1",
            hub: hub.name,
            group: Output.interpolate`${hub.name}/groups/gateways`,
            gateway: {
              capacity: "CAPACITY_1_GBPS",
              ipRangeReservations: [{ ipRange: "10.200.0.0/23" }],
            },
          });
          const route =
            yield* GCP.NetworkConnectivity.SpokesGatewayAdvertisedRoute(
              "OnPrem",
              {
                parent: spoke.name,
                gatewayAdvertisedRouteId:
                  created.route.gatewayAdvertisedRouteId,
                ipRange: "192.168.0.0/16",
                recipient: "ADVERTISE_TO_HUB",
                priority: 200,
                description: "route a",
                labels: { env: "test" },
              },
            );
          return { hub, spoke, route };
        }),
      );

      // Priority updates in place.
      expect(updated.route.name).toEqual(created.route.name);
      expect(updated.route.uniqueId).toEqual(created.route.uniqueId);
      expect(updated.route.description).toEqual("route a");
      expect(updated.route.priority).toEqual(200);

      const replaced = yield* stack.deploy(
        Effect.gen(function* () {
          const hub = yield* GCP.NetworkConnectivity.Hub("Mesh", {
            hubId: created.hub.hubId,
            description: "ncc hub for gateway route",
            policyMode: "PRESET",
            presetTopology: "HYBRID_INSPECTION",
          });
          const spoke = yield* GCP.NetworkConnectivity.Spoke("Gw", {
            spokeId: created.spoke.spokeId,
            location: "us-central1",
            hub: hub.name,
            group: Output.interpolate`${hub.name}/groups/gateways`,
            gateway: {
              capacity: "CAPACITY_1_GBPS",
              ipRangeReservations: [{ ipRange: "10.200.0.0/23" }],
            },
          });
          const route =
            yield* GCP.NetworkConnectivity.SpokesGatewayAdvertisedRoute(
              "OnPrem",
              {
                parent: spoke.name,
                gatewayAdvertisedRouteId:
                  created.route.gatewayAdvertisedRouteId,
                ipRange: "192.168.0.0/16",
                recipient: "ADVERTISE_TO_HUB",
                priority: 200,
                description: "route b",
                labels: { env: "prod", role: "gw" },
              },
            );
          return { hub, spoke, route };
        }),
      );

      // Labels are immutable: changing them replaces the route (the pinned
      // id is reused, so the old route is deleted first).
      expect(replaced.route.name).toEqual(created.route.name);
      expect(replaced.route.uniqueId).not.toEqual(created.route.uniqueId);
      expect(replaced.route.labels).toMatchObject({ env: "prod", role: "gw" });

      const refetched =
        yield* networkconnectivity.getProjectsLocationsSpokesGatewayAdvertisedRoutes(
          { name: replaced.route.name },
        );
      expect(refetched.labels?.env).toEqual("prod");
      expect(refetched.labels?.role).toEqual("gw");
      expect(refetched.priority).toEqual(200);

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.route.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:networkconnectivity", "live"],
    timeout: 1_800_000,
    retry: 0,
  },
);
