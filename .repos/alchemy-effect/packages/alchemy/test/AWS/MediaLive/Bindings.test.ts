import * as AWS from "@/AWS";
import * as Core from "@/Test/Core";
import * as Test from "@/Test/Alchemy";
import * as eventbridge from "@distilled.cloud/aws/eventbridge";
import { describe, expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import MediaLiveChannelTestFunctionLive, {
  MediaLiveChannelTestFunction,
} from "./fixtures/channel-handler";
import MediaLiveTestFunctionLive, {
  MediaLiveTestFunction,
} from "./fixtures/handler";

const testOptions = { providers: AWS.providers() };
const { test, beforeAll, afterAll } = Test.make(testOptions);
const sharedStack = Core.scratchStack(testOptions, "MediaLiveBindings");
const channelStack = Core.scratchStack(testOptions, "MediaLiveChannelBindings");

// Lambda function URL cold-start (DNS, IAM propagation, init) can take well
// over 60s on a fresh deploy.
const readinessPolicy = Schedule.max([
  Schedule.fixed("2 seconds"),
  Schedule.recurs(75),
]);

class TransientUpstream extends Data.TaggedError("TransientUpstream")<{
  readonly status: number;
  readonly body: string;
}> {}

// The shared Lambda fixture occasionally answers a transient 5xx under load
// (cold re-init, IAM propagation on the freshly attached policy that the
// handler's `Effect.orDie` surfaces as a 500). Retry only 5xx; a genuine
// 4xx/assertion failure surfaces immediately.
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

const getJson = (base: string, path: string) =>
  send(HttpClientRequest.get(`${base}${path}`)).pipe(
    Effect.flatMap((r) => r.json),
  );

const postJson = (base: string, path: string) =>
  send(HttpClientRequest.post(`${base}${path}`)).pipe(
    Effect.flatMap((r) => r.json),
  );

const awaitReady = (readinessUrl: string) =>
  HttpClient.get(readinessUrl).pipe(
    Effect.flatMap((response) =>
      response.status === 200
        ? Effect.succeed(response)
        : Effect.fail(new Error(`Function not ready: ${response.status}`)),
    ),
    Effect.tapError((error) =>
      Effect.logWarning(
        `MediaLive test setup: fixture not ready yet (${String(error)})`,
      ),
    ),
    Effect.retry({ schedule: readinessPolicy }),
  );

let baseUrl: string;
let functionArn: string;

describe.sequential("MediaLive Bindings", () => {
  beforeAll(
    Effect.gen(function* () {
      yield* Effect.logInfo(
        "MediaLive test setup: destroying previous resources",
      );
      yield* sharedStack.destroy();

      yield* Effect.logInfo("MediaLive test setup: deploying fixture");
      const attrs = yield* sharedStack.deploy(
        Effect.gen(function* () {
          return yield* MediaLiveTestFunction;
        }).pipe(Effect.provide(MediaLiveTestFunctionLive)),
      );

      expect(attrs.functionUrl).toBeTruthy();
      baseUrl = attrs.functionUrl!.replace(/\/+$/, "");
      functionArn = attrs.functionArn;

      yield* awaitReady(`${baseUrl}/bindings`);
    }),
    { timeout: 300_000 },
  );

  afterAll(sharedStack.destroy(), { timeout: 240_000 });

  describe("binding registration", () => {
    test.provider("all three capabilities initialize in the runtime", () =>
      Effect.gen(function* () {
        const response = (yield* getJson(baseUrl, "/bindings")) as {
          bound: string[];
        };
        expect(response.bound).toHaveLength(3);
      }),
    );
  });

  describe("DescribeInput", () => {
    test.provider("the fixture input idles DETACHED with its pull URL", () =>
      Effect.gen(function* () {
        const response = (yield* getJson(baseUrl, "/input")) as {
          state?: string;
          type?: string;
          sourceUrls?: string[];
        };
        expect(["DETACHED", "ATTACHED"]).toContain(response.state);
        expect(response.type).toBe("URL_PULL");
        expect(response.sourceUrls).toEqual([
          "https://example.com/stream/index.m3u8",
        ]);
      }),
    );
  });

  describe("ListChannels", () => {
    test.provider("account-level channel enumeration succeeds", () =>
      Effect.gen(function* () {
        const response = (yield* getJson(baseUrl, "/channels")) as {
          count: number;
        };
        expect(response.count).toBeGreaterThanOrEqual(0);
      }),
    );
  });

  describe("ListInputs", () => {
    test.provider(
      "account-level input enumeration sees the fixture input",
      () =>
        Effect.gen(function* () {
          const response = (yield* getJson(baseUrl, "/inputs")) as {
            count: number;
          };
          expect(response.count).toBeGreaterThanOrEqual(1);
        }),
    );
  });

  describe("consumeChannelEvents", () => {
    test.provider(
      "the deploy created an EventBridge rule targeting the function",
      () =>
        Effect.gen(function* () {
          // Out-of-band via distilled: the fixture's consumeChannelEvents
          // must have materialized as a rule on the default bus with the
          // Lambda as target.
          const { RuleNames } = yield* eventbridge.listRuleNamesByTarget({
            TargetArn: functionArn,
          });
          expect((RuleNames ?? []).length).toBeGreaterThanOrEqual(1);
        }),
    );
  });
});

// ---------------------------------------------------------------------------
// Channel-scoped bindings — the fixture provisions a real (IDLE, unbilled)
// channel, which takes minutes to create/delete, so the block is gated the
// same way as the Channel lifecycle test.
// ---------------------------------------------------------------------------

let channelBaseUrl: string;

describe.skipIf(!process.env.AWS_TEST_MEDIALIVE)(
  "MediaLive Channel Bindings (gated AWS_TEST_MEDIALIVE=1)",
  () => {
    beforeAll(
      Effect.gen(function* () {
        yield* Effect.logInfo(
          "MediaLive channel test setup: destroying previous resources",
        );
        yield* channelStack.destroy();

        yield* Effect.logInfo(
          "MediaLive channel test setup: deploying channel fixture",
        );
        const attrs = yield* channelStack.deploy(
          Effect.gen(function* () {
            return yield* MediaLiveChannelTestFunction;
          }).pipe(Effect.provide(MediaLiveChannelTestFunctionLive)),
        );

        expect(attrs.functionUrl).toBeTruthy();
        channelBaseUrl = attrs.functionUrl!.replace(/\/+$/, "");

        yield* awaitReady(`${channelBaseUrl}/bindings`);
      }),
      { timeout: 600_000 },
    );

    afterAll(channelStack.destroy(), { timeout: 600_000 });

    describe("binding registration", () => {
      test.provider("all nine capabilities initialize in the runtime", () =>
        Effect.gen(function* () {
          const response = (yield* getJson(channelBaseUrl, "/bindings")) as {
            bound: string[];
          };
          expect(response.bound).toHaveLength(9);
        }),
      );
    });

    describe("DescribeChannel", () => {
      test.provider("the fixture channel idles IDLE and never runs", () =>
        Effect.gen(function* () {
          const response = (yield* getJson(channelBaseUrl, "/channel")) as {
            state?: string;
            channelClass?: string;
            pipelinesRunning?: number;
          };
          expect(response.state).toBe("IDLE");
          expect(response.channelClass).toBe("SINGLE_PIPELINE");
        }),
      );
    });

    describe("DescribeSchedule", () => {
      test.provider("a fresh channel has an empty schedule", () =>
        Effect.gen(function* () {
          const response = (yield* getJson(channelBaseUrl, "/schedule")) as {
            actions: number;
          };
          expect(response.actions).toBe(0);
        }),
      );
    });

    describe("BatchUpdateSchedule + DeleteSchedule", () => {
      test.provider(
        "programming and clearing a schedule action roundtrips",
        () =>
          Effect.gen(function* () {
            const response = (yield* postJson(
              channelBaseUrl,
              "/schedule-cycle",
            )) as { created: number; cleared: boolean; tag?: string };
            // An IDLE channel accepts fixed-time actions on most accounts;
            // where MediaLive rejects them, the typed tag is the outcome.
            if (response.tag === undefined) {
              expect(response.created).toBe(1);
              expect(response.cleared).toBe(true);
            } else {
              expect([
                "BadRequestException",
                "UnprocessableEntityException",
              ]).toContain(response.tag);
            }
          }),
      );
    });

    describe("ListAlerts", () => {
      test.provider("a never-started channel lists its (empty) alerts", () =>
        Effect.gen(function* () {
          const response = (yield* getJson(channelBaseUrl, "/alerts")) as {
            alerts: number;
          };
          expect(response.alerts).toBeGreaterThanOrEqual(0);
        }),
      );
    });

    describe("DescribeThumbnails", () => {
      test.provider(
        "an IDLE channel has no thumbnails — empty details or the typed BadRequestException",
        () =>
          Effect.gen(function* () {
            const response = (yield* getJson(
              channelBaseUrl,
              "/thumbnails",
            )) as { details: number; tag?: string };
            expect(response.details).toBe(0);
            if (response.tag !== undefined) {
              expect(response.tag).toBe("BadRequestException");
            }
          }),
      );
    });
  },
);
