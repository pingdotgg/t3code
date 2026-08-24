import * as AWS from "@/AWS";
import { ParameterGroup } from "@/AWS/MemoryDB";
import * as Test from "@/Test/Alchemy";
import * as memorydb from "@distilled.cloud/aws/memorydb";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: AWS.providers() });

// Ungated typed-error probe: proves the distilled error union carries the
// not-found tag this provider's read/delete paths depend on.
test.provider(
  "describeParameterGroups on a nonexistent group fails with ParameterGroupNotFoundFault",
  () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        memorydb.describeParameterGroups({
          ParameterGroupName: "alchemy-nonexistent-memorydb-params-probe",
        }),
      );
      expect(error._tag).toBe("ParameterGroupNotFoundFault");
    }),
);

const readParameterValue = (name: string, parameter: string) =>
  Effect.gen(function* () {
    const page = yield* memorydb.describeParameters({
      ParameterGroupName: name,
    });
    return page.Parameters?.find((p) => p.Name === parameter)?.Value;
  });

// Deleting can transiently reject while the group settles after an update.
const assertGroupGone = (name: string) =>
  memorydb.describeParameterGroups({ ParameterGroupName: name }).pipe(
    Effect.flatMap(() =>
      Effect.fail(new Error(`parameter group '${name}' still exists`)),
    ),
    Effect.catchTag("ParameterGroupNotFoundFault", () => Effect.void),
    Effect.retry({
      schedule: Schedule.max([
        Schedule.fixed("5 seconds"),
        Schedule.recurs(12),
      ]),
    }),
  );

test.provider(
  "create parameter group, update a parameter, reset it, destroy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      // 1. Create with one override.
      const created = yield* stack
        .deploy(
          Effect.gen(function* () {
            const group = yield* ParameterGroup("Params", {
              family: "memorydb_valkey7",
              description: "alchemy memorydb parameter group fixture",
              parameters: { "maxmemory-policy": "allkeys-lru" },
              tags: { fixture: "memorydb-parameter-group" },
            });
            return { group };
          }),
        )
        .pipe(Effect.map(({ group }) => group));

      expect(created.parameterGroupName).toBeDefined();
      expect(created.parameterGroupArn).toContain(":parametergroup/");
      expect(created.family).toBe("memorydb_valkey7");

      // Out-of-band: the override was applied.
      const applied = yield* readParameterValue(
        created.parameterGroupName,
        "maxmemory-policy",
      );
      expect(applied).toBe("allkeys-lru");

      // 2. Update the override value.
      yield* stack.deploy(
        Effect.gen(function* () {
          const group = yield* ParameterGroup("Params", {
            family: "memorydb_valkey7",
            description: "alchemy memorydb parameter group fixture",
            parameters: { "maxmemory-policy": "volatile-lru" },
            tags: { fixture: "memorydb-parameter-group" },
          });
          return { group };
        }),
      );
      const updated = yield* readParameterValue(
        created.parameterGroupName,
        "maxmemory-policy",
      );
      expect(updated).toBe("volatile-lru");

      // 3. Remove the override — it resets to the engine default.
      yield* stack.deploy(
        Effect.gen(function* () {
          const group = yield* ParameterGroup("Params", {
            family: "memorydb_valkey7",
            description: "alchemy memorydb parameter group fixture",
            tags: { fixture: "memorydb-parameter-group" },
          });
          return { group };
        }),
      );
      const reset = yield* readParameterValue(
        created.parameterGroupName,
        "maxmemory-policy",
      );
      expect(reset).toBe("noeviction");

      // 4. Destroy and verify out-of-band it is gone.
      yield* stack.destroy();
      yield* assertGroupGone(created.parameterGroupName);
    }),
  { timeout: 300_000 },
);
