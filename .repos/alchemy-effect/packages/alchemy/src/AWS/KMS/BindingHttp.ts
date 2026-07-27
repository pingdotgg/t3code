import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import { isBindingHost } from "../Lambda/Function.ts";
import { keyLabel, keyPolicyStatement, type KeyLike } from "./KeyBinding.ts";

/**
 * Shared scaffolding for the AWS KMS HTTP bindings.
 *
 * NOT exported from `index.ts` — every thin `{Op}Http.ts` in this service is
 * a `Layer.effect(Cap, make…HttpBinding({ … }))` over one of the two builders
 * below. Everything except the operation and the IAM action list is
 * boilerplate.
 */

/**
 * Build the impl Effect for a KMS cryptographic operation scoped to a
 * {@link KeyLike} target (a `Key` resource or the `alias/...` name of a
 * pre-existing key): the deploy-time half grants `actions` on the bound key
 * (exact key ARN, or `Resource: "*"` + `kms:RequestAlias` for an alias), and
 * the runtime half injects the key identifier into every request.
 */
export const makeKmsKeyHttpBinding = <
  I extends { KeyId?: string },
  A,
  E,
  R,
>(options: {
  /** Fully-qualified binding tag, e.g. `AWS.KMS.Sign`. */
  tag: string;
  /** The distilled operation. */
  operation: Effect.Effect<(input: I) => Effect.Effect<A, E>, never, R>;
  /** IAM actions granted on the bound key. */
  actions: readonly `kms:${string}`[];
}) =>
  Effect.gen(function* () {
    const op = yield* options.operation;

    return Effect.fn(function* (key: KeyLike) {
      const KeyId =
        typeof key === "string" ? Effect.succeed(key) : yield* key.keyId;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          yield* host.bind`Allow(${host}, ${options.tag}(${key}))`({
            policyStatements: [keyPolicyStatement(options.actions, key)],
          });
        }
      }
      return Effect.fn(`${options.tag}(${keyLabel(key)})`)(function* (
        request?: Omit<I, "KeyId">,
      ) {
        const keyId = yield* KeyId;
        return yield* op({ ...request, KeyId: keyId } as I);
      });
    });
  });

/**
 * Build the impl Effect for an account-level KMS operation that is not
 * scoped to a key (e.g. `kms:GenerateRandom`). The deploy-time half grants
 * `actions` on `*`.
 */
export const makeKmsAccountHttpBinding = <I, A, E, R>(options: {
  /** Fully-qualified binding tag, e.g. `AWS.KMS.GenerateRandom`. */
  tag: string;
  /** The distilled operation, invoked with the caller's request as-is. */
  operation: Effect.Effect<(input: I) => Effect.Effect<A, E>, never, R>;
  /** IAM actions granted on `*`. */
  actions: readonly `kms:${string}`[];
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
