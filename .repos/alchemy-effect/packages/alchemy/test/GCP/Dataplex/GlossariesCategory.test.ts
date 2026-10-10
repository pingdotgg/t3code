import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as dataplex from "@distilled.cloud/gcp/dataplex_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import { withDataplexSlot } from "./quota.ts";

const { test } = Test.make({ providers: GCP.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const waitUntilGone = (name: string) =>
  dataplex.getProjectsLocationsGlossariesCategories({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider.skipIf(!!process.env.FAST)(
  "create, update, and delete a glossary category",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const glossary = yield* GCP.Dataplex.Glossary("BusinessTerms", {
            location: "us-central1",
            displayName: "glossary",
            labels: { env: "test" },
          });
          const category = yield* GCP.Dataplex.GlossariesCategory("Finance", {
            glossary: glossary.name,
            displayName: "finance",
            description: "finance terms",
            labels: { env: "test" },
          });
          return { glossary, category };
        }),
      );

      expect(created.category.name).toContain("/categories/");
      expect(created.category.glossary).toEqual(created.glossary.name);
      expect(created.category.displayName).toEqual("finance");
      expect(created.category.description).toEqual("finance terms");
      expect(created.category.labels).toMatchObject({ env: "test" });
      expect(created.category.parent).toEqual(created.glossary.name);

      const fetched = yield* dataplex.getProjectsLocationsGlossariesCategories({
        name: created.category.name,
      });
      expect(fetched.name).toEqual(created.category.name);
      expect(fetched.labels?.env).toEqual("test");
      expect(
        Object.keys(fetched.labels ?? {}).some((key) =>
          key.startsWith("alchemy-"),
        ),
      ).toEqual(true);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const glossary = yield* GCP.Dataplex.Glossary("BusinessTerms", {
            glossaryId: created.glossary.glossaryId,
            location: "us-central1",
            displayName: "glossary",
            labels: { env: "test" },
          });
          const category = yield* GCP.Dataplex.GlossariesCategory("Finance", {
            glossary: glossary.name,
            categoryId: created.category.categoryId,
            displayName: "finance v2",
            description: "finance terms v2",
            labels: { env: "prod", team: "data" },
          });
          return { glossary, category };
        }),
      );

      expect(updated.category.name).toEqual(created.category.name);
      expect(updated.category.displayName).toEqual("finance v2");
      expect(updated.category.description).toEqual("finance terms v2");
      expect(updated.category.labels).toMatchObject({
        env: "prod",
        team: "data",
      });

      yield* stack.destroy();
      const gone = yield* waitUntilGone(created.category.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel, withDataplexSlot),
  { tags: ["provider:gcp", "provider:gcp:dataplex", "live"], timeout: 900_000 },
);
