import * as AWS from "@alchemy.run/aws";
import { describe, expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Core from "@alchemy.run/test/Core";
import * as Lambda from "@distilled.cloud/aws/lambda";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as Schedule from "effect/Schedule";
import LambdaBindingsTestFunctionLive, { LambdaBindingsTestFunction } from "./bindings-handler.ts";

const testOptions = { providers: AWS.providers() };
const { test, beforeAll, afterAll } = Test.make(testOptions);
const sharedStack = Core.scratchStack(testOptions, "LambdaBindings");

let baseUrl: string;
let deployedFunctionName: string;

// Fresh function URLs take a few seconds to start serving 200s; ride
// through propagation + cold start with a bounded retry.
const getJson = (path: string, times = 10) =>
  HttpClient.get(`${baseUrl}${path}`).pipe(
    Effect.flatMap((response) =>
      response.status === 200
        ? response.json
        : response.text.pipe(
            Effect.flatMap((body) =>
              Effect.fail(new Error(`${path} returned ${response.status}: ${body}`)),
            ),
          ),
    ),
    Effect.retry({
      schedule: Schedule.max([Schedule.exponential("1 second"), Schedule.recurs(times)]),
    }),
  );

describe("Lambda Bindings", { tags: ["provider:aws", "provider:aws:lambda", "live"] }, () => {
  beforeAll(
    Effect.gen(function* () {
      yield* sharedStack.destroy();
      const { functionName, functionUrl } = yield* sharedStack.deploy(
        Effect.gen(function* () {
          return yield* LambdaBindingsTestFunction;
        }).pipe(Effect.provide(LambdaBindingsTestFunctionLive)),
      );
      expect(functionUrl).toBeTruthy();
      baseUrl = functionUrl!.replace(/\/+$/, "");
      deployedFunctionName = functionName;
    }),
    { timeout: 300_000 },
  );

  afterAll(
    Effect.gen(function* () {
      yield* sharedStack.destroy();
      // Out-of-band proof the destroy removed the host function. The raw
      // afterAll context has no providers layer (only `test.provider` bodies
      // do), so the distilled call must be wrapped in `Core.withProviders`
      // to satisfy Credentials/HttpClient/Region.
      if (deployedFunctionName) {
        yield* Core.withProviders(
          Lambda.getFunction({ FunctionName: deployedFunctionName }).pipe(
            Effect.flatMap(() =>
              Effect.fail(new Error(`Function ${deployedFunctionName} still exists`)),
            ),
            Effect.catchTag("ResourceNotFoundException", () => Effect.void),
            Effect.retry({
              schedule: Schedule.max([Schedule.exponential(500), Schedule.recurs(8)]),
            }),
          ),
          testOptions,
          "LambdaBindings",
        );
      }
    }),
    { timeout: 180_000 },
  );

  test.provider(
    "InvokeFunction invokes the target function through its alias",
    () =>
      Effect.gen(function* () {
        const result = (yield* getJson("/invoke", 30)) as {
          statusCode: number;
          executedVersion: string;
        };
        expect(result.statusCode).toBe(200);
        // The target sets `alias: "live"`, so the binding runs the version
        // the alias serves, never `$LATEST`.
        expect(result.executedVersion).toMatch(/^[1-9]\d*$/);
      }),
    { timeout: 120_000 },
  );

  test.provider(
    "InvokeWithResponseStream streams the target's response",
    () =>
      Effect.gen(function* () {
        const result = (yield* getJson("/invoke-stream")) as {
          statusCode: number;
          payload: string;
          complete: boolean;
          eventShapes: string[][];
        };
        expect(result.statusCode).toBe(200);
        expect(result.complete).toBe(true);
        expect(result.payload, `event shapes: ${JSON.stringify(result.eventShapes)}`).toContain(
          "ok",
        );
      }),
    { timeout: 120_000 },
  );

  test.provider(
    "GetFunction reads the target's configuration",
    () =>
      Effect.gen(function* () {
        const result = (yield* getJson("/get-function")) as { functionName: string };
        expect(result.functionName).toBeTruthy();
      }),
    { timeout: 120_000 },
  );

  test.provider(
    "GetAccountSettings reads account limits",
    () =>
      Effect.gen(function* () {
        const result = (yield* getJson("/account-settings")) as { concurrentExecutions: number };
        expect(result.concurrentExecutions).toBeGreaterThan(0);
      }),
    { timeout: 120_000 },
  );

  test.provider(
    "ListFunctions lists functions in the region",
    () =>
      Effect.gen(function* () {
        const result = (yield* getJson("/list-functions")) as { count: number };
        expect(result.count).toBeGreaterThan(0);
      }),
    { timeout: 120_000 },
  );
});
