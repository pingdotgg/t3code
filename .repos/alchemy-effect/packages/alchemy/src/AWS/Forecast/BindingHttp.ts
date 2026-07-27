import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { PolicyStatement } from "../IAM/Policy.ts";
import { isBindingHost } from "../Lambda/Function.ts";

/**
 * Shared HTTP scaffolding for the Amazon Forecast runtime bindings.
 *
 * The runtime-targeted Forecast objects (dataset import jobs, predictors,
 * forecasts) are created *at runtime* with caller-chosen names, so their ARNs
 * are unknowable at deploy time — every binding is account-level and grants
 * its action(s) on `Resource: ["*"]`. The only variation between bindings is
 * the distilled operation, the IAM action, and whether the operation passes
 * a data-access role to the service (`CreateDatasetImportJob` /
 * `CreateAutoPredictor`, which additionally need `iam:PassRole` conditioned
 * to `forecast.amazonaws.com`).
 *
 * NOT exported from `index.ts` — every thin `{Op}Http.ts` in this service is
 * a `Layer.effect(Cap, makeForecastHttpBinding({ … }))`.
 */
export const makeForecastHttpBinding = <I, A, E, R>(options: {
  /**
   * Short capability name used in the binding sid and runtime span, e.g.
   * `"QueryForecast"`.
   */
  capability: string;
  /**
   * IAM actions granted on `Resource: ["*"]` (the target ARNs are created at
   * runtime and unknowable at deploy time).
   */
  iamActions: readonly string[];
  /**
   * The distilled operation implementing the capability.
   */
  operation: Effect.Effect<(input: I) => Effect.Effect<A, E>, never, R>;
  /**
   * Grant `iam:PassRole` (conditioned to `forecast.amazonaws.com`) so the
   * function can hand the service the role it assumes to read S3 training
   * data or use a customer KMS key. Set on the `Create*` bindings that accept
   * a `RoleArn`.
   */
  passRole?: boolean;
}) =>
  Effect.gen(function* () {
    const op = yield* options.operation;

    return Effect.fn(function* () {
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          const policyStatements: PolicyStatement[] = [
            {
              Effect: "Allow",
              Action: [...options.iamActions],
              // Runtime-created Forecast ARNs are unknowable at deploy time.
              Resource: ["*"],
            },
          ];
          if (options.passRole) {
            policyStatements.push({
              Effect: "Allow",
              Action: ["iam:PassRole"],
              Resource: ["*"],
              Condition: {
                StringEquals: {
                  "iam:PassedToService": "forecast.amazonaws.com",
                },
              },
            });
          }
          yield* host.bind`Allow(${host}, AWS.Forecast.${options.capability}())`(
            { policyStatements },
          );
        }
      }
      return Effect.fn(`AWS.Forecast.${options.capability}`)(function* (
        request: I,
      ) {
        return yield* op(request);
      });
    });
  });
