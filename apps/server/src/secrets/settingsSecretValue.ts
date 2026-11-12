import {
  isSecretReference,
  secretReferencesInSettings,
  SettingsSecretUnresolvedError,
  type SettingsSecretValue,
  withSettingsSecrets,
} from "@t3tools/contracts";
import type * as SecretResolver from "@t3tools/secret-provider-core/server/SecretResolver";
import * as Effect from "effect/Effect";
import type * as Schema from "effect/Schema";

/**
 * Replaces each reference in the slots `schema` declares as `SettingsSecretValue` with the secret
 * it names, read in one batch. A secret that cannot be read, or reads empty, keeps its reference,
 * which `requireSettingsSecretLiteral` turns into an error for the consumer of that field.
 */
export const resolveSettingsSecrets = Effect.fn("SettingsSecrets.resolve")(function* <
  Settings extends Readonly<Record<string, unknown>>,
>(resolver: SecretResolver.SecretResolver["Service"], schema: Schema.Top, settings: Settings) {
  const pending = secretReferencesInSettings(schema, settings);
  if (pending.length === 0) return settings;
  const values = yield* resolver.read(pending.map(({ reference }) => reference));
  return withSettingsSecrets(
    settings,
    pending.flatMap((slot, index) => {
      const value = values[index];
      return value === undefined || value.trim() === "" ? [] : [{ ...slot, value }];
    }),
  );
});

/**
 * The secret a credential setting holds or names. A named secret that cannot be read, or reads
 * empty, fails instead of passing for a missing token, so callers that would fall back to another
 * credential cannot silently switch accounts.
 */
export const requireSettingsSecret = Effect.fn("SettingsSecrets.require")(function* (
  resolver: SecretResolver.SecretResolver["Service"],
  value: SettingsSecretValue,
) {
  if (!isSecretReference(value)) return value;
  const [secret] = yield* resolver.read([value]);
  if (secret === undefined || secret.trim() === "") {
    return yield* new SettingsSecretUnresolvedError({
      provider: yield* resolver.label(value.provider),
    });
  }
  return secret;
});
