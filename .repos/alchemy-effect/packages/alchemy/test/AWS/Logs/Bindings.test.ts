import * as AWS from "@/AWS";
import * as Core from "@/Test/Core";
import * as Test from "@/Test/Alchemy";
import { describe, expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import LogsTestFunctionLive, { LogsTestFunction } from "./handler.ts";

const testOptions = { providers: AWS.providers() };
const { test, beforeAll, afterAll } = Test.make(testOptions);
const sharedStack = Core.scratchStack(testOptions, "LogsBindings");

// Lambda function URL cold-start (DNS, IAM propagation, init) can take well
// over 60s on a fresh deploy under parallel-suite load. Budget ~150s of
// readiness polling.
const readinessPolicy = Schedule.max([
  Schedule.fixed("2 seconds"),
  Schedule.recurs(75),
]);

let baseUrl: string;

class TransientUpstream extends Data.TaggedError("TransientUpstream")<{
  readonly status: number;
  readonly body: string;
}> {}

class MarkerNotVisible extends Data.TaggedError("MarkerNotVisible")<{
  readonly marker: string;
}> {}

// The shared Lambda fixture occasionally answers a transient 5xx under
// parallel load (cold re-init, IAM propagation). Retry 5xx only; a genuine
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

const putMarker = (marker: string) =>
  send(HttpClientRequest.post(`${baseUrl}/put?message=${marker}`)).pipe(
    Effect.flatMap((r) => r.json),
  );

// FilterLogEvents observes freshly-ingested events after a short delay —
// poll bounded (~40s).
const filterUntilVisible = (marker: string) =>
  send(HttpClientRequest.get(`${baseUrl}/filter?pattern=${marker}`)).pipe(
    Effect.flatMap((r) => r.json),
    Effect.flatMap((body) => {
      const messages = (body as { messages: (string | undefined)[] }).messages;
      return messages.some((message) => message?.includes(marker))
        ? Effect.succeed(messages)
        : Effect.fail(new MarkerNotVisible({ marker }));
    }),
    Effect.retry({
      while: (e) => e._tag === "MarkerNotVisible",
      schedule: Schedule.max([
        Schedule.fixed("2 seconds"),
        Schedule.recurs(20),
      ]),
    }),
  );

describe("Logs Bindings", () => {
  beforeAll(
    Effect.gen(function* () {
      yield* Effect.logInfo("Logs test setup: destroying previous resources");
      yield* sharedStack.destroy();

      yield* Effect.logInfo("Logs test setup: deploying fixture");
      const { functionUrl } = yield* sharedStack.deploy(
        Effect.gen(function* () {
          return yield* LogsTestFunction;
        }).pipe(Effect.provide(LogsTestFunctionLive)),
      );

      expect(functionUrl).toBeTruthy();
      baseUrl = functionUrl!.replace(/\/+$/, "");
      const readinessUrl = `${baseUrl}/get-events`;

      yield* Effect.logInfo(
        `Logs test setup: probing readiness at ${readinessUrl}`,
      );
      yield* HttpClient.get(readinessUrl).pipe(
        Effect.flatMap((response) =>
          response.status === 200
            ? Effect.succeed(response)
            : Effect.fail(new Error(`Function not ready: ${response.status}`)),
        ),
        Effect.tapError((error) =>
          Effect.logWarning(
            `Logs test setup: fixture not ready yet (${String(error)})`,
          ),
        ),
        Effect.retry({ schedule: readinessPolicy }),
      );
    }),
    { timeout: 240_000 },
  );

  afterAll.skipIf(!!process.env.NO_DESTROY)(sharedStack.destroy(), {
    timeout: 120_000,
  });

  describe("PutLogEvents", () => {
    test.provider("writes a log event through the binding", (_stack) =>
      Effect.gen(function* () {
        const marker = `put-${crypto.randomUUID()}`;
        const response = yield* putMarker(marker);
        expect((response as any).ok).toBe(true);
        expect((response as any).rejected).toBeNull();
      }),
    );
  });

  describe("FilterLogEvents", () => {
    test.provider(
      "round-trips a marker written by the fixture",
      (_stack) =>
        Effect.gen(function* () {
          const marker = `filter-${crypto.randomUUID()}`;
          yield* putMarker(marker);
          const messages = yield* filterUntilVisible(marker);
          expect(messages.some((m) => m?.includes(marker))).toBe(true);
        }),
      { timeout: 90_000 },
    );
  });

  describe("GetLogEvents", () => {
    test.provider(
      "reads events back from the bound stream",
      (_stack) =>
        Effect.gen(function* () {
          const marker = `get-${crypto.randomUUID()}`;
          yield* putMarker(marker);

          const messages = yield* send(
            HttpClientRequest.get(`${baseUrl}/get-events`),
          ).pipe(
            Effect.flatMap((r) => r.json),
            Effect.flatMap((body) => {
              const found = (body as { messages: (string | undefined)[] })
                .messages;
              return found.some((message) => message?.includes(marker))
                ? Effect.succeed(found)
                : Effect.fail(new MarkerNotVisible({ marker }));
            }),
            Effect.retry({
              while: (e) => e._tag === "MarkerNotVisible",
              schedule: Schedule.max([
                Schedule.fixed("2 seconds"),
                Schedule.recurs(20),
              ]),
            }),
          );
          expect(messages.some((m) => m?.includes(marker))).toBe(true);
        }),
      { timeout: 90_000 },
    );
  });

  describe("StartQuery", () => {
    test.provider(
      "starts an Insights query scoped to the bound group",
      (_stack) =>
        Effect.gen(function* () {
          const response = yield* send(
            HttpClientRequest.get(`${baseUrl}/query`),
          ).pipe(Effect.flatMap((r) => r.json));
          expect((response as any).queryId).toBeTruthy();
        }),
      { timeout: 90_000 },
    );
  });

  describe("GetQueryResults", () => {
    test.provider(
      "polls the started query to completion",
      (_stack) =>
        Effect.gen(function* () {
          const response = yield* send(
            HttpClientRequest.get(`${baseUrl}/query`),
          ).pipe(Effect.flatMap((r) => r.json));
          expect((response as any).status).toBe("Complete");
          expect((response as any).resultCount).toBeGreaterThanOrEqual(0);
        }),
      { timeout: 90_000 },
    );
  });

  describe("StopQuery", () => {
    test.provider(
      "stops (or observes completion of) a started query",
      (_stack) =>
        Effect.gen(function* () {
          const response = yield* send(
            HttpClientRequest.get(`${baseUrl}/stop-query`),
          ).pipe(Effect.flatMap((r) => r.json));
          const body = response as {
            ok: boolean;
            stopped: boolean;
            error: string | null;
          };
          expect(body.ok).toBe(true);
          // Either the stop landed, or a benign completion/registration race
          // surfaced as one of the two typed tags — anything else (e.g.
          // AccessDenied) dies in the fixture and fails the request.
          expect(
            body.stopped === true ||
              body.error === "InvalidParameterException" ||
              body.error === "ResourceNotFoundException",
          ).toBe(true);
        }),
      { timeout: 90_000 },
    );
  });

  describe("GetLogRecord", () => {
    test.provider(
      "fetches the full record behind a query-result @ptr",
      (_stack) =>
        Effect.gen(function* () {
          const marker = `record-${crypto.randomUUID()}`;
          yield* putMarker(marker);
          // Insights sees freshly-ingested events after a short delay —
          // poll the query route until it returns rows (bounded, ~60s).
          const ptr = yield* send(
            HttpClientRequest.get(`${baseUrl}/query`),
          ).pipe(
            Effect.flatMap((r) => r.json),
            Effect.flatMap((body) => {
              const found = (body as { ptr: string | null }).ptr;
              return found
                ? Effect.succeed(found)
                : Effect.fail(new MarkerNotVisible({ marker }));
            }),
            Effect.retry({
              while: (e) => e._tag === "MarkerNotVisible",
              schedule: Schedule.max([
                Schedule.fixed("5 seconds"),
                Schedule.recurs(10),
              ]),
            }),
          );

          const record = yield* send(
            HttpClientRequest.get(
              `${baseUrl}/record?ptr=${encodeURIComponent(ptr)}`,
            ),
          ).pipe(Effect.flatMap((r) => r.json));
          expect((record as any).message).toBeTruthy();
        }),
      { timeout: 180_000 },
    );
  });

  describe("GetLogGroupFields", () => {
    test.provider(
      "discovers fields present in the bound group",
      (_stack) =>
        Effect.gen(function* () {
          const marker = `fields-${crypto.randomUUID()}`;
          yield* putMarker(marker);
          const response = yield* send(
            HttpClientRequest.get(`${baseUrl}/fields`),
          ).pipe(Effect.flatMap((r) => r.json));
          expect(Array.isArray((response as any).fields)).toBe(true);
        }),
      { timeout: 90_000 },
    );
  });

  describe("DescribeLogStreams", () => {
    test.provider(
      "lists the streams of the bound group",
      (_stack) =>
        Effect.gen(function* () {
          const response = yield* send(
            HttpClientRequest.get(`${baseUrl}/streams`),
          ).pipe(Effect.flatMap((r) => r.json));
          const streams = (response as { streams: string[] }).streams;
          expect(streams).toContain("alchemy-test-bindings-stream");
        }),
      { timeout: 90_000 },
    );
  });

  describe("CreateLogStream + DeleteLogStream", () => {
    test.provider(
      "creates and deletes a dynamic stream through the bindings",
      (_stack) =>
        Effect.gen(function* () {
          const name = "alchemy-test-bindings-dynamic-stream";
          const response = yield* send(
            HttpClientRequest.post(`${baseUrl}/stream-lifecycle?name=${name}`),
          ).pipe(Effect.flatMap((r) => r.json));
          expect((response as any).seen).toBe(true);
          expect((response as any).gone).toBe(true);
        }),
      { timeout: 90_000 },
    );
  });
});
