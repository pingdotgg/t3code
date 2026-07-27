import * as AWS from "@/AWS";
import * as Core from "@/Test/Core";
import * as Test from "@/Test/Alchemy";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import RumBindingsFunctionLive, { RumBindingsFunction } from "./handler";

const testOptions = { providers: AWS.providers() };
const { test, beforeAll, afterAll } = Test.make(testOptions);
const sharedStack = Core.scratchStack(testOptions, "RumBindings");

// Lambda function URL cold-start (DNS, IAM propagation, init) can take well
// over 60s on a fresh deploy.
const readinessPolicy = Schedule.max([
  Schedule.fixed("2 seconds"),
  Schedule.recurs(75),
]);

let baseUrl: string;

const getJson = (path: string) =>
  HttpClient.get(`${baseUrl}${path}`).pipe(Effect.flatMap((r) => r.json));

const postJson = (path: string) =>
  HttpClient.execute(HttpClientRequest.post(`${baseUrl}${path}`)).pipe(
    Effect.flatMap((r) => r.json),
  );

interface TagResponse {
  tag: string;
  error?: string;
  count?: number;
}

// The role policy granting rum:* on the monitor is attached moments before
// the first request — IAM propagation can lag ~10-30s, surfacing as
// AccessDeniedException. Retry (bounded) until the grant lands; any other
// tag surfaces immediately for assertion.
const untilGranted = <E, R>(request: Effect.Effect<unknown, E, R>) =>
  request.pipe(
    Effect.map((r) => r as TagResponse),
    Effect.repeat({
      schedule: Schedule.spaced("5 seconds"),
      until: (r): boolean => r.tag !== "AccessDeniedException",
      times: 10,
    }),
  );

describe.sequential("RUM Bindings", () => {
  beforeAll(
    Effect.gen(function* () {
      yield* Effect.logInfo("RUM test setup: destroying previous resources");
      yield* sharedStack.destroy();

      yield* Effect.logInfo("RUM test setup: deploying fixture");
      const attrs = yield* sharedStack.deploy(
        Effect.gen(function* () {
          return yield* RumBindingsFunction;
        }).pipe(Effect.provide(RumBindingsFunctionLive)),
      );

      expect(attrs.functionUrl).toBeTruthy();
      baseUrl = attrs.functionUrl!.replace(/\/+$/, "");

      yield* Effect.logInfo("RUM test setup: probing readiness");
      yield* HttpClient.get(`${baseUrl}/bindings`).pipe(
        Effect.flatMap((response) =>
          response.status === 200
            ? Effect.succeed(response)
            : Effect.fail(new Error(`Function not ready: ${response.status}`)),
        ),
        Effect.retry({ schedule: readinessPolicy }),
      );
    }),
    { timeout: 300_000 },
  );

  afterAll(process.env.NO_DESTROY ? Effect.void : sharedStack.destroy(), {
    timeout: 300_000,
  });

  describe("binding registration", () => {
    test.provider("both capabilities initialize in the runtime", (_stack) =>
      Effect.gen(function* () {
        const response = (yield* getJson("/bindings")) as { bound: string[] };
        expect(response.bound).toHaveLength(2);
        expect(response.bound).toContain("putRumEvents");
        expect(response.bound).toContain("getAppMonitorData");
      }),
    );
  });

  describe("PutRumEvents", () => {
    test.provider(
      "sends a session's events to the data-plane endpoint",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* untilGranted(
            postJson("/events"),
          )) as TagResponse;
          yield* Effect.logInfo(
            `/events response: ${JSON.stringify(response)}`,
          );
          // "ok" proves the dataplane host prefix, the id/details injection,
          // and the rum:PutRumEvents grant all round-tripped. On failure the
          // route's error string surfaces in the assertion diff.
          expect(response.error ?? response.tag).toBe("ok");
        }),
      { timeout: 120_000 },
    );
  });

  describe("GetAppMonitorData", () => {
    test.provider(
      "reads the trailing hour of events (name injected)",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* untilGranted(
            getJson("/data"),
          )) as TagResponse;
          yield* Effect.logInfo(`/data response: ${JSON.stringify(response)}`);
          expect(response.error ?? response.tag).toBe("ok");
          // Ingested events surface asynchronously (minutes) — a zero count
          // still proves the grant + monitor-name injection round-tripped.
          expect(response.count).toBeGreaterThanOrEqual(0);
        }),
      { timeout: 120_000 },
    );
  });
});
