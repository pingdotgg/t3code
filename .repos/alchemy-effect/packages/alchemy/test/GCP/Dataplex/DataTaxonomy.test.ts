import * as GCP from "@/GCP";
import { GcpEnvironment } from "@/GCP/Environment";
import * as Test from "@/Test/Alchemy";
import * as dataplex from "@distilled.cloud/gcp/dataplex_v1";
import * as GcpRetry from "@distilled.cloud/gcp/Retry";
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
  dataplex.getProjectsLocationsDataTaxonomies({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "creating a data taxonomy returns InternalServerError (API sunset)",
  () =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      const error = yield* Effect.flip(
        dataplex
          .createProjectsLocationsDataTaxonomies({
            parent: `projects/${project}/locations/us-central1`,
            dataTaxonomyId: "alchemy-probe-taxonomy",
            validateOnly: true,
            body: { displayName: "probe" },
          })
          .pipe(GcpRetry.none),
      );
      expect(error._tag).toEqual("InternalServerError");
    }).pipe(logLevel, withDataplexSlot),
  { tags: ["provider:gcp", "provider:gcp:dataplex", "live"], timeout: 900_000 },
);

// Data taxonomies are sunset: creates fail with InternalServerError (probe
// above). Set GCP_TEST_DATATAXONOMY=1 on a project that still has access.
test.provider.skipIf(!process.env.GCP_TEST_DATATAXONOMY)(
  "create, update, and delete a data taxonomy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Dataplex.DataTaxonomy("Pii", {
            location: "us-central1",
            displayName: "pii a",
            description: "taxonomy a",
            labels: { env: "test" },
          });
        }),
      );

      expect(created.name).toContain("/dataTaxonomies/");
      expect(created.dataTaxonomyId).toEqual(expect.any(String));
      expect(created.location).toEqual("us-central1");
      expect(created.displayName).toEqual("pii a");
      expect(created.description).toEqual("taxonomy a");
      expect(created.labels).toMatchObject({ env: "test" });

      const fetched = yield* dataplex.getProjectsLocationsDataTaxonomies({
        name: created.name,
      });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.labels?.env).toEqual("test");
      expect(
        Object.keys(fetched.labels ?? {}).some((key) =>
          key.startsWith("alchemy-"),
        ),
      ).toEqual(true);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Dataplex.DataTaxonomy("Pii", {
            dataTaxonomyId: created.dataTaxonomyId,
            location: "us-central1",
            displayName: "pii b",
            description: "taxonomy b",
            labels: { env: "prod", team: "data" },
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.displayName).toEqual("pii b");
      expect(updated.description).toEqual("taxonomy b");
      expect(updated.labels).toMatchObject({ env: "prod", team: "data" });

      yield* stack.destroy();
      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel, withDataplexSlot),
  { tags: ["provider:gcp", "provider:gcp:dataplex", "live"], timeout: 900_000 },
);
