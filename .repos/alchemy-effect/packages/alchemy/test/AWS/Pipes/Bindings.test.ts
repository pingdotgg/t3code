import * as AWS from "@/AWS";
import * as Core from "@/Test/Core";
import * as Test from "@/Test/Alchemy";
import { describe, expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import PipesBindingsFunctionLive, {
  PipesBindingsFunction,
} from "./bindings-handler.ts";

const testOptions = { providers: AWS.providers() };
const { test, beforeAll, afterAll } = Test.make(testOptions);
const sharedStack = Core.scratchStack(testOptions, "PipesBindings");

// Lambda function URL cold-start (DNS, IAM propagation, init) can take well
// over 60s on a fresh deploy.
const readinessPolicy = Schedule.max([
  Schedule.fixed("2 seconds"),
  Schedule.recurs(75),
]);

let baseUrl: string;

class TransientUpstream extends Data.TaggedError("TransientUpstream")<{
  readonly status: number;
  readonly body: string;
}> {}

class PipeNotSettled extends Data.TaggedError("PipeNotSettled")<{
  readonly currentState: string | undefined;
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
    // The response body has no compile-time shape; widen the distilled Json
    // union to `unknown` so call sites can assert their expected shape.
    Effect.map((json): unknown => json),
  );

interface DescribeResponse {
  name: string | undefined;
  currentState: string | undefined;
  desiredState: string | undefined;
}

// Poll the fixture's /describe route (bounded) until the pipe settles into
// the expected state after a stop/start.
const awaitState = (expected: string) =>
  getJson("/describe").pipe(
    Effect.flatMap((raw) => {
      const described = raw as DescribeResponse;
      return described.currentState === expected
        ? Effect.succeed(described)
        : Effect.fail(
            new PipeNotSettled({ currentState: described.currentState }),
          );
    }),
    Effect.retry({
      while: (e): boolean => e._tag === "PipeNotSettled",
      schedule: Schedule.max([
        Schedule.fixed("3 seconds"),
        Schedule.recurs(30),
      ]),
    }),
  );

describe.sequential("AWS.Pipes bindings", () => {
  beforeAll(
    Effect.gen(function* () {
      yield* Effect.logInfo("Pipes test setup: destroying previous resources");
      yield* sharedStack.destroy();

      yield* Effect.logInfo("Pipes test setup: deploying fixture");
      const attrs = yield* sharedStack.deploy(
        Effect.gen(function* () {
          return yield* PipesBindingsFunction;
        }).pipe(Effect.provide(PipesBindingsFunctionLive)),
      );

      expect(attrs.functionUrl).toBeTruthy();
      baseUrl = attrs.functionUrl!.replace(/\/+$/, "");

      const readinessUrl = `${baseUrl}/bindings`;
      yield* Effect.logInfo(
        `Pipes test setup: probing readiness at ${readinessUrl}`,
      );
      yield* HttpClient.get(readinessUrl).pipe(
        Effect.flatMap((response) =>
          response.status === 200
            ? Effect.succeed(response)
            : Effect.fail(new Error(`Function not ready: ${response.status}`)),
        ),
        Effect.tapError((error) =>
          Effect.logWarning(
            `Pipes test setup: fixture not ready yet (${String(error)})`,
          ),
        ),
        Effect.retry({ schedule: readinessPolicy }),
      );
    }),
    { timeout: 240_000 },
  );

  afterAll(sharedStack.destroy(), { timeout: 180_000 });

  describe("binding registration", () => {
    test.provider("all four capabilities initialize in the runtime", (_stack) =>
      Effect.gen(function* () {
        const response = (yield* getJson("/bindings")) as { bound: string[] };
        expect(response.bound).toHaveLength(4);
      }),
    );
  });

  describe("DescribePipe", () => {
    test.provider("reads the pipe's live state", (_stack) =>
      Effect.gen(function* () {
        const described = (yield* getJson("/describe")) as DescribeResponse;
        expect(described.name).toBeTruthy();
        // The provider waits for the pipe to settle out of CREATING before
        // returning, so the fixture pipe is already RUNNING.
        expect(described.currentState).toBe("RUNNING");
        expect(described.desiredState).toBe("RUNNING");
      }),
    );
  });

  describe("ListPipes", () => {
    test.provider("finds the pipe by name prefix", (_stack) =>
      Effect.gen(function* () {
        const described = (yield* getJson("/describe")) as DescribeResponse;
        const { names } = (yield* getJson("/list")) as { names: string[] };
        expect(names).toContain(described.name);
      }),
    );
  });

  describe("StopPipe + StartPipe", () => {
    test.provider(
      "stops the running pipe, then starts it again",
      (_stack) =>
        Effect.gen(function* () {
          const stopped = (yield* getJson("/stop")) as {
            desiredState: string;
            currentState: string;
          };
          expect(stopped.desiredState).toBe("STOPPED");

          // Wait (bounded) for the pipe to settle — StartPipe during
          // STOPPING would be a ConflictException.
          yield* awaitState("STOPPED");

          const started = (yield* getJson("/start")) as {
            desiredState: string;
            currentState: string;
          };
          expect(started.desiredState).toBe("RUNNING");

          yield* awaitState("RUNNING");
        }),
      { timeout: 240_000 },
    );
  });
});
