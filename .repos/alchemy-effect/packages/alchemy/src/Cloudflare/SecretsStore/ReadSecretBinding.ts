import type * as runtime from "@cloudflare/workers-types";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { Worker, WorkerEnvironment } from "../Workers/Worker.ts";
import type { Secret } from "./Secret.ts";
import { ReadSecret, SecretError } from "./ReadSecret.ts";

export const ReadSecretBinding = Layer.effect(
  ReadSecret,
  Effect.gen(function* () {
    const env = yield* WorkerEnvironment;
    const host = yield* Worker;

    return Effect.fn(function* (secret: Secret) {
      if (!globalThis.__ALCHEMY_RUNTIME__) {
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
      }
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
