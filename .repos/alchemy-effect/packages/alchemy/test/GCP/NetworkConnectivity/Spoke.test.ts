import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as networkconnectivity from "@distilled.cloud/gcp/networkconnectivity_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import { withNetworkSlot } from "../networkQuota.ts";

const { test } = Test.make({ providers: GCP.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const waitUntilGone = (name: string) =>
  networkconnectivity.getProjectsLocationsSpokes({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider.skipIf(!!process.env.FAST)(
  "create, update, and delete a vpc spoke",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const network = yield* GCP.Compute.Network("SpokeVpc", {
            autoCreateSubnetworks: false,
          });
          const hub = yield* GCP.NetworkConnectivity.Hub("Mesh", {
            description: "ncc hub for spoke",
          });
          const spoke = yield* GCP.NetworkConnectivity.Spoke("VpcSpoke", {
            hub: hub.name,
            description: "spoke a",
            labels: { env: "test" },
            linkedVpcNetwork: {
              uri: network.selfLink.as<string>(),
            },
          });
          return { network, hub, spoke };
        }),
      );

      expect(created.spoke.name).toContain("/spokes/");
      expect(created.spoke.name).toContain("/locations/global/");
      expect(created.spoke.spokeId).toEqual(expect.any(String));
      expect(created.spoke.location).toEqual("global");
      expect(created.spoke.hub).toEqual(created.hub.name);
      expect(created.spoke.description).toEqual("spoke a");
      expect(created.spoke.labels).toMatchObject({ env: "test" });
      expect(created.spoke.spokeType).toEqual("VPC_NETWORK");
      expect(created.spoke.state).toEqual("ACTIVE");
      expect(created.spoke.uniqueId).toEqual(expect.any(String));
      expect(created.spoke.createTime).toEqual(expect.any(String));
      expect(created.spoke.linkedVpcNetwork?.uri).toContain(
        `networks/${created.network.networkName}`,
      );

      const fetched = yield* networkconnectivity.getProjectsLocationsSpokes({
        name: created.spoke.name,
      });
      expect(fetched.name).toEqual(created.spoke.name);
      expect(fetched.hub).toEqual(created.hub.name);
      expect(fetched.description).toEqual("spoke a");
      expect(fetched.labels?.env).toEqual("test");
      expect(fetched.spokeType).toEqual("VPC_NETWORK");
      expect(fetched.state).toEqual("ACTIVE");
      expect(
        Object.keys(fetched.labels ?? {}).some((key) =>
          key.startsWith("alchemy-"),
        ),
      ).toEqual(true);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const network = yield* GCP.Compute.Network("SpokeVpc", {
            networkName: created.network.networkName,
            autoCreateSubnetworks: false,
          });
          const hub = yield* GCP.NetworkConnectivity.Hub("Mesh", {
            hubId: created.hub.hubId,
            description: "ncc hub for spoke",
          });
          const spoke = yield* GCP.NetworkConnectivity.Spoke("VpcSpoke", {
            spokeId: created.spoke.spokeId,
            hub: hub.name,
            description: "spoke b",
            labels: { env: "prod", role: "spoke" },
            linkedVpcNetwork: {
              uri: network.selfLink.as<string>(),
            },
          });
          return { network, hub, spoke };
        }),
      );

      expect(updated.spoke.name).toEqual(created.spoke.name);
      expect(updated.spoke.uniqueId).toEqual(created.spoke.uniqueId);
      expect(updated.spoke.description).toEqual("spoke b");
      expect(updated.spoke.labels).toMatchObject({
        env: "prod",
        role: "spoke",
      });
      expect(updated.spoke.state).toEqual("ACTIVE");

      const refetched = yield* networkconnectivity.getProjectsLocationsSpokes({
        name: created.spoke.name,
      });
      expect(refetched.description).toEqual("spoke b");
      expect(refetched.labels?.env).toEqual("prod");
      expect(refetched.labels?.role).toEqual("spoke");
      expect(refetched.hub).toEqual(created.hub.name);

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.spoke.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel, withNetworkSlot),
  {
    tags: ["provider:gcp", "provider:gcp:networkconnectivity", "live"],
    timeout: 600_000,
  },
);
