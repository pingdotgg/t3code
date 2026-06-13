import * as secretsmanager from "@distilled.cloud/aws/secrets-manager";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Binding from "../../Binding.ts";
import { isFunction } from "../Lambda/Function.ts";
import type { Secret } from "./Secret.ts";

export interface GetSecretValueRequest extends Omit<
  secretsmanager.GetSecretValueRequest,
  "SecretId"
> {}

/**
 * Runtime binding for `secretsmanager:GetSecretValue`.
 */
export class GetSecretValue extends Binding.Service<
  GetSecretValue,
  (
    secret: Secret,
  ) => Effect.Effect<
    (
      request?: GetSecretValueRequest,
    ) => Effect.Effect<
      secretsmanager.GetSecretValueResponse,
      secretsmanager.GetSecretValueError
    >
  >
>()("AWS.SecretsManager.GetSecretValue") {}

export const GetSecretValueLive = Layer.effect(
  GetSecretValue,
  Effect.gen(function* () {
    const Policy = yield* GetSecretValuePolicy;
    const getSecretValue = yield* secretsmanager.getSecretValue;

    return Effect.fn(function* (secret: Secret) {
      const SecretId = yield* secret.secretArn;
      yield* Policy(secret);
      return Effect.fn(function* (request: GetSecretValueRequest = {}) {
        const secretId = yield* SecretId;
        return yield* getSecretValue({
          ...request,
          SecretId: secretId,
        });
      });
    });
  }),
);

export class GetSecretValuePolicy extends Binding.Policy<
  GetSecretValuePolicy,
  (secret: Secret) => Effect.Effect<void>
>()("AWS.SecretsManager.GetSecretValue") {}

export const GetSecretValuePolicyLive = GetSecretValuePolicy.layer.succeed(
  Effect.fn(function* (host, secret) {
    if (isFunction(host)) {
      yield* host.bind`Allow(${host}, AWS.SecretsManager.GetSecretValue(${secret}))`(
        {
          policyStatements: [
            {
              Effect: "Allow",
              Action: [
                "secretsmanager:GetSecretValue",
                "secretsmanager:DescribeSecret",
              ],
              Resource: [secret.secretArn],
            },
          ],
        },
      );
    } else {
      return yield* Effect.die(
        `GetSecretValuePolicy does not support runtime '${host.Type}'`,
      );
    }
  }),
);
