import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";

import { ApprovalGate } from "../Services/ApprovalGate.ts";
import { ApprovalGateLive } from "./ApprovalGate.ts";

const layer = it.layer(ApprovalGateLive);

layer("ApprovalGate", (it) => {
  it.effect("await resolves once resolve is called", () =>
    Effect.gen(function* () {
      const gate = yield* ApprovalGate;
      const fiber = yield* Effect.forkChild(gate.await("sr-1" as never));
      yield* Effect.yieldNow;
      yield* gate.resolve("sr-1" as never, true);
      const approved = yield* Fiber.join(fiber);
      assert.equal(approved, true);
    }),
  );
});
