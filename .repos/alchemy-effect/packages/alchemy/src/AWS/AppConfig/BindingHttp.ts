/**
 * Shared HTTP-binding scaffolding for AppConfig capabilities.
 *
 * INTERNAL — deliberately NOT exported from `index.ts`. Each `{Op}Http.ts`
 * is a thin call to {@link makeAppConfigHttpBinding}; everything except the
 * operation, the identifier resolvers, and the IAM grant is boilerplate:
 * resolve the bound resources' identifiers (which also registers them on the
 * host's environment), register the IAM policy statement on the binding host
 * (skipped inside the deployed function), and return the traced runtime
 * client that merges the identifiers into each wire request.
 */
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Binding from "../../Binding.ts";
import type { Input } from "../../Input.ts";
import type * as Output from "../../Output.ts";
import type { ResourceLike } from "../../Resource.ts";
import { AWSEnvironment } from "../Environment.ts";
import { isBindingHost } from "../Lambda/Function.ts";

/** Region/account available to an IAM grant factory. */
export interface AppConfigIamContext {
  region: string;
  accountId: string;
}

export interface AppConfigHttpBindingSpec {
  /**
   * Wire-request fields resolved from the bound resources' attributes,
   * keyed by the operation's request field name (e.g. `ApplicationId`).
   */
  identifiers: Record<string, Output.Output<string, never>>;
  /** The IAM actions + resource ARNs the host needs for this capability. */
  iam: (ctx: AppConfigIamContext) => {
    actions: string[];
    resources: Input<string>[];
  };
}

/**
 * Build the `Layer.effect` for an AppConfig HTTP binding from its three
 * distinguishing parts: the distilled operation, the identifier resolvers,
 * and the IAM grant.
 */
export const makeAppConfigHttpBinding = <
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
    /** The distilled AppConfig operation backing the capability. */
    operation: Effect.Effect<
      (input: WireIn) => Effect.Effect<Out, Err>,
      never,
      OpReq
    >;
    /** Derive identifiers + IAM grant from the bound resources. */
    spec: (...args: Parameters<Shape>) => AppConfigHttpBindingSpec;
  },
): Layer.Layer<Self, never, OpReq> =>
  Layer.effect(
    service,
    Effect.gen(function* () {
      const operation = yield* options.operation;

      return Effect.fn(function* (...args: Parameters<Shape>) {
        const { identifiers, iam } = options.spec(...args);
        const label = (args as ResourceLike[])
          .map((arg) => arg.LogicalId)
          .join(", ");

        // Outputs yield DEFERRED effects — resolving them here registers the
        // attributes on the host environment; re-yield per invocation below.
        const resolved: [string, Effect.Effect<string>][] = [];
        for (const [key, output] of Object.entries(identifiers)) {
          resolved.push([key, yield* output]);
        }

        if (!globalThis.__ALCHEMY_RUNTIME__) {
          const host = yield* Binding.Host;
          if (isBindingHost(host)) {
            const { accountId, region } =
              yield* AWSEnvironment.current as unknown as Effect.Effect<{
                accountId: string;
                region: string;
              }>;
            const { actions, resources } = iam({ accountId, region });
            yield* host.bind(
              `Allow(${host.LogicalId}, ${service.key}(${label}))`,
              {
                policyStatements: [
                  {
                    Effect: "Allow",
                    Action: actions,
                    Resource: resources,
                  },
                ],
              },
            );
          }
        }

        return Effect.fn(`${service.key}(${label})`)(function* (
          request: object,
        ) {
          const ids: Record<string, string> = {};
          for (const [key, effect] of resolved) {
            ids[key] = yield* effect;
          }
          return yield* operation({ ...request, ...ids } as WireIn);
        });
      }) as unknown as Shape;
    }),
  );
