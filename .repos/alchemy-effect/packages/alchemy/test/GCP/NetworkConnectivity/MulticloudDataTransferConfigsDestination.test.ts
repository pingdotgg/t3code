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
    .getProjectsLocationsMulticloudDataTransferConfigsDestinations({ name })
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
  "getProjectsLocationsMulticloudDataTransferConfigsDestinations on a missing destination fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      yield* stack.destroy();

      const error = yield* Effect.flip(
        networkconnectivity.getProjectsLocationsMulticloudDataTransferConfigsDestinations(
          {
            name: `projects/${project}/locations/us-central1/multicloudDataTransferConfigs/alchemy-missing/destinations/alchemy-missing`,
          },
        ),
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
  "create, update, and delete a multicloud data transfer destination",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const config =
            yield* GCP.NetworkConnectivity.MulticloudDataTransferConfig("Dte", {
              location: "europe-west3",
              description: "dte parent",
              services: { "cloud-storage": {} },
            });
          const destination =
            yield* GCP.NetworkConnectivity.MulticloudDataTransferConfigsDestination(
              "OnPrem",
              {
                parent: config.name,
                ipPrefix: "203.0.113.0/24",
                endpoints: [{ asn: "16509", csp: "AWS" }],
                description: "dest a",
                labels: { env: "test" },
              },
            );
          return { config, destination };
        }),
      );

      expect(created.destination.name).toContain("/destinations/");
      expect(created.destination.parent).toEqual(created.config.name);
      expect(created.destination.ipPrefix).toEqual("203.0.113.0/24");
      expect(created.destination.labels).toMatchObject({ env: "test" });

      const fetched =
        yield* networkconnectivity.getProjectsLocationsMulticloudDataTransferConfigsDestinations(
          { name: created.destination.name },
        );
      expect(fetched.name).toEqual(created.destination.name);
      expect(fetched.ipPrefix).toEqual("203.0.113.0/24");
      expect(fetched.labels?.env).toEqual("test");
      expect(
        Object.keys(fetched.labels ?? {}).some((key) =>
          key.startsWith("alchemy-"),
        ),
      ).toEqual(true);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const config =
            yield* GCP.NetworkConnectivity.MulticloudDataTransferConfig("Dte", {
              multicloudDataTransferConfigId:
                created.config.multicloudDataTransferConfigId,
              location: created.config.location,
              description: "dte parent",
              services: { "cloud-storage": {} },
            });
          const destination =
            yield* GCP.NetworkConnectivity.MulticloudDataTransferConfigsDestination(
              "OnPrem",
              {
                parent: config.name,
                destinationId: created.destination.destinationId,
                ipPrefix: "203.0.113.0/24",
                endpoints: [{ asn: "16509", csp: "AWS" }],
                description: "dest b",
                labels: { env: "prod", role: "dte" },
              },
            );
          return { config, destination };
        }),
      );

      expect(updated.destination.name).toEqual(created.destination.name);
      expect(updated.destination.description).toEqual("dest b");
      expect(updated.destination.labels).toMatchObject({
        env: "prod",
        role: "dte",
      });

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.destination.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:networkconnectivity", "live"],
    timeout: 180_000,
  },
);
