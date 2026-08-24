import * as AWS from "@/AWS";
import { DBParameterGroup } from "@/AWS/Neptune";
import * as Test from "@/Test/Alchemy";
import * as neptune from "@distilled.cloud/aws/neptune";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";

const { test } = Test.make({ providers: AWS.providers() });

const assertGone = (name: string) =>
  neptune.describeDBParameterGroups({ DBParameterGroupName: name }).pipe(
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
  neptune.describeDBParameters
    .pages({ DBParameterGroupName: name, Source: "user" })
    .pipe(
      Stream.runCollect,
      Effect.map((chunk) =>
        Array.from(chunk).flatMap((page) => page.Parameters ?? []),
      ),
    );

test.provider(
  "create, modify parameters, reset, delete a Neptune DB parameter group",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group } = yield* stack.deploy(
        Effect.gen(function* () {
          const group = yield* DBParameterGroup("InstanceParams", {
            family: "neptune1.4",
            description: "alchemy neptune instance params",
            parameters: { neptune_query_timeout: "180000" },
            tags: { fixture: "neptune-instance-params" },
          });
          return { group };
        }),
      );

      expect(group.dbParameterGroupName).toBeDefined();
      expect(group.dbParameterGroupArn).toContain(":pg:");
      expect(group.family).toBe("neptune1.4");
      expect(group.parameters).toEqual({ neptune_query_timeout: "180000" });

      // Out-of-band verification: the override is recorded as a user param.
      const userParams = yield* readUserParameters(group.dbParameterGroupName);
      expect(
        userParams.find((p) => p.ParameterName === "neptune_query_timeout")
          ?.ParameterValue,
      ).toBe("180000");

      // Update the parameter value in place.
      const { group: updated } = yield* stack.deploy(
        Effect.gen(function* () {
          const group = yield* DBParameterGroup("InstanceParams", {
            family: "neptune1.4",
            description: "alchemy neptune instance params",
            parameters: { neptune_query_timeout: "60000" },
            tags: { fixture: "neptune-instance-params" },
          });
          return { group };
        }),
      );
      expect(updated.dbParameterGroupName).toBe(group.dbParameterGroupName);
      const updatedParams = yield* readUserParameters(
        group.dbParameterGroupName,
      );
      expect(
        updatedParams.find((p) => p.ParameterName === "neptune_query_timeout")
          ?.ParameterValue,
      ).toBe("60000");

      // Remove the override — the provider resets it to the engine default.
      yield* stack.deploy(
        Effect.gen(function* () {
          const group = yield* DBParameterGroup("InstanceParams", {
            family: "neptune1.4",
            description: "alchemy neptune instance params",
            tags: { fixture: "neptune-instance-params" },
          });
          return { group };
        }),
      );
      const resetParams = yield* readUserParameters(group.dbParameterGroupName);
      expect(
        resetParams.find((p) => p.ParameterName === "neptune_query_timeout"),
      ).toBeUndefined();

      yield* stack.destroy();
      yield* assertGone(group.dbParameterGroupName);
    }),
  { timeout: 240_000 },
);
