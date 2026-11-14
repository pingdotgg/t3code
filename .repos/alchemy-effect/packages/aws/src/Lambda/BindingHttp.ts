import type { Output as OutputType } from "alchemy/Output";
import * as Effect from "effect/Effect";
import * as AWSBindings from "../AWSBindings.ts";
import type { Function } from "./Function.ts";
import { qualifiedArnOf } from "./QualifiedArn.ts";

/**
 * Shared scaffolding for AWS Lambda control/data-plane HTTP bindings.
 *
 * NOT exported from `index.ts` — every near-identical `{Op}Http.ts` in this
 * service is a thin `Layer.effect(Cap, make…HttpBinding({ … }))` over one of
 * the builders below. Everything except the operation, the IAM action list,
 * and the granted ARNs is boilerplate. How the host reaches AWS (native vs
 * external, see `AWSBindings.ts`) is handled by `AWSBindings.withCredentials`
 * and `AWSBindings.Bind`.
 */

/** Region segment of an AWS ARN (`arn:partition:service:<region>:...`). */
export const regionFromArn = (arn: string): string => arn.split(":")[3] ?? "us-east-1";

/**
 * Build the impl Effect for a function-scoped operation (`Invoke`,
 * `GetFunction`, `InvokeWithResponseStream`): the runtime callable injects
 * the bound {@link Function}'s ARN as `FunctionName` and the deploy-time
 * half grants `actions` on `resources` (default: the function ARN).
 */
export const makeFunctionHttpBinding = <I extends { FunctionName?: string }, A, E, R>(options: {
  /** Fully-qualified binding tag, e.g. `AWS.Lambda.GetFunction`. */
  tag: string;
  /**
   * The distilled operation; `FunctionName` is injected from the function.
   * Resolved with the host's credentials (see `AWSBindings.withCredentials`),
   * signing in the function's region on a host with a created key.
   */
  operation: Effect.Effect<(input: I) => Effect.Effect<A, E>, never, R>;
  /** IAM actions granted on `resources`. */
  actions: readonly string[];
  /** ARNs the actions are granted on. @default the function ARN */
  resources?: (func: Function) => (string | OutputType<string>)[];
  /**
   * Target the Function's alias (see `FunctionProps.alias`) instead of the
   * unqualified function, for operations that invoke it. Grants the actions
   * on the alias ARN unless `resources` overrides it.
   */
  qualified?: boolean;
}) =>
  Effect.gen(function* () {
    const bind = yield* AWSBindings.Bind;
    return Effect.fn(function* (func: Function) {
      const target = options.qualified ? qualifiedArnOf(func) : func.functionArn;
      const FunctionArn = options.qualified
        ? // Same runtime path as `yield* output` (which keys the value by the
          // expression's source text), with a readable key; typed like the
          // iterator, whose RuntimeContext the host always provides.
          // oxlint-disable-next-line effecttsgo/unsafe-effect-type-assertion -- the host provides RuntimeContext at runtime
          yield* target.bind(`${func.LogicalId}.qualifiedArn`) as Effect.Effect<
            Effect.Effect<string>
          >
        : yield* func.functionArn;
      // resolved per bind because a host with a created key signs in the function's own region
      const op = yield* AWSBindings.withCredentials(
        options.operation,
        Effect.succeed(Effect.map(FunctionArn, regionFromArn)),
      );
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        yield* bind`${options.tag}(${func})`({
          policyStatements: [
            {
              Effect: "Allow",
              Action: [...options.actions],
              Resource: options.resources?.(func) ?? [target],
            },
          ],
        });
      }
      return Effect.fn(`${options.tag}(${func.LogicalId})`)(function* (
        request?: Omit<I, "FunctionName">,
      ) {
        return yield* op({ ...request, FunctionName: yield* FunctionArn } as I);
      });
    });
  });

/**
 * Build the impl Effect for an account-level operation
 * (`GetAccountSettings`, `ListFunctions`): the runtime callable passes the
 * caller's request through unchanged and the deploy-time half grants
 * `actions` on `*` (these Lambda actions do not support resource-level
 * permissions).
 */
export const makeLambdaAccountHttpBinding = <I, A, E, R>(options: {
  /** Fully-qualified binding tag, e.g. `AWS.Lambda.ListFunctions`. */
  tag: string;
  /** The distilled operation, invoked with the caller's request as-is. */
  operation: Effect.Effect<(input: I) => Effect.Effect<A, E>, never, R>;
  /** IAM actions granted on `*`. */
  actions: readonly string[];
}) =>
  Effect.gen(function* () {
    const bind = yield* AWSBindings.Bind;
    const op = yield* AWSBindings.withCredentials(options.operation);

    return Effect.fn(function* () {
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        yield* bind`${options.tag}()`({
          policyStatements: [
            {
              Effect: "Allow",
              Action: [...options.actions],
              Resource: ["*"],
            },
          ],
        });
      }
      return Effect.fn(options.tag)(function* (request?: I) {
        return yield* op((request ?? {}) as I);
      });
    });
  });
