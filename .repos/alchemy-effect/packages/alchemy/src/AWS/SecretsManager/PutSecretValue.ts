import * as secretsmanager from "@distilled.cloud/aws/secrets-manager";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Binding from "../../Binding.ts";
import { isFunction } from "../Lambda/Function.ts";
import type { Secret } from "./Secret.ts";

export interface PutSecretValueRequest extends Omit<
  secretsmanager.PutSecretValueRequest,
  "SecretId"
> {}

/**
 * Runtime binding for `secretsmanager:PutSecretValue`.
 */
export class PutSecretValue extends Binding.Service<
  PutSecretValue,
  (
    secret: Secret,
  ) => Effect.Effect<
    (
      request: PutSecretValueRequest,
    ) => Effect.Effect<
      secretsmanager.PutSecretValueResponse,
      secretsmanager.PutSecretValueError
    >
  >
>()("AWS.SecretsManager.PutSecretValue") {}

export const PutSecretValueLive = Layer.effect(
  PutSecretValue,
  Effect.gen(function* () {
    const Policy = yield* PutSecretValuePolicy;
    const putSecretValue = yield* secretsmanager.putSecretValue;

    return Effect.fn(function* (secret: Secret) {
      const SecretId = yield* secret.secretArn;
      yield* Policy(secret);
      return Effect.fn(function* (request: PutSecretValueRequest) {
        const secretId = yield* SecretId;
        return yield* putSecretValue({
          ...request,
          SecretId: secretId,
        });
      });
    });
  }),
);

export class PutSecretValuePolicy extends Binding.Policy<
  PutSecretValuePolicy,
  (secret: Secret) => Effect.Effect<void>
>()("AWS.SecretsManager.PutSecretValue") {}

export const PutSecretValuePolicyLive = PutSecretValuePolicy.layer.succeed(
  Effect.fn(function* (host, secret) {
    if (isFunction(host)) {
      yield* host.bind`Allow(${host}, AWS.SecretsManager.PutSecretValue(${secret}))`(
        {
          policyStatements: [
            {
              Effect: "Allow",
              Action: [
                "secretsmanager:PutSecretValue",
                "secretsmanager:DescribeSecret",
              ],
              Resource: [secret.secretArn],
            },
          ],
        },
      );
    } else {
      return yield* Effect.die(
        `PutSecretValuePolicy does not support runtime '${host.Type}'`,
      );
    }
  }),
);
