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

const privateCloud = process.env.GCP_TEST_VMWAREENGINE_PRIVATE_CLOUD ?? "";
const vpcNetworkOf = (project: string) =>
  process.env.GCP_TEST_VMWAREENGINE_VPC_NETWORK ??
  `projects/${project}/global/networks/default`;

const runLifecycle =
  !!process.env.GCP_TEST_VMWAREENGINE &&
  privateCloud.length > 0 &&
  !process.env.FAST;

const waitUntilGone = (name: string) =>
  vmwareengine
    .getProjectsLocationsPrivateCloudsManagementDnsZoneBindings({ name })
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
  "getProjectsLocationsPrivateCloudsManagementDnsZoneBindings on a missing binding fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;

      yield* stack.destroy();

      const error = yield* Effect.flip(
        vmwareengine.getProjectsLocationsPrivateCloudsManagementDnsZoneBindings(
          {
            name: `projects/${project}/locations/us-central1-a/privateClouds/alchemy-pc-missing/managementDnsZoneBindings/alchemy-dns-missing`,
          },
        ),
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
  "create, update, and delete a management dns zone binding",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;

      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.VMwareEngine.PrivateCloudsManagementDnsZoneBinding(
            "VpcDns",
            {
              privateCloud,
              vpcNetwork: vpcNetworkOf(project),
              description: "alchemy-test-dns",
            },
          );
        }),
      );

      expect(created.name).toContain("/managementDnsZoneBindings/");
      expect(created.privateCloud).toEqual(privateCloud.replace(/\/+$/, ""));
      expect(created.description).toEqual("alchemy-test-dns");
      expect(created.createTime).toEqual(expect.any(String));

      const fetched =
        yield* vmwareengine.getProjectsLocationsPrivateCloudsManagementDnsZoneBindings(
          {
            name: created.name,
          },
        );
      expect(fetched.name).toEqual(created.name);
      expect(fetched.description).toContain("alchemy-id=");
      expect(fetched.description).toContain("alchemy-test-dns");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.VMwareEngine.PrivateCloudsManagementDnsZoneBinding(
            "VpcDns",
            {
              privateCloud,
              managementDnsZoneBindingId: created.managementDnsZoneBindingId,
              vpcNetwork: vpcNetworkOf(project),
              description: "alchemy-prod-dns",
            },
          );
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.description).toEqual("alchemy-prod-dns");

      const refetched =
        yield* vmwareengine.getProjectsLocationsPrivateCloudsManagementDnsZoneBindings(
          {
            name: created.name,
          },
        );
      expect(refetched.description).toContain("alchemy-prod-dns");
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
