import * as AWS from "@/AWS";
import * as Core from "@/Test/Core";
import * as Test from "@/Test/Alchemy";
import * as eventbridge from "@distilled.cloud/aws/eventbridge";
import * as SQS from "@distilled.cloud/aws/sqs";
import { describe, expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import EventBridgeTestFunctionLive, {
  BusAndQueues,
  BusAndQueuesLive,
  EventBridgeTestFunction,
} from "./handler.ts";

const testOptions = { providers: AWS.providers() };
const { test, beforeAll, afterAll } = Test.make(testOptions);
const sharedStack = Core.scratchStack(testOptions, "EventBridgeBindings");

// Lambda function URL cold-start (DNS, IAM propagation, init) can take well
// over 60s on a fresh deploy under parallel-suite load. Budget ~150s.
const readinessPolicy = Schedule.max([
  Schedule.fixed("2 seconds"),
  Schedule.recurs(75),
]);

let baseUrl: string;
let customQueueUrl: string;
let defaultQueueUrl: string;
let functionArn: string;

class TransientUpstream extends Data.TaggedError("TransientUpstream")<{
  readonly status: number;
  readonly body: string;
}> {}

// Retry transient 5xx from the fixture (cold re-init under parallel load);
// a genuine 4xx/assertion failure is surfaced immediately.
const send = (request: HttpClientRequest.HttpClientRequest) =>
  HttpClient.execute(request).pipe(
    Effect.flatMap((response) =>
      response.status >= 500
        ? response.text.pipe(
            Effect.flatMap((body) =>
              Effect.fail(
                new TransientUpstream({ status: response.status, body }),
              ),
            ),
          )
        : Effect.succeed(response),
    ),
    Effect.retry({
      while: (e) => e._tag === "TransientUpstream",
      schedule: Schedule.max([
        Schedule.exponential("500 millis"),
        Schedule.recurs(6),
      ]),
    }),
  );

class EventNotDelivered extends Data.TaggedError("EventNotDelivered") {}

interface DeliveredEvent {
  source: string;
  detailType: string;
  detail: { marker: string };
}

// EventBridge rules on a freshly-created bus take a while to propagate; events
// published before the rule is active are silently dropped (EventBridge does
// not retro-deliver). So publish-then-poll in a bounded loop: each iteration
// re-publishes the marker event and long-polls the sink queue for it.
// Worst case ~= 18 * (publish + 5s long poll) ~= 95s, within the 120s test
// timeout.
const publishUntilReceived = Effect.fn(function* (
  route: string,
  queueUrl: string,
  marker: string,
) {
  return yield* Effect.gen(function* () {
    const publishResponse = yield* send(
      HttpClientRequest.bodyJsonUnsafe(
        HttpClientRequest.post(`${baseUrl}${route}`),
        { marker },
      ),
    ).pipe(Effect.flatMap((r) => r.json));
    expect(publishResponse).toHaveProperty("failedEntryCount", 0);

    const result = yield* SQS.receiveMessage({
      QueueUrl: queueUrl,
      MaxNumberOfMessages: 10,
      WaitTimeSeconds: 5,
    });
    const match = (result.Messages ?? [])
      .flatMap((message) =>
        message.Body ? [JSON.parse(message.Body) as DeliveredEvent] : [],
      )
      .find((body) => body.detail?.marker === marker);
    if (!match) {
      yield* Effect.logInfo(
        `EventBridge test: no matching event on ${route} yet (rule still propagating?)`,
      );
      return yield* Effect.fail(new EventNotDelivered());
    }
    return match;
  }).pipe(
    Effect.retry({
      while: (e) => e._tag === "EventNotDelivered",
      schedule: Schedule.max([
        Schedule.fixed("5 seconds"),
        Schedule.recurs(17),
      ]),
    }),
  );
});

describe("EventBridge Bindings", () => {
  beforeAll(
    Effect.gen(function* () {
      yield* Effect.logInfo(
        "EventBridge test setup: destroying previous resources",
      );
      yield* sharedStack.destroy();

      yield* Effect.logInfo("EventBridge test setup: deploying fixture");
      const { fn, custom, dflt } = yield* sharedStack.deploy(
        Effect.gen(function* () {
          const { customQueue, defaultQueue } = yield* BusAndQueues;
          const fn = yield* EventBridgeTestFunction;
          return { fn, custom: customQueue, dflt: defaultQueue };
        }).pipe(
          Effect.provide(
            Layer.mergeAll(EventBridgeTestFunctionLive, BusAndQueuesLive),
          ),
        ),
      );

      expect(fn.functionUrl).toBeTruthy();
      baseUrl = fn.functionUrl!.replace(/\/+$/, "");
      customQueueUrl = custom.queueUrl;
      defaultQueueUrl = dflt.queueUrl;
      functionArn = fn.functionArn;

      yield* Effect.logInfo(
        `EventBridge test setup: probing readiness at ${baseUrl}/health`,
      );
      yield* HttpClient.get(`${baseUrl}/health`).pipe(
        Effect.flatMap((response) =>
          response.status === 200
            ? Effect.succeed(response)
            : Effect.fail(new Error(`Function not ready: ${response.status}`)),
        ),
        Effect.tapError((error) =>
          Effect.logWarning(
            `EventBridge test setup: fixture not ready yet (${String(error)})`,
          ),
        ),
        Effect.retry({ schedule: readinessPolicy }),
      );
      yield* Effect.logInfo("EventBridge test setup: fixture ready");
    }),
    { timeout: 240_000 },
  );

  afterAll.skipIf(!!process.env.NO_DESTROY)(
    sharedStack.destroy().pipe(
      // Typed wait-until-gone: the custom bus must be deleted after teardown.
      // The raw afterAll context has no providers layer (only `test.provider`
      // bodies do), so the out-of-band distilled call must be wrapped in
      // `withProviders` to satisfy Credentials/HttpClient/Region.
      Effect.andThen(
        Core.withProviders(
          eventbridge
            .describeEventBus({ Name: "alchemy-test-eb-bindings" })
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
              Effect.map((gone) => expect(gone).toBe(true)),
            ),
          testOptions,
          "EventBridgeBindings",
        ),
      ),
    ),
    {
      // Teardown deletes ~30 resources (invoke permissions, event-source
      // rules, the Lambda fixture + role, ToggleRule, TestArchive, both
      // sinks, then the buses). Each delete is bounded — the EventBus
      // provider force-sweeps AWS's lingering managed archival rule — but
      // the serial sum needs headroom on a slow AWS day.
      timeout: 360_000,
    },
  );

  describe("PutEvents", () => {
    test.provider("publishes an event to the custom bus", (_stack) =>
      Effect.gen(function* () {
        const response = (yield* send(
          HttpClientRequest.bodyJsonUnsafe(
            HttpClientRequest.post(`${baseUrl}/publish-custom`),
            { marker: "put-events-custom-direct" },
          ),
        ).pipe(Effect.flatMap((r) => r.json))) as {
          failedEntryCount: number;
          entries: Array<{ EventId?: string }>;
        };

        expect(response.failedEntryCount).toBe(0);
        expect(response.entries).toHaveLength(1);
        expect(response.entries[0].EventId).toBeTruthy();
      }),
    );

    test.provider("publishes an event to the default bus", (_stack) =>
      Effect.gen(function* () {
        const response = (yield* send(
          HttpClientRequest.bodyJsonUnsafe(
            HttpClientRequest.post(`${baseUrl}/publish-default`),
            { marker: "put-events-default-direct" },
          ),
        ).pipe(Effect.flatMap((r) => r.json))) as {
          failedEntryCount: number;
          entries: Array<{ EventId?: string }>;
        };

        expect(response.failedEntryCount).toBe(0);
        expect(response.entries).toHaveLength(1);
        expect(response.entries[0].EventId).toBeTruthy();
      }),
    );
  });

  describe("EnableRule / DisableRule / DescribeRule", () => {
    test.provider(
      "toggles the rule state and observes it via DescribeRule",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* send(
            HttpClientRequest.post(`${baseUrl}/rule-toggle`),
          ).pipe(Effect.flatMap((r) => r.json))) as {
            afterDisable: string;
            afterEnable: string;
          };

          expect(response.afterDisable).toBe("DISABLED");
          expect(response.afterEnable).toBe("ENABLED");
        }),
      { timeout: 60_000 },
    );
  });

  describe("ListRuleNamesByTarget", () => {
    test.provider(
      "finds the consume-loop rule targeting the function",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* send(
            HttpClientRequest.bodyJsonUnsafe(
              HttpClientRequest.post(`${baseUrl}/rule-names-by-target`),
              { targetArn: functionArn },
            ),
          ).pipe(Effect.flatMap((r) => r.json))) as {
            ruleNames: string[];
          };

          // The default-bus consume loop's rule targets the Lambda.
          expect(Array.isArray(response.ruleNames)).toBe(true);
          expect(response.ruleNames.length).toBeGreaterThanOrEqual(1);
        }),
      { timeout: 60_000 },
    );
  });

  describe("DescribeEventBus", () => {
    test.provider("describes the bound custom bus", (_stack) =>
      Effect.gen(function* () {
        const response = (yield* send(
          HttpClientRequest.get(`${baseUrl}/bus-info`),
        ).pipe(Effect.flatMap((r) => r.json))) as {
          name: string;
          arn: string;
        };

        expect(response.name).toBe("alchemy-test-eb-bindings");
        expect(response.arn).toContain(":event-bus/alchemy-test-eb-bindings");
      }),
    );
  });

  describe("ListEventBuses", () => {
    test.provider("enumerates account buses including the default", (_stack) =>
      Effect.gen(function* () {
        const response = (yield* send(
          HttpClientRequest.get(`${baseUrl}/event-buses`),
        ).pipe(Effect.flatMap((r) => r.json))) as { names: string[] };

        expect(response.names).toContain("default");
        expect(response.names).toContain("alchemy-test-eb-bindings");
      }),
    );
  });

  describe("ListRules", () => {
    test.provider("lists the rules on the bound custom bus", (_stack) =>
      Effect.gen(function* () {
        const response = (yield* send(
          HttpClientRequest.get(`${baseUrl}/rules`),
        ).pipe(Effect.flatMap((r) => r.json))) as { ruleNames: string[] };

        // The toggle rule and the custom-bus consume-loop rule live here.
        expect(response.ruleNames).toContain("alchemy-test-eb-toggle");
        expect(response.ruleNames.length).toBeGreaterThanOrEqual(2);
      }),
    );
  });

  describe("ListTargetsByRule", () => {
    test.provider("lists the (empty) targets of the toggle rule", (_stack) =>
      Effect.gen(function* () {
        const response = (yield* send(
          HttpClientRequest.get(`${baseUrl}/targets-by-rule`),
        ).pipe(Effect.flatMap((r) => r.json))) as { targetCount: number };

        expect(response.targetCount).toBe(0);
      }),
    );
  });

  describe("TestEventPattern", () => {
    test.provider("matches and rejects events against a pattern", (_stack) =>
      Effect.gen(function* () {
        const matching = (yield* send(
          HttpClientRequest.bodyJsonUnsafe(
            HttpClientRequest.post(`${baseUrl}/test-pattern`),
            { source: "alchemy.test.pattern" },
          ),
        ).pipe(Effect.flatMap((r) => r.json))) as { matches: boolean };
        expect(matching.matches).toBe(true);

        const nonMatching = (yield* send(
          HttpClientRequest.bodyJsonUnsafe(
            HttpClientRequest.post(`${baseUrl}/test-pattern`),
            { source: "other.source" },
          ),
        ).pipe(Effect.flatMap((r) => r.json))) as { matches: boolean };
        expect(nonMatching.matches).toBe(false);
      }),
    );
  });

  describe("Replays", () => {
    test.provider("ListReplays enumerates account replays", (_stack) =>
      Effect.gen(function* () {
        const response = (yield* send(
          HttpClientRequest.get(`${baseUrl}/replays`),
        ).pipe(Effect.flatMap((r) => r.json))) as { count: number };

        expect(typeof response.count).toBe("number");
        expect(response.count).toBeGreaterThanOrEqual(0);
      }),
    );

    test.provider(
      "StartReplay/DescribeReplay/CancelReplay drive a replay of the archive",
      (_stack) =>
        Effect.gen(function* () {
          const res = yield* send(
            HttpClientRequest.bodyJsonUnsafe(
              HttpClientRequest.post(`${baseUrl}/replay`),
              {},
            ),
          );
          const bodyText = yield* res.text;
          expect(res.status, bodyText).toBe(200);
          const response = yield* Effect.sync(
            () => JSON.parse(bodyText) as { state: string; cancel: string },
          );

          expect([
            "STARTING",
            "RUNNING",
            "COMPLETED",
            "CANCELLING",
            "CANCELLED",
            "FAILED",
          ]).toContain(response.state);
          expect(["cancelled", "not-cancellable"]).toContain(response.cancel);
        }),
      { timeout: 60_000 },
    );
  });

  describe("EventSource", () => {
    test.provider(
      "consume loop receives custom-bus events",
      (_stack) =>
        Effect.gen(function* () {
          const event = yield* publishUntilReceived(
            "/publish-custom",
            customQueueUrl,
            "consume-loop-custom",
          );

          expect(event.source).toBe("alchemy.test.custom");
          expect(event.detailType).toBe("TestEvent");
          expect(event.detail.marker).toBe("consume-loop-custom");
        }),
      { timeout: 120_000 },
    );

    test.provider(
      "consume loop receives default-bus events",
      (_stack) =>
        Effect.gen(function* () {
          const event = yield* publishUntilReceived(
            "/publish-default",
            defaultQueueUrl,
            "consume-loop-default",
          );

          expect(event.source).toBe("alchemy.test.default");
          expect(event.detailType).toBe("TestEvent");
          expect(event.detail.marker).toBe("consume-loop-default");
        }),
      { timeout: 120_000 },
    );
  });
});
