import * as AWS from "@/AWS";
import * as Core from "@/Test/Core";
import * as Test from "@/Test/Alchemy";
import { describe, expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import AppSyncBindingsFunctionLive, {
  AppSyncBindingsFunction,
} from "./fixtures/bindings-handler";

const testOptions = { providers: AWS.providers() };
const { test, beforeAll, afterAll } = Test.make(testOptions);
const sharedStack = Core.scratchStack(testOptions, "AppSyncBindings");

let baseUrl: string;

class TransientUpstream extends Data.TaggedError("TransientUpstream")<{
  readonly status: number;
  readonly body: string;
}> {}

// Fresh Lambda role + appsync:GraphQL permissions propagate eventually — the
// first calls can 500 with an auth error under the handler's `Effect.orDie`.
// Retry 5xx only; a genuine 4xx fails immediately.
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
        Schedule.recurs(8),
      ]),
    }),
  );

describe("AppSync Bindings", () => {
  beforeAll(
    Effect.gen(function* () {
      yield* Effect.logInfo(
        "AppSync bindings setup: destroying previous resources",
      );
      yield* sharedStack.destroy();

      yield* Effect.logInfo(
        "AppSync bindings setup: deploying api -> resolvers -> Lambda",
      );
      const { functionUrl } = yield* sharedStack.deploy(
        Effect.gen(function* () {
          return yield* AppSyncBindingsFunction;
        }).pipe(Effect.provide(AppSyncBindingsFunctionLive)),
      );

      expect(functionUrl).toBeTruthy();
      baseUrl = functionUrl!.replace(/\/+$/, "");

      // Readiness probe — fresh function URLs take seconds to serve 200s.
      yield* HttpClient.get(`${baseUrl}/ping`).pipe(
        Effect.flatMap((response) =>
          response.status === 200
            ? Effect.succeed(response)
            : Effect.fail(new Error(`Function not ready: ${response.status}`)),
        ),
        Effect.retry({
          schedule: Schedule.max([
            Schedule.fixed("2 seconds"),
            Schedule.recurs(75),
          ]),
        }),
      );
    }),
    { timeout: 300_000 },
  );
  afterAll(sharedStack.destroy(), { timeout: 300_000 });

  describe("GraphQL", () => {
    test.provider(
      "the Lambda executes a SigV4-signed query through the binding",
      () =>
        Effect.gen(function* () {
          const result = yield* send(
            HttpClientRequest.post(`${baseUrl}/graphql`).pipe(
              HttpClientRequest.bodyJsonUnsafe({
                query: "query($a: Int!, $b: Int!) { add(a: $a, b: $b) }",
                variables: { a: 2, b: 3 },
              }),
            ),
          ).pipe(
            Effect.flatMap((response) => response.json),
            Effect.map(
              (json) =>
                json as {
                  data?: { add?: number };
                  errors?: Array<{ message: string }>;
                },
            ),
            Effect.filterOrFail(
              (json) => json.data?.add !== undefined,
              (json) => new Error(`no data.add: ${JSON.stringify(json)}`),
            ),
            Effect.retry({
              schedule: Schedule.max([
                Schedule.spaced("3 seconds"),
                Schedule.recurs(20),
              ]),
            }),
          );
          expect(result.data?.add).toBe(5);
        }),
      { timeout: 180_000 },
    );

    test.provider(
      "GraphQL field errors surface on result.errors (not as failures)",
      () =>
        Effect.gen(function* () {
          const result = yield* send(
            HttpClientRequest.post(`${baseUrl}/graphql`).pipe(
              HttpClientRequest.bodyJsonUnsafe({
                query: "query { nonexistentField }",
              }),
            ),
          ).pipe(
            Effect.flatMap((response) => response.json),
            Effect.map(
              (json) => json as { errors?: Array<{ message: string }> },
            ),
          );
          expect(result.errors?.length).toBeGreaterThan(0);
        }),
      { timeout: 120_000 },
    );

    test.provider(
      "resolvers read environmentVariables via ctx.env",
      () =>
        Effect.gen(function* () {
          const result = yield* send(
            HttpClientRequest.post(`${baseUrl}/graphql`).pipe(
              HttpClientRequest.bodyJsonUnsafe({
                query: "query { greeting }",
              }),
            ),
          ).pipe(
            Effect.flatMap((response) => response.json),
            Effect.map((json) => json as { data?: { greeting?: string } }),
            Effect.filterOrFail(
              (json) => json.data?.greeting != null,
              (json) => new Error(`no data.greeting: ${JSON.stringify(json)}`),
            ),
            Effect.retry({
              schedule: Schedule.max([
                Schedule.spaced("3 seconds"),
                Schedule.recurs(10),
              ]),
            }),
          );
          expect(result.data?.greeting).toBe("hello from ctx.env");
        }),
      { timeout: 120_000 },
    );
  });

  describe("GetIntrospectionSchema", () => {
    test.provider(
      "the Lambda reads the API's live SDL through the binding",
      () =>
        Effect.gen(function* () {
          const result = yield* send(
            HttpClientRequest.get(`${baseUrl}/schema`),
          ).pipe(
            Effect.flatMap((response) => response.json),
            Effect.map((json) => json as { sdl?: string }),
            Effect.filterOrFail(
              (json) => json.sdl != null,
              (json) => new Error(`no sdl: ${JSON.stringify(json)}`),
            ),
            Effect.retry({
              schedule: Schedule.max([
                Schedule.spaced("3 seconds"),
                Schedule.recurs(10),
              ]),
            }),
          );
          expect(result.sdl).toContain("add(a: Int!, b: Int!): Int!");
          expect(result.sdl).toContain("type Query");
        }),
      { timeout: 120_000 },
    );
  });

  describe("EvaluateCode", () => {
    test.provider(
      "the Lambda evaluates APPSYNC_JS resolver code through the binding",
      () =>
        Effect.gen(function* () {
          const result = yield* send(
            HttpClientRequest.post(`${baseUrl}/evaluate`),
          ).pipe(
            Effect.flatMap((response) => response.json),
            Effect.map(
              (json) =>
                json as {
                  evaluationResult?: string;
                  error?: { message?: string };
                },
            ),
            Effect.filterOrFail(
              (json) => json.evaluationResult != null,
              (json) =>
                new Error(`no evaluationResult: ${JSON.stringify(json)}`),
            ),
            Effect.retry({
              schedule: Schedule.max([
                Schedule.spaced("3 seconds"),
                Schedule.recurs(10),
              ]),
            }),
          );
          expect(JSON.parse(result.evaluationResult!)).toMatchObject({
            payload: 5,
          });
        }),
      { timeout: 120_000 },
    );
  });

  describe("EvaluateMappingTemplate", () => {
    test.provider(
      "the Lambda renders a VTL mapping template through the binding",
      () =>
        Effect.gen(function* () {
          const result = yield* send(
            HttpClientRequest.post(`${baseUrl}/evaluate-template`),
          ).pipe(
            Effect.flatMap((response) => response.json),
            Effect.map(
              (json) =>
                json as {
                  evaluationResult?: string;
                  error?: { message?: string };
                },
            ),
            Effect.filterOrFail(
              (json) => json.evaluationResult != null,
              (json) =>
                new Error(`no evaluationResult: ${JSON.stringify(json)}`),
            ),
            Effect.retry({
              schedule: Schedule.max([
                Schedule.spaced("3 seconds"),
                Schedule.recurs(10),
              ]),
            }),
          );
          expect(JSON.parse(result.evaluationResult!)).toMatchObject({
            sum: 5,
          });
        }),
      { timeout: 120_000 },
    );
  });

  describe("FlushApiCache", () => {
    test.provider(
      "the flush call is authorized and returns the typed NotFoundException without a cache",
      () =>
        Effect.gen(function* () {
          // The fixture API deliberately has NO cache (cache instances bill
          // hourly): a typed NotFoundException proves the binding executed
          // with the granted appsync:FlushApiCache; an IAM denial surfaces
          // a different tag. Repeat briefly through IAM propagation.
          const outcome = yield* send(
            HttpClientRequest.post(`${baseUrl}/flush`),
          ).pipe(
            Effect.flatMap((response) => response.json),
            Effect.map(
              (json) =>
                json as {
                  flushed: boolean;
                  reason?: string;
                  message?: string;
                },
            ),
            Effect.repeat({
              schedule: Schedule.spaced("2 seconds"),
              until: (json): boolean => json.reason === "NotFoundException",
              times: 10,
            }),
          );
          expect(outcome).toMatchObject({
            flushed: false,
            reason: "NotFoundException",
          });
        }),
      { timeout: 90_000 },
    );
  });
});
