import * as AWS from "@/AWS";
import * as Test from "@/Test/Vitest";
import * as Lambda from "@distilled.cloud/aws/lambda";
import { expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { TestFunction, TestFunctionLive } from "./handler.ts";

const { test } = Test.make({ providers: AWS.providers() });

test.provider(
  "creates permission scoped to function URL invocation",
  (stack) =>
    Effect.gen(function* () {
      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          const fn = yield* TestFunction;
          const permission = yield* AWS.Lambda.Permission("UrlInvokeOnly", {
            action: "lambda:InvokeFunction",
            functionName: fn.functionName,
            principal: "*",
            invokedViaFunctionUrl: true,
          });

          return { fn, permission };
        }).pipe(Effect.provide(TestFunctionLive)),
      );

      const policy = yield* getPolicyStatement(
        deployed.fn.functionName,
        deployed.permission.statementId,
      );

      expect(policy.Condition).toEqual({
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
