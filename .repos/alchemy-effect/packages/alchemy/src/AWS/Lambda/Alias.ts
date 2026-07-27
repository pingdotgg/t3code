import * as Lambda from "@distilled.cloud/aws/lambda";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { deepEqual, isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { AWSEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  syncEventInvokeConfig,
  type EventInvokeConfig,
} from "./EventInvokeConfig.ts";

export interface AliasProps {
  /**
   * The name or ARN of the Lambda function.
   */
  functionName: string;
  /**
   * Lambda function version that this alias invokes.
   */
  functionVersion: string;
  /**
   * Name of the alias. If omitted, a unique name is generated.
   */
  aliasName?: string;
  /**
   * Description of the alias.
   */
  description?: string;
  /**
   * Weighted routing configuration for shifting traffic to an additional
   * function version.
   */
  routingConfig?: Lambda.AliasRoutingConfiguration;
  /**
   * Asynchronous invocation settings (retries, event age, destinations)
   * scoped to this alias. Omit to remove any existing alias-level config and
   * fall back to Lambda's defaults (2 retries, 6-hour max event age, no
   * destinations).
   */
  eventInvokeConfig?: EventInvokeConfig;
}

export interface Alias extends Resource<
  "AWS.Lambda.Alias",
  AliasProps,
  {
    /**
     * ARN of the Lambda alias.
     */
    aliasArn: string;
    /**
     * Name of the alias.
     */
    aliasName: string;
    /**
     * Name or ARN of the Lambda function this alias belongs to.
     */
    functionName: string;
    /**
     * Lambda function version that this alias invokes.
     */
    functionVersion: string;
    /**
     * API Gateway-compatible invocation ARN for this alias.
     */
    invokeArn: string;
    /**
     * Description of the alias.
     */
    description?: string;
    /**
     * Weighted routing configuration for this alias.
     */
    routingConfig?: Lambda.AliasRoutingConfiguration;
    /**
     * Latest Lambda revision id for this alias.
     */
    revisionId?: string;
  },
  never,
  Providers
> {}

/**
 * A Lambda alias for routing invocations to a stable function version.
 *
 * @section Creating Aliases
 * @example Production Alias
 * ```typescript
 * const alias = yield* Alias("ProductionAlias", {
 *   functionName: fn.functionName,
 *   functionVersion: "1",
 *   aliasName: "production",
 * });
 * ```
 *
 * @section Weighted Routing
 * @example Shift Traffic to Another Version
 * ```typescript
 * const alias = yield* Alias("LiveAlias", {
 *   functionName: fn.functionName,
 *   functionVersion: "2",
 *   aliasName: "live",
 *   routingConfig: {
 *     AdditionalVersionWeights: {
 *       "3": 0.1,
 *     },
 *   },
 * });
 * ```
 *
 * @section Async Invocation
 * @example Alias-Scoped Retry Behavior
 * ```typescript
 * const alias = yield* Alias("LiveAlias", {
 *   functionName: fn.functionName,
 *   functionVersion: "2",
 *   aliasName: "live",
 *   eventInvokeConfig: {
 *     maximumRetryAttempts: 0,
 *     destinationConfig: {
 *       OnFailure: {
 *         Destination: queue.queueArn,
 *       },
 *     },
 *   },
 * });
 * ```
 */
export const Alias = Resource<Alias>("AWS.Lambda.Alias");

const normalizeRoutingConfig = (
  config: Lambda.AliasRoutingConfiguration | undefined,
): Lambda.AliasRoutingConfiguration | undefined => {
  const weights = Object.fromEntries(
    Object.entries(config?.AdditionalVersionWeights ?? {}).filter(
      (entry): entry is [string, number] => entry[1] !== undefined,
    ),
  );
  return Object.keys(weights).length > 0
    ? { AdditionalVersionWeights: weights }
    : undefined;
};

export const AliasProvider = () =>
  Provider.effect(
    Alias,
    Effect.gen(function* () {
      const createAliasName = (id: string, aliasName?: string) =>
        aliasName
          ? Effect.succeed(aliasName)
          : createPhysicalName({
              id,
              maxLength: 128,
              delimiter: "-",
            });

      const retryOnAliasConflict = <A, E extends { _tag: string }, R>(
        effect: Effect.Effect<A, E, R>,
      ) =>
        effect.pipe(
          Effect.retry({
            while: (e) => e._tag === "ResourceConflictException",
            schedule: Schedule.max([
              Schedule.exponential(500),
              Schedule.recurs(10),
            ]),
          }),
        );

      const snapshotAlias = (
        functionName: string,
        alias: Lambda.AliasConfiguration,
        region: string,
      ): Alias["Attributes"] | undefined => {
        if (!alias.AliasArn || !alias.Name || !alias.FunctionVersion) {
          return undefined;
        }
        return {
          aliasArn: alias.AliasArn,
          aliasName: alias.Name,
          functionName,
          functionVersion: alias.FunctionVersion,
          invokeArn: `arn:aws:apigateway:${region}:lambda:path/2015-03-31/functions/${alias.AliasArn}/invocations`,
          description: alias.Description || undefined,
          routingConfig: normalizeRoutingConfig(alias.RoutingConfig),
          revisionId: alias.RevisionId,
        };
      };

      return {
        stables: ["aliasArn", "aliasName", "functionName"],
        diff: Effect.fn(function* ({ id, olds, news }) {
          if (!isResolved(news)) return;
          const oldAliasName = yield* createAliasName(id, olds.aliasName);
          const newAliasName = yield* createAliasName(id, news.aliasName);
          if (
            olds.functionName !== news.functionName ||
            oldAliasName !== newAliasName
          ) {
            return { action: "replace" } as const;
          }
        }),
        read: Effect.fn(function* ({ id, olds, output }) {
          const functionName = output?.functionName ?? olds?.functionName;
          if (!functionName) return undefined;
          const aliasName =
            output?.aliasName ?? (yield* createAliasName(id, olds?.aliasName));
          const { region } = yield* AWSEnvironment.current;
          const alias = yield* Lambda.getAlias({
            FunctionName: functionName,
            Name: aliasName,
          }).pipe(
            Effect.catchTag("ResourceNotFoundException", () =>
              Effect.succeed(undefined),
            ),
          );
          return alias ? snapshotAlias(functionName, alias, region) : undefined;
        }),
        list: () =>
          Effect.gen(function* () {
            const { region } = yield* AWSEnvironment.current;
            const functionNames = yield* Lambda.listFunctions.pages({}).pipe(
              Stream.runCollect,
              Effect.map((chunk) =>
                Array.from(chunk).flatMap((page) =>
                  (page.Functions ?? [])
                    .map((fn) => fn.FunctionName)
                    .filter((name): name is string => name !== undefined),
                ),
              ),
            );
            const aliases = yield* Effect.forEach(
              functionNames,
              (functionName) =>
                Lambda.listAliases.items({ FunctionName: functionName }).pipe(
                  Stream.runCollect,
                  Effect.map((chunk) =>
                    Array.from(chunk).flatMap((alias) => {
                      const attrs = snapshotAlias(functionName, alias, region);
                      return attrs ? [attrs] : [];
                    }),
                  ),
                  Effect.catchTag("ResourceNotFoundException", () =>
                    Effect.succeed([] as Alias["Attributes"][]),
                  ),
                ),
              { concurrency: 10 },
            );
            return aliases.flat();
          }),
        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const { region } = yield* AWSEnvironment.current;
          const aliasName =
            output?.aliasName ?? (yield* createAliasName(id, news.aliasName));
          const desiredRoutingConfig = normalizeRoutingConfig(
            news.routingConfig,
          );
          const getAlias = Lambda.getAlias({
            FunctionName: news.functionName,
            Name: aliasName,
          }).pipe(
            Effect.catchTag("ResourceNotFoundException", () =>
              Effect.succeed(undefined),
            ),
          );

          let alias = yield* getAlias;

          if (!alias) {
            alias = yield* Lambda.createAlias({
              FunctionName: news.functionName,
              Name: aliasName,
              FunctionVersion: news.functionVersion,
              Description: news.description,
              RoutingConfig: desiredRoutingConfig,
            }).pipe(
              Effect.catchTag("ResourceConflictException", () => getAlias),
            );
          }

          const observedRoutingConfig = normalizeRoutingConfig(
            alias?.RoutingConfig,
          );
          if (
            !alias ||
            alias.FunctionVersion !== news.functionVersion ||
            (alias.Description || undefined) !== news.description ||
            !deepEqual(observedRoutingConfig, desiredRoutingConfig)
          ) {
            alias = yield* retryOnAliasConflict(
              Lambda.updateAlias({
                FunctionName: news.functionName,
                Name: aliasName,
                FunctionVersion: news.functionVersion,
                Description: news.description ?? "",
                RoutingConfig:
                  desiredRoutingConfig ??
                  (observedRoutingConfig
                    ? { AdditionalVersionWeights: {} }
                    : undefined),
              }),
            );
          }

          const attrs = snapshotAlias(news.functionName, alias, region);
          if (!attrs) {
            return yield* Effect.die(
              `Lambda alias ${aliasName} did not return complete attributes.`,
            );
          }

          yield* syncEventInvokeConfig({
            functionName: news.functionName,
            qualifier: attrs.aliasName,
            config: news.eventInvokeConfig,
          });

          yield* session.note(
            `Alias ${attrs.aliasName} on ${attrs.functionName}`,
          );

          return attrs;
        }),
        delete: Effect.fn(function* ({ output }) {
          // The alias-scoped async config does not die with the alias — clear
          // it first so a later alias of the same name starts clean.
          yield* syncEventInvokeConfig({
            functionName: output.functionName,
            qualifier: output.aliasName,
            config: undefined,
          });
          yield* retryOnAliasConflict(
            Lambda.deleteAlias({
              FunctionName: output.functionName,
              Name: output.aliasName,
            }),
          ).pipe(
            Effect.catchTag("ResourceNotFoundException", () => Effect.void),
          );
        }),
      };
    }),
  );
