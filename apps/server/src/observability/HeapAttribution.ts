// @effect-diagnostics nodeBuiltinImport:off - only node:v8 exposes a heap reading cheap enough to take per span.
import * as NodeV8 from "node:v8";

import * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";
import * as Tracer from "effect/Tracer";

const MB = 1024 * 1024;
// Smaller growth is noise from concurrent fibers; an attribute on every span would bloat exports.
const SPAN_GROWTH_ATTRIBUTE_BYTES = 8 * MB;
const SPIKE_GROWTH_BYTES = 128 * MB;
const SPIKE_WINDOW_SAMPLES = 10;
const SPIKE_COOLDOWN_SAMPLES = 60;
const RECENT_SPANS = 32;
const REPORTED_SPANS = 8;

const readHeapUsed = () => NodeV8.getHeapStatistics().used_heap_size;

interface Growth {
  readonly name: string;
  readonly growthBytes: number;
}

/**
 * Heap growth is approximate: it includes other fibers' allocations and GC, so it names
 * suspects, not culprits. A spike lists what was open or just grew.
 */
export const make = (tracer: Tracer.Tracer, heapUsed: () => number = readHeapUsed) =>
  Effect.sync(() => {
    const open = new Map<
      Tracer.Span,
      { readonly name: string; readonly startHeap: number; readonly startTick: number }
    >();
    const recent: Array<Growth & { readonly endTick: number }> = [];
    const samples: Array<number> = [];
    let cooldown = 0;
    let tick = 0;

    const wrapped = Tracer.make({
      ...(tracer.context === undefined ? {} : { context: tracer.context }),
      span(options) {
        const span = tracer.span(options);
        const startHeap = heapUsed();
        open.set(span, { name: options.name, startHeap, startTick: tick });
        const end = span.end.bind(span);
        span.end = (endTime, exit) => {
          open.delete(span);
          const growthBytes = heapUsed() - startHeap;
          if (growthBytes >= SPAN_GROWTH_ATTRIBUTE_BYTES) {
            span.attribute("memory.heap_growth_bytes", growthBytes);
            recent.push({ name: options.name, growthBytes, endTick: tick });
            if (recent.length > RECENT_SPANS) recent.shift();
          }
          end(endTime, exit);
        };
        return span;
      },
    });

    // Untraced: it runs every second and only emits a span when the heap spikes.
    const sample = Effect.fnUntraced(function* () {
      const heap = heapUsed();
      tick++;
      samples.push(heap);
      if (samples.length > SPIKE_WINDOW_SAMPLES) samples.shift();
      if (cooldown > 0) {
        cooldown--;
        return;
      }
      const growthBytes = heap - Math.min(...samples);
      if (growthBytes < SPIKE_GROWTH_BYTES) return;
      cooldown = SPIKE_COOLDOWN_SAMPLES;
      const suspects = [
        // Spans open since before the window, such as subscriptions, would claim all of its growth.
        ...[...open.values()]
          .filter(({ startTick }) => tick - startTick <= samples.length)
          .map(({ name, startHeap }) => ({ name, growthBytes: heap - startHeap })),
        ...recent.filter(({ endTick }) => tick - endTick <= samples.length),
      ]
        .filter((suspect) => suspect.growthBytes >= SPAN_GROWTH_ATTRIBUTE_BYTES)
        .toSorted((left, right) => right.growthBytes - left.growthBytes)
        .slice(0, REPORTED_SPANS)
        .map(({ name, growthBytes }) => `${name} +${Math.round(growthBytes / MB)} MB`);
      recent.length = 0;
      // A span, not a log: this fiber starts before the server logger is provided.
      yield* Effect.void.pipe(
        Effect.withSpan("server.heap.spike", {
          root: true,
          level: "Warn",
          attributes: {
            heapUsedMb: Math.round(heap / MB),
            growthMb: Math.round(growthBytes / MB),
            suspects,
          },
        }),
      );
    });

    const run: Effect.Effect<void, never, Scope.Scope> = sample().pipe(
      Effect.andThen(Effect.sleep("1 second")),
      Effect.forever,
      Effect.withTracer(wrapped),
      Effect.forkScoped,
      Effect.asVoid,
    );

    return { tracer: wrapped, run };
  });
