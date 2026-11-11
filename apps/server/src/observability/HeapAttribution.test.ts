import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Context from "effect/Context";
import * as TestClock from "effect/testing/TestClock";
import * as Tracer from "effect/Tracer";

import * as HeapAttribution from "./HeapAttribution.ts";

const MB = 1024 * 1024;

it.effect("names the span that grew the heap in a spike, not an older open or ended one", () =>
  Effect.gen(function* () {
    const ended: Array<Tracer.NativeSpan> = [];
    const inner = Tracer.make({
      span(options) {
        const span = new Tracer.NativeSpan(options);
        const end = span.end.bind(span);
        span.end = (endTime, exit) => {
          end(endTime, exit);
          ended.push(span);
        };
        return span;
      },
    });
    let heap = 300 * MB;
    const attribution = yield* HeapAttribution.make(inner, () => heap);
    yield* attribution.run;
    // The sampler's baseline: heap before the spans allocate.
    yield* TestClock.adjust("1 second");
    const open = (name: string) =>
      attribution.tracer.span({
        name,
        parent: Option.none(),
        annotations: Context.empty(),
        links: [],
        startTime: 0n,
        kind: "internal",
        root: false,
        sampled: true,
      });

    const subscription = open("ws.rpc.orchestration.subscribeShell");
    const old = open("ProjectionStore.getSnapshot");
    // Slow drift never spikes, but leaves the long-lived span far above its start.
    for (let step = 0; step < 5; step++) {
      heap += 80 * MB;
      yield* TestClock.adjust("11 seconds");
      if (step === 1) old.end(1n, undefined as never);
    }
    const small = open("ProjectionStore.getThreadShell");
    const big = open("ProjectionStore.getThreadProjection");
    heap += 2 * MB;
    small.end(1n, undefined as never);
    heap += 198 * MB;
    yield* TestClock.adjust("2 seconds");

    const spike = ended.find((span) => span.name === "server.heap.spike");
    assert.isDefined(spike);
    assert.deepEqual(spike!.attributes.get("suspects"), [
      "ProjectionStore.getThreadProjection +200 MB",
    ]);
    big.end(2n, undefined as never);
    subscription.end(3n, undefined as never);
    assert.equal(big.attributes.get("memory.heap_growth_bytes"), 200 * MB);
    assert.isUndefined(small.attributes.get("memory.heap_growth_bytes"));
    assert.equal(old.attributes.get("memory.heap_growth_bytes"), 160 * MB);
  }),
);
