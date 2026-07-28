import * as AWS from "@/AWS";
import { ParameterGroup } from "@/AWS/DAX";
import * as Test from "@/Test/Alchemy";
import * as dax from "@distilled.cloud/aws/dax";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: AWS.providers() });

// Ungated typed-error probe: prove the distilled error union carries the
// not-found tag this provider's read/delete paths depend on.
test.provider(
  "describeParameterGroups on a nonexistent group fails with ParameterGroupNotFoundFault",
  () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        dax.describeParameterGroups({
          ParameterGroupNames: ["alchemy-nonexistent-dax-params-probe"],
        }),
      );
      expect(error._tag).toBe("ParameterGroupNotFoundFault");
    }),
);

const readParameterValue = (groupName: string, parameterName: string) =>
  dax
    .describeParameters({ ParameterGroupName: groupName })
    .pipe(
      Effect.map(
        (response) =>
          (response.Parameters ?? []).find(
            (p) => p.ParameterName === parameterName,
          )?.ParameterValue,
      ),
    );

const assertGone = (name: string) =>
  dax.describeParameterGroups({ ParameterGroupNames: [name] }).pipe(
    Effect.flatMap(() =>
      Effect.fail(new Error(`parameter group '${name}' still exists`)),
    ),
    Effect.catchTag("ParameterGroupNotFoundFault", () => Effect.void),
    Effect.retry({
      schedule: Schedule.max([
        Schedule.fixed("2 seconds"),
        Schedule.recurs(10),
      ]),
    }),
  );

test.provider(
  "create, update parameters, delete a DAX parameter group",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group } = yield* stack.deploy(
        Effect.gen(function* () {
          const group = yield* ParameterGroup("Params", {
            description: "alchemy dax parameter group",
            parameters: { "query-ttl-millis": "60000" },
          });
          return { group };
        }),
      );

      expect(group.parameterGroupName).toBeDefined();
      expect(group.parameters["query-ttl-millis"]).toBe("60000");

      // Out-of-band verification via distilled.
      const observedValue = yield* readParameterValue(
        group.parameterGroupName,
        "query-ttl-millis",
      );
      expect(observedValue).toBe("60000");

      // Update a parameter value and add a second override in place.
      const { group: updated } = yield* stack.deploy(
        Effect.gen(function* () {
          const group = yield* ParameterGroup("Params", {
            description: "alchemy dax parameter group",
            parameters: {
              "query-ttl-millis": "120000",
              "record-ttl-millis": "300000",
            },
          });
          return { group };
        }),
      );
      expect(updated.parameterGroupName).toBe(group.parameterGroupName);
      expect(updated.parameters["query-ttl-millis"]).toBe("120000");
      expect(updated.parameters["record-ttl-millis"]).toBe("300000");

      const requeried = yield* readParameterValue(
        group.parameterGroupName,
        "query-ttl-millis",
      );
      expect(requeried).toBe("120000");

      yield* stack.destroy();
      yield* assertGone(group.parameterGroupName);
    }),
  { timeout: 240_000 },
);
