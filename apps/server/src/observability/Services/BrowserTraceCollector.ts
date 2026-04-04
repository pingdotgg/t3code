import { ServiceMap } from "effect";
import type { Effect } from "effect";

import type { TraceRecord } from "../TraceRecord.ts";

export interface BrowserTraceCollectorShape {
  readonly record: (records: ReadonlyArray<TraceRecord>) => Effect.Effect<void>;
}

export class BrowserTraceCollector extends ServiceMap.Service<
  BrowserTraceCollector,
  BrowserTraceCollectorShape
>()("t3/observability/Services/BrowserTraceCollector") {}
