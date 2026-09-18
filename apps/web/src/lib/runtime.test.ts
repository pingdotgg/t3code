import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Tracer from "effect/Tracer";

import * as ClientTracer from "../observability/clientTracer";
import { runtime } from "./runtime";

describe("web runtime", () => {
  it("routes client spans to the exporter client tracing configured", async () => {
    const exported: Array<string> = [];
    ClientTracer.setDelegate(
      Tracer.make({
        span(options) {
          exported.push(options.name);
          return new Tracer.NativeSpan(options);
        },
      }),
    );

    try {
      await runtime.runPromise(Effect.void.pipe(Effect.withSpan("client.work")));
    } finally {
      ClientTracer.setDelegate(null);
    }

    expect(exported).toEqual(["client.work"]);
  });
});
