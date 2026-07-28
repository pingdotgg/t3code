import * as AWS from "@/AWS";
import { Memory } from "@/AWS/BedrockAgentCore";
import * as Test from "@/Test/Alchemy";
import * as control from "@distilled.cloud/aws/bedrock-agentcore-control";
import { expect } from "alchemy-test";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: AWS.providers() });

// Ungated typed-error probe: prove the distilled error union carries the
// not-found tag this provider's read/delete paths depend on.
test.provider(
  "getMemory on a nonexistent id fails with ResourceNotFoundException",
  () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        control.getMemory({
          memoryId: "alchemy_nonexistent_probe-0000000000",
        }),
      );
      expect(error._tag).toBe("ResourceNotFoundException");
    }),
);

const assertMemoryGone = (memoryId: string) =>
  Effect.gen(function* () {
    const status = yield* control.getMemory({ memoryId }).pipe(
      Effect.map((r) => r.memory.status as string),
      Effect.catchTag("ResourceNotFoundException", () =>
        Effect.succeed("GONE" as string),
      ),
    );
    if (status !== "GONE") {
      return yield* Effect.fail(
        new Error(`memory still exists (status: ${status})`),
      );
    }
  }).pipe(
    Effect.retry({
      schedule: Schedule.max([
        Schedule.fixed("5 seconds"),
        Schedule.recurs(18),
      ]),
    }),
  );

// A memory takes ~2.5 minutes to reach ACTIVE — the full lifecycle is gated
// behind AWS_TEST_SLOW to keep the default CI pass fast. The create path is
// also exercised (gated) by the Bindings fixture.
test.provider.skipIf(!process.env.AWS_TEST_SLOW)(
  "create short-term memory, verify, update expiry, destroy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deployMemory = (eventExpiryDuration: Duration.Input) =>
        Effect.gen(function* () {
          const memory = yield* Memory("SessionMemory", {
            eventExpiryDuration,
            tags: { fixture: "agentcore-memory" },
          });
          return { memory };
        });

      const { memory } = yield* stack.deploy(deployMemory("7 days"));

      expect(memory.memoryId).toBeTruthy();
      expect(memory.memoryArn).toContain(":memory/");
      expect(memory.status).toBe("ACTIVE");

      // out-of-band verification via distilled
      const observed = yield* control.getMemory({
        memoryId: memory.memoryId,
      });
      expect(observed.memory.status).toBe("ACTIVE");
      expect(observed.memory.eventExpiryDuration).toBe(7);

      // tags observed on the resource
      const tags = yield* control.listTagsForResource({
        resourceArn: memory.memoryArn,
      });
      expect(tags.tags?.fixture).toBe("agentcore-memory");
      expect(tags.tags?.["alchemy::id"]).toBe("SessionMemory");

      // update in place — same memory id, new expiry
      const { memory: updated } = yield* stack.deploy(deployMemory("14 days"));
      expect(updated.memoryId).toBe(memory.memoryId);
      const observedUpdated = yield* control.getMemory({
        memoryId: memory.memoryId,
      });
      expect(observedUpdated.memory.eventExpiryDuration).toBe(14);

      yield* stack.destroy();
      yield* assertMemoryGone(memory.memoryId);
    }),
  { timeout: 600_000 },
);
