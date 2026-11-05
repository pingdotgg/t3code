import * as GCP from "@alchemy.run/gcp";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { database } from "./database.ts";

/**
 * Writes the app user's password as the secret's latest version at deploy
 * time, so the service can read it at runtime.
 */
export const storePassword = Effect.gen(function* () {
  const { password, passwordSecret } = yield* database;

  const StorePassword = Alchemy.Action(
    "StorePassword",
    Effect.gen(function* () {
      const secret = yield* GCP.SecretManager.ReadWriteSecret(passwordSecret);
      return Effect.fn(function* (input: { password: Redacted.Redacted<string> }) {
        const value = Redacted.value(input.password);
        if ((yield* secret.access()) !== value) {
          yield* secret.addVersion(value);
        }
      });
    }).pipe(Effect.provide(GCP.SecretManager.ReadWriteSecretHttp)),
  );

  return yield* StorePassword({ password: password.text });
});
