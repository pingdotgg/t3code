import { Context } from "effect";
import type { Effect } from "effect";

import type { TraceRecord } from "../TraceRecord.ts";

export interface BrowserTraceCollectorShape {
  readonly record: (records: ReadonlyArray<TraceRecord>) => Effect.Effect<void>;
}

export class BrowserTraceCollector extends Context.Service<
  BrowserTraceCollector,
  BrowserTraceCollectorShape
>()("harness/observability/Services/BrowserTraceCollector") {}
