import * as Lambda from "@/AWS/Lambda";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import path from "pathe";

const main = path.resolve(import.meta.dirname, "durable-handler.ts");

/**
 * A three-operation durable orchestration: two checkpointed steps around a
 * durable sleep. The sleep suspends the execution (the invocation returns
 * PENDING) and Lambda re-invokes the function to resume, so a SUCCEEDED
 * result proves the full checkpoint/replay round-trip:
 *   invoke #1 — step "reserve" checkpoints, wait checkpoints, suspend
 *   invoke #2 — replay memoizes "reserve", runs "price", completes
 *
 * A DurableFunction IS the Lambda function (wrapper of AWS.Lambda.Function):
 * the wrapper sets `DurableConfig` at create time, disables the Function URL,
 * self-binds the checkpoint-protocol IAM, and vendors
 * `@aws/durable-execution-sdk-js` into the artifact automatically.
 */
export class DurableFlow extends Lambda.DurableFunction<DurableFlow>()(
  "DurableFlow",
) {}

export default DurableFlow.make(
  {
    main,
    executionTimeout: Duration.hours(1),
    retentionPeriod: "1 day",
    // Per-invocation budget (each resume is its own invocation).
    timeout: Duration.seconds(60),
  },
  Effect.gen(function* () {
    return Effect.fn(function* (input: { orderId: string }) {
      const reserved = yield* Lambda.Durable.step(
        "reserve",
        Effect.succeed({ orderId: input.orderId, reserved: true }),
      );
      yield* Lambda.Durable.sleep("cooldown", "5 seconds");
      const total = yield* Lambda.Durable.step(
        "price",
        // Non-deterministic work belongs inside a step: the checkpointed
        // result replays identically on the resume invocation.
        Effect.sync(() => 40 + 2),
      );
      return { orderId: reserved.orderId, reserved: reserved.reserved, total };
    });
  }),
);
