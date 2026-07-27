import * as AWS from "@/AWS";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import * as Lambda from "@distilled.cloud/aws/lambda";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { TestFunction, TestFunctionLive } from "./handler.ts";

const { test } = Test.make({ providers: AWS.providers() });

test.provider(
  "creates permission scoped to function URL invocation",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

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

      yield* stack.destroy();
      yield* assertFunctionDeleted(deployed.fn.functionName);
    }).pipe(
      Effect.tap(() => stack.destroy()),
      Effect.onError(() => stack.destroy().pipe(Effect.ignore)),
    ),
  { timeout: 180_000 },
);

test.provider(
  "list enumerates the deployed permission",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          const fn = yield* TestFunction;
          const permission = yield* AWS.Lambda.Permission("ListPermission", {
            action: "lambda:InvokeFunction",
            functionName: fn.functionName,
            principal: "*",
            invokedViaFunctionUrl: true,
          });

          return { fn, permission };
        }).pipe(Effect.provide(TestFunctionLive)),
      );

      const provider = yield* Provider.findProvider(AWS.Lambda.Permission);
      const all = yield* provider.list();

      expect(
        all.some(
          (p) =>
            p.statementId === deployed.permission.statementId &&
            p.functionName === deployed.fn.functionName,
        ),
      ).toBe(true);

      yield* stack.destroy();
      yield* assertFunctionDeleted(deployed.fn.functionName);
    }).pipe(
      Effect.tap(() => stack.destroy()),
      Effect.onError(() => stack.destroy().pipe(Effect.ignore)),
    ),
  { timeout: 180_000 },
);

// Out-of-band proof that the trailing destroy removed the host function (and
// with it the permission's policy) from the cloud.
const assertFunctionDeleted = Effect.fn(function* (functionName: string) {
  yield* Lambda.getFunction({ FunctionName: functionName }).pipe(
    Effect.flatMap(() =>
      Effect.fail(new Error(`Function ${functionName} still exists`)),
    ),
    Effect.catchTag("ResourceNotFoundException", () => Effect.void),
    Effect.retry({
      schedule: Schedule.max([Schedule.exponential(500), Schedule.recurs(8)]),
    }),
  );
});

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
      schedule: Schedule.max([Schedule.exponential(500), Schedule.recurs(10)]),
    }),
  );
});
