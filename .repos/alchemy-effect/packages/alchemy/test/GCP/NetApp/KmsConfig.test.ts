import { GcpEnvironment } from "@/GCP/Environment";
import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as netapp from "@distilled.cloud/gcp/netapp_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: GCP.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const runLifecycle = !process.env.FAST;

const waitUntilGone = (name: string) =>
  netapp.getProjectsLocationsKmsConfigs({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "getProjectsLocationsKmsConfigs on a missing config fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;

      yield* stack.destroy();

      const error = yield* Effect.flip(
        netapp.getProjectsLocationsKmsConfigs({
          name: `projects/${project}/locations/us-central1/kmsConfigs/alchemy-netapp-missing`,
        }),
      );
      expect(error._tag).toEqual("NotFound");

      const page = yield* netapp.listProjectsLocationsKmsConfigs({
        parent: `projects/${project}/locations/-`,
        pageSize: 10,
      });
      expect((page.kmsConfigs ?? []).map((item) => item.name)).not.toContain(
        `projects/${project}/locations/us-central1/kmsConfigs/alchemy-netapp-missing`,
      );

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:netapp", "live"], timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete a kms config",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      const cryptoKeyName = `projects/${project}/locations/us-central1/keyRings/alchemy-test-keyring/cryptoKeys/alchemy-test-cryptokey-enc`;

      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.NetApp.KmsConfig("Cmek", {
            cryptoKeyName,
            description: "alchemy-test-cmek",
            labels: { env: "test" },
          });
        }),
      );

      expect(created.name).toContain("/kmsConfigs/");
      expect(created.cryptoKeyName).toEqual(cryptoKeyName);
      expect(created.labels).toMatchObject({ env: "test" });

      const fetched = yield* netapp.getProjectsLocationsKmsConfigs({
        name: created.name,
      });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.cryptoKeyName).toEqual(cryptoKeyName);
      expect(fetched.labels?.env).toEqual("test");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.NetApp.KmsConfig("Cmek", {
            kmsConfigId: created.kmsConfigId,
            cryptoKeyName,
            description: "alchemy-prod-cmek",
            labels: { env: "prod", role: "cmek" },
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.description).toEqual("alchemy-prod-cmek");
      expect(updated.labels).toMatchObject({ env: "prod", role: "cmek" });

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:netapp", "live"], timeout: 900_000 },
);
