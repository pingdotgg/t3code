import type { TraceRecord } from "@t3tools/shared/observability";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

export interface BrowserTraceCollectorShape {
  readonly record: (records: ReadonlyArray<TraceRecord>) => Effect.Effect<void>;
}

export class BrowserTraceCollector extends Context.Service<
  BrowserTraceCollector,
  BrowserTraceCollectorShape
>()("t3/observability/Services/BrowserTraceCollector") {}
