import * as AWS from "@/AWS";
import * as Core from "@/Test/Core";
import * as Test from "@/Test/Alchemy";
import * as eventbridge from "@distilled.cloud/aws/eventbridge";
import * as sts from "@distilled.cloud/aws/sts";
import { describe, expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import IVSRealtimeTestFunctionLive, {
  IVSRealtimeTestFunction,
} from "./fixtures/handler.ts";

const testOptions = { providers: AWS.providers() };
const { test, beforeAll, afterAll } = Test.make(testOptions);
const sharedStack = Core.scratchStack(testOptions, "IVSRealtimeBindings");

const readinessPolicy = Schedule.max([
  Schedule.fixed("2 seconds"),
  Schedule.recurs(60),
]);

let baseUrl: string;
let functionArn: string;

class TransientUpstream extends Data.TaggedError("TransientUpstream")<{
  readonly status: number;
  readonly body: string;
}> {}

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
        Schedule.exponential("1 second"),
        Schedule.recurs(5),
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

/** Result of a probe route: success marker or the typed error tag. */
interface Probe {
  ok?: boolean;
  found?: boolean;
  count?: number;
  tag?: string;
}

describe("IVSRealtime Bindings", () => {
  beforeAll(
    Effect.gen(function* () {
      yield* Effect.logInfo(
        "IVSRealtime test setup: destroying previous resources",
      );
      yield* sharedStack.destroy();

      yield* Effect.logInfo("IVSRealtime test setup: deploying fixture");
      const attrs = yield* sharedStack.deploy(
        Effect.gen(function* () {
          return yield* IVSRealtimeTestFunction;
        }).pipe(Effect.provide(IVSRealtimeTestFunctionLive)),
      );

      expect(attrs.functionUrl).toBeTruthy();
      baseUrl = attrs.functionUrl!.replace(/\/+$/, "");
      functionArn = attrs.functionArn;
      const readinessUrl = `${baseUrl}/ping`;

      yield* Effect.logInfo(
        `IVSRealtime test setup: probing readiness at ${readinessUrl}`,
      );
      yield* HttpClient.get(readinessUrl).pipe(
        Effect.flatMap((response) =>
          response.status === 200
            ? Effect.succeed(response)
            : Effect.fail(new Error(`Function not ready: ${response.status}`)),
        ),
        Effect.tapError((error) =>
          Effect.logWarning(
            `IVSRealtime test setup: fixture not ready yet (${String(error)})`,
          ),
        ),
        Effect.retry({ schedule: readinessPolicy }),
      );
    }),
    { timeout: 240_000 },
  );

  afterAll(sharedStack.destroy(), { timeout: 120_000 });

  describe("binding registration", () => {
    test.provider("all fourteen capabilities initialize in the runtime", () =>
      Effect.gen(function* () {
        const response = (yield* getJson("/bindings")) as { bound: string[] };
        expect(response.bound).toHaveLength(14);
      }),
    );
  });

  describe("IVSRealtime.CreateParticipantToken", () => {
    test.provider(
      "mints a redacted participant token honoring duration",
      () =>
        Effect.gen(function* () {
          const response = (yield* postJson("/token")) as {
            tokenLength: number;
            tokenIsRedacted: boolean;
            participantId?: string;
            duration?: number;
          };

          expect(response.tokenLength).toBeGreaterThan(0);
          // SensitiveString in distilled decodes to a Redacted value.
          expect(response.tokenIsRedacted).toBe(true);
          expect(response.participantId).toBeTruthy();
          // duration: "30 minutes" must reach the wire as duration: 30.
          expect(response.duration).toBe(30);
        }),
      { timeout: 120_000 },
    );
  });

  describe("IVSRealtime.ListStageSessions", () => {
    test.provider(
      "lists the fresh stage's sessions (none yet)",
      () =>
        Effect.gen(function* () {
          const response = (yield* getJson("/sessions")) as { count: number };
          expect(response.count).toBe(0);
        }),
      { timeout: 120_000 },
    );
  });

  describe("IVSRealtime.GetStageSession", () => {
    test.provider(
      "returns the typed not-found tag for a missing session",
      () =>
        Effect.gen(function* () {
          const response = (yield* getJson("/session-missing")) as Probe;
          expect([
            "ResourceNotFoundException",
            "ValidationException",
          ]).toContain(response.tag);
        }),
      { timeout: 120_000 },
    );
  });

  describe("IVSRealtime.ListParticipants", () => {
    test.provider(
      "round-trips a session-scoped list",
      () =>
        Effect.gen(function* () {
          const response = (yield* getJson("/participants")) as Probe;
          if (response.tag !== undefined) {
            expect(response.tag).toBe("ValidationException");
          } else {
            expect(response.count).toBe(0);
          }
        }),
      { timeout: 120_000 },
    );
  });

  describe("IVSRealtime.GetParticipant", () => {
    test.provider(
      "returns the typed not-found tag for a missing participant",
      () =>
        Effect.gen(function* () {
          const response = (yield* getJson("/participant-missing")) as Probe;
          expect([
            "ResourceNotFoundException",
            "ValidationException",
          ]).toContain(response.tag);
        }),
      { timeout: 120_000 },
    );
  });

  describe("IVSRealtime.ListParticipantEvents", () => {
    test.provider(
      "round-trips a participant-scoped event list",
      () =>
        Effect.gen(function* () {
          const response = (yield* getJson("/participant-events")) as Probe;
          if (response.tag !== undefined) {
            expect(response.tag).toBe("ValidationException");
          } else {
            expect(response.count).toBe(0);
          }
        }),
      { timeout: 120_000 },
    );
  });

  describe("IVSRealtime.ListParticipantReplicas", () => {
    test.provider(
      "round-trips a replica list for a missing participant",
      () =>
        Effect.gen(function* () {
          const response = (yield* getJson("/replicas")) as Probe;
          if (response.tag !== undefined) {
            expect(response.tag).toBe("ValidationException");
          } else {
            expect(response.count).toBe(0);
          }
        }),
      { timeout: 120_000 },
    );
  });

  describe("IVSRealtime.DisconnectParticipant", () => {
    test.provider(
      "round-trips a disconnect for a missing participant",
      () =>
        Effect.gen(function* () {
          const response = (yield* postJson("/disconnect")) as Probe;
          if (response.tag !== undefined) {
            expect([
              "ResourceNotFoundException",
              "ValidationException",
            ]).toContain(response.tag);
          } else {
            expect(response.ok).toBe(true);
          }
        }),
      { timeout: 120_000 },
    );
  });

  describe("IVSRealtime.StartParticipantReplication", () => {
    test.provider(
      "returns a typed rejection for a missing participant",
      () =>
        Effect.gen(function* () {
          const response = (yield* postJson("/replication-start")) as Probe;
          expect([
            "ResourceNotFoundException",
            "ValidationException",
            "ConflictException",
            "PendingVerification",
          ]).toContain(response.tag);
        }),
      { timeout: 120_000 },
    );
  });

  describe("IVSRealtime.StopParticipantReplication", () => {
    test.provider(
      "round-trips a stop for a missing participant",
      () =>
        Effect.gen(function* () {
          const response = (yield* postJson("/replication-stop")) as Probe;
          if (response.tag !== undefined) {
            expect([
              "ResourceNotFoundException",
              "ValidationException",
            ]).toContain(response.tag);
          } else {
            expect(response.ok).toBe(true);
          }
        }),
      { timeout: 120_000 },
    );
  });

  describe("IVSRealtime.ListCompositions", () => {
    test.provider(
      "lists the account's compositions",
      () =>
        Effect.gen(function* () {
          const response = (yield* getJson("/compositions")) as {
            count: number;
          };
          expect(response.count).toBeGreaterThanOrEqual(0);
        }),
      { timeout: 120_000 },
    );
  });

  describe("IVSRealtime.GetComposition", () => {
    test.provider(
      "returns the typed not-found tag for a missing composition",
      () =>
        Effect.gen(function* () {
          const region = yield* yield* AWS.Region;
          const { Account } = yield* sts.getCallerIdentity({});
          const arn = `arn:aws:ivs:${region}:${Account}:composition/AbCdEfGh1234`;
          const response = (yield* getJson(
            `/composition-missing?arn=${encodeURIComponent(arn)}`,
          )) as Probe;
          expect([
            "ResourceNotFoundException",
            "ValidationException",
          ]).toContain(response.tag);
        }),
      { timeout: 120_000 },
    );
  });

  describe("IVSRealtime.StopComposition", () => {
    test.provider(
      "returns the typed not-found tag for a missing composition",
      () =>
        Effect.gen(function* () {
          const region = yield* yield* AWS.Region;
          const { Account } = yield* sts.getCallerIdentity({});
          const arn = `arn:aws:ivs:${region}:${Account}:composition/AbCdEfGh1234`;
          const response = (yield* postJson(
            `/composition-stop?arn=${encodeURIComponent(arn)}`,
          )) as Probe;
          expect([
            "ResourceNotFoundException",
            "ValidationException",
          ]).toContain(response.tag);
        }),
      { timeout: 120_000 },
    );
  });

  describe("IVSRealtime.StartComposition", () => {
    test.provider(
      "returns a typed rejection for a missing storage configuration",
      () =>
        Effect.gen(function* () {
          const region = yield* yield* AWS.Region;
          const { Account } = yield* sts.getCallerIdentity({});
          const arn = `arn:aws:ivs:${region}:${Account}:storage-configuration/AbCdEfGh1234`;
          const response = (yield* postJson(
            `/composition-start?arn=${encodeURIComponent(arn)}`,
          )) as Probe;
          expect([
            "ResourceNotFoundException",
            "ValidationException",
            "PendingVerification",
          ]).toContain(response.tag);
        }),
      { timeout: 120_000 },
    );
  });

  describe("consumeStageEvents", () => {
    test.provider(
      "the deploy created an EventBridge rule targeting the function",
      () =>
        Effect.gen(function* () {
          // Out-of-band via distilled: the fixture's consumeStageEvents must
          // have materialized as a rule on the default bus with the Lambda
          // as target.
          const { RuleNames } = yield* eventbridge.listRuleNamesByTarget({
            TargetArn: functionArn,
          });
          expect((RuleNames ?? []).length).toBeGreaterThanOrEqual(1);
        }),
      { timeout: 120_000 },
    );
  });
});
