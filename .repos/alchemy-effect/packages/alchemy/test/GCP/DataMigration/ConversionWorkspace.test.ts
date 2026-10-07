import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as datamigration from "@distilled.cloud/gcp/datamigration_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { logLevel, currentProject, waitUntilGone } from "./common.ts";

const { test } = Test.make({ providers: GCP.providers() });

test.provider(
  "getProjectsLocationsConversionWorkspaces on a missing workspace fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      const project = yield* currentProject;

      yield* stack.destroy();

      const error = yield* Effect.flip(
        datamigration.getProjectsLocationsConversionWorkspaces({
          name: `projects/${project}/locations/us-central1/conversionWorkspaces/alchemy-missing-workspace`,
        }),
      );
      expect(error._tag).toEqual("NotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:datamigration", "live"],
    timeout: 90_000,
  },
);

test.provider(
  "create, update, and delete a conversion workspace",
  (stack) =>
    Effect.gen(function* () {
      const project = yield* currentProject;

      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.DataMigration.ConversionWorkspace("OracleToPg", {
            location: "us-central1",
            displayName: "oracle-to-pg",
            source: { engine: "ORACLE", version: "11" },
            destination: { engine: "POSTGRESQL", version: "14" },
            globalSettings: { skip_triggers: "false" },
          });
        }),
      );

      expect(created.conversionWorkspaceId).toEqual(expect.any(String));
      expect(created.name).toEqual(
        `projects/${project}/locations/us-central1/conversionWorkspaces/${created.conversionWorkspaceId}`,
      );
      expect(created.location).toEqual("us-central1");
      expect(created.displayName).toEqual("oracle-to-pg");
      expect(created.source?.engine).toEqual("ORACLE");
      expect(created.destination?.engine).toEqual("POSTGRESQL");
      expect(created.globalSettings).toMatchObject({ skip_triggers: "false" });

      const fetched =
        yield* datamigration.getProjectsLocationsConversionWorkspaces({
          name: created.name,
        });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.displayName).toMatch(/^\[(alchemy|alc) /);
      expect(fetched.displayName).toContain("oracle-to-pg");
      expect(fetched.source?.engine).toEqual("ORACLE");
      expect(fetched.destination?.version).toEqual("14");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.DataMigration.ConversionWorkspace("OracleToPg", {
            conversionWorkspaceId: created.conversionWorkspaceId,
            location: "us-central1",
            displayName: "oracle-to-pg-v2",
            source: { engine: "ORACLE", version: "11" },
            destination: { engine: "POSTGRESQL", version: "14" },
            globalSettings: { skip_triggers: "true" },
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.displayName).toEqual("oracle-to-pg-v2");
      expect(updated.globalSettings).toMatchObject({ skip_triggers: "true" });

      const fetchedUpdate =
        yield* datamigration.getProjectsLocationsConversionWorkspaces({
          name: updated.name,
        });
      expect(fetchedUpdate.displayName).toContain("oracle-to-pg-v2");
      expect(fetchedUpdate.globalSettings?.skip_triggers).toEqual("true");

      yield* stack.destroy();
      const gone = yield* waitUntilGone(
        datamigration.getProjectsLocationsConversionWorkspaces({
          name: created.name,
        }),
      );
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:datamigration", "live"],
    timeout: 90_000,
  },
);
