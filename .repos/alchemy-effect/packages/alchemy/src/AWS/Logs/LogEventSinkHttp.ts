import type * as Logs from "@distilled.cloud/aws/cloudwatch-logs";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Binding from "../../Binding.ts";
import * as Output from "../../Output.ts";
import { makeBatchedSink } from "../internal/BatchedSink.ts";
import { isBindingHost } from "../Lambda/Function.ts";
import { LogEventSink, type LogEventSinkProps } from "./LogEventSink.ts";
import type { LogGroup } from "./LogGroup.ts";
import { PutLogEvents } from "./PutLogEvents.ts";

const encoder = new TextEncoder();

/**
 * The `PutLogEvents` batch-size formula charges each event its UTF-8 message
 * size plus 26 bytes of overhead.
 */
const PER_EVENT_OVERHEAD = 26;

/**
 * Select the events `rejectedLogEventsInfo` marks as permanently rejected,
 * preserving input order. The API skips (never ingests) these while still
 * processing the remaining valid events, so they must be dropped — not
 * retried:
 *
 * - `tooOldLogEventEndIndex` / `expiredLogEventEndIndex` — everything up to
 *   and including that index is too old / past retention;
 * - `tooNewLogEventStartIndex` — everything from that index on is more than
 *   2 hours in the future.
 */
const selectRejected = (
  out: Logs.PutLogEventsResponse,
  batch: readonly Logs.InputLogEvent[],
): readonly Logs.InputLogEvent[] => {
  const info = out.rejectedLogEventsInfo;
  if (info === undefined) {
    return [];
  }
  const rejectedHeadEnd = Math.max(
    info.tooOldLogEventEndIndex ?? -1,
    info.expiredLogEventEndIndex ?? -1,
  );
  const tooNewStart = info.tooNewLogEventStartIndex ?? batch.length;
  return batch.filter(
    (_, index) => index <= rejectedHeadEnd || index >= tooNewStart,
  );
};

export const LogEventSinkHttp = Layer.effect(
  LogEventSink,
  Effect.gen(function* () {
    const putLogEvents = yield* PutLogEvents;

    return Effect.fn(function* (logGroup: LogGroup, props: LogEventSinkProps) {
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          yield* host.bind`Allow(${host}, AWS.Logs.LogEventSink(${logGroup}))`({
            policyStatements: [
              {
                // PutLogEvents authorizes against the log-stream resource
                // (`log-group:{name}:log-stream:{stream}`), covered by the
                // `:*` wildcard on the group ARN.
                Effect: "Allow",
                Action: ["logs:PutLogEvents"],
                Resource: [Output.interpolate`${logGroup.logGroupArn}:*`],
              },
            ],
          });
        }
      }
      const put = yield* putLogEvents(logGroup);
      return makeBatchedSink<
        Logs.InputLogEvent,
        Logs.PutLogEventsResponse,
        Logs.PutLogEventsError
      >({
        maxRecords: 10_000,
        maxBytes: 1_048_576,
        sizeOf: (event) =>
          encoder.encode(event.message).length + PER_EVENT_OVERHEAD,
        send: (batch) =>
          put({
            logStreamName: props.logStreamName,
            logEvents: [...batch],
          }),
        // No `unprocessed` extractor: PutLogEvents has no transient per-event
        // failure mode — timestamp rejections are permanent, so drop + surface.
        rejected: selectRejected,
      });
    });
  }),
);
