import * as AWS from "@/AWS";
import * as Test from "@/Test/Alchemy";
import * as logs from "@distilled.cloud/aws/cloudwatch-logs";
import { expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpBody from "effect/unstable/http/HttpBody";
import * as HttpClient from "effect/unstable/http/HttpClient";
import LogEventSinkFunctionLive, {
  LogEventSinkFunction,
} from "./sink-handler.ts";

const { test } = Test.make({ providers: AWS.providers() });

class FunctionNotReady extends Data.TaggedError("FunctionNotReady") {}

class TransientUpstream extends Data.TaggedError("TransientUpstream")<{
  readonly status: number;
}> {}

class EventsNotVisible extends Data.TaggedError("EventsNotVisible")<{
  readonly missing: readonly string[];
}> {}

/** Poll the fixture's /ready route until it serves the resolved log target. */
const waitForReady = (url: string) =>
  Effect.gen(function* () {
    const response = yield* HttpClient.get(url);
    if (response.status !== 200) {
      return yield* Effect.fail(new FunctionNotReady());
    }
    // A fresh function URL can briefly 200 before the captured env (the log
    // group name) has propagated — keep polling until it is a string.
    const json = (yield* response.json) as any;
    if (
      typeof json?.logGroupName === "string" &&
      typeof json?.logStreamName === "string"
    ) {
      return {
        logGroupName: json.logGroupName as string,
        logStreamName: json.logStreamName as string,
      };
    }
    return yield* Effect.fail(new FunctionNotReady());
  }).pipe(
    Effect.retry({
      while: (error) => error._tag === "FunctionNotReady",
      schedule: Schedule.max([
        Schedule.fixed("2 seconds"),
        Schedule.recurs(75),
      ]),
    }),
  );

/** POST a JSON body to the fixture, retrying transient 5xx cold-start noise. */
const postJson = (url: string, body: unknown) =>
  Effect.gen(function* () {
    const response = yield* HttpClient.post(url, {
      body: yield* HttpBody.json(body),
    });
    if (response.status >= 500) {
      return yield* Effect.fail(
        new TransientUpstream({ status: response.status }),
      );
    }
    return yield* response.json;
  }).pipe(
    Effect.retry({
      while: (e) => e._tag === "TransientUpstream",
      schedule: Schedule.max([
        Schedule.exponential("1 second"),
        Schedule.recurs(6),
      ]),
    }),
  );

/**
 * Out-of-band read: poll GetLogEvents until every marker is visible in the
 * stream (ingestion lags a few seconds), returning the observed messages.
 */
const waitForEvents = (
  logGroupName: string,
  logStreamName: string,
  markers: readonly string[],
) =>
  Effect.gen(function* () {
    const result = yield* logs.getLogEvents({
      logGroupName,
      logStreamName,
      startFromHead: true,
    });
    const messages = (result.events ?? []).map((event) => event.message ?? "");
    const missing = markers.filter(
      (marker) => !messages.some((message) => message.includes(marker)),
    );
    if (missing.length > 0) {
      return yield* Effect.fail(new EventsNotVisible({ missing }));
    }
    return messages;
  }).pipe(
    Effect.retry({
      // Ride out both ingestion lag and the brief post-create window where
      // the stream is not yet describable.
      while: (e) =>
        e._tag === "EventsNotVisible" || e._tag === "ResourceNotFoundException",
      schedule: Schedule.max([
        Schedule.fixed("2 seconds"),
        Schedule.recurs(30),
      ]),
    }),
  );

test.provider(
  "LogEventSink streams events through a deployed Lambda and drops rejected events",
  (stack) =>
    Effect.gen(function* () {
      // Leading destroy reconciles away any partial deployment left behind by
      // a previous crashed run (physical names are deterministic, so the
      // re-deploy adopts and the trailing destroy cleans up).
      yield* stack.destroy();

      const fn = yield* stack.deploy(
        LogEventSinkFunction.pipe(Effect.provide(LogEventSinkFunctionLive)),
      );
      const baseUrl = fn.functionUrl!.replace(/\/+$/, "");

      const { logGroupName, logStreamName } = yield* waitForReady(
        `${baseUrl}/ready`,
      );

      // 25 markers through the sink in one request-scoped drain.
      const markers = Array.from(
        { length: 25 },
        (_, i) => `sink-${i}-${crypto.randomUUID()}`,
      );
      const response = yield* postJson(`${baseUrl}/sink`, {
        messages: markers,
      });
      expect((response as any).ok).toBe(true);
      expect((response as any).count).toBe(markers.length);

      // Out-of-band: read the stream directly via distilled.
      yield* waitForEvents(logGroupName, logStreamName, markers);

      // Partial rejection: PutLogEvents has no transient per-event failure
      // mode, so the partial-failure path the API supports is permanent
      // rejection — an event >2h in the future is skipped by the API while
      // the valid events in the same batch are still ingested. The sink must
      // drop it (REJECT, no retry) and complete without error.
      const validMarkers = Array.from(
        { length: 3 },
        (_, i) => `valid-${i}-${crypto.randomUUID()}`,
      );
      const rejectedMarker = `rejected-${crypto.randomUUID()}`;
      const rejectedResponse = yield* postJson(
        `${baseUrl}/sink-with-rejected`,
        { valid: validMarkers, rejected: rejectedMarker },
      );
      expect((rejectedResponse as any).ok).toBe(true);

      const messages = yield* waitForEvents(
        logGroupName,
        logStreamName,
        validMarkers,
      );
      // The rejected (too-new) event was never ingested.
      expect(messages.some((message) => message.includes(rejectedMarker))).toBe(
        false,
      );

      yield* stack.destroy();

      // Assert the sink's log group is gone after the final destroy.
      const remaining = yield* logs.describeLogGroups({
        logGroupNamePrefix: logGroupName,
        limit: 1,
      });
      expect(
        (remaining.logGroups ?? []).some(
          (group) => group.logGroupName === logGroupName,
        ),
      ).toBe(false);
    }),
  { timeout: 240_000 },
);
