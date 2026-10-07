import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as compute from "@distilled.cloud/gcp/compute_v1";
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

const runLifecycle = !!process.env.GCP_TEST_WIRE_GROUP && !process.env.FAST;

const waitUntilGone = (
  projectId: string,
  crossSiteNetwork: string,
  wireGroup: string,
) =>
  compute
    .getWireGroups({
      project: projectId,
      crossSiteNetwork,
      wireGroup,
    })
    .pipe(
      Effect.as("found" as const),
      Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
      Effect.repeat({
        schedule: Schedule.spaced("1 second"),
        until: (status) => status === "gone",
        times: 10,
      }),
    );

test.provider(
  "getWireGroups on a missing group fails with NotFound",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      yield* stack.destroy();

      const error = yield* Effect.flip(
        compute.getWireGroups({
          project,
          crossSiteNetwork: "alchemy-missing-csn",
          wireGroup: "alchemy-missing-wire-group",
        }),
      );
      expect(error._tag).toBe("NotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:compute", "live"], timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete a wire group",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Compute.WireGroup("Metro", {
            crossSiteNetwork: process.env.GCP_TEST_CROSS_SITE_NETWORK ?? "",
            description: "nyc-to-sfo",
            adminEnabled: true,
            wireProperties: {
              bandwidthUnmetered: "10",
              bandwidthAllocation: "SHARED_WITH_WIRE_GROUP",
            },
            endpoints: {
              nyc: {
                interconnects: {
                  a: {
                    interconnect:
                      process.env.GCP_TEST_INTERCONNECT_A ??
                      "global/interconnects/nyc-a",
                    vlanTags: [100],
                  },
                },
              },
              sfo: {
                interconnects: {
                  a: {
                    interconnect:
                      process.env.GCP_TEST_INTERCONNECT_B ??
                      "global/interconnects/sfo-a",
                    vlanTags: [100],
                  },
                },
              },
            },
          });
        }),
      );

      expect(created.wireGroupName).toEqual(expect.any(String));
      expect(created.adminEnabled).toEqual(true);
      expect(created.description).toEqual("nyc-to-sfo");

      const fetched = yield* compute.getWireGroups({
        project: created.project,
        crossSiteNetwork: created.crossSiteNetwork,
        wireGroup: created.wireGroupName,
      });
      expect(fetched.name).toEqual(created.wireGroupName);
      expect(fetched.description).toContain("[alchemy ");
      expect(fetched.description).toContain("nyc-to-sfo");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Compute.WireGroup("Metro", {
            wireGroupName: created.wireGroupName,
            crossSiteNetwork: created.crossSiteNetwork,
            description: "nyc-to-sfo updated",
            adminEnabled: false,
            wireProperties: created.wireProperties,
            endpoints: created.endpoints,
          });
        }),
      );

      expect(updated.wireGroupName).toEqual(created.wireGroupName);
      expect(updated.description).toEqual("nyc-to-sfo updated");
      expect(updated.adminEnabled).toEqual(false);

      yield* stack.destroy();
      const gone = yield* waitUntilGone(
        created.project,
        created.crossSiteNetwork,
        created.wireGroupName,
      );
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:compute", "live"], timeout: 90_000 },
);
