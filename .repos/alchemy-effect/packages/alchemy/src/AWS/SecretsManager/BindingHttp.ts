import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import { isBindingHost } from "../Lambda/Function.ts";
import type { Secret } from "./Secret.ts";

/**
 * Shared scaffolding for the AWS Secrets Manager HTTP bindings.
 *
 * NOT exported from `index.ts` — every thin `{Op}Http.ts` in this service is
 * a `Layer.effect(Cap, make…HttpBinding({ … }))` over one of the two builders
 * below. Everything except the operation and the IAM action list is
 * boilerplate.
 */

/**
 * Build the impl Effect for a Secrets Manager operation scoped to a bound
 * {@link Secret}: the deploy-time half grants `actions` on the secret's ARN,
 * and the runtime half injects the secret ARN as `SecretId` into every
 * request.
 */
export const makeSecretHttpBinding = <
  I extends { SecretId?: string },
  A,
  E,
  R,
>(options: {
  /** Fully-qualified binding tag, e.g. `AWS.SecretsManager.GetSecretValue`. */
  tag: string;
  /** The distilled operation. */
  operation: Effect.Effect<(input: I) => Effect.Effect<A, E>, never, R>;
  /** IAM actions granted on the bound secret. */
  actions: readonly `secretsmanager:${string}`[];
}) =>
  Effect.gen(function* () {
    const op = yield* options.operation;

    return Effect.fn(function* (secret: Secret) {
      const SecretId = yield* secret.secretArn;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          yield* host.bind`Allow(${host}, ${options.tag}(${secret}))`({
            policyStatements: [
              {
                Effect: "Allow",
                Action: [...options.actions],
                Resource: [secret.secretArn],
              },
            ],
          });
        }
      }
      return Effect.fn(`${options.tag}(${secret.LogicalId})`)(function* (
        request?: Omit<I, "SecretId">,
      ) {
        const secretId = yield* SecretId;
        return yield* op({ ...request, SecretId: secretId } as I);
      });
    });
  });

/**
 * Build the impl Effect for an account-level Secrets Manager operation that
 * is not scoped to a secret (e.g. `secretsmanager:GetRandomPassword`,
 * `secretsmanager:ListSecrets`). The deploy-time half grants `actions` on
 * `*`.
 */
export const makeSecretsManagerAccountHttpBinding = <I, A, E, R>(options: {
  /** Fully-qualified binding tag, e.g. `AWS.SecretsManager.ListSecrets`. */
  tag: string;
  /** The distilled operation, invoked with the caller's request as-is. */
  operation: Effect.Effect<(input: I) => Effect.Effect<A, E>, never, R>;
  /** IAM actions granted on `*`. */
  actions: readonly `secretsmanager:${string}`[];
}) =>
  Effect.gen(function* () {
    const op = yield* options.operation;

    return Effect.fn(function* () {
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
            ],
          });
        }
      }
      return Effect.fn(options.tag)(function* (request?: I) {
        return yield* op((request ?? {}) as I);
      });
    });
  });
