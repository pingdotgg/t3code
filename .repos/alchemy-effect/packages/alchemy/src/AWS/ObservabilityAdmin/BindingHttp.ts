import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import { isBindingHost } from "../Lambda/Function.ts";

/**
 * Shared HTTP scaffolding for the CloudWatch Observability Admin runtime
 * bindings.
 *
 * Every account-level Observability Admin read (`ListResourceTelemetry`,
 * `GetTelemetryEvaluationStatus`, ...) targets account configuration rather
 * than a discrete ARN, so each binding grants its action on
 * `Resource: ["*"]`. The only variation between bindings is the distilled
 * operation and the IAM action.
 *
 * NOT exported from `index.ts` — every thin `{Op}Http.ts` in this service is
 * a `Layer.effect(Cap, makeObservabilityAdminHttpBinding({ … }))`.
 */
export const makeObservabilityAdminHttpBinding = <I, A, E, R>(options: {
  /**
   * Short capability name used in the binding sid and runtime span, e.g.
   * `"ListResourceTelemetry"`.
   */
  capability: string;
  /**
   * IAM actions granted on `Resource: ["*"]` (account-level configuration
   * reads have no resource ARN to scope to).
   */
  iamActions: readonly string[];
  /**
   * The distilled operation implementing the capability.
   */
  operation: Effect.Effect<(input: I) => Effect.Effect<A, E>, never, R>;
}) =>
  Effect.gen(function* () {
    const op = yield* options.operation;

    return Effect.fn(function* () {
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          yield* host.bind`Allow(${host}, AWS.ObservabilityAdmin.${options.capability}())`(
            {
              policyStatements: [
                {
                  Effect: "Allow",
                  Action: [...options.iamActions],
                  // Account-level configuration reads have no resource ARN.
                  Resource: ["*"],
                },
              ],
            },
          );
        }
      }
      return Effect.fn(`AWS.ObservabilityAdmin.${options.capability}`)(
        function* (request?: I) {
          return yield* op(request ?? ({} as I));
        },
      );
    });
  });
