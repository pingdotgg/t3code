import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Tracer from "effect/Tracer";
import * as OtlpExporter from "effect/observability/OtlpExporter";
import * as OtlpTracer from "effect/observability/OtlpTracer";

const MAX_PENDING_SPANS = 1_000;
const EXPORT_TIMEOUT = "10 seconds";

export const make = Effect.fn("ServerTraceExporter.make")(
  function* (options: {
    readonly url: string;
    readonly exportInterval: Duration.Input;
    readonly headers?: Parameters<typeof OtlpTracer.make>[0]["headers"];
    readonly resource?: Parameters<typeof OtlpTracer.make>[0]["resource"];
  }) {
    const flusher = yield* OtlpExporter.Flusher;
    // Own both flush triggers so a slow collector cannot accumulate concurrent export bodies.
    const tracer = yield* OtlpTracer.make({
      ...options,
      exportInterval: Duration.infinity,
      maxBatchSize: Number.POSITIVE_INFINITY,
    });
    const wake = yield* Queue.sliding<void>(1);
    let pending = 0;
    let dropped = 0;

    const flush = Effect.suspend(() => {
      const droppedSpans = dropped;
      dropped = 0;
      pending = 0;
      return flusher.flush.pipe(
        Effect.timeoutOption(EXPORT_TIMEOUT),
        Effect.andThen(
          droppedSpans === 0
            ? Effect.void
            : Effect.logWarning("Dropped OTLP trace spans while the export buffer was full", {
                count: droppedSpans,
              }),
        ),
      );
    });

    yield* Queue.take(wake).pipe(
      Effect.timeoutOption(options.exportInterval),
      Effect.andThen(flush),
      Effect.forever,
      Effect.withTracerEnabled(false),
      Effect.updateContext(Context.omit(Tracer.ParentSpan)<never>),
      Effect.forkScoped,
    );

    return Tracer.make({
      span(spanOptions) {
        const span = tracer.span(spanOptions);
        if (!span.sampled) return span;
        const end = span.end.bind(span);
        span.end = (endTime, exit) => {
          if (pending >= MAX_PENDING_SPANS) {
            dropped++;
            return;
          }
          end(endTime, exit);
          pending++;
          if (pending === MAX_PENDING_SPANS) Queue.offerUnsafe(wake, undefined);
        };
        return span;
      },
    });
  },
  Effect.provide(Layer.fresh(OtlpExporter.layerFlusher)),
);
