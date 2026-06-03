import * as AWS from "@/AWS";
import * as Test from "@/Test/Vitest";
import * as Lambda from "@distilled.cloud/aws/lambda";
import { expect } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import { TestFunction, TestFunctionLive } from "./handler.ts";

const timeoutHandlerPath = new URL("./timeout-handler.ts", import.meta.url)
  .pathname;

const { test } = Test.make({ providers: AWS.providers() });

test.provider(
  "create, update, delete function",
  (stack) =>
    Effect.gen(function* () {
      const { functionName, functionUrl } = yield* stack.deploy(
        TestFunction.pipe(Effect.provide(TestFunctionLive)),
      );

      expect(functionUrl).toBeTruthy();

      const response = yield* HttpClient.get(functionUrl!).pipe(
        Effect.flatMap((response) =>
          response.status === 200
            ? Effect.succeed(response)
            : Effect.fail(
                new Error(`Function URL returned ${response.status}`),
              ),
        ),
        Effect.tapError((error) => Effect.logError(error)),
        Effect.retry({
          schedule: Schedule.exponential(500).pipe(
            Schedule.both(Schedule.recurs(10)),
          ),
        }),
      );

      expect(response.status).toBe(200);
      expect(yield* response.text).toBe("Hello, world!");

      const invokePolicy = yield* getPolicyStatement(
        functionName,
        "FunctionURLAllowPublicInvoke",
      );
      expect(invokePolicy.Condition).toEqual({
        Bool: {
          "lambda:InvokedViaFunctionUrl": "true",
        },
      });
    }).pipe(
      Effect.tap(() => stack.destroy()),
      Effect.onError(() => stack.destroy().pipe(Effect.ignore)),
    ),
  { timeout: 180_000 },
);

test.provider(
  "applies and updates the Lambda timeout",
  (stack) =>
    Effect.gen(function* () {
      const initial = yield* stack.deploy(
        AWS.Lambda.Function<{}>()("TimeoutFn", {
          main: timeoutHandlerPath,
          handler: "handler",
          isExternal: true,
          url: false,
          timeout: Duration.seconds(15),
        }),
      );

      const initialConfig = yield* Lambda.getFunction({
        FunctionName: initial.functionName,
      });
      expect(initialConfig.Configuration?.Timeout).toBe(15);

      yield* stack.deploy(
        AWS.Lambda.Function<{}>()("TimeoutFn", {
          main: timeoutHandlerPath,
          handler: "handler",
          isExternal: true,
          url: false,
          timeout: Duration.seconds(45),
        }),
      );

      const updatedConfig = yield* Lambda.getFunction({
        FunctionName: initial.functionName,
      }).pipe(
        Effect.filterOrFail(
          (c) => c.Configuration?.Timeout === 45,
          () => new Error("Timeout update has not propagated yet"),
        ),
        Effect.retry({
          schedule: Schedule.exponential(500).pipe(
            Schedule.both(Schedule.recurs(10)),
          ),
        }),
      );
      expect(updatedConfig.Configuration?.Timeout).toBe(45);
    }).pipe(
      Effect.tap(() => stack.destroy()),
      Effect.onError(() => stack.destroy().pipe(Effect.ignore)),
    ),
  { timeout: 360_000 },
);

const getPolicyStatement = Effect.fn(function* (
  functionName: string,
  statementId: string,
) {
  return yield* Lambda.getPolicy({ FunctionName: functionName }).pipe(
    Effect.flatMap(({ Policy }) =>
      Effect.try({
        try: () => {
          const policy = JSON.parse(Policy ?? "{}") as {
            Statement?: Array<{
              Sid?: string;
              Condition?: unknown;
            }>;
          };
          const statement = policy.Statement?.find(
            (statement) => statement.Sid === statementId,
          );
          if (!statement) {
            throw new Error(`Policy statement ${statementId} not found`);
          }
          return statement;
        },
        catch: (cause) =>
          cause instanceof Error ? cause : new Error(String(cause)),
      }),
    ),
    Effect.retry({
      schedule: Schedule.exponential(500).pipe(
        Schedule.both(Schedule.recurs(10)),
      ),
    }),
  );
});
