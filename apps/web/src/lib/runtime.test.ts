import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Tracer from "effect/Tracer";

import { runtime } from "./runtime";

describe("web runtime", () => {
  it("does not record background client spans", async () => {
    const recorded: Array<string> = [];
    const tracer = Tracer.make({
      span(options) {
        recorded.push(options.name);
        return new Tracer.NativeSpan(options);
      },
    });
    await runtime.runPromise(
      Effect.void.pipe(
        Effect.withSpan("web.backgroundActivity.report"),
        Effect.provideService(Tracer.Tracer, tracer),
      ),
    );
    expect(recorded).toEqual([]);
  });
});
