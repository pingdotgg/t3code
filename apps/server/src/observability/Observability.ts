import * as HttpObservability from "@t3tools/shared/httpObservability";
import { makeLocalFileTracer } from "@t3tools/shared/observability";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as References from "effect/References";
import * as Tracer from "effect/Tracer";
import * as Statement from "effect/sql/Statement";

import * as ServerConfig from "../config.ts";
import * as ServerLogger from "../serverLogger.ts";
import * as HeapAttribution from "./HeapAttribution.ts";

/** Traces stay in local files. */
export const layer = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;

    const layerTraceReferences = Layer.mergeAll(
      Layer.succeed(Tracer.MinimumTraceLevel, config.traceMinLevel),
      Layer.succeed(References.TracerTimingEnabled, config.traceTimingEnabled),
      // Preserve SQL spans while awaiting connections so lock waits can be recorded on them.
      Layer.succeed(Statement.SpanPropagationEnabled, true),
      HttpObservability.layer,
    );

    const layerTracer = Layer.effect(
      Tracer.Tracer,
      Effect.gen(function* () {
        const tracer = yield* makeLocalFileTracer({
          filePath: config.serverTracePath,
          maxBytes: config.traceMaxBytes,
          maxFiles: config.traceMaxFiles,
          batchWindowMs: config.traceBatchWindowMs,
        });
        const heapAttribution = yield* HeapAttribution.make(tracer);
        yield* heapAttribution.run;
        return heapAttribution.tracer;
      }),
    );

    return Layer.mergeAll(ServerLogger.layer, layerTraceReferences, layerTracer);
  }),
);
