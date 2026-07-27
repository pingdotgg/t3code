import * as AWS from "@/AWS";
import * as Test from "@/Test/Alchemy";
import * as Lambda from "@distilled.cloud/aws/lambda";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { fileURLToPath } from "node:url";

const timeoutHandlerPath = fileURLToPath(
  new URL("./timeout-handler.ts", import.meta.url),
);

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
          functionVersion: string;
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
            url: false,
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

          const live = alias
            ? yield* AWS.Lambda.Alias("LiveAlias", {
                functionName: fn.functionName,
                functionVersion: alias.functionVersion,
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
      expect(liveCreated.DestinationConfig?.OnFailure?.Destination).toBe(
        undefined,
      );

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
      expect(liveUpdated.DestinationConfig?.OnFailure?.Destination).toBe(
        created.queue.queueArn,
      );

      // --- omit the prop: the config is deleted, not left behind ---
      const removed = yield* stack.deploy(program({}));
      yield* expectNoConfig(removed.fn.functionName);

      // --- alias-scoped config ---
      const version = yield* publishVersion(
        removed.fn.functionName,
        "version 1",
      );
      const withAlias = yield* stack.deploy(
        program({
          alias: {
            functionVersion: version,
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
      const aliasCleared = yield* stack.deploy(
        program({ alias: { functionVersion: version } }),
      );
      yield* expectNoConfig(
        aliasCleared.fn.functionName,
        aliasCleared.live!.aliasName,
      );

      yield* stack.destroy();

      // Out-of-band proof the destroy removed the host function (and with it
      // the event invoke configs) from the cloud.
      yield* Lambda.getFunction({
        FunctionName: aliasCleared.fn.functionName,
      }).pipe(
        Effect.flatMap(() =>
          Effect.fail(
            new Error(`Function ${aliasCleared.fn.functionName} still exists`),
          ),
        ),
        Effect.catchTag("ResourceNotFoundException", () => Effect.void),
        Effect.retry({
          schedule: Schedule.max([
            Schedule.exponential(500),
            Schedule.recurs(8),
          ]),
        }),
      );
    }).pipe(
      Effect.tap(() => stack.destroy()),
      Effect.onError(() => stack.destroy().pipe(Effect.ignore)),
    ),
  { timeout: 360_000 },
);

const getConfigOrUndefined = Effect.fn(function* (
  functionName: string,
  qualifier?: string,
) {
  return yield* Lambda.getFunctionEventInvokeConfig({
    FunctionName: functionName,
    Qualifier: qualifier,
  }).pipe(
    Effect.catchTag("ResourceNotFoundException", () =>
      Effect.succeed(undefined),
    ),
  );
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
        config.DestinationConfig?.OnFailure?.Destination ===
          expected.onFailureDestination,
      () => new Error("Event invoke config update has not propagated yet"),
    ),
    Effect.retry({
      schedule: Schedule.max([Schedule.exponential(500), Schedule.recurs(10)]),
    }),
  );
});

const expectNoConfig = Effect.fn(function* (
  functionName: string,
  qualifier?: string,
) {
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

const publishVersion = Effect.fn(function* (
  functionName: string,
  description: string,
) {
  const config = yield* Lambda.publishVersion({
    FunctionName: functionName,
    Description: description,
  }).pipe(
    Effect.retry({
      while: (e) => e._tag === "ResourceConflictException",
      schedule: Schedule.max([Schedule.exponential(500), Schedule.recurs(10)]),
    }),
    Effect.filterOrFail(
      (config) => config.Version !== undefined,
      () => new Error("Published Lambda version was missing Version."),
    ),
  );
  return config.Version!;
});
