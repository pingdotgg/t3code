import * as AWS from "@/AWS";
import * as Core from "@/Test/Core";
import * as Test from "@/Test/Alchemy";
import * as logs from "@distilled.cloud/aws/cloudwatch-logs";
import * as eventbridge from "@distilled.cloud/aws/eventbridge";
import * as im from "@distilled.cloud/aws/internetmonitor";
import { describe, expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import InternetMonitorBindingsFunctionLive, {
  InternetMonitorBindingsFunction,
} from "./handler";

const testOptions = { providers: AWS.providers() };
const { test, beforeAll, afterAll } = Test.make(testOptions);
const sharedStack = Core.scratchStack(testOptions, "InternetMonitorBindings");

// Lambda function URL cold-start (DNS, IAM propagation, init) can take well
// over 60s on a fresh deploy.
const readinessPolicy = Schedule.max([
  Schedule.fixed("2 seconds"),
  Schedule.recurs(75),
]);

let baseUrl: string;
let functionArn: string;

// beforeAll/afterAll hooks run outside `test.provider`'s layer, so raw
// distilled calls need the provider layer (credentials, region) supplied
// explicitly.
const aws = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Core.withProviders(effect, testOptions, sharedStack.name);

// Names of all monitors owned by this suite's scratch stack (matched by the
// internal `alchemy::stack` ownership tag), read fresh from the cloud.
const listStackMonitors = aws(
  im.listMonitors.items({}).pipe(
    Stream.runCollect,
    Effect.flatMap((monitors) =>
      Effect.forEach(
        Array.from(monitors),
        (monitor) =>
          im.getMonitor({ MonitorName: monitor.MonitorName }).pipe(
            Effect.map((r) =>
              r.Tags?.["alchemy::stack"] === sharedStack.name
                ? [monitor.MonitorName]
                : [],
            ),
            // Tolerate delete races between list and get.
            Effect.catchTag("ResourceNotFoundException", () =>
              Effect.succeed([] as string[]),
            ),
          ),
        { concurrency: 4 },
      ),
    ),
    Effect.map((names) => names.flat()),
  ),
);

class TransientUpstream extends Data.TaggedError("TransientUpstream")<{
  readonly status: number;
  readonly body: string;
}> {}

// The shared Lambda fixture occasionally answers a transient 5xx under load
// (cold re-init, IAM propagation on the freshly attached policy). Retry only
// 5xx; a genuine 4xx/assertion failure surfaces immediately.
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

describe.sequential("InternetMonitor Bindings", () => {
  beforeAll(
    Effect.gen(function* () {
      yield* Effect.logInfo(
        "InternetMonitor test setup: destroying previous resources",
      );
      yield* sharedStack.destroy();

      yield* Effect.logInfo("InternetMonitor test setup: deploying fixture");
      const attrs = yield* sharedStack.deploy(
        Effect.gen(function* () {
          return yield* InternetMonitorBindingsFunction;
        }).pipe(Effect.provide(InternetMonitorBindingsFunctionLive)),
      );

      expect(attrs.functionUrl).toBeTruthy();
      baseUrl = attrs.functionUrl!.replace(/\/+$/, "");
      functionArn = attrs.functionArn;

      const readinessUrl = `${baseUrl}/bindings`;
      yield* Effect.logInfo(
        `InternetMonitor test setup: probing readiness at ${readinessUrl}`,
      );
      yield* HttpClient.get(readinessUrl).pipe(
        Effect.flatMap((response) =>
          response.status === 200
            ? Effect.succeed(response)
            : Effect.fail(new Error(`Function not ready: ${response.status}`)),
        ),
        Effect.tapError((error) =>
          Effect.logWarning(
            `InternetMonitor test setup: fixture not ready yet (${String(error)})`,
          ),
        ),
        Effect.retry({ schedule: readinessPolicy }),
      );
    }),
    { timeout: 300_000 },
  );

  afterAll(
    Effect.gen(function* () {
      if (process.env.NO_DESTROY) return;
      // Capture our monitor names before destroy so the log-group reap can
      // be verified per-monitor afterwards.
      const owned = yield* listStackMonitors;
      yield* sharedStack.destroy();
      // Zero-orphan proof: no monitor tagged with this stack remains.
      const remaining = yield* listStackMonitors;
      expect(remaining).toEqual([]);
      // And the auto-created /aws/internet-monitor/{name}/* log groups were
      // reaped by the provider delete.
      const remainingLogGroups = yield* aws(
        Effect.forEach(owned, (name) =>
          logs
            .describeLogGroups({
              logGroupNamePrefix: `/aws/internet-monitor/${name}`,
            })
            .pipe(
              Effect.map((r) => (r.logGroups ?? []).map((g) => g.logGroupName)),
            ),
        ),
      );
      expect(remainingLogGroups.flat()).toEqual([]);
    }),
    { timeout: 300_000 },
  );

  describe("binding registration", () => {
    test.provider("all 8 capabilities initialize in the runtime", (_stack) =>
      Effect.gen(function* () {
        const response = (yield* getJson("/bindings")) as { bound: string[] };
        expect(response.bound).toHaveLength(8);
        expect(response.bound).toContain("listHealthEvents");
        expect(response.bound).toContain("startQuery");
        expect(response.bound).toContain("listInternetEvents");
      }),
    );
  });

  describe("ListHealthEvents", () => {
    test.provider(
      "lists health events on the bound monitor (name injected)",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* getJson("/health-events")) as {
            count: number;
          };
          // A fresh empty monitor has no health events; a zero count still
          // proves the grant + monitor-name injection round-tripped.
          expect(response.count).toBeGreaterThanOrEqual(0);
        }),
    );
  });

  describe("GetHealthEvent", () => {
    test.provider(
      "typed rejection for a nonexistent event id (grant proven)",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* getJson("/health-events/typed-probe")) as {
            tag: string;
          };
          // Any typed tag except AccessDenied proves the IAM grant reached
          // the monitor-scoped API.
          expect(response.tag).not.toBe("AccessDeniedException");
        }),
    );
  });

  describe("ListInternetEvents", () => {
    test.provider("lists global internet events (account-level)", (_stack) =>
      Effect.gen(function* () {
        const response = (yield* getJson("/internet-events")) as {
          count: number;
        };
        expect(response.count).toBeGreaterThanOrEqual(0);
      }),
    );
  });

  describe("GetInternetEvent", () => {
    test.provider(
      "typed rejection for a nonexistent event id (grant proven)",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* getJson("/internet-event/typed-probe")) as {
            tag: string;
          };
          expect(response.tag).not.toBe("AccessDeniedException");
        }),
    );
  });

  describe("StartQuery / GetQueryStatus / GetQueryResults / StopQuery", () => {
    test.provider(
      "runs a MEASUREMENTS query end-to-end on the bound monitor",
      (_stack) =>
        Effect.gen(function* () {
          type QueryResponse = {
            step: string;
            tag?: string;
            error?: string;
            queryId?: string;
            status?: string;
            fields?: number;
            rows?: number;
            stopTag?: string;
          };
          // The role policy granting internetmonitor:* is attached moments
          // before this test — IAM propagation can lag ~10-30s, surfacing as
          // AccessDeniedException from a step. Retry (bounded) until the
          // grant lands; any other failure surfaces immediately.
          const response = yield* getJson("/query").pipe(
            Effect.map((r) => r as QueryResponse),
            Effect.repeat({
              schedule: Schedule.spaced("5 seconds"),
              until: (r): boolean => r.tag !== "AccessDeniedException",
              times: 10,
            }),
          );
          // On a step failure the route reports { step, tag, error } — log
          // the full payload so the exact typed failure is never elided.
          yield* Effect.logInfo(`/query response: ${JSON.stringify(response)}`);
          expect(response).toMatchObject({ step: "ok" });
          expect(response.queryId).toBeTruthy();
          // An empty monitor's query still runs to a terminal state.
          expect(["SUCCEEDED", "FAILED", "CANCELED"]).toContain(
            response.status,
          );
          expect(response.rows).toBeGreaterThanOrEqual(0);
          expect(response.stopTag).not.toBe("AccessDeniedException");
        }),
      { timeout: 180_000 },
    );
  });

  describe("consumeHealthEvents", () => {
    test.provider(
      "the deploy created an EventBridge rule targeting the function",
      (_stack) =>
        Effect.gen(function* () {
          // Out-of-band via distilled: the fixture's consumeHealthEvents
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
