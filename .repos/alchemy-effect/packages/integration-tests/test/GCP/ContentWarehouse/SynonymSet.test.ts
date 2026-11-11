import * as GCP from "@alchemy.run/gcp";
import { GcpEnvironment } from "@alchemy.run/gcp/Environment";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as cw from "@distilled.cloud/gcp/contentwarehouse_v1";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: GCP.providers() });

const logLevel = Effect.provideService(MinimumLogLevel, process.env.DEBUG ? "Debug" : "Info");

// Document AI Warehouse is disabled on the testing project: calls fail with
// ServiceDisabled "Document AI Warehouse API has not been used in project ...
// before or it is disabled" (the service also needs per-project
// provisioning). Set GCP_TEST_CONTENTWAREHOUSE=1 on a provisioned project.
const runLifecycle = !process.env.FAST && !!process.env.GCP_TEST_CONTENTWAREHOUSE;

const location = "us";

const waitUntilGone = (name: string) =>
  cw.getProjectsLocationsSynonymSets({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

// Skipped: the Content Warehouse endpoint answers every request with an HTML
// 502 after ~20s (Document AI Warehouse is being retired), so the
// ServiceDisabled probe can't complete.
test.provider.skip(
  "getProjectsLocationsSynonymSets without Document AI Warehouse enabled fails with ServiceDisabled",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      const parent = `projects/${project}/locations/${location}`;
      yield* stack.destroy();

      const error = yield* Effect.flip(
        cw.getProjectsLocationsSynonymSets({
          name: `${parent}/synonymSets/alchemy-missing-synonyms`,
        }),
      );
      expect(error._tag).toEqual("ServiceDisabled");

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:contentwarehouse", "live"],
    timeout: 90_000,
  },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete a synonym set",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      const parent = `projects/${project}/locations/${location}`;
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.ContentWarehouse.SynonymSet("Sales", {
            location,
            synonyms: [{ words: ["sale", "invoice", "bill"] }],
          });
        }),
      );

      expect(created.context).toEqual(expect.any(String));
      expect(created.name).toContain("/synonymSets/");
      expect(
        (created.synonyms ?? []).some((group) => (group.words ?? []).includes("invoice")),
      ).toEqual(true);

      const fetched = yield* cw.getProjectsLocationsSynonymSets({
        name: created.name,
      });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.synonyms).toEqual(created.synonyms);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.ContentWarehouse.SynonymSet("Sales", {
            context: created.context,
            location,
            synonyms: [
              { words: ["sale", "invoice", "bill", "order"] },
              { words: ["money", "credit"] },
            ],
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(
        (updated.synonyms ?? []).some((group) => (group.words ?? []).includes("order")),
      ).toEqual(true);
      expect(
        (updated.synonyms ?? []).some((group) => (group.words ?? []).includes("credit")),
      ).toEqual(true);

      yield* stack.destroy();
      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:contentwarehouse", "live"],
    timeout: 90_000,
  },
);
