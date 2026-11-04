import { describe, expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import { DuplicateLogicalIdError } from "@/Resource";
import { Bucket, Queue, TestLayers } from "./test.resources.ts";

const { test } = Test.make({ providers: TestLayers() });

describe("logical ids", { tags: ["unit", "local"] }, () => {
  test.provider("a second type under the same logical id dies", (stack) =>
    Effect.gen(function* () {
      const exit = yield* Effect.gen(function* () {
        yield* Bucket("Thing", { name: "topic" });
        yield* Queue("Thing", { name: "queue" });
        return {};
      }).pipe(stack.deploy, Effect.exit);

      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const defects = exit.cause.reasons.flatMap((reason) =>
          reason._tag === "Die" && reason.defect instanceof DuplicateLogicalIdError
            ? [reason.defect]
            : [],
        );
        const duplicate = defects.find((defect) => defect._tag === "DuplicateLogicalIdError");
        expect(duplicate?.fqn).toEqual("Thing");
        expect(duplicate?.existingType).toEqual("Test.Bucket");
        expect(duplicate?.conflictingType).toEqual("Test.Queue");
        expect(duplicate?.message).toContain("'Thing'");
        expect(duplicate?.message).toContain("'Test.Bucket'");
        expect(duplicate?.message).toContain("'Test.Queue'");
      }
    }),
  );

  test.provider("yielding the same logical id returns the registered resource", (stack) =>
    Effect.gen(function* () {
      const output = yield* Effect.gen(function* () {
        const first = yield* Bucket("Thing", { name: "a" });
        const again = yield* Bucket("Thing", { name: "a" });
        const reference = yield* Bucket("Thing");
        return { first, again, reference };
      }).pipe(stack.deploy);

      expect(output.again).toBe(output.first);
      expect(output.reference).toBe(output.first);

      yield* stack.destroy();
    }),
  );
});
