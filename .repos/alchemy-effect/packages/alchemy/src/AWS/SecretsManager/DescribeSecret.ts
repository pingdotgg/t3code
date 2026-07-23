import * as secretsmanager from "@distilled.cloud/aws/secrets-manager";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Binding from "../../Binding.ts";
import { isFunction } from "../Lambda/Function.ts";
import type { Secret } from "./Secret.ts";

/**
 * Runtime binding for `secretsmanager:DescribeSecret`.
 */
export class DescribeSecret extends Binding.Service<
  DescribeSecret,
  (
    secret: Secret,
  ) => Effect.Effect<
    () => Effect.Effect<
      secretsmanager.DescribeSecretResponse,
      secretsmanager.DescribeSecretError
    >
  >
>()("AWS.SecretsManager.DescribeSecret") {}

export const DescribeSecretLive = Layer.effect(
  DescribeSecret,
  Effect.gen(function* () {
    const Policy = yield* DescribeSecretPolicy;
    const describeSecret = yield* secretsmanager.describeSecret;

    return Effect.fn(function* (secret: Secret) {
      const SecretId = yield* secret.secretArn;
      yield* Policy(secret);
      return Effect.fn(function* () {
        return yield* describeSecret({
          SecretId: yield* SecretId,
        });
      });
    });
  }),
);

export class DescribeSecretPolicy extends Binding.Policy<
  DescribeSecretPolicy,
  (secret: Secret) => Effect.Effect<void>
>()("AWS.SecretsManager.DescribeSecret") {}

export const DescribeSecretPolicyLive = DescribeSecretPolicy.layer.succeed(
  Effect.fn(function* (host, secret) {
    if (isFunction(host)) {
      yield* host.bind`Allow(${host}, AWS.SecretsManager.DescribeSecret(${secret}))`(
        {
          policyStatements: [
            {
              Effect: "Allow",
              Action: ["secretsmanager:DescribeSecret"],
              Resource: [secret.secretArn],
            },
          ],
        },
      );
    } else {
      return yield* Effect.die(
        `DescribeSecretPolicy does not support runtime '${host.Type}'`,
      );
    }
  }),
);
