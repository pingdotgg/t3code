import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as retail from "@distilled.cloud/gcp/retail_v2";
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

// Retail only serves projects that accepted the Retail data use terms (a
// one-time console step); until then every call fails with
// RetailDataUseTermsNotAccepted. Set GCP_TEST_RETAIL_TERMS=1 once accepted.
const runLifecycle = !!process.env.GCP_TEST_RETAIL_TERMS;

const waitUntilGone = (name: string) =>
  retail.getProjectsLocationsCatalogsServingConfigs({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "getProjectsLocationsCatalogsServingConfigs on a missing serving config fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;

      yield* stack.destroy();

      const error = yield* Effect.flip(
        retail.getProjectsLocationsCatalogsServingConfigs({
          name: `projects/${project}/locations/global/catalogs/default_catalog/servingConfigs/alchemy-missing`,
        }),
      );
      expect(error._tag).toEqual(
        runLifecycle ? "NotFound" : "RetailDataUseTermsNotAccepted",
      );

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:retail", "live"], timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete a catalog serving config",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Retail.CatalogsServingConfig("Preview", {
            displayName: "preview search",
          });
        }),
      );

      expect(created.name).toContain("/servingConfigs/");
      expect(created.solutionTypes).toEqual(
        expect.arrayContaining(["SOLUTION_TYPE_SEARCH"]),
      );

      const fetched = yield* retail.getProjectsLocationsCatalogsServingConfigs({
        name: created.name,
      });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.displayName).toEqual(created.displayName);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Retail.CatalogsServingConfig("Preview", {
            servingConfigId: created.servingConfigId,
            catalog: created.catalog,
            displayName: "preview search updated",
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.displayName).toEqual("preview search updated");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:retail", "live"], timeout: 90_000 },
);
