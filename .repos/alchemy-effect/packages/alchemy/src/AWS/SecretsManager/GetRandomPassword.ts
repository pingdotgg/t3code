import * as secretsmanager from "@distilled.cloud/aws/secrets-manager";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Binding from "../../Binding.ts";
import { isFunction } from "../Lambda/Function.ts";

/**
 * Runtime binding for `secretsmanager:GetRandomPassword`.
 */
export class GetRandomPassword extends Binding.Service<
  GetRandomPassword,
  () => Effect.Effect<
    (
      request?: secretsmanager.GetRandomPasswordRequest,
    ) => Effect.Effect<
      secretsmanager.GetRandomPasswordResponse,
      secretsmanager.GetRandomPasswordError
    >
  >
>()("AWS.SecretsManager.GetRandomPassword") {}

export const GetRandomPasswordLive = Layer.effect(
  GetRandomPassword,
  Effect.gen(function* () {
    const Policy = yield* GetRandomPasswordPolicy;
    const getRandomPassword = yield* secretsmanager.getRandomPassword;

    return Effect.fn(function* () {
      yield* Policy();
      return Effect.fn(function* (
        request: secretsmanager.GetRandomPasswordRequest = {},
      ) {
        return yield* getRandomPassword(request);
      });
    });
  }),
);

export class GetRandomPasswordPolicy extends Binding.Policy<
  GetRandomPasswordPolicy,
  () => Effect.Effect<void>
>()("AWS.SecretsManager.GetRandomPassword") {}

export const GetRandomPasswordPolicyLive =
  GetRandomPasswordPolicy.layer.succeed(
    Effect.fn(function* (host) {
      if (isFunction(host)) {
        yield* host.bind`Allow(${host}, AWS.SecretsManager.GetRandomPassword())`(
          {
            policyStatements: [
              {
                Effect: "Allow",
                Action: ["secretsmanager:GetRandomPassword"],
                Resource: ["*"],
              },
            ],
          },
        );
      } else {
        return yield* Effect.die(
          `GetRandomPasswordPolicy does not support runtime '${host.Type}'`,
        );
      }
    }),
  );
