import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as datamigration from "@distilled.cloud/gcp/datamigration_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { logLevel, currentProject, waitUntilGone } from "./common.ts";

const { test } = Test.make({ providers: GCP.providers() });

test.provider(
  "getProjectsLocationsConversionWorkspacesMappingRules on a missing rule fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      const project = yield* currentProject;

      yield* stack.destroy();

      const error = yield* Effect.flip(
        datamigration.getProjectsLocationsConversionWorkspacesMappingRules({
          name: `projects/${project}/locations/us-central1/conversionWorkspaces/alchemy-missing-workspace/mappingRules/alchemy-missing-rule`,
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
  "create and delete a conversion workspace mapping rule",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const workspace = yield* GCP.DataMigration.ConversionWorkspace(
            "OracleToPg",
            {
              location: "us-central1",
              displayName: "rule-workspace",
              source: { engine: "ORACLE", version: "11" },
              destination: { engine: "POSTGRESQL", version: "14" },
            },
          );
          const rule = yield* GCP.DataMigration.ConversionWorkspacesMappingRule(
            "Rename",
            {
              conversionWorkspace: workspace.name,
              location: "us-central1",
              displayName: "rename-schema",
              ruleScope: "DATABASE_ENTITY_TYPE_SCHEMA",
              ruleOrder: "1000",
              filter: { entities: ["src_schema"] },
              singleEntityRename: { newName: "dst_schema" },
            },
          );
          return { workspace, rule };
        }),
      );

      expect(created.rule.mappingRuleId).toEqual(expect.any(String));
      expect(created.rule.name).toEqual(
        `${created.workspace.name}/mappingRules/${created.rule.mappingRuleId}`,
      );
      expect(created.rule.conversionWorkspace).toEqual(created.workspace.name);
      expect(created.rule.displayName).toEqual("rename-schema");
      expect(created.rule.ruleScope).toEqual("DATABASE_ENTITY_TYPE_SCHEMA");
      expect(created.rule.singleEntityRename?.newName).toEqual("dst_schema");

      const fetched =
        yield* datamigration.getProjectsLocationsConversionWorkspacesMappingRules(
          { name: created.rule.name },
        );
      // The API omits `name` from mapping rules; the fetch by name is the check.
      expect(fetched.ruleScope).toEqual("DATABASE_ENTITY_TYPE_SCHEMA");
      expect(fetched.displayName).toMatch(/^\[(alchemy|alc) /);
      expect(fetched.singleEntityRename?.newName).toEqual("dst_schema");
      expect(fetched.filter?.entities).toContain("src_schema");

      yield* stack.destroy();
      const gone = yield* waitUntilGone(
        datamigration.getProjectsLocationsConversionWorkspacesMappingRules({
          name: created.rule.name,
        }),
      );
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:datamigration", "live"],
    timeout: 90_000,
  },
);
