import type * as runtime from "@cloudflare/workers-types";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Binding from "../../Binding.ts";
import type { ResourceLike } from "../../Resource.ts";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import { isWorker, WorkerEnvironment } from "../Workers/Worker.ts";
import type { Secret } from "./Secret.ts";

export class SecretError extends Data.TaggedError("SecretError")<{
  message: string;
  cause: Error;
}> {}

/**
 * A bound secret. The client itself is an `Effect` that resolves to the
 * secret's current value, so you can `yield* apiKey` directly. Use `.get()`
 * for the same thing as a callable, or `.raw` for the underlying
 * `SecretsStoreSecret` binding.
 */
export interface SecretClient extends Effect.Effect<
  Redacted.Redacted<string>,
  SecretError,
  RuntimeContext
> {
  /**
   * Effect that resolves to the raw Cloudflare `SecretsStoreSecret` binding.
   */
  raw: Effect.Effect<runtime.SecretsStoreSecret, never, RuntimeContext>;
  /**
   * Read the current value of the secret.
   */
  get(): Effect.Effect<Redacted.Redacted<string>, SecretError, RuntimeContext>;
}

export class SecretBinding extends Binding.Service<
  SecretBinding,
  (secret: Secret) => Effect.Effect<SecretClient>
>()("Cloudflare.SecretsStore.Secret") {}

export const SecretBindingLive = Layer.effect(
  SecretBinding,
  Effect.gen(function* () {
    const bind = yield* SecretBindingPolicy;
    const env = yield* WorkerEnvironment;

    return Effect.fn(function* (secret: Secret) {
      yield* bind(secret);
      const raw = Effect.sync(
        () =>
          (env as Record<string, runtime.SecretsStoreSecret>)[secret.LogicalId],
      );
      const tryPromise = <T>(
        fn: () => Promise<T>,
      ): Effect.Effect<T, SecretError> =>
        Effect.tryPromise({
          try: fn,
          catch: (error: any) =>
            new SecretError({
              message: error.message ?? "Unknown error",
              cause: error,
            }),
        });

      const getEffect = raw.pipe(
        Effect.flatMap((raw) =>
          tryPromise(() => raw.get().then(Redacted.make)),
        ),
      );

      return Object.assign(getEffect, {
        raw,
        get: () => getEffect,
      });
    });
  }),
);

export class SecretBindingPolicy extends Binding.Policy<
  SecretBindingPolicy,
  (secret: Secret) => Effect.Effect<void>
>()("Cloudflare.SecretsStore.Secret") {}

export const SecretBindingPolicyLive = SecretBindingPolicy.layer.succeed(
  Effect.fn(function* (host: ResourceLike, secret: Secret) {
    if (isWorker(host)) {
      yield* host.bind`${secret}`({
        bindings: [
          {
            type: "secrets_store_secret",
            name: secret.LogicalId,
            secretName: secret.secretName,
            storeId: secret.storeId,
          },
        ],
      });
    } else {
      return yield* Effect.die(
        new Error(`SecretBinding does not support runtime '${host.Type}'`),
      );
    }
  }),
);
