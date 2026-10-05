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
  retail.getProjectsLocationsCatalogsControls({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "getProjectsLocationsCatalogsControls on a missing control fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;

      yield* stack.destroy();

      const error = yield* Effect.flip(
        retail.getProjectsLocationsCatalogsControls({
          name: `projects/${project}/locations/global/catalogs/default_catalog/controls/alchemy-missing`,
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
  "create, update, and delete a catalog control",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Retail.CatalogsControl("Greetings", {
            displayName: "greetings",
            synonyms: ["hello", "hi"],
          });
        }),
      );

      expect(created.name).toContain("/controls/");
      expect(created.synonyms).toEqual(expect.arrayContaining(["hello", "hi"]));

      const fetched = yield* retail.getProjectsLocationsCatalogsControls({
        name: created.name,
      });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.displayName).toEqual(created.displayName);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Retail.CatalogsControl("Greetings", {
            controlId: created.controlId,
            catalog: created.catalog,
            displayName: "greetings-updated",
            synonyms: ["hello", "hi", "hey"],
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.synonyms).toEqual(
        expect.arrayContaining(["hello", "hi", "hey"]),
      );

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:retail", "live"], timeout: 90_000 },
);
