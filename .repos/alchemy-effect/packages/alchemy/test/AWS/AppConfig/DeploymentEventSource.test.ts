import * as AWS from "@/AWS";
import * as Core from "@/Test/Core";
import * as Test from "@/Test/Alchemy";
import { describe, expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import AppConfigEventsTestFunctionLive, {
  AppConfigEventsTestFunction,
} from "./fixtures/events-handler";

const testOptions = { providers: AWS.providers() };
const { test, beforeAll, afterAll } = Test.make(testOptions);
const sharedStack = Core.scratchStack(testOptions, "AppConfigEvents");

let baseUrl: string;

interface EventBody {
  event: {
    InvocationId?: string;
    Type?: string;
    DeploymentNumber?: number;
    Environment?: { Id?: string };
  } | null;
}

class DeploymentRequestFailed extends Data.TaggedError(
  "DeploymentRequestFailed",
)<{
  readonly status: number;
  readonly body: string;
}> {}

class DeploymentEventPending extends Data.TaggedError(
  "DeploymentEventPending",
)<{
  readonly deploymentNumber: number;
}> {}

const startDeployment = Effect.suspend(() =>
  HttpClient.execute(
    HttpClientRequest.post(`${baseUrl}/deploy`).pipe(
      HttpClientRequest.bodyJsonUnsafe({ version: "1" }),
    ),
  ).pipe(
    Effect.flatMap((response) =>
      response.status === 200
        ? response.json
        : response.text.pipe(
            Effect.flatMap((body) =>
              Effect.fail(
                new DeploymentRequestFailed({ status: response.status, body }),
              ),
            ),
          ),
    ),
    Effect.map((json) => json as { deploymentNumber?: number; state?: string }),
    // Lambda URL cold starts and fresh execution-role permissions can surface
    // as transient 5xx responses. Retry those only; genuine 4xx responses are
    // actionable test failures.
    Effect.retry({
      while: (error) =>
        error._tag === "DeploymentRequestFailed" && error.status >= 500,
      schedule: Schedule.exponential("1 second"),
      times: 6,
    }),
  ),
);

const awaitCompleteEvent = (deploymentNumber: number) =>
  HttpClient.get(
    `${baseUrl}/event?number=${deploymentNumber}&type=OnDeploymentComplete`,
  ).pipe(
    Effect.flatMap((response) => response.json),
    Effect.map((json) => json as unknown as EventBody),
    Effect.flatMap((body) =>
      body.event === null
        ? Effect.fail(new DeploymentEventPending({ deploymentNumber }))
        : Effect.succeed(body.event),
    ),
    Effect.retry({
      while: (error) => error._tag === "DeploymentEventPending",
      schedule: Schedule.fixed("3 seconds"),
      times: 5,
    }),
  );

describe("AppConfig DeploymentEventSource", () => {
  beforeAll(
    Effect.gen(function* () {
      yield* Effect.logInfo(
        "AppConfig event source setup: destroying previous resources",
      );
      yield* sharedStack.destroy();

      yield* Effect.logInfo(
        "AppConfig event source setup: deploying app -> env -> extension -> Lambda",
      );
      const { functionUrl } = yield* sharedStack.deploy(
        Effect.gen(function* () {
          return yield* AppConfigEventsTestFunction;
        }).pipe(Effect.provide(AppConfigEventsTestFunctionLive)),
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

  test.provider(
    "deployment notifications invoke the Lambda through the extension",
    () =>
      Effect.gen(function* () {
        // AppConfig notifications are fire-and-forget. The first invocation
        // can be lost while the freshly-created AppConfig invoke role is
        // propagating; waiting longer for that same notification cannot make
        // it reappear. Retry the whole bounded start+observe cycle so each
        // attempt emits a fresh action-point notification.
        const observed = yield* Effect.gen(function* () {
          const started = yield* startDeployment;
          const deploymentNumber = started.deploymentNumber;
          if (deploymentNumber === undefined) {
            return yield* Effect.fail(
              new DeploymentRequestFailed({
                status: 200,
                body: "StartDeployment response omitted DeploymentNumber",
              }),
            );
          }
          return {
            deploymentNumber,
            event: yield* awaitCompleteEvent(deploymentNumber),
          };
        }).pipe(
          Effect.retry({
            while: (error) => error._tag === "DeploymentEventPending",
            schedule: Schedule.fixed("5 seconds"),
            times: 3,
          }),
        );

        expect(observed.deploymentNumber).toBeGreaterThan(0);
        expect(observed.event.InvocationId).toBeTruthy();
        expect(observed.event.DeploymentNumber).toBe(observed.deploymentNumber);
      }),
    { timeout: 120_000 },
  );
});
