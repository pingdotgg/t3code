import { fileURLToPath } from "node:url";
import * as AWS from "@alchemy.run/aws";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Lambda from "@distilled.cloud/aws/lambda";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { driftActions, repairDrift, waitForDrift } from "../drift.ts";

const timeoutHandlerPath = fileURLToPath(new URL("./timeout-handler.ts", import.meta.url));

const { test } = Test.make({ providers: AWS.providers() });

test.provider(
  "syncs event invoke config on function and alias",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const program = ({
        functionConfig,
        alias,
      }: {
        functionConfig?: AWS.Lambda.EventInvokeConfig;
        alias?: {
          eventInvokeConfig?: AWS.Lambda.EventInvokeConfig;
        };
      }) =>
        Effect.gen(function* () {
          const queue = yield* AWS.SQS.Queue("FailureQueue", {
            visibilityTimeout: "30 seconds",
          });

          const fn = yield* AWS.Lambda.Function("AsyncFn", {
            main: timeoutHandlerPath,
            handler: "handler",
            isExternal: true,
            functionUrl: false,
            eventInvokeConfig: functionConfig,
          });

          yield* fn.bind("AllowEventInvokeDestination", {
            policyStatements: [
              {
                Effect: "Allow",
                Action: ["sqs:SendMessage"],
                Resource: [queue.queueArn],
              },
            ],
          });

          const version = yield* AWS.Lambda.Version("AsyncVersion", {
            function: fn,
          });

          const live = alias
            ? yield* AWS.Lambda.Alias("LiveAlias", {
                version,
                aliasName: "live",
                eventInvokeConfig: alias.eventInvokeConfig,
              })
            : undefined;

          return { fn, queue, live };
        });

      // --- create with function-level config ---
      const created = yield* stack.deploy(
        program({
          functionConfig: {
            maximumRetryAttempts: 0,
            maximumEventAge: "1 minute",
          },
        }),
      );

      const liveCreated = yield* expectConfig(created.fn.functionName, {
        maximumRetryAttempts: 0,
        maximumEventAgeInSeconds: 60,
      });
      expect(liveCreated.MaximumRetryAttempts).toBe(0);
      expect(liveCreated.MaximumEventAgeInSeconds).toBe(60);
      expect(liveCreated.DestinationConfig?.OnFailure?.Destination).toBe(undefined);

      // --- update retry behavior and add a failure destination ---
      const updated = yield* stack.deploy(
        program({
          functionConfig: {
            maximumRetryAttempts: 1,
            maximumEventAge: "2 minutes",
            destinationConfig: {
              OnFailure: {
                Destination: created.queue.queueArn,
              },
            },
          },
        }),
      );

      const liveUpdated = yield* expectConfig(updated.fn.functionName, {
        maximumRetryAttempts: 1,
        maximumEventAgeInSeconds: 120,
        onFailureDestination: created.queue.queueArn,
      });
      expect(liveUpdated.MaximumRetryAttempts).toBe(1);
      expect(liveUpdated.MaximumEventAgeInSeconds).toBe(120);
      expect(liveUpdated.DestinationConfig?.OnFailure?.Destination).toBe(created.queue.queueArn);

      // --- omit the prop: the config is deleted, not left behind ---
      const removed = yield* stack.deploy(program({}));
      yield* expectNoConfig(removed.fn.functionName);

      // --- alias-scoped config ---
      const withAlias = yield* stack.deploy(
        program({
          alias: {
            eventInvokeConfig: {
              maximumRetryAttempts: 2,
              maximumEventAge: "5 minutes",
              destinationConfig: {
                OnFailure: {
                  Destination: created.queue.queueArn,
                },
              },
            },
          },
        }),
      );

      const liveAliasConfig = yield* expectConfig(
        withAlias.fn.functionName,
        {
          maximumRetryAttempts: 2,
          maximumEventAgeInSeconds: 300,
          onFailureDestination: created.queue.queueArn,
        },
        withAlias.live!.aliasName,
      );
      expect(liveAliasConfig.MaximumRetryAttempts).toBe(2);
      expect(liveAliasConfig.MaximumEventAgeInSeconds).toBe(300);
      expect(liveAliasConfig.DestinationConfig?.OnFailure?.Destination).toBe(
        created.queue.queueArn,
      );
      // The unqualified function stays unconfigured.
      yield* expectNoConfig(withAlias.fn.functionName);

      // --- omit the alias prop: the alias-scoped config is deleted ---
      const aliasCleared = yield* stack.deploy(program({ alias: {} }));
      yield* expectNoConfig(aliasCleared.fn.functionName, aliasCleared.live!.aliasName);

      yield* stack.destroy();

      // Out-of-band proof the destroy removed the host function (and with it
      // the event invoke configs) from the cloud.
      yield* Lambda.getFunction({
        FunctionName: aliasCleared.fn.functionName,
      }).pipe(
        Effect.flatMap(() =>
          Effect.fail(new Error(`Function ${aliasCleared.fn.functionName} still exists`)),
        ),
        Effect.catchTag("ResourceNotFoundException", () => Effect.void),
        Effect.retry({
          schedule: Schedule.max([Schedule.exponential(500), Schedule.recurs(8)]),
        }),
      );
    }).pipe(
      Effect.tap(() => stack.destroy()),
      Effect.onError(() => stack.destroy().pipe(Effect.ignore)),
    ),
  {
    tags: ["provider:aws", "provider:aws:lambda", "provider:aws:sqs", "live"],
    timeout: 360_000,
  },
);

const getConfigOrUndefined = Effect.fn(function* (functionName: string, qualifier?: string) {
  return yield* Lambda.getFunctionEventInvokeConfig({
    FunctionName: functionName,
    Qualifier: qualifier,
  }).pipe(Effect.catchTag("ResourceNotFoundException", () => Effect.succeed(undefined)));
});

// Reads until the config matches the expected shape (updates propagate
// eventually), failing after a bounded number of attempts.
const expectConfig = Effect.fn(function* (
  functionName: string,
  expected: {
    maximumRetryAttempts: number;
    maximumEventAgeInSeconds: number;
    onFailureDestination?: string;
  },
  qualifier?: string,
) {
  return yield* getConfigOrUndefined(functionName, qualifier).pipe(
    Effect.filterOrFail(
      (config): config is Lambda.FunctionEventInvokeConfig =>
        config !== undefined &&
        config.MaximumRetryAttempts === expected.maximumRetryAttempts &&
        config.MaximumEventAgeInSeconds === expected.maximumEventAgeInSeconds &&
        config.DestinationConfig?.OnFailure?.Destination === expected.onFailureDestination,
      () => new Error("Event invoke config update has not propagated yet"),
    ),
    Effect.retry({
      schedule: Schedule.max([Schedule.exponential(500), Schedule.recurs(10)]),
    }),
  );
});

const expectNoConfig = Effect.fn(function* (functionName: string, qualifier?: string) {
  yield* getConfigOrUndefined(functionName, qualifier).pipe(
    Effect.filterOrFail(
      (config) => config === undefined,
      () => new Error("Event invoke config removal has not propagated yet"),
    ),
    Effect.retry({
      schedule: Schedule.max([Schedule.exponential(500), Schedule.recurs(10)]),
    }),
  );
});

// #2688: Function and Alias `read` must observe the async invocation config,
// or retries or destinations changed out of band read as `unchanged`.
test.provider(
  "drift detects and repairs out-of-band event invoke config on function and alias",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { fn, live } = yield* stack.deploy(
        Effect.gen(function* () {
          const fn = yield* AWS.Lambda.Function("DriftAsyncFn", {
            main: timeoutHandlerPath,
            handler: "handler",
            isExternal: true,
            functionUrl: false,
            eventInvokeConfig: { maximumRetryAttempts: 0 },
          });
          const version = yield* AWS.Lambda.Version("DriftAsyncVersion", { function: fn });
          const live = yield* AWS.Lambda.Alias("DriftAsyncAlias", {
            version,
            aliasName: "live",
            eventInvokeConfig: { maximumRetryAttempts: 1 },
          });
          return { fn, live };
        }),
      );
      const actions = yield* driftActions(stack);
      expect(Object.values(actions).every((action) => action === "unchanged")).toBe(true);

      yield* Lambda.putFunctionEventInvokeConfig({
        FunctionName: fn.functionName,
        MaximumRetryAttempts: 2,
      });
      yield* Lambda.putFunctionEventInvokeConfig({
        FunctionName: fn.functionName,
        Qualifier: live.aliasName,
        MaximumRetryAttempts: 2,
      });

      const fnDrift = yield* waitForDrift(stack, "DriftAsyncFn", "drifted");
      expect(fnDrift?.attr?.eventInvokeConfig?.maximumRetryAttempts).toBe(2);
      const aliasDrift = yield* waitForDrift(stack, "DriftAsyncAlias", "drifted");
      expect(aliasDrift?.attr?.eventInvokeConfig?.maximumRetryAttempts).toBe(2);

      const repaired = yield* repairDrift(stack);
      expect(repaired.resources.DriftAsyncFn?.action).toBe("repaired");
      expect(repaired.resources.DriftAsyncAlias?.action).toBe("repaired");
      const after = yield* driftActions(stack);
      expect(Object.values(after).every((action) => action === "unchanged")).toBe(true);
      const fnConfig = yield* Lambda.getFunctionEventInvokeConfig({
        FunctionName: fn.functionName,
      });
      expect(fnConfig.MaximumRetryAttempts).toBe(0);
      const aliasConfig = yield* Lambda.getFunctionEventInvokeConfig({
        FunctionName: fn.functionName,
        Qualifier: live.aliasName,
      });
      expect(aliasConfig.MaximumRetryAttempts).toBe(1);

      yield* stack.destroy();
    }),
  { tags: ["provider:aws", "provider:aws:lambda", "live"], timeout: 240_000 },
);
