import * as GCP from "@/GCP";
import { GcpEnvironment } from "@/GCP/Environment";
import * as Test from "@/Test/Alchemy";
import * as aiplatform from "@distilled.cloud/gcp/aiplatform_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: GCP.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

// Bigtable-backed store provisioning takes 1-3 minutes.
const runLifecycle = !process.env.FAST;

const waitUntilGone = (name: string) =>
  aiplatform.getProjectsLocationsFeatureOnlineStores({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "getProjectsLocationsFeatureOnlineStores on a missing store fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      const parent = `projects/${project}/locations/us-central1`;
      yield* stack.destroy();

      const error = yield* Effect.flip(
        aiplatform.getProjectsLocationsFeatureOnlineStores({
          name: `${parent}/featureOnlineStores/alchemy_missing`,
        }),
      );
      expect(error._tag).toEqual("NotFound");
      const page = yield* aiplatform.listProjectsLocationsFeatureOnlineStores({
        parent,
        pageSize: 10,
      });
      expect(
        (page.featureOnlineStores ?? []).map((item) => item.name),
      ).not.toContain(`${parent}/featureOnlineStores/alchemy_missing`);

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:aiplatform", "live"],
    timeout: 90_000,
  },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete a feature online store",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.AIPlatform.FeatureOnlineStore("Serving", {
            location: "us-central1",
            labels: { env: "test" },
          });
        }),
      );

      expect(created.name).toContain("/featureOnlineStores/");
      expect(created.location).toEqual("us-central1");
      expect(created.labels).toMatchObject({ env: "test" });

      const fetched = yield* aiplatform.getProjectsLocationsFeatureOnlineStores(
        {
          name: created.name,
        },
      );
      expect(fetched.name).toEqual(created.name);
      expect(fetched.labels?.env).toEqual("test");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.AIPlatform.FeatureOnlineStore("Serving", {
            featureOnlineStoreId: created.featureOnlineStoreId,
            location: "us-central1",
            labels: { env: "prod", role: "serving" },
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.labels).toMatchObject({ env: "prod", role: "serving" });

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:aiplatform", "live"],
    timeout: 600_000,
  },
);
