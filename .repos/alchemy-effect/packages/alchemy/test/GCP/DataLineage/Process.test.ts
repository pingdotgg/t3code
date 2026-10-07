import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as datalineage from "@distilled.cloud/gcp/datalineage_v1";
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

const waitUntilGone = (name: string) =>
  datalineage.getProjectsLocationsProcesses({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "getProjectsLocationsProcesses on a missing process fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;

      yield* stack.destroy();

      const error = yield* Effect.flip(
        datalineage.getProjectsLocationsProcesses({
          name: `projects/${project}/locations/us-central1/processes/alchemy-missing-process`,
        }),
      );
      expect(error._tag).toEqual("NotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:datalineage", "live"],
    timeout: 90_000,
  },
);

test.provider.skipIf(!!process.env.FAST)(
  "create, update, and delete a lineage process",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.DataLineage.Process("Etl", {
            location: "us-central1",
            displayName: "etl a",
            origin: { sourceType: "CUSTOM", name: "alchemy" },
            attributes: { env: "test" },
          });
        }),
      );

      expect(created.name).toContain("/processes/");
      expect(created.processId).toEqual(expect.any(String));
      expect(created.location).toEqual("us-central1");
      expect(created.displayName).toEqual("etl a");
      expect(created.origin?.sourceType).toEqual("CUSTOM");
      expect(created.attributes).toMatchObject({ env: "test" });

      const fetched = yield* datalineage.getProjectsLocationsProcesses({
        name: created.name,
      });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.displayName).toEqual("etl a");
      expect(fetched.attributes?.env).toEqual("test");
      expect(
        Object.keys(fetched.attributes ?? {}).some((key) =>
          key.startsWith("alchemy-"),
        ),
      ).toEqual(true);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.DataLineage.Process("Etl", {
            processId: created.processId,
            location: "us-central1",
            displayName: "etl b",
            origin: { sourceType: "CUSTOM", name: "dbt" },
            attributes: { env: "prod", team: "data" },
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.displayName).toEqual("etl b");
      expect(updated.origin?.name).toEqual("dbt");
      expect(updated.attributes).toMatchObject({ env: "prod", team: "data" });

      yield* stack.destroy();
      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:datalineage", "live"],
    timeout: 90_000,
  },
);
