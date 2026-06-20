import type { TraceRecord, TraceSink } from "@t3tools/shared/observability";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

export class BrowserTraceCollector extends Context.Service<
  BrowserTraceCollector,
  {
    readonly record: (records: ReadonlyArray<TraceRecord>) => Effect.Effect<void>;
  }
>()("t3/observability/BrowserTraceCollector") {}

export const make = (sink: TraceSink): BrowserTraceCollector["Service"] =>
  BrowserTraceCollector.of({
    record: (records) =>
      Effect.sync(() => {
        for (const record of records) {
          sink.push(record);
        }
      }),
  });

export const layer = (sink: TraceSink) => Layer.succeed(BrowserTraceCollector, make(sink));
