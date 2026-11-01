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

// Needs Cloud Armor Managed Protection Plus (GCP_TEST_CLOUD_ARMOR=1); without
// it insert fails with `BadRequest: Network Security Policies require Cloud
// Armor Managed Protection Plus tier and above to use.`
const runLifecycle = !!process.env.GCP_TEST_CLOUD_ARMOR && !process.env.FAST;

const region = "us-central1";

const waitUntilGone = (networkEdgeSecurityService: string) =>
  GcpEnvironment.current.pipe(
    Effect.flatMap(({ project }) =>
      compute
        .getNetworkEdgeSecurityServices({
          project,
          region,
          networkEdgeSecurityService,
        })
        .pipe(
          Effect.as("found" as const),
          Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
          Effect.repeat({
            schedule: Schedule.spaced("1 second"),
            until: (status) => status === "gone",
            times: 10,
          }),
        ),
    ),
  );

test.provider(
  "getNetworkEdgeSecurityServices on a missing service fails with NotFound",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      yield* stack.destroy();

      const error = yield* Effect.flip(
        compute.getNetworkEdgeSecurityServices({
          project,
          region,
          networkEdgeSecurityService: "alchemy-missing-ness",
        }),
      );
      expect(error._tag).toBe("NotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:compute", "live"], timeout: 90_000 },
);

test.provider(
  "insertNetworkEdgeSecurityServices without Cloud Armor Enterprise fails with CloudArmorEnterpriseRequired",
  () =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      const error = yield* Effect.flip(
        compute.insertNetworkEdgeSecurityServices({
          project,
          region,
          body: {
            name: "alchemy-ness-probe",
            description: "alchemy entitlement probe",
          },
        }),
      );
      expect(error._tag).toEqual("CloudArmorEnterpriseRequired");
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:compute", "live"], timeout: 60_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete a network edge security service",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Compute.NetworkEdgeSecurityService("EdgeArmor", {
            region,
            description: "regional network armor",
          });
        }),
      );

      expect(created.networkEdgeSecurityServiceName).toEqual(
        expect.any(String),
      );
      expect(created.region).toEqual(region);
      expect(created.description).toEqual("regional network armor");

      const fetched = yield* compute.getNetworkEdgeSecurityServices({
        project: created.project,
        region,
        networkEdgeSecurityService: created.networkEdgeSecurityServiceName,
      });
      expect(fetched.name).toEqual(created.networkEdgeSecurityServiceName);
      expect(fetched.description).toContain("[alchemy ");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Compute.NetworkEdgeSecurityService("EdgeArmor", {
            networkEdgeSecurityServiceName:
              created.networkEdgeSecurityServiceName,
            region,
            description: "updated network armor",
          });
        }),
      );
      expect(updated.description).toEqual("updated network armor");

      yield* stack.destroy();
      const gone = yield* waitUntilGone(created.networkEdgeSecurityServiceName);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:compute", "live"], timeout: 90_000 },
);
