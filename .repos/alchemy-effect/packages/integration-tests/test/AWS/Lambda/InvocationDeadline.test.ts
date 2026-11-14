import { makeFunctionHttpHandler } from "@alchemy.run/aws/Lambda/HttpServer";
import {
  DEFAULT_TIMEOUT_MARGIN_MS,
  HandlerContext,
  InvocationDeadlineState,
  lambdaTimeoutOf,
  readTimeoutGrace,
  TIMEOUT_GRACE_ENV,
  toDurationMillis,
  withInvocationDeadline,
} from "@alchemy.run/aws/Lambda/InvocationDeadline";
import { describe, expect, it } from "@alchemy.run/test";
import type * as lambda from "aws-lambda";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as TestClock from "effect/testing/TestClock";

describe(
  "readTimeoutGrace",
  { tags: ["unit", "provider:aws", "provider:aws:lambda", "local"] },
  () => {
    it("never interrupts when unset, empty or unparseable", () => {
      expect(readTimeoutGrace(undefined)).toBe(0);
      expect(readTimeoutGrace("")).toBe(0);
      expect(readTimeoutGrace("abc")).toBe(0);
      expect(readTimeoutGrace("-1")).toBe(0);
    });

    it("parses whole milliseconds", () => {
      expect(readTimeoutGrace("0")).toBe(0);
      expect(readTimeoutGrace("1500")).toBe(1500);
      expect(readTimeoutGrace("250.9")).toBe(250);
    });
  },
);

describe(
  "toDurationMillis",
  { tags: ["unit", "provider:aws", "provider:aws:lambda", "local"] },
  () => {
    it("returns undefined for undefined", () => {
      expect(toDurationMillis(undefined)).toBeUndefined();
    });

    it("converts a Duration to whole milliseconds", () => {
      expect(toDurationMillis(Duration.zero)).toBe(0);
      expect(toDurationMillis(Duration.millis(250))).toBe(250);
      expect(toDurationMillis(Duration.seconds(1))).toBe(1000);
      expect(toDurationMillis(Duration.infinity)).toBeUndefined();
    });

    it("converts a state-JSON rehydrated Duration", () => {
      const json = JSON.parse(JSON.stringify(Duration.millis(750))) as Duration.Duration;
      expect(toDurationMillis(json)).toBe(750);
    });
  },
);

describe(
  "lambdaTimeoutOf",
  { tags: ["unit", "provider:aws", "provider:aws:lambda", "local"] },
  () => {
    const run = (props: Omit<Parameters<typeof lambdaTimeoutOf>[0], "id">) =>
      Effect.runSync(Effect.result(lambdaTimeoutOf({ id: "Fn", ...props })));

    it("adds the default margin to the default timeout", () => {
      expect(DEFAULT_TIMEOUT_MARGIN_MS).toBe(1000);
      expect(run({ timeout: undefined, timeoutMargin: undefined, interrupt: true })).toMatchObject({
        success: { timeoutSeconds: 4, graceMs: 1000 },
      });
    });

    it("interrupts at the exact timeout; Lambda's timeout rounds up", () => {
      expect(
        run({
          timeout: Duration.millis(2500),
          timeoutMargin: Duration.millis(200),
          interrupt: true,
        }),
      ).toMatchObject({ success: { timeoutSeconds: 3, graceMs: 500 } });
    });

    it("configures the timeout as-is when the handler is never interrupted", () => {
      expect(
        run({ timeout: Duration.millis(2500), timeoutMargin: undefined, interrupt: false }),
      ).toMatchObject({ success: { timeoutSeconds: 3, graceMs: 0 } });
      expect(
        run({ timeout: Duration.seconds(60), timeoutMargin: Duration.zero, interrupt: true }),
      ).toMatchObject({ success: { timeoutSeconds: 60, graceMs: 0 } });
      expect(
        run({ timeout: Duration.seconds(900), timeoutMargin: undefined, interrupt: false }),
      ).toMatchObject({ success: { timeoutSeconds: 900, graceMs: 0 } });
    });

    it("rejects a timeout whose margin does not fit in 900 seconds", () => {
      const result = run({
        timeout: Duration.seconds(900),
        timeoutMargin: undefined,
        interrupt: true,
      });
      expect(result).toMatchObject({
        failure: { _tag: "AWS.Lambda.FunctionTimeoutTooLong", timeoutMs: 900_000, marginMs: 1000 },
      });
      expect(
        run({ timeout: Duration.seconds(899), timeoutMargin: undefined, interrupt: true }),
      ).toMatchObject({ success: { timeoutSeconds: 900, graceMs: 1000 } });
    });
  },
);

// A Lambda context whose hard timeout is `remainingMs` away. The guard reads
// it once, when the invocation starts.
const makeContext = (remainingMs: number): lambda.Context =>
  ({
    functionName: "deadline-fn",
    awsRequestId: "req-1",
    getRemainingTimeInMillis: () => remainingMs,
  }) as lambda.Context;

// Runs `self` under the deadline guard with Lambda's timeout `remainingMs`
// away and `graceMs` of it reserved past the Function's timeout. `state` is
// the dispatcher's per-invocation deadline state.
const guarded = <A, E>(
  self: Effect.Effect<A, E>,
  { remainingMs, graceMs }: { remainingMs: number; graceMs: number },
  options?: { interrupt?: boolean },
  state: { fired: boolean } = { fired: false },
) =>
  Effect.gen(function* () {
    process.env[TIMEOUT_GRACE_ENV] = String(graceMs);
    return yield* self.pipe(
      withInvocationDeadline(options),
      Effect.provideService(HandlerContext, makeContext(remainingMs)),
      Effect.provideService(InvocationDeadlineState, state),
      Effect.ensuring(Effect.sync(() => delete process.env[TIMEOUT_GRACE_ENV])),
      Effect.exit,
      Effect.forkChild,
    );
  });

describe(
  "withInvocationDeadline",
  // Sets the grace env var, which the guard reads per invocation.
  { tags: ["unit", "provider:aws", "provider:aws:lambda", "local"] },
  () => {
    it.effect(
      "leaves a handler that finishes inside its timeout untouched",
      () =>
        Effect.gen(function* () {
          const state = { fired: false };
          const fiber = yield* guarded(
            Effect.sleep("2 seconds").pipe(Effect.as("done")),
            { remainingMs: 4000, graceMs: 1000 },
            undefined,
            state,
          );
          yield* TestClock.adjust("2 seconds");
          expect(yield* Fiber.join(fiber)).toEqual(Exit.succeed("done"));
          expect(state.fired).toBe(false);
        }),
      { exclusive: true },
    );

    it.effect(
      "interrupts a handler at its timeout and runs its finalizers",
      () =>
        Effect.gen(function* () {
          const events: string[] = [];
          const state = { fired: false };
          const fiber = yield* guarded(
            Effect.never.pipe(
              Effect.ensuring(Effect.sync(() => events.push("finalizer"))),
              Effect.onInterrupt(() => Effect.sync(() => events.push("interrupted"))),
            ),
            { remainingMs: 4000, graceMs: 1000 },
            undefined,
            state,
          );
          yield* TestClock.adjust("2999 millis");
          expect(events).toEqual([]);
          yield* TestClock.adjust("1 millis");
          const exit = yield* Fiber.join(fiber);
          expect(events).toEqual(["finalizer", "interrupted"]);
          // The dispatcher holds a fired invocation until Lambda's timeout.
          expect(state.fired).toBe(true);
          expect(exit).toMatchObject({
            _tag: "Failure",
            cause: {
              reasons: [
                {
                  _tag: "Fail",
                  error: { _tag: "AWS.Lambda.InvocationTimeoutError", budgetMs: 3000 },
                },
              ],
            },
          });
        }),
      { exclusive: true },
    );

    it.effect(
      "never interrupts a handler without grace",
      () =>
        Effect.gen(function* () {
          const fiber = yield* guarded(Effect.sleep("3500 millis").pipe(Effect.as("done")), {
            remainingMs: 4000,
            graceMs: 0,
          });
          yield* TestClock.adjust("3500 millis");
          expect(yield* Fiber.join(fiber)).toEqual(Exit.succeed("done"));
        }),
      { exclusive: true },
    );

    it.effect(
      "never interrupts a handler that opts out",
      () =>
        Effect.gen(function* () {
          const fiber = yield* guarded(
            Effect.sleep("3500 millis").pipe(Effect.as("done")),
            { remainingMs: 4000, graceMs: 1000 },
            { interrupt: false },
          );
          yield* TestClock.adjust("3500 millis");
          expect(yield* Fiber.join(fiber)).toEqual(Exit.succeed("done"));
        }),
      { exclusive: true },
    );

    it.effect(
      "an inner guard that opts out stands the outer one down",
      () =>
        Effect.gen(function* () {
          const fiber = yield* guarded(
            Effect.sleep("3500 millis").pipe(
              Effect.as("done"),
              withInvocationDeadline({ interrupt: false }),
            ),
            { remainingMs: 4000, graceMs: 1000 },
          );
          yield* TestClock.adjust("3500 millis");
          expect(yield* Fiber.join(fiber)).toEqual(Exit.succeed("done"));
        }),
      { exclusive: true },
    );

    it.effect(
      "fails an HTTP request that runs past its timeout after its finalizers",
      () =>
        Effect.gen(function* () {
          const events: string[] = [];
          const handler = Effect.never.pipe(
            Effect.ensuring(Effect.sync(() => events.push("finalizer"))),
            Effect.as(HttpServerResponse.text("never")),
          );
          const out = makeFunctionHttpHandler(
            handler as Effect.Effect<
              HttpServerResponse.HttpServerResponse,
              never,
              HttpServerRequest.HttpServerRequest
            >,
          )(functionUrlEvent);
          if (!Effect.isEffect(out)) {
            return yield* Effect.die("Expected Effect from Function URL handler");
          }
          const state = { fired: false };
          const fiber = yield* guarded(out, { remainingMs: 4000, graceMs: 1000 }, undefined, state);
          yield* TestClock.adjust("3 seconds");
          const exit = yield* Fiber.join(fiber);
          expect(events).toEqual(["finalizer"]);
          expect(state.fired).toBe(true);
          expect(exit).toMatchObject({
            _tag: "Failure",
            cause: {
              reasons: [{ _tag: "Fail", error: { _tag: "AWS.Lambda.InvocationTimeoutError" } }],
            },
          });
        }),
      { exclusive: true },
    );
  },
);

const functionUrlEvent = {
  version: "2.0",
  routeKey: "$default",
  rawPath: "/",
  rawQueryString: "",
  headers: { host: "example.lambda-url.us-east-1.on.aws", "x-forwarded-proto": "https" },
  requestContext: {
    accountId: "123456789012",
    apiId: "api-id",
    domainName: "example.lambda-url.us-east-1.on.aws",
    domainPrefix: "example",
    http: {
      method: "GET",
      path: "/",
      protocol: "HTTP/1.1",
      sourceIp: "203.0.113.42",
      userAgent: "test",
    },
    requestId: "request-id",
    routeKey: "$default",
    stage: "$default",
    time: "01/Jan/2026:00:00:00 +0000",
    timeEpoch: 0,
  },
  isBase64Encoded: false,
} satisfies lambda.LambdaFunctionURLEvent;
