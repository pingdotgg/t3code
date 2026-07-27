import { makeWorkerRuntimeContext } from "@/Cloudflare/Workers/WorkerRuntimeContext.ts";
import * as Effect from "effect/Effect";
import { describe, expect, it } from "alchemy-test";

describe("WorkerRuntimeContext", () => {
  it("dispatches an event to every listener for that event type", async () => {
    const ctx = makeWorkerRuntimeContext("test-worker");
    const observed: string[] = [];

    await Effect.runPromise(
      Effect.gen(function* () {
        yield* ctx.listen((event) => {
          if (event.type !== "queue") return;
          return Effect.sync(() => {
            observed.push("first");
          });
        });
        yield* ctx.listen((event) => {
          if (event.type !== "queue") return;
          return Effect.sync(() => {
            observed.push("second");
          });
        });
      }),
    );

    const exports = await Effect.runPromise(ctx.exports);
    const [program, services] = exports.default.queue(
      { queue: "queue-a", messages: [] },
      {},
      {} as ExecutionContext,
    );

    await Effect.runPromise(program.pipe(Effect.provide(services)));

    expect(observed).toEqual(["first", "second"]);
  });
});
