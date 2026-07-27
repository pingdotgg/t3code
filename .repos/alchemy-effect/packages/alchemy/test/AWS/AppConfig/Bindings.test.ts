import * as AWS from "@/AWS";
import * as Core from "@/Test/Core";
import * as Test from "@/Test/Alchemy";
import { describe, expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import AppConfigTestFunctionLive, {
  AppConfigTestFunction,
} from "./fixtures/handler";

const testOptions = { providers: AWS.providers() };
const { test, beforeAll, afterAll } = Test.make(testOptions);
const sharedStack = Core.scratchStack(testOptions, "AppConfigBindings");

let baseUrl: string;

class TransientUpstream extends Data.TaggedError("TransientUpstream")<{
  readonly status: number;
  readonly body: string;
}> {}

// Fresh Lambda role + AppConfig permissions propagate eventually — the first
// fetches can 500 with AccessDenied under the handler's `Effect.orDie`. Retry
// 5xx only; a genuine 4xx fails immediately.
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

// Sequential: the tests share one Lambda + one AppConfig environment, and
// AppConfig allows only one in-flight deployment per environment. Concurrent
// execution races the v2 rollout against the v1 `/config` assertion.
describe.sequential("AppConfig Bindings", () => {
  beforeAll(
    Effect.gen(function* () {
      yield* Effect.logInfo(
        "AppConfig test setup: destroying previous resources",
      );
      yield* sharedStack.destroy();

      yield* Effect.logInfo(
        "AppConfig test setup: deploying app -> env -> profile -> version -> deployment -> Lambda",
      );
      const { functionUrl } = yield* sharedStack.deploy(
        Effect.gen(function* () {
          return yield* AppConfigTestFunction;
        }).pipe(Effect.provide(AppConfigTestFunctionLive)),
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

      // Authorization gate — control-plane grants on a freshly created role
      // can take up to a minute to become effective. Wait once here so every
      // test runs against a fully authorized Lambda.
      yield* HttpClient.execute(
        HttpClientRequest.post(`${baseUrl}/validate`).pipe(
          HttpClientRequest.bodyJsonUnsafe({ version: "1" }),
        ),
      ).pipe(
        Effect.flatMap((response) =>
          response.status === 200
            ? Effect.succeed(response)
            : Effect.fail(
                new Error(
                  `management bindings not yet authorized: ${response.status}`,
                ),
              ),
        ),
        Effect.retry({
          schedule: Schedule.max([
            Schedule.spaced("5 seconds"),
            Schedule.recurs(24),
          ]),
        }),
      );
    }),
    { timeout: 360_000 },
  );
  afterAll(sharedStack.destroy(), { timeout: 300_000 });

  describe("GetConfiguration", () => {
    test.provider(
      "the Lambda fetches its deployed configuration through the binding",
      () =>
        Effect.gen(function* () {
          // The data plane may briefly serve an empty body right after the
          // deployment completes; retry until the content is present.
          const body = yield* send(
            HttpClientRequest.get(`${baseUrl}/config`),
          ).pipe(
            Effect.flatMap((response) => response.json),
            Effect.map(
              (json) => json as { content?: string; contentType?: string },
            ),
            Effect.filterOrFail(
              (json) =>
                typeof json.content === "string" && json.content.length > 0,
              () => new Error("configuration not yet available"),
            ),
            Effect.retry({
              schedule: Schedule.max([
                Schedule.spaced("3 seconds"),
                Schedule.recurs(20),
              ]),
            }),
          );

          expect(body.contentType).toContain("application/json");
          expect(JSON.parse(body.content!)).toEqual({
            featureX: true,
            limit: 42,
          });
        }),
      { timeout: 180_000 },
    );
  });

  describe("CreateHostedConfigurationVersion + StartDeployment + GetDeployment", () => {
    test.provider(
      "the Lambda writes a new version, rolls it out, and serves it",
      () =>
        Effect.gen(function* () {
          const newContent = JSON.stringify({ featureX: false, limit: 7 });

          // 1. Write a new hosted configuration version through the binding.
          const version = yield* send(
            HttpClientRequest.post(`${baseUrl}/version`).pipe(
              HttpClientRequest.bodyJsonUnsafe({ content: newContent }),
            ),
          ).pipe(
            Effect.flatMap((response) => response.json),
            Effect.map((json) => json as { versionNumber?: number }),
          );
          expect(version.versionNumber).toBeGreaterThan(1);

          // 2. Roll it out with the all-at-once strategy.
          const started = yield* send(
            HttpClientRequest.post(`${baseUrl}/deploy`).pipe(
              HttpClientRequest.bodyJsonUnsafe({
                version: String(version.versionNumber),
              }),
            ),
          ).pipe(
            Effect.flatMap((response) => response.json),
            Effect.map(
              (json) => json as { deploymentNumber?: number; state?: string },
            ),
          );
          expect(started.deploymentNumber).toBeGreaterThan(0);

          // 3. Poll the deployment through the binding until it completes.
          const settled = yield* send(
            HttpClientRequest.get(
              `${baseUrl}/deployment?number=${started.deploymentNumber}`,
            ),
          ).pipe(
            Effect.flatMap((response) => response.json),
            Effect.map((json) => json as { state?: string }),
            Effect.repeat({
              schedule: Schedule.spaced("3 seconds"),
              until: (json): boolean => json.state === "COMPLETE",
              times: 30,
            }),
          );
          expect(settled.state).toBe("COMPLETE");

          // 4. The data plane now serves the new content.
          const body = yield* send(
            HttpClientRequest.get(`${baseUrl}/config`),
          ).pipe(
            Effect.flatMap((response) => response.json),
            Effect.map((json) => json as { content?: string }),
            Effect.filterOrFail(
              (json) => json.content === newContent,
              () => new Error("new configuration not yet served"),
            ),
            Effect.retry({
              schedule: Schedule.max([
                Schedule.spaced("3 seconds"),
                Schedule.recurs(20),
              ]),
            }),
          );
          expect(JSON.parse(body.content!)).toEqual({
            featureX: false,
            limit: 7,
          });
        }),
      { timeout: 300_000 },
    );
  });

  describe("ValidateConfiguration", () => {
    test.provider(
      "the Lambda validates a hosted version against the profile's validators",
      () =>
        Effect.gen(function* () {
          const body = yield* send(
            HttpClientRequest.post(`${baseUrl}/validate`).pipe(
              HttpClientRequest.bodyJsonUnsafe({ version: "1" }),
            ),
          ).pipe(
            Effect.flatMap((response) => response.json),
            Effect.map((json) => json as { valid?: boolean }),
          );
          expect(body.valid).toBe(true);
        }),
      { timeout: 120_000 },
    );
  });

  describe("StopDeployment", () => {
    test.provider(
      "the Lambda stops a slow in-flight rollout",
      () =>
        Effect.gen(function* () {
          // Start a rollout that takes 20 minutes so it is stoppable.
          const started = yield* send(
            HttpClientRequest.post(`${baseUrl}/deploy`).pipe(
              HttpClientRequest.bodyJsonUnsafe({ version: "1", slow: true }),
            ),
          ).pipe(
            Effect.flatMap((response) => response.json),
            Effect.map(
              (json) => json as { deploymentNumber?: number; state?: string },
            ),
          );
          expect(started.deploymentNumber).toBeGreaterThan(0);

          const stopped = yield* send(
            HttpClientRequest.post(`${baseUrl}/stop`).pipe(
              HttpClientRequest.bodyJsonUnsafe({
                number: started.deploymentNumber,
              }),
            ),
          ).pipe(
            Effect.flatMap((response) => response.json),
            Effect.map((json) => json as { state?: string }),
          );
          expect(stopped.state).toBe("ROLLED_BACK");
        }),
      { timeout: 180_000 },
    );
  });
});
