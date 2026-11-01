import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as vmwareengine from "@distilled.cloud/gcp/vmwareengine_v1";
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

// Private clouds need VMware Engine node quota and bill thousands of dollars
// a month; set GCP_TEST_VMWAREENGINE=1 on an entitled project to opt in.
const runLifecycle = !!process.env.GCP_TEST_VMWAREENGINE && !process.env.FAST;

const waitUntilGone = (name: string) =>
  vmwareengine.getProjectsLocationsNetworkPeerings({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "getProjectsLocationsNetworkPeerings on a missing peering fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;

      yield* stack.destroy();

      const error = yield* Effect.flip(
        vmwareengine.getProjectsLocationsNetworkPeerings({
          name: `projects/${project}/locations/global/networkPeerings/alchemy-np-missing`,
        }),
      );
      expect(error._tag).toEqual("NotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:vmwareengine", "live"],
    timeout: 90_000,
  },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete a network peering",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;

      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const ven = yield* GCP.VMwareEngine.VmwareEngineNetwork("Ven", {
            type: "STANDARD",
            description: "peering parent",
          });
          const peering = yield* GCP.VMwareEngine.NetworkPeering("ToVpc", {
            vmwareEngineNetwork: ven.name,
            peerNetwork: `projects/${project}/global/networks/default`,
            peerNetworkType: "STANDARD",
            description: "alchemy-test-peering",
          });
          return { ven, peering };
        }),
      );

      expect(created.peering.name).toContain("/networkPeerings/");
      expect(created.peering.location).toEqual("global");
      expect(created.peering.description).toEqual("alchemy-test-peering");

      const fetched = yield* vmwareengine.getProjectsLocationsNetworkPeerings({
        name: created.peering.name,
      });
      expect(fetched.name).toEqual(created.peering.name);
      expect(fetched.description).toContain("alchemy-id=");
      expect(fetched.description).toContain("alchemy-test-peering");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const ven = yield* GCP.VMwareEngine.VmwareEngineNetwork("Ven", {
            vmwareEngineNetworkId: created.ven.vmwareEngineNetworkId,
            type: "STANDARD",
            description: "peering parent",
          });
          const peering = yield* GCP.VMwareEngine.NetworkPeering("ToVpc", {
            networkPeeringId: created.peering.networkPeeringId,
            vmwareEngineNetwork: ven.name,
            peerNetwork: `projects/${project}/global/networks/default`,
            peerNetworkType: "STANDARD",
            description: "alchemy-prod-peering",
          });
          return { ven, peering };
        }),
      );

      expect(updated.peering.name).toEqual(created.peering.name);
      expect(updated.peering.description).toEqual("alchemy-prod-peering");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.peering.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:vmwareengine", "live"],
    timeout: 120_000,
  },
);
