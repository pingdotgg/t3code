import * as Binding from "alchemy/Binding";
import type { Input } from "alchemy/Input";
import type * as Output from "alchemy/Output";
import type { ResourceLike } from "alchemy/Resource";
/**
 * Shared HTTP-binding scaffolding for App Runner capabilities.
 *
 * INTERNAL — deliberately NOT exported from `index.ts`. Each `{Op}Http.ts`
 * is a thin call to {@link makeAppRunnerHttpBinding}; everything except the
 * operation, the identifier resolvers, and the IAM grant is boilerplate:
 * resolve the bound resources' identifiers (which also registers them on the
 * host's environment), register the IAM policy statement on the binding host
 * (skipped inside the deployed function), and return the traced runtime
 * client that merges the identifiers into each wire request.
 */
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as AWSBindings from "../AWSBindings.ts";
import { AWSEnvironment } from "../Environment.ts";

/** Region/account available to an IAM grant factory. */
export interface AppRunnerIamContext {
  region: string;
  accountId: string;
}

export interface AppRunnerHttpBindingSpec {
  /**
   * Wire-request fields resolved from the bound resources' attributes,
   * keyed by the operation's request field name (e.g. `ServiceArn`).
   */
  identifiers: Record<string, Output.Output<string, never>>;
  /** The IAM actions + resource ARNs the host needs for this capability. */
  iam: (ctx: AppRunnerIamContext) => {
    actions: string[];
    resources: Input<string>[];
  };
}

/**
 * Build the `Layer.effect` for an App Runner HTTP binding from its three
 * distinguishing parts: the distilled operation, the identifier resolvers,
 * and the IAM grant.
 */
export const makeAppRunnerHttpBinding = <
  Self,
  Identifier extends string,
  Shape extends (...args: any[]) => Effect.Effect<any, any, any>,
  WireIn extends object,
  Out,
  Err,
  OpReq,
>(
  service: Binding.Service<Self, Identifier, Shape>,
  options: {
    /** The distilled App Runner operation backing the capability. */
    operation: Effect.Effect<(input: WireIn) => Effect.Effect<Out, Err>, never, OpReq>;
    /** Derive identifiers + IAM grant from the bound resources. */
    spec: (...args: Parameters<Shape>) => AppRunnerHttpBindingSpec;
  },
): Layer.Layer<Self, never, OpReq> =>
  Layer.effect(
    service,
    Effect.gen(function* () {
      const bind = yield* AWSBindings.Bind;
      const operation = yield* AWSBindings.withCredentials(options.operation);

      return Effect.fn(function* (...args: Parameters<Shape>) {
        const { identifiers, iam } = options.spec(...args);
        const label = (args as ResourceLike[]).map((arg) => arg.LogicalId).join(", ");

        // Outputs yield DEFERRED effects — resolving them here registers the
        // attributes on the host environment; re-yield per invocation below.
        const resolved: [string, Effect.Effect<string>][] = [];
        for (const [key, output] of Object.entries(identifiers)) {
          resolved.push([key, yield* output]);
        }

        if (!globalThis.__ALCHEMY_RUNTIME__) {
          const { accountId, region } = yield* AWSEnvironment.current as unknown as Effect.Effect<{
            accountId: string;
            region: string;
          }>;
          const { actions, resources } = iam({ accountId, region });
          yield* bind`${service.key}(${label})`({
            policyStatements: [
              {
                Effect: "Allow",
                Action: actions,
                Resource: resources,
              },
            ],
          });
        }

        return Effect.fn(`${service.key}(${label})`)(function* (request?: object) {
          const ids: Record<string, string> = {};
          for (const [key, effect] of resolved) {
            ids[key] = yield* effect;
          }
          return yield* operation({ ...request, ...ids } as WireIn);
        });
      }) as unknown as Shape;
    }),
  );
