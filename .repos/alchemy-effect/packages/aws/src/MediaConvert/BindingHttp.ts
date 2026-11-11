import * as Effect from "effect/Effect";
import * as AWSBindings from "../AWSBindings.ts";
import type { PolicyStatement } from "../IAM/Policy.ts";

/**
 * Shared HTTP scaffolding for the AWS Elemental MediaConvert runtime
 * bindings.
 *
 * MediaConvert jobs are created *at runtime* with server-assigned ids, so
 * their ARNs are unknowable at deploy time — every binding is account-level
 * and grants its action(s) on `Resource: ["*"]`. The only variation between
 * bindings is the distilled operation, the IAM action, and whether the
 * operation passes an S3-access role to the service (`CreateJob`, which
 * additionally needs `iam:PassRole` conditioned to
 * `mediaconvert.amazonaws.com`).
 *
 * NOT exported from `index.ts` — every thin `{Op}Http.ts` in this service is
 * a `Layer.effect(Cap, makeMediaConvertHttpBinding({ … }))`.
 */
export const makeMediaConvertHttpBinding = <I, A, E, R>(options: {
  /**
   * Short capability name used in the binding sid and runtime span, e.g.
   * `"CreateJob"`.
   */
  capability: string;
  /**
   * IAM actions granted on `Resource: ["*"]` (job ARNs are server-assigned
   * at runtime and unknowable at deploy time).
   */
  iamActions: readonly string[];
  /**
   * The distilled operation implementing the capability.
   */
  operation: Effect.Effect<(input: I) => Effect.Effect<A, E>, never, R>;
  /**
   * Grant `iam:PassRole` (conditioned to `mediaconvert.amazonaws.com`) so
   * the function can hand the service the role it assumes to read the input
   * from and write the output to S3. Set on `CreateJob`.
   */
  passRole?: boolean;
}) =>
  Effect.gen(function* () {
    const bind = yield* AWSBindings.Bind;
    const op = yield* AWSBindings.withCredentials(options.operation);

    return Effect.fn(function* () {
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const policyStatements: PolicyStatement[] = [
          {
            Effect: "Allow",
            Action: [...options.iamActions],
            // Job ARNs are server-assigned at runtime; queue/preset/template
            // references inside a job are resolved by the service.
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
                "iam:PassedToService": "mediaconvert.amazonaws.com",
              },
            },
          });
        }
        yield* bind`AWS.MediaConvert.${options.capability}()`({
          policyStatements,
        });
      }
      return Effect.fn(`AWS.MediaConvert.${options.capability}`)(function* (request?: I) {
        return yield* op((request ?? {}) as I);
      });
    });
  });
