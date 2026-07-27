import * as AWS from "@/AWS";
import * as Provider from "@/Provider";
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
  "create, update, list, replace, delete alias",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const program = ({
        envVersion,
        alias,
      }: {
        envVersion: string;
        alias?: {
          aliasName: string;
          functionVersion: string;
          description?: string;
          routingConfig?: Lambda.AliasRoutingConfiguration;
        };
      }) =>
        Effect.gen(function* () {
          const fn = yield* AWS.Lambda.Function("AliasFn", {
            main: timeoutHandlerPath,
            handler: "handler",
            isExternal: true,
            url: false,
            env: {
              VERSION: envVersion,
            },
          });

          const live = alias
            ? yield* AWS.Lambda.Alias("LiveAlias", {
                functionName: fn.functionName,
                functionVersion: alias.functionVersion,
                aliasName: alias.aliasName,
                description: alias.description,
                routingConfig: alias.routingConfig,
              })
            : undefined;

          return { fn, live };
        });

      const initial = yield* stack.deploy(program({ envVersion: "1" }));
      const version1 = yield* publishVersion(
        initial.fn.functionName,
        "version 1",
      );

      // --- create ---
      const created = yield* stack.deploy(
        program({
          envVersion: "1",
          alias: {
            aliasName: "live",
            functionVersion: version1,
            description: "live v1",
          },
        }),
      );
      const createdAlias = created.live!;

      expect(createdAlias.aliasName).toBe("live");
      expect(createdAlias.functionVersion).toBe(version1);
      expect(createdAlias.invokeArn).toContain(createdAlias.aliasArn);

      // Assert the alias actually exists in the cloud.
      const liveV1 = yield* getAliasOrUndefined(
        created.fn.functionName,
        "live",
      );
      expect(liveV1).toBeDefined();
      expect(liveV1!.AliasArn).toBe(createdAlias.aliasArn);
      expect(liveV1!.FunctionVersion).toBe(version1);
      expect(liveV1!.Description).toBe("live v1");
      expect(liveV1!.RoutingConfig?.AdditionalVersionWeights ?? {}).toEqual({});

      // --- update (function version + weighted routing + description) ---
      const updatedFunction = yield* stack.deploy(
        program({
          envVersion: "2",
          alias: {
            aliasName: "live",
            functionVersion: version1,
            description: "live v1",
          },
        }),
      );
      const version2 = yield* publishVersion(
        updatedFunction.fn.functionName,
        "version 2",
      );

      const updated = yield* stack.deploy(
        program({
          envVersion: "2",
          alias: {
            aliasName: "live",
            functionVersion: version2,
            description: "weighted live",
            routingConfig: {
              AdditionalVersionWeights: {
                [version1]: 0.25,
              },
            },
          },
        }),
      );
      const updatedAlias = updated.live!;

      // Updating in place must keep the same ARN (not a replacement).
      expect(updatedAlias.aliasArn).toBe(createdAlias.aliasArn);
      expect(updatedAlias.functionVersion).toBe(version2);
      expect(updatedAlias.description).toBe("weighted live");
      expect(updatedAlias.routingConfig).toEqual({
        AdditionalVersionWeights: {
          [version1]: 0.25,
        },
      });

      // Assert the cloud reflects the update.
      const liveV2 = yield* getAliasOrUndefined(
        updated.fn.functionName,
        "live",
      );
      expect(liveV2).toBeDefined();
      expect(liveV2!.AliasArn).toBe(createdAlias.aliasArn);
      expect(liveV2!.FunctionVersion).toBe(version2);
      expect(liveV2!.Description).toBe("weighted live");
      expect(liveV2!.RoutingConfig?.AdditionalVersionWeights).toEqual({
        [version1]: 0.25,
      });

      // --- update (clear description + routing) ---
      const cleared = yield* stack.deploy(
        program({
          envVersion: "2",
          alias: {
            aliasName: "live",
            functionVersion: version2,
          },
        }),
      );
      const clearedAlias = cleared.live!;

      expect(clearedAlias.aliasArn).toBe(createdAlias.aliasArn);
      expect(clearedAlias.functionVersion).toBe(version2);
      expect(clearedAlias.description).toBeUndefined();
      expect(clearedAlias.routingConfig).toBeUndefined();

      // Assert the cloud cleared description and routing.
      const liveCleared = yield* getAliasOrUndefined(
        cleared.fn.functionName,
        "live",
      );
      expect(liveCleared).toBeDefined();
      expect(liveCleared!.Description ?? "").toBe("");
      expect(
        liveCleared!.RoutingConfig?.AdditionalVersionWeights ?? {},
      ).toEqual({});

      // --- replace (rename the alias) ---
      // The provider's `diff` flags an aliasName change as a replacement, so a
      // brand new alias is created and the old one deleted.
      const replaced = yield* stack.deploy(
        program({
          envVersion: "2",
          alias: {
            aliasName: "stable",
            functionVersion: version2,
            description: "renamed",
          },
        }),
      );
      const replacedAlias = replaced.live!;

      expect(replacedAlias.aliasName).toBe("stable");
      // A replacement must mint a new ARN.
      expect(replacedAlias.aliasArn).not.toBe(createdAlias.aliasArn);
      expect(replacedAlias.functionVersion).toBe(version2);
      expect(replacedAlias.description).toBe("renamed");

      // The new alias exists in the cloud...
      const stableAlias = yield* getAliasOrUndefined(
        replaced.fn.functionName,
        "stable",
      );
      expect(stableAlias).toBeDefined();
      expect(stableAlias!.AliasArn).toBe(replacedAlias.aliasArn);
      expect(stableAlias!.FunctionVersion).toBe(version2);
      expect(stableAlias!.Description).toBe("renamed");

      // ...and the old one was deleted as part of the replacement.
      const oldLive = yield* getAliasOrUndefined(
        replaced.fn.functionName,
        "live",
      );
      expect(oldLive).toBeUndefined();

      // --- list ---
      const provider = yield* Provider.findProvider(AWS.Lambda.Alias);
      const aliases = yield* provider.list();
      expect(
        aliases.some(
          (alias) =>
            alias.functionName === replaced.fn.functionName &&
            alias.aliasName === "stable",
        ),
      ).toBe(true);

      // --- delete ---
      yield* stack.destroy();

      const afterDestroy = yield* getAliasOrUndefined(
        replaced.fn.functionName,
        "stable",
      );
      expect(afterDestroy).toBeUndefined();

      // ...and the host function itself is gone (bounded retry to ride out
      // delete propagation).
      yield* Lambda.getFunction({
        FunctionName: replaced.fn.functionName,
      }).pipe(
        Effect.flatMap(() =>
          Effect.fail(
            new Error(`Function ${replaced.fn.functionName} still exists`),
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

const getAliasOrUndefined = Effect.fn(function* (
  functionName: string,
  name: string,
) {
  return yield* Lambda.getAlias({
    FunctionName: functionName,
    Name: name,
  }).pipe(
    Effect.catchTag("ResourceNotFoundException", () =>
      Effect.succeed(undefined),
    ),
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
