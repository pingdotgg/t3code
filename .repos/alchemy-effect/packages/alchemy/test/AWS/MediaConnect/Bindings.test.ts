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
import MediaConnectTestFunctionLive, {
  MediaConnectTestFunction,
} from "./fixtures/handler";

const testOptions = { providers: AWS.providers() };
const { test, beforeAll, afterAll } = Test.make(testOptions);
const sharedStack = Core.scratchStack(testOptions, "MediaConnectBindings");

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

describe.sequential("MediaConnect Bindings", () => {
  beforeAll(
    Effect.gen(function* () {
      yield* Effect.logInfo(
        "MediaConnect test setup: destroying previous resources",
      );
      yield* sharedStack.destroy();

      yield* Effect.logInfo("MediaConnect test setup: deploying fixture");
      const attrs = yield* sharedStack.deploy(
        Effect.gen(function* () {
          return yield* MediaConnectTestFunction;
        }).pipe(Effect.provide(MediaConnectTestFunctionLive)),
      );

      expect(attrs.functionUrl).toBeTruthy();
      baseUrl = attrs.functionUrl!.replace(/\/+$/, "");
      functionArn = attrs.functionArn;

      const readinessUrl = `${baseUrl}/bindings`;
      yield* Effect.logInfo(
        `MediaConnect test setup: probing readiness at ${readinessUrl}`,
      );
      yield* HttpClient.get(readinessUrl).pipe(
        Effect.flatMap((response) =>
          response.status === 200
            ? Effect.succeed(response)
            : Effect.fail(new Error(`Function not ready: ${response.status}`)),
        ),
        Effect.tapError((error) =>
          Effect.logWarning(
            `MediaConnect test setup: fixture not ready yet (${String(error)})`,
          ),
        ),
        Effect.retry({ schedule: readinessPolicy }),
      );
    }),
    { timeout: 300_000 },
  );

  afterAll(sharedStack.destroy(), { timeout: 240_000 });

  describe("binding registration", () => {
    test.provider("all nine capabilities initialize in the runtime", () =>
      Effect.gen(function* () {
        const response = (yield* getJson("/bindings")) as { bound: string[] };
        expect(response.bound).toHaveLength(9);
      }),
    );
  });

  describe("DescribeFlow", () => {
    test.provider("the fixture flow idles in STANDBY", () =>
      Effect.gen(function* () {
        const response = (yield* getJson("/flow")) as {
          status?: string;
          sourceName?: string;
        };
        expect(response.status).toBe("STANDBY");
        expect(response.sourceName).toBe("primary");
      }),
    );
  });

  describe("DescribeFlowSourceMetadata", () => {
    test.provider(
      "an idle flow has no programs — only messages or the typed BadRequestException",
      () =>
        Effect.gen(function* () {
          const response = (yield* getJson("/source-metadata")) as {
            programs: number;
            messages: number;
            tag?: string;
          };
          expect(response.programs).toBe(0);
          if (response.tag !== undefined) {
            expect(response.tag).toBe("BadRequestException");
          }
        }),
    );
  });

  describe("DescribeFlowSourceThumbnail", () => {
    test.provider(
      "an idle flow has no thumbnail image — only messages or the typed BadRequestException",
      () =>
        Effect.gen(function* () {
          const response = (yield* getJson("/thumbnail")) as {
            hasImage: boolean;
            messages: number;
            tag?: string;
          };
          expect(response.hasImage).toBe(false);
          if (response.tag !== undefined) {
            expect(response.tag).toBe("BadRequestException");
          }
        }),
    );
  });

  describe("ListFlows", () => {
    test.provider("account-level flow enumeration sees the fixture flow", () =>
      Effect.gen(function* () {
        const response = (yield* getJson("/flows")) as { count: number };
        expect(response.count).toBeGreaterThanOrEqual(1);
      }),
    );
  });

  describe("ListEntitlements", () => {
    test.provider("account-level entitlement enumeration succeeds", () =>
      Effect.gen(function* () {
        const response = (yield* getJson("/entitlements")) as {
          count: number;
        };
        expect(response.count).toBeGreaterThanOrEqual(0);
      }),
    );
  });

  describe("StopFlow", () => {
    test.provider(
      "stopping a STANDBY flow is the typed BadRequestException",
      () =>
        Effect.gen(function* () {
          const response = (yield* postJson("/stop")) as {
            status?: string;
            tag?: string;
          };
          expect(response.tag).toBe("BadRequestException");
          expect(response.status).toBeUndefined();
        }),
    );
  });

  describe("GrantFlowEntitlements + RevokeFlowEntitlement", () => {
    test.provider("granting and revoking an entitlement roundtrips", () =>
      Effect.gen(function* () {
        const response = (yield* postJson("/entitlement-cycle")) as {
          granted: boolean;
          revoked: boolean;
          tag?: string;
        };
        // A failure surfaces its typed tag in the response for diagnosis.
        expect(response.tag).toBeUndefined();
        expect(response.granted).toBe(true);
        expect(response.revoked).toBe(true);
      }),
    );
  });

  describe("StartFlow", () => {
    // An ACTIVE flow bills for transport by the hour, so the start/stop
    // roundtrip only runs when explicitly enabled.
    test.provider.skipIf(!process.env.AWS_TEST_MEDIACONNECT)(
      "start/stop roundtrip returns the flow to rest",
      () =>
        Effect.gen(function* () {
          const response = (yield* postJson("/start-stop")) as {
            startStatus?: string;
            stopStatus?: string;
          };
          expect(["STARTING", "ACTIVE"]).toContain(response.startStatus);
          expect(["STOPPING", "STANDBY"]).toContain(response.stopStatus);
        }),
      { timeout: 150_000 },
    );
  });

  describe("consumeFlowEvents", () => {
    test.provider(
      "the deploy created an EventBridge rule targeting the function",
      () =>
        Effect.gen(function* () {
          // Out-of-band via distilled: the fixture's consumeFlowEvents
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
