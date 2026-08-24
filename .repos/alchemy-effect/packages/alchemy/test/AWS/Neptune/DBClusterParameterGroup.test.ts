import * as AWS from "@/AWS";
import { DBClusterParameterGroup } from "@/AWS/Neptune";
import * as Test from "@/Test/Alchemy";
import * as neptune from "@distilled.cloud/aws/neptune";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";

const { test } = Test.make({ providers: AWS.providers() });

const assertGone = (name: string) =>
  neptune
    .describeDBClusterParameterGroups({ DBClusterParameterGroupName: name })
    .pipe(
      Effect.flatMap(() =>
        Effect.fail(new Error(`parameter group '${name}' still exists`)),
      ),
      Effect.catchTag("DBParameterGroupNotFoundFault", () => Effect.void),
      Effect.retry({
        schedule: Schedule.max([
          Schedule.fixed("2 seconds"),
          Schedule.recurs(10),
        ]),
      }),
    );

const readUserParameters = (name: string) =>
  neptune.describeDBClusterParameters
    .pages({ DBClusterParameterGroupName: name, Source: "user" })
    .pipe(
      Stream.runCollect,
      Effect.map((chunk) =>
        Array.from(chunk).flatMap((page) => page.Parameters ?? []),
      ),
    );

test.provider(
  "create, modify parameters, reset, delete a Neptune cluster parameter group",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group } = yield* stack.deploy(
        Effect.gen(function* () {
          const group = yield* DBClusterParameterGroup("Params", {
            family: "neptune1.4",
            description: "alchemy neptune cluster params",
            parameters: { neptune_query_timeout: "180000" },
            tags: { fixture: "neptune-cluster-params" },
          });
          return { group };
        }),
      );

      expect(group.dbClusterParameterGroupName).toBeDefined();
      expect(group.dbClusterParameterGroupArn).toContain(":cluster-pg:");
      expect(group.family).toBe("neptune1.4");
      expect(group.parameters).toEqual({ neptune_query_timeout: "180000" });

      // Out-of-band verification: the override is recorded as a user param.
      const userParams = yield* readUserParameters(
        group.dbClusterParameterGroupName,
      );
      expect(
        userParams.find((p) => p.ParameterName === "neptune_query_timeout")
          ?.ParameterValue,
      ).toBe("180000");

      // Update the parameter value in place.
      const { group: updated } = yield* stack.deploy(
        Effect.gen(function* () {
          const group = yield* DBClusterParameterGroup("Params", {
            family: "neptune1.4",
            description: "alchemy neptune cluster params",
            parameters: { neptune_query_timeout: "60000" },
            tags: { fixture: "neptune-cluster-params" },
          });
          return { group };
        }),
      );
      expect(updated.dbClusterParameterGroupName).toBe(
        group.dbClusterParameterGroupName,
      );
      const updatedParams = yield* readUserParameters(
        group.dbClusterParameterGroupName,
      );
      expect(
        updatedParams.find((p) => p.ParameterName === "neptune_query_timeout")
          ?.ParameterValue,
      ).toBe("60000");

      // Remove the override — the provider resets it to the engine default.
      yield* stack.deploy(
        Effect.gen(function* () {
          const group = yield* DBClusterParameterGroup("Params", {
            family: "neptune1.4",
            description: "alchemy neptune cluster params",
            tags: { fixture: "neptune-cluster-params" },
          });
          return { group };
        }),
      );
      const resetParams = yield* readUserParameters(
        group.dbClusterParameterGroupName,
      );
      expect(
        resetParams.find((p) => p.ParameterName === "neptune_query_timeout"),
      ).toBeUndefined();

      yield* stack.destroy();
      yield* assertGone(group.dbClusterParameterGroupName);
    }),
  { timeout: 240_000 },
);
