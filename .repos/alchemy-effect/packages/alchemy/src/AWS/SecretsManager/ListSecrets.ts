import * as secretsmanager from "@distilled.cloud/aws/secrets-manager";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Binding from "../../Binding.ts";
import { isFunction } from "../Lambda/Function.ts";

/**
 * Runtime binding for `secretsmanager:ListSecrets`.
 */
export class ListSecrets extends Binding.Service<
  ListSecrets,
  () => Effect.Effect<
    (
      request?: secretsmanager.ListSecretsRequest,
    ) => Effect.Effect<
      secretsmanager.ListSecretsResponse,
      secretsmanager.ListSecretsError
    >
  >
>()("AWS.SecretsManager.ListSecrets") {}

export const ListSecretsLive = Layer.effect(
  ListSecrets,
  Effect.gen(function* () {
    const Policy = yield* ListSecretsPolicy;
    const listSecrets = yield* secretsmanager.listSecrets;

    return Effect.fn(function* () {
      yield* Policy();
      return Effect.fn(function* (
        request: secretsmanager.ListSecretsRequest = {},
      ) {
        return yield* listSecrets(request);
      });
    });
  }),
);

export class ListSecretsPolicy extends Binding.Policy<
  ListSecretsPolicy,
  () => Effect.Effect<void>
>()("AWS.SecretsManager.ListSecrets") {}

export const ListSecretsPolicyLive = ListSecretsPolicy.layer.succeed(
  Effect.fn(function* (host) {
    if (isFunction(host)) {
      yield* host.bind`Allow(${host}, AWS.SecretsManager.ListSecrets())`({
        policyStatements: [
          {
            Effect: "Allow",
            Action: ["secretsmanager:ListSecrets"],
            Resource: ["*"],
          },
        ],
      });
    } else {
      return yield* Effect.die(
        `ListSecretsPolicy does not support runtime '${host.Type}'`,
      );
    }
  }),
);
