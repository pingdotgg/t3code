import * as GCP from "@/GCP";
import { GcpEnvironment } from "@/GCP/Environment";
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

// Attribute bindings hang off sunset data taxonomies, whose creates fail with
// InternalServerError "An internal error has occurred". Set
// GCP_TEST_DATAPLEX_DATA_ATTRIBUTE_BINDING=1 on a project that still has them.
const runLifecycle =
  process.env.GCP_TEST_DATAPLEX_DATA_ATTRIBUTE_BINDING === "1";

const waitUntilGone = (name: string) =>
  dataplex.getProjectsLocationsDataAttributeBindings({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "getProjectsLocationsDataAttributeBindings on a missing binding fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      yield* stack.destroy();

      const error = yield* Effect.flip(
        dataplex.getProjectsLocationsDataAttributeBindings({
          name: `projects/${project}/locations/us-central1/dataAttributeBindings/alchemy-missing-binding`,
        }),
      );
      expect(error._tag).toEqual("NotFound");

      yield* stack.destroy();
    }).pipe(logLevel, withDataplexSlot),
  { tags: ["provider:gcp", "provider:gcp:dataplex", "live"], timeout: 900_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete a data attribute binding",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Dataplex.DataAttributeBinding("Pii", {
            location: "us-central1",
            displayName: "pii bind",
            description: "binding a",
            labels: { env: "test" },
          });
        }),
      );

      expect(created.name).toContain("/dataAttributeBindings/");
      expect(created.dataAttributeBindingId).toEqual(expect.any(String));
      expect(created.labels).toMatchObject({ env: "test" });

      const fetched = yield* dataplex.getProjectsLocationsDataAttributeBindings(
        { name: created.name },
      );
      expect(fetched.name).toEqual(created.name);
      expect(
        Object.keys(fetched.labels ?? {}).some((key) =>
          key.startsWith("alchemy-"),
        ),
      ).toEqual(true);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Dataplex.DataAttributeBinding("Pii", {
            dataAttributeBindingId: created.dataAttributeBindingId,
            location: "us-central1",
            displayName: "pii bind prod",
            description: "binding b",
            labels: { env: "prod", team: "data" },
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.displayName).toEqual("pii bind prod");
      expect(updated.labels).toMatchObject({ env: "prod", team: "data" });

      yield* stack.destroy();
      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel, withDataplexSlot),
  { tags: ["provider:gcp", "provider:gcp:dataplex", "live"], timeout: 900_000 },
);
