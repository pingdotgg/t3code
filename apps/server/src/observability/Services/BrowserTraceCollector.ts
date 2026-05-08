import type { TraceRecord } from "@t3tools/shared/observability";
import { Context } from "effect";
import type { Effect } from "effect";

export interface BrowserTraceCollectorShape {
  readonly record: (records: ReadonlyArray<TraceRecord>) => Effect.Effect<void>;
}

export class BrowserTraceCollector extends Context.Service<
  BrowserTraceCollector,
  BrowserTraceCollectorShape
>()("t3/observability/Services/BrowserTraceCollector") {}
