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
  vmwareengine.getProjectsLocationsNetworkPolicies({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "getProjectsLocationsNetworkPolicies on a missing policy fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;

      yield* stack.destroy();

      const error = yield* Effect.flip(
        vmwareengine.getProjectsLocationsNetworkPolicies({
          name: `projects/${project}/locations/us-central1/networkPolicies/alchemy-npol-missing`,
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
  "create, update, and delete a network policy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const ven = yield* GCP.VMwareEngine.VmwareEngineNetwork("Ven", {
            type: "STANDARD",
            description: "policy parent",
          });
          const policy = yield* GCP.VMwareEngine.NetworkPolicy("Edge", {
            vmwareEngineNetwork: ven.name,
            edgeServicesCidr: "192.168.100.0/26",
            internetAccess: { enabled: false },
            externalIp: { enabled: false },
            description: "alchemy-test-npol",
          });
          return { ven, policy };
        }),
      );

      expect(created.policy.name).toContain("/networkPolicies/");
      expect(created.policy.edgeServicesCidr).toEqual("192.168.100.0/26");
      expect(created.policy.description).toEqual("alchemy-test-npol");

      const fetched = yield* vmwareengine.getProjectsLocationsNetworkPolicies({
        name: created.policy.name,
      });
      expect(fetched.name).toEqual(created.policy.name);
      expect(fetched.description).toContain("alchemy-id=");
      expect(fetched.description).toContain("alchemy-test-npol");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const ven = yield* GCP.VMwareEngine.VmwareEngineNetwork("Ven", {
            vmwareEngineNetworkId: created.ven.vmwareEngineNetworkId,
            type: "STANDARD",
            description: "policy parent",
          });
          const policy = yield* GCP.VMwareEngine.NetworkPolicy("Edge", {
            networkPolicyId: created.policy.networkPolicyId,
            vmwareEngineNetwork: ven.name,
            edgeServicesCidr: "192.168.100.0/26",
            internetAccess: { enabled: true },
            externalIp: { enabled: false },
            description: "alchemy-prod-npol",
          });
          return { ven, policy };
        }),
      );

      expect(updated.policy.name).toEqual(created.policy.name);
      expect(updated.policy.description).toEqual("alchemy-prod-npol");
      expect(updated.policy.internetAccess?.enabled).toEqual(true);

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.policy.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:vmwareengine", "live"],
    timeout: 120_000,
  },
);
