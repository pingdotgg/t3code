import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import { isBindingHost } from "../Lambda/Function.ts";
import type { CloudControlBindingOptions } from "./BindingOptions.ts";

/**
 * Shared scaffolding for Cloud Control HTTP bindings.
 *
 * NOT exported from `index.ts` — every `{Op}Http.ts` in this service is a
 * thin `Layer.effect(Cap, makeCloudControlHttpBinding({ … }))` over the
 * builder below. Everything except the operation and the IAM action is
 * boilerplate.
 *
 * All Cloud Control bindings are account-level: the `cloudformation:*Resource`
 * actions do not support resource-level scoping (the target is an arbitrary
 * CloudFormation type name), so the grant is on `*`. Because Cloud Control
 * invokes the resource type's handlers with the caller's credentials, callers
 * of handler-invoking operations may pass extra
 * {@link CloudControlBindingOptions.handlerPolicyStatements} that are attached
 * to the host alongside the Cloud Control grant.
 */
export const makeCloudControlHttpBinding = <I, A, E, R>(options: {
  /** Fully-qualified binding tag, e.g. `AWS.CloudControl.GetResource`. */
  tag: string;
  /** The distilled operation, invoked with the caller's request as-is. */
  operation: Effect.Effect<(input: I) => Effect.Effect<A, E>, never, R>;
  /** IAM actions granted on `*` (Cloud Control has no resource-level scoping). */
  actions: readonly string[];
}) =>
  Effect.gen(function* () {
    const op = yield* options.operation;

    return Effect.fn(function* (bindOptions?: CloudControlBindingOptions) {
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          yield* host.bind`Allow(${host}, ${options.tag}())`({
            policyStatements: [
              {
                Effect: "Allow",
                Action: [...options.actions],
                Resource: ["*"],
              },
              ...(bindOptions?.handlerPolicyStatements ?? []),
            ],
          });
        }
      }
      return Effect.fn(options.tag)(function* (request?: I) {
        return yield* op((request ?? {}) as I);
      });
    });
  });
