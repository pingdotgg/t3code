import * as GCP from "@/GCP";
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

const runLifecycle = !process.env.FAST;

const waitUntilGone = (name: string) =>
  networkconnectivity
    .getProjectsLocationsMulticloudDataTransferConfigs({ name })
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
  "getProjectsLocationsMulticloudDataTransferConfigs on a missing config fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      yield* stack.destroy();

      const error = yield* Effect.flip(
        networkconnectivity.getProjectsLocationsMulticloudDataTransferConfigs({
          name: `projects/${project}/locations/us-central1/multicloudDataTransferConfigs/alchemy-missing`,
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
  "create, update, and delete a multicloud data transfer config",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.NetworkConnectivity.MulticloudDataTransferConfig(
            "Dte",
            {
              location: "europe-west1",
              description: "dte a",
              services: { "cloud-storage": {}, "compute-engine": {} },
              labels: { env: "test" },
            },
          );
        }),
      );

      expect(created.name).toContain("/multicloudDataTransferConfigs/");
      expect(created.location).toEqual("europe-west1");
      expect(created.description).toEqual("dte a");
      expect(created.labels).toMatchObject({ env: "test" });
      expect(created.multicloudDataTransferConfigId).toEqual(
        expect.any(String),
      );

      const fetched =
        yield* networkconnectivity.getProjectsLocationsMulticloudDataTransferConfigs(
          { name: created.name },
        );
      expect(fetched.name).toEqual(created.name);
      expect(fetched.description).toEqual("dte a");
      expect(fetched.labels?.env).toEqual("test");
      expect(
        Object.keys(fetched.labels ?? {}).some((key) =>
          key.startsWith("alchemy-"),
        ),
      ).toEqual(true);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.NetworkConnectivity.MulticloudDataTransferConfig(
            "Dte",
            {
              multicloudDataTransferConfigId:
                created.multicloudDataTransferConfigId,
              location: created.location,
              description: "dte b",
              labels: { env: "prod", role: "dte" },
            },
          );
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.description).toEqual("dte b");
      expect(updated.labels).toMatchObject({ env: "prod", role: "dte" });

      const refetched =
        yield* networkconnectivity.getProjectsLocationsMulticloudDataTransferConfigs(
          { name: created.name },
        );
      expect(refetched.description).toEqual("dte b");
      expect(refetched.labels?.env).toEqual("prod");
      expect(refetched.labels?.role).toEqual("dte");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:networkconnectivity", "live"],
    timeout: 180_000,
  },
);
