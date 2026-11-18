import type { OtlpSignal } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Metric from "effect/Metric";
import { HttpClient } from "effect/http";
import type { HttpBody } from "effect/http";
import { OtlpSerialization } from "effect/observability";

import { otlpExportAttemptFailuresTotal } from "./Metrics.ts";

/**
 * Re-provides the HttpClient and OtlpSerialization one OTLP exporter uses, counting its failed
 * attempts on the metrics channel. The exporter applies `filterStatusOk` and its retries outside
 * this client, so a non-2xx arrives here as a response and each retry is counted.
 */
export const layer = (signal: OtlpSignal) =>
  Layer.effectContext(
    Effect.gen(function* () {
      const context = yield* Effect.context<never>();
      const client = yield* HttpClient.HttpClient;
      const serialization = yield* OtlpSerialization.OtlpSerialization;
      const failures = (reason: string) =>
        Metric.withAttributes(otlpExportAttemptFailuresTotal, { signal, reason });
      // Encoding runs synchronously inside the exporter, before any request exists.
      const counted =
        <A>(encode: (data: A) => HttpBody.HttpBody) =>
        (data: A) => {
          try {
            return encode(data);
          } catch (error) {
            failures("encode").updateUnsafe(1, context);
            throw error;
          }
        };
      return Context.make(
        HttpClient.HttpClient,
        client.pipe(
          HttpClient.tap((response) =>
            response.status >= 200 && response.status < 300
              ? Effect.void
              : Metric.update(failures(`status_${response.status}`), 1),
          ),
          HttpClient.tapError(() => Metric.update(failures("transport"), 1)),
        ),
      ).pipe(
        Context.add(OtlpSerialization.OtlpSerialization, {
          traces: counted(serialization.traces),
          metrics: counted(serialization.metrics),
          logs: counted(serialization.logs),
        }),
      );
    }),
  );
