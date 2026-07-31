import * as AWS from "@/AWS";
import { ClusterParameterGroup } from "@/AWS/Redshift";
import * as Test from "@/Test/Alchemy";
import * as redshift from "@distilled.cloud/aws/redshift";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";

const { test } = Test.make({ providers: AWS.providers() });

// Ungated typed-error probe: proves the distilled error union carries the
// not-found tag this provider's read/delete paths depend on.
test.provider(
  "describeClusterParameterGroups on a nonexistent group fails with ClusterParameterGroupNotFoundFault",
  () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        redshift.describeClusterParameterGroups({
          ParameterGroupName: "alchemy-nonexistent-redshift-cpg-probe",
        }),
      );
      expect(error._tag).toBe("ClusterParameterGroupNotFoundFault");
    }),
);

// Read the user-sourced parameter overrides out-of-band.
const readUserParameters = (name: string) =>
  Effect.gen(function* () {
    const response = yield* redshift.describeClusterParameters({
      ParameterGroupName: name,
      Source: "user",
    });
    return Object.fromEntries(
      (response.Parameters ?? []).flatMap((p) =>
        p.ParameterName !== undefined && p.ParameterValue !== undefined
          ? [[p.ParameterName, p.ParameterValue]]
          : [],
      ),
    );
  });

test.provider(
  "create with parameters, update/reset parameters, destroy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      // Create with two parameter overrides.
      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* ClusterParameterGroup("Params", {
            family: "redshift-1.0",
            parameters: {
              enable_user_activity_logging: "true",
              statement_timeout: "60000",
            },
            tags: { fixture: "redshift-parameter-group" },
          });
        }),
      );

      expect(created.clusterParameterGroupName).toBeDefined();
      expect(created.clusterParameterGroupArn).toContain(":parametergroup:");
      expect(created.family).toBe("redshift-1.0");
      expect(created.parameters).toEqual({
        enable_user_activity_logging: "true",
        statement_timeout: "60000",
      });

      // Out-of-band verification via distilled.
      const observedParams = yield* readUserParameters(
        created.clusterParameterGroupName,
      );
      expect(observedParams).toEqual({
        enable_user_activity_logging: "true",
        statement_timeout: "60000",
      });
      const observed = yield* redshift.describeClusterParameterGroups({
        ParameterGroupName: created.clusterParameterGroupName,
      });
      expect(
        observed.ParameterGroups?.[0]?.Tags?.some(
          (t) => t.Key === "fixture" && t.Value === "redshift-parameter-group",
        ),
      ).toBe(true);

      // Update — change one value, drop the other (reset to engine
      // default), keep the same name/family/description so it's in-place.
      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* ClusterParameterGroup("Params", {
            family: "redshift-1.0",
            parameters: { statement_timeout: "120000" },
            tags: { fixture: "redshift-parameter-group" },
          });
        }),
      );

      expect(updated.clusterParameterGroupName).toBe(
        created.clusterParameterGroupName,
      );
      expect(updated.parameters).toEqual({ statement_timeout: "120000" });

      const reobservedParams = yield* readUserParameters(
        created.clusterParameterGroupName,
      );
      expect(reobservedParams).toEqual({ statement_timeout: "120000" });

      // Destroy and verify gone with the typed not-found tag.
      yield* stack.destroy();
      const error = yield* Effect.flip(
        redshift.describeClusterParameterGroups({
          ParameterGroupName: created.clusterParameterGroupName,
        }),
      );
      expect(error._tag).toBe("ClusterParameterGroupNotFoundFault");
    }),
  { timeout: 120_000 },
);

test.provider(
  "changing the family replaces the parameter group",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      // Engine-generated name so the replacement can create the new group
      // under a fresh physical name before deleting the old one.
      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* ClusterParameterGroup("ReplaceParams", {
            family: "redshift-1.0",
            description: "before replacement",
          });
        }),
      );
      expect(created.description).toBe("before replacement");

      // Description is create-only — changing it must replace.
      const replaced = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* ClusterParameterGroup("ReplaceParams", {
            family: "redshift-1.0",
            description: "after replacement",
          });
        }),
      );
      expect(replaced.description).toBe("after replacement");
      expect(replaced.clusterParameterGroupName).not.toBe(
        created.clusterParameterGroupName,
      );

      // Old group is gone, new group exists.
      const oldGone = yield* Effect.flip(
        redshift.describeClusterParameterGroups({
          ParameterGroupName: created.clusterParameterGroupName,
        }),
      );
      expect(oldGone._tag).toBe("ClusterParameterGroupNotFoundFault");
      const observed = yield* redshift.describeClusterParameterGroups({
        ParameterGroupName: replaced.clusterParameterGroupName,
      });
      expect(observed.ParameterGroups?.[0]?.Description).toBe(
        "after replacement",
      );

      yield* stack.destroy();
      const error = yield* Effect.flip(
        redshift.describeClusterParameterGroups({
          ParameterGroupName: replaced.clusterParameterGroupName,
        }),
      );
      expect(error._tag).toBe("ClusterParameterGroupNotFoundFault");
    }),
  { timeout: 120_000 },
);
