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
  dataplex.getProjectsLocationsDataTaxonomiesAttributes({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider.skipIf(!process.env.GCP_TEST_DATATAXONOMY)(
  "create, update, and delete a data attribute",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const taxonomy = yield* GCP.Dataplex.DataTaxonomy("Pii", {
            location: "us-central1",
            displayName: "pii taxonomy",
            labels: { env: "test" },
          });
          const attribute = yield* GCP.Dataplex.DataTaxonomiesAttribute(
            "Email",
            {
              dataTaxonomy: taxonomy.name,
              displayName: "email",
              description: "email addresses",
              labels: { env: "test" },
            },
          );
          return { taxonomy, attribute };
        }),
      );

      expect(created.attribute.name).toContain("/attributes/");
      expect(created.attribute.dataTaxonomy).toEqual(created.taxonomy.name);
      expect(created.attribute.displayName).toEqual("email");
      expect(created.attribute.description).toEqual("email addresses");
      expect(created.attribute.labels).toMatchObject({ env: "test" });

      const fetched =
        yield* dataplex.getProjectsLocationsDataTaxonomiesAttributes({
          name: created.attribute.name,
        });
      expect(fetched.name).toEqual(created.attribute.name);
      expect(fetched.labels?.env).toEqual("test");
      expect(
        Object.keys(fetched.labels ?? {}).some((key) =>
          key.startsWith("alchemy-"),
        ),
      ).toEqual(true);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const taxonomy = yield* GCP.Dataplex.DataTaxonomy("Pii", {
            dataTaxonomyId: created.taxonomy.dataTaxonomyId,
            location: "us-central1",
            displayName: "pii taxonomy",
            labels: { env: "test" },
          });
          const attribute = yield* GCP.Dataplex.DataTaxonomiesAttribute(
            "Email",
            {
              dataTaxonomy: taxonomy.name,
              dataAttributeId: created.attribute.dataAttributeId,
              displayName: "email v2",
              description: "email addresses v2",
              labels: { env: "prod", class: "restricted" },
            },
          );
          return { taxonomy, attribute };
        }),
      );

      expect(updated.attribute.name).toEqual(created.attribute.name);
      expect(updated.attribute.displayName).toEqual("email v2");
      expect(updated.attribute.description).toEqual("email addresses v2");
      expect(updated.attribute.labels).toMatchObject({
        env: "prod",
        class: "restricted",
      });

      yield* stack.destroy();
      const gone = yield* waitUntilGone(created.attribute.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel, withDataplexSlot),
  { tags: ["provider:gcp", "provider:gcp:dataplex", "live"], timeout: 900_000 },
);
