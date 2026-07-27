import * as AWS from "@/AWS";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import * as iam from "@distilled.cloud/aws/iam";
import * as Lambda from "@distilled.cloud/aws/lambda";
import { expect } from "alchemy-test";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import { fileURLToPath } from "node:url";
import { TestFunction, TestFunctionLive } from "./handler.ts";

const timeoutHandlerPath = fileURLToPath(
  new URL("./timeout-handler.ts", import.meta.url),
);
const externalPackageHandlerPath = fileURLToPath(
  new URL("./external-package-handler.ts", import.meta.url),
);

const { test } = Test.make({ providers: AWS.providers() });

test.provider(
  "create, update, delete function",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { functionName, functionUrl, roleName } = yield* stack.deploy(
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
          schedule: Schedule.max([
            Schedule.exponential(500),
            Schedule.recurs(10),
          ]),
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

      yield* stack.destroy();
      yield* assertFunctionDeleted(functionName);
      yield* assertRoleDeleted(roleName);
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
      yield* stack.destroy();

      const initial = yield* stack.deploy(
        AWS.Lambda.Function("TimeoutFn", {
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
        AWS.Lambda.Function("TimeoutFn", {
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
          schedule: Schedule.max([
            Schedule.exponential(500),
            Schedule.recurs(10),
          ]),
        }),
      );
      expect(updatedConfig.Configuration?.Timeout).toBe(45);

      yield* stack.destroy();
      yield* assertFunctionDeleted(initial.functionName);
    }).pipe(
      Effect.tap(() => stack.destroy()),
      Effect.onError(() => stack.destroy().pipe(Effect.ignore)),
    ),
  { timeout: 360_000 },
);

test.provider(
  "installs explicit external packages into the deployment artifact",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { functionName, functionUrl } = yield* stack.deploy(
        AWS.Lambda.Function("InstallFn", {
          main: externalPackageHandlerPath,
          handler: "handler",
          isExternal: true,
          url: true,
          build: {
            install: ["uuid"],
          },
        }),
      );

      const response = yield* HttpClient.get(functionUrl!).pipe(
        Effect.flatMap((response) =>
          response.status === 200
            ? Effect.succeed(response)
            : Effect.fail(
                new Error(`Function URL returned ${response.status}`),
              ),
        ),
        Effect.retry({
          schedule: Schedule.max([
            Schedule.exponential(500),
            Schedule.recurs(10),
          ]),
        }),
      );

      const body = JSON.parse(yield* response.text) as { id: string };
      expect(body.id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );

      yield* stack.destroy();
      yield* assertFunctionDeleted(functionName);
    }).pipe(
      Effect.tap(() => stack.destroy()),
      Effect.onError(() => stack.destroy().pipe(Effect.ignore)),
    ),
  { timeout: 360_000 },
);

test.provider(
  "applies and updates the Lambda architecture",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const initial = yield* stack.deploy(
        AWS.Lambda.Function("ArchitectureFn", {
          main: timeoutHandlerPath,
          handler: "handler",
          isExternal: true,
          url: false,
          architecture: "arm64",
        }),
      );

      yield* waitForArchitecture(initial.functionName, "arm64");

      const updated = yield* stack.deploy(
        AWS.Lambda.Function("ArchitectureFn", {
          main: timeoutHandlerPath,
          handler: "handler",
          isExternal: true,
          url: false,
        }),
      );

      expect(updated.functionName).toBe(initial.functionName);
      yield* waitForArchitecture(updated.functionName, "x86_64");

      yield* stack.destroy();
      yield* assertFunctionDeleted(initial.functionName);
    }).pipe(
      Effect.tap(() => stack.destroy()),
      Effect.onError(() => stack.destroy().pipe(Effect.ignore)),
    ),
  { timeout: 360_000 },
);

test.provider(
  "applies, updates, and removes reserved concurrency",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const initial = yield* stack.deploy(
        AWS.Lambda.Function("ConcurrencyFn", {
          main: timeoutHandlerPath,
          handler: "handler",
          isExternal: true,
          url: false,
        }),
      );

      expect(initial.reservedConcurrentExecutions).toBeUndefined();
      yield* waitForReservedConcurrency(initial.functionName, undefined);

      const updated = yield* stack.deploy(
        AWS.Lambda.Function("ConcurrencyFn", {
          main: timeoutHandlerPath,
          handler: "handler",
          isExternal: true,
          url: false,
          reservedConcurrentExecutions: 0,
        }),
      );

      expect(updated.functionName).toBe(initial.functionName);
      expect(updated.reservedConcurrentExecutions).toBe(0);
      yield* waitForReservedConcurrency(updated.functionName, 0);

      const removed = yield* stack.deploy(
        AWS.Lambda.Function("ConcurrencyFn", {
          main: timeoutHandlerPath,
          handler: "handler",
          isExternal: true,
          url: false,
        }),
      );

      expect(removed.functionName).toBe(initial.functionName);
      expect(removed.reservedConcurrentExecutions).toBeUndefined();
      yield* waitForReservedConcurrency(removed.functionName, undefined);

      yield* stack.destroy();
      yield* assertFunctionDeleted(initial.functionName);
    }).pipe(
      Effect.tap(() => stack.destroy()),
      Effect.onError(() => stack.destroy().pipe(Effect.ignore)),
    ),
  { timeout: 360_000 },
);

// Canonical `list()` test (AWS account/region-scoped collection): deploy a
// real function, resolve the provider from context via the typed
// `Provider.findProvider`, call `list()`, and assert the deployed function
// appears in the exhaustively-paginated result.
test.provider(
  "list enumerates the deployed function",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deployed = yield* stack.deploy(
        AWS.Lambda.Function("ListFn", {
          main: timeoutHandlerPath,
          handler: "handler",
          isExternal: true,
          url: false,
        }),
      );

      const provider = yield* Provider.findProvider(AWS.Lambda.Function);
      const all = yield* provider.list();

      expect(all.some((f) => f.functionName === deployed.functionName)).toBe(
        true,
      );

      yield* stack.destroy();
      yield* assertFunctionDeleted(deployed.functionName);
    }).pipe(
      Effect.tap(() => stack.destroy()),
      Effect.onError(() => stack.destroy().pipe(Effect.ignore)),
    ),
  { timeout: 180_000 },
);

test.provider(
  "updates function URL auth to AWS_IAM",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const initial = yield* stack.deploy(
        AWS.Lambda.Function("IamUrlFn", {
          main: timeoutHandlerPath,
          handler: "handler",
          isExternal: true,
          url: true,
        }),
      );

      const invokePolicy = yield* getPolicyStatement(
        initial.functionName,
        "FunctionURLAllowPublicInvoke",
      );
      expect(invokePolicy.Condition).toEqual({
        Bool: {
          "lambda:InvokedViaFunctionUrl": "true",
        },
      });

      const updated = yield* stack.deploy(
        AWS.Lambda.Function("IamUrlFn", {
          main: timeoutHandlerPath,
          handler: "handler",
          isExternal: true,
          url: {
            authType: "AWS_IAM",
            cors: {
              AllowHeaders: ["authorization", "content-type"],
              AllowMethods: ["GET", "POST"],
              AllowOrigins: ["https://example.com"],
              ExposeHeaders: ["x-request-id"],
              MaxAge: 300,
            },
            invokeMode: "RESPONSE_STREAM",
          },
        }),
      );

      expect(updated.functionName).toBe(initial.functionName);
      expect(updated.functionUrl).toBeTruthy();

      const config = yield* getFunctionUrlConfigWithAuth(
        updated.functionName,
        "AWS_IAM",
      );
      expect(config.AuthType).toBe("AWS_IAM");
      expect(config.InvokeMode).toBe("RESPONSE_STREAM");
      expect(config.Cors).toEqual({
        AllowHeaders: ["authorization", "content-type"],
        AllowMethods: ["GET", "POST"],
        AllowOrigins: ["https://example.com"],
        ExposeHeaders: ["x-request-id"],
        MaxAge: 300,
      });

      yield* waitForPolicyStatementAbsent(
        updated.functionName,
        "FunctionURLAllowPublicAccess",
      );
      yield* waitForPolicyStatementAbsent(
        updated.functionName,
        "FunctionURLAllowPublicInvoke",
      );

      const response = yield* HttpClient.get(updated.functionUrl!).pipe(
        Effect.flatMap((response) =>
          response.status === 403
            ? Effect.succeed(response)
            : Effect.fail(
                new Error(`IAM Function URL returned ${response.status}`),
              ),
        ),
        Effect.retry({
          schedule: Schedule.max([
            Schedule.exponential(500),
            Schedule.recurs(10),
          ]),
        }),
      );
      expect(response.status).toBe(403);

      yield* stack.destroy();
      yield* assertFunctionDeleted(initial.functionName);
    }).pipe(
      Effect.tap(() => stack.destroy()),
      Effect.onError(() => stack.destroy().pipe(Effect.ignore)),
    ),
  { timeout: 360_000 },
);

// Out-of-band proof that the trailing destroy actually removed the function
// from the cloud (bounded retry to ride out delete propagation).
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

// Function cleanup owns its generated execution role. Verify the role is not
// stranded when deletion also waits for Lambda's asynchronous log flush.
const assertRoleDeleted = Effect.fn(function* (roleName: string) {
  yield* iam.getRole({ RoleName: roleName }).pipe(
    Effect.flatMap(() =>
      Effect.fail(new Error(`Role ${roleName} still exists`)),
    ),
    Effect.catchTag("NoSuchEntityException", () => Effect.void),
    Effect.retry({
      schedule: Schedule.spaced("1 second"),
      times: 8,
    }),
  );
});

const getPolicyStatement = Effect.fn(function* (
  functionName: string,
  statementId: string,
) {
  return yield* findPolicyStatement(functionName, statementId).pipe(
    Effect.flatMap((statement) =>
      statement
        ? Effect.succeed(statement)
        : Effect.fail(new Error(`Policy statement ${statementId} not found`)),
    ),
    Effect.retry({
      schedule: Schedule.max([Schedule.exponential(500), Schedule.recurs(10)]),
    }),
  );
});

const waitForPolicyStatementAbsent = Effect.fn(function* (
  functionName: string,
  statementId: string,
) {
  yield* findPolicyStatement(functionName, statementId).pipe(
    Effect.flatMap((statement) =>
      statement
        ? Effect.fail(new Error(`Policy statement ${statementId} still exists`))
        : Effect.void,
    ),
    Effect.retry({
      schedule: Schedule.max([Schedule.exponential(500), Schedule.recurs(10)]),
    }),
  );
});

const findPolicyStatement = Effect.fn(function* (
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
          return policy.Statement?.find(
            (statement) => statement.Sid === statementId,
          );
        },
        catch: (cause) =>
          cause instanceof Error ? cause : new Error(String(cause)),
      }),
    ),
    Effect.catchTag("ResourceNotFoundException", () =>
      Effect.succeed(undefined),
    ),
  );
});

const getFunctionUrlConfigWithAuth = Effect.fn(function* (
  functionName: string,
  authType: Lambda.FunctionUrlAuthType,
) {
  return yield* Lambda.getFunctionUrlConfig({
    FunctionName: functionName,
  }).pipe(
    Effect.filterOrFail(
      (config) => config.AuthType === authType,
      () => new Error("Function URL auth has not propagated yet"),
    ),
    Effect.retry({
      schedule: Schedule.max([Schedule.exponential(500), Schedule.recurs(10)]),
    }),
  );
});

const waitForReservedConcurrency = Effect.fn(function* (
  functionName: string,
  expected: number | undefined,
) {
  return yield* Lambda.getFunctionConcurrency({
    FunctionName: functionName,
  }).pipe(
    Effect.map((config) => config.ReservedConcurrentExecutions),
    Effect.catchTag("ResourceNotFoundException", () =>
      Effect.succeed(undefined),
    ),
    Effect.filterOrFail(
      (actual) => actual === expected,
      () => new Error("Reserved concurrency update has not propagated yet"),
    ),
    Effect.retry({
      schedule: Schedule.max([Schedule.exponential(500), Schedule.recurs(10)]),
    }),
  );
});

const waitForArchitecture = Effect.fn(function* (
  functionName: string,
  expected: AWS.Lambda.FunctionArchitecture,
) {
  return yield* Lambda.getFunction({ FunctionName: functionName }).pipe(
    Effect.map((result) => result.Configuration?.Architectures),
    Effect.filterOrFail(
      (architectures) => architectures?.[0] === expected,
      () => new Error("Lambda architecture update has not propagated yet"),
    ),
    Effect.retry({
      schedule: Schedule.max([Schedule.exponential(500), Schedule.recurs(10)]),
    }),
  );
});
