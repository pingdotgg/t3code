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
import IvsTestFunctionLive, { IvsTestFunction } from "./fixtures/handler";

const testOptions = { providers: AWS.providers() };
const { test, beforeAll, afterAll } = Test.make(testOptions);
const sharedStack = Core.scratchStack(testOptions, "IVSBindings");

// Lambda function URL cold-start (DNS, IAM propagation, init) can take well
// over 60s on a fresh deploy.
const readinessPolicy = Schedule.max([
  Schedule.fixed("2 seconds"),
  Schedule.recurs(75),
]);

let baseUrl: string;
let functionArn: string;

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

const getJson = (path: string) =>
  send(HttpClientRequest.get(`${baseUrl}${path}`)).pipe(
    Effect.flatMap((r) => r.json),
  );

const postJson = (path: string) =>
  send(HttpClientRequest.post(`${baseUrl}${path}`)).pipe(
    Effect.flatMap((r) => r.json),
  );

describe.sequential("IVS Bindings", () => {
  beforeAll(
    Effect.gen(function* () {
      yield* Effect.logInfo("IVS test setup: destroying previous resources");
      yield* sharedStack.destroy();

      yield* Effect.logInfo("IVS test setup: deploying fixture");
      const attrs = yield* sharedStack.deploy(
        Effect.gen(function* () {
          return yield* IvsTestFunction;
        }).pipe(Effect.provide(IvsTestFunctionLive)),
      );

      expect(attrs.functionUrl).toBeTruthy();
      baseUrl = attrs.functionUrl!.replace(/\/+$/, "");
      functionArn = attrs.functionArn;

      const readinessUrl = `${baseUrl}/bindings`;
      yield* Effect.logInfo(
        `IVS test setup: probing readiness at ${readinessUrl}`,
      );
      yield* HttpClient.get(readinessUrl).pipe(
        Effect.flatMap((response) =>
          response.status === 200
            ? Effect.succeed(response)
            : Effect.fail(new Error(`Function not ready: ${response.status}`)),
        ),
        Effect.tapError((error) =>
          Effect.logWarning(
            `IVS test setup: fixture not ready yet (${String(error)})`,
          ),
        ),
        Effect.retry({ schedule: readinessPolicy }),
      );
    }),
    { timeout: 240_000 },
  );

  afterAll(sharedStack.destroy(), { timeout: 120_000 });

  describe("binding registration", () => {
    test.provider("all nine capabilities initialize in the runtime", () =>
      Effect.gen(function* () {
        const response = (yield* getJson("/bindings")) as { bound: string[] };
        expect(response.bound).toHaveLength(9);
      }),
    );
  });

  describe("GetStream", () => {
    test.provider(
      "an idle channel answers with the typed ChannelNotBroadcasting",
      () =>
        Effect.gen(function* () {
          const response = (yield* getJson("/stream")) as {
            live: boolean;
            viewers: number;
          };
          expect(response.live).toBe(false);
          expect(response.viewers).toBe(0);
        }),
    );
  });

  describe("GetStreamSession", () => {
    test.provider("a never-broadcast channel has no latest session", () =>
      Effect.gen(function* () {
        const response = (yield* getJson("/session")) as { found: boolean };
        expect(response.found).toBe(false);
      }),
    );
  });

  describe("ListStreamSessions", () => {
    test.provider("the idle channel's session history is empty", () =>
      Effect.gen(function* () {
        const response = (yield* getJson("/sessions")) as { count: number };
        expect(response.count).toBe(0);
      }),
    );
  });

  describe("ListStreams", () => {
    test.provider("account-level live-stream enumeration succeeds", () =>
      Effect.gen(function* () {
        const response = (yield* getJson("/streams")) as { count: number };
        expect(response.count).toBeGreaterThanOrEqual(0);
      }),
    );
  });

  describe("PutMetadata", () => {
    test.provider(
      "inserting metadata into an idle stream is the typed ChannelNotBroadcasting",
      () =>
        Effect.gen(function* () {
          const response = (yield* postJson("/metadata")) as {
            inserted: boolean;
            tag?: string;
          };
          expect(response.inserted).toBe(false);
          expect(response.tag).toBe("ChannelNotBroadcasting");
        }),
    );
  });

  describe("StopStream", () => {
    test.provider(
      "stopping an idle channel is the typed ChannelNotBroadcasting",
      () =>
        Effect.gen(function* () {
          const response = (yield* postJson("/stop")) as {
            stopped: boolean;
            tag?: string;
          };
          expect(response.stopped).toBe(false);
          expect(response.tag).toBe("ChannelNotBroadcasting");
        }),
    );
  });

  describe("StartViewerSessionRevocation", () => {
    test.provider("revoking a viewer session succeeds", () =>
      Effect.gen(function* () {
        const response = (yield* postJson("/revoke")) as {
          ok: boolean;
          tag?: string;
        };
        expect(response.ok).toBe(true);
      }),
    );
  });

  describe("InsertAdBreak", () => {
    test.provider(
      "inserting an ad break into an idle stream is a typed failure",
      () =>
        Effect.gen(function* () {
          const response = (yield* postJson("/adbreak")) as {
            inserted: boolean;
            tag?: string;
          };
          expect(response.inserted).toBe(false);
          expect([
            "ChannelNotBroadcasting",
            "ValidationException",
            "ConflictException",
          ]).toContain(response.tag);
        }),
    );
  });

  describe("BatchStartViewerSessionRevocation", () => {
    test.provider(
      "batch-revoking a viewer session reports no per-pair errors",
      () =>
        Effect.gen(function* () {
          const response = (yield* postJson("/revoke-batch")) as {
            errorCount: number;
          };
          expect(response.errorCount).toBe(0);
        }),
    );
  });

  describe("consumeStreamEvents", () => {
    test.provider(
      "the deploy created an EventBridge rule targeting the function",
      () =>
        Effect.gen(function* () {
          // Out-of-band via distilled: the fixture's consumeStreamEvents
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
