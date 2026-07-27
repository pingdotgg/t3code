import * as AWS from "@/AWS";
import * as Test from "@/Test/Alchemy";
import * as eventbridge from "@distilled.cloud/aws/eventbridge";
import * as SQS from "@distilled.cloud/aws/sqs";
import { expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpBody from "effect/unstable/http/HttpBody";
import * as HttpClient from "effect/unstable/http/HttpClient";
import { BusSinkFunction, BusSinkFunctionLive } from "./sink-handler.ts";

const { test } = Test.make({ providers: AWS.providers() });

class FunctionNotReady extends Data.TaggedError("FunctionNotReady") {}

class SinkRequestFailed extends Data.TaggedError("SinkRequestFailed")<{
  readonly status: number;
  readonly body: string;
}> {}

class EventsNotDelivered extends Data.TaggedError("EventsNotDelivered")<{
  readonly missing: number;
}> {}

const waitForFunctionReady = (url: string) =>
  HttpClient.get(url).pipe(
    Effect.flatMap((response) =>
      response.status === 200
        ? (response.json as Effect.Effect<{ queueUrl: string }>)
        : Effect.fail(new FunctionNotReady()),
    ),
    // A freshly-deployed function can briefly serve a 200 before its captured
    // env vars (the queue URL) have finished propagating, so treat a missing
    // queueUrl as "not ready yet" and keep polling.
    Effect.flatMap((json: any) =>
      typeof json?.queueUrl === "string"
        ? Effect.succeed({ queueUrl: json.queueUrl as string })
        : Effect.fail(new FunctionNotReady()),
    ),
    Effect.retry({
      while: (error) => error._tag === "FunctionNotReady",
      schedule: Schedule.max([
        Schedule.fixed("2 seconds"),
        Schedule.recurs(75),
      ]),
    }),
  );

/** POST a marker batch to the fixture's /sink route; fail on non-200. */
const postSink = Effect.fn(function* (
  baseUrl: string,
  body: { markers: string[]; includeMalformed?: boolean },
) {
  const response = yield* HttpClient.post(`${baseUrl}/sink`, {
    body: yield* HttpBody.json(body),
  });
  if (response.status !== 200) {
    const text = yield* response.text;
    return yield* Effect.fail(
      new SinkRequestFailed({ status: response.status, body: text }),
    );
  }
  return (yield* response.json) as { ok: boolean; count: number };
});

/**
 * Drain the routed queue, collecting `detail.marker` values into `received`,
 * until every expected marker has been observed. Bounded — fails with
 * `EventsNotDelivered` when the schedule is exhausted.
 */
const waitForMarkers = Effect.fn(function* (
  queueUrl: string,
  expected: readonly string[],
) {
  const received = new Set<string>();
  yield* Effect.gen(function* () {
    const result = yield* SQS.receiveMessage({
      QueueUrl: queueUrl,
      MaxNumberOfMessages: 10,
      WaitTimeSeconds: 2,
    });
    for (const message of result.Messages ?? []) {
      if (message.Body) {
        const event = JSON.parse(message.Body) as {
          detail?: { marker?: string };
        };
        const marker = event.detail?.marker;
        if (typeof marker === "string") {
          received.add(marker);
        }
      }
      if (message.ReceiptHandle) {
        yield* SQS.deleteMessage({
          QueueUrl: queueUrl,
          ReceiptHandle: message.ReceiptHandle,
        });
      }
    }
    const missing = expected.filter((marker) => !received.has(marker));
    if (missing.length > 0) {
      return yield* Effect.fail(
        new EventsNotDelivered({ missing: missing.length }),
      );
    }
  }).pipe(
    Effect.retry({
      while: (e) => e._tag === "EventsNotDelivered",
      schedule: Schedule.max([
        Schedule.fixed("2 seconds"),
        Schedule.recurs(30),
      ]),
    }),
  );
  return received;
});

/**
 * EventBridge rules on a freshly-created bus take a while to propagate;
 * events published before the rule is active are silently dropped (no
 * retro-delivery). Publish-then-poll in a bounded loop: each iteration
 * re-publishes the probe marker through the sink and long-polls the routed
 * queue for it.
 */
const probeUntilRouted = Effect.fn(function* (
  baseUrl: string,
  queueUrl: string,
  marker: string,
) {
  yield* Effect.gen(function* () {
    const response = yield* postSink(baseUrl, { markers: [marker] });
    expect(response.ok).toBe(true);

    const result = yield* SQS.receiveMessage({
      QueueUrl: queueUrl,
      MaxNumberOfMessages: 10,
      WaitTimeSeconds: 5,
    });
    const match = (result.Messages ?? []).some((message) =>
      message.Body ? message.Body.includes(marker) : false,
    );
    if (!match) {
      yield* Effect.logInfo(
        "BusSink test: probe event not routed yet (rule still propagating?)",
      );
      return yield* Effect.fail(new EventsNotDelivered({ missing: 1 }));
    }
  }).pipe(
    Effect.retry({
      while: (e) => e._tag === "EventsNotDelivered",
      schedule: Schedule.max([
        Schedule.fixed("5 seconds"),
        Schedule.recurs(17),
      ]),
    }),
  );
});

test.provider(
  "BusSink streams entries through a deployed Lambda to EventBridge",
  (stack) =>
    Effect.gen(function* () {
      // Leading destroy: reconcile away any partial deployment left behind by
      // a previous crashed run (physical names are deterministic constants).
      yield* stack.destroy();

      const fn = yield* stack.deploy(
        BusSinkFunction.pipe(Effect.provide(BusSinkFunctionLive)),
      );
      const baseUrl = fn.functionUrl!.replace(/\/+$/, "");

      const { queueUrl } = yield* waitForFunctionReady(`${baseUrl}/ready`);

      // Prove the bus -> queue rule is active before asserting on batches.
      yield* probeUntilRouted(baseUrl, queueUrl, "bussink-probe");

      // 25 entries > the PutEvents limit of 10, so the batched sink must
      // split the chunk into 3 sequential API calls (10 + 10 + 5).
      const markers = Array.from(
        { length: 25 },
        (_, i) => `bussink-${i}-${crypto.randomUUID()}`,
      );
      const response = yield* postSink(baseUrl, { markers });
      expect(response.ok).toBe(true);
      expect(response.count).toBe(markers.length);

      yield* waitForMarkers(queueUrl, markers);

      // Partial failure: one entry with malformed Detail is rejected
      // per-entry (ErrorCode: MalformedDetail). The sink must drop it and
      // deliver the rest without failing the batch.
      const partialMarkers = Array.from(
        { length: 3 },
        (_, i) => `bussink-partial-${i}-${crypto.randomUUID()}`,
      );
      const partial = yield* postSink(baseUrl, {
        markers: partialMarkers,
        includeMalformed: true,
      });
      expect(partial.ok).toBe(true);
      expect(partial.count).toBe(partialMarkers.length + 1);

      yield* waitForMarkers(queueUrl, partialMarkers);

      yield* stack.destroy();

      // Typed wait-until-gone: the sink's event bus must be deleted.
      const gone = yield* eventbridge
        .describeEventBus({ Name: "alchemy-test-eb-bus-sink" })
        .pipe(
          Effect.map(() => false),
          Effect.catchTag("ResourceNotFoundException", () =>
            Effect.succeed(true),
          ),
          Effect.repeat({
            schedule: Schedule.spaced("2 seconds"),
            until: (isGone): boolean => isGone,
            times: 10,
          }),
        );
      expect(gone).toBe(true);
    }),
  { timeout: 240_000 },
);
