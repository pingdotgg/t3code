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
  vmwareengine.getProjectsLocationsVmwareEngineNetworks({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "getProjectsLocationsVmwareEngineNetworks on a missing network fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;

      yield* stack.destroy();

      const error = yield* Effect.flip(
        vmwareengine.getProjectsLocationsVmwareEngineNetworks({
          name: `projects/${project}/locations/global/vmwareEngineNetworks/alchemy-ven-missing`,
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
  "create, update, and delete a vmware engine network",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.VMwareEngine.VmwareEngineNetwork("Ven", {
            type: "STANDARD",
            description: "alchemy-test-ven",
          });
        }),
      );

      expect(created.name).toContain("/vmwareEngineNetworks/");
      expect(created.name).toContain("/locations/global/");
      expect(created.vmwareEngineNetworkId).toEqual(expect.any(String));
      expect(created.location).toEqual("global");
      expect(created.type).toEqual("STANDARD");
      expect(created.description).toEqual("alchemy-test-ven");
      expect(created.state).toEqual("ACTIVE");
      expect(created.createTime).toEqual(expect.any(String));

      const fetched =
        yield* vmwareengine.getProjectsLocationsVmwareEngineNetworks({
          name: created.name,
        });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.type).toEqual("STANDARD");
      expect(fetched.description).toContain("alchemy-id=");
      expect(fetched.description).toContain("alchemy-test-ven");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.VMwareEngine.VmwareEngineNetwork("Ven", {
            vmwareEngineNetworkId: created.vmwareEngineNetworkId,
            location: "global",
            type: "STANDARD",
            description: "alchemy-prod-ven",
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.uid).toEqual(created.uid);
      expect(updated.description).toEqual("alchemy-prod-ven");

      const refetched =
        yield* vmwareengine.getProjectsLocationsVmwareEngineNetworks({
          name: created.name,
        });
      expect(refetched.description).toContain("alchemy-prod-ven");
      expect(refetched.description).toContain("alchemy-id=");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:vmwareengine", "live"],
    timeout: 120_000,
  },
);
