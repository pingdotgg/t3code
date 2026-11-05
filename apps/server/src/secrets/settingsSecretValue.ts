import {
  isSecretReference,
  secretReferencesInSettings,
  type SettingsSecretValue,
  withSettingsSecrets,
} from "@t3tools/contracts";
import type * as SecretResolver from "@t3tools/secret-provider-core/server/SecretResolver";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

/**
 * Replaces each reference in the slots `schema` declares as `SettingsSecretValue` with the secret
 * it names, read in one batch. An unreadable secret comes back as `""`, so it behaves as unset.
 */
export const resolveSettingsSecrets = Effect.fn("SettingsSecrets.resolve")(function* <
  Settings extends Readonly<Record<string, unknown>>,
>(resolver: SecretResolver.SecretResolver["Service"], schema: Schema.Top, settings: Settings) {
  const pending = secretReferencesInSettings(schema, settings);
  if (pending.length === 0) return settings;
  const values = yield* resolver.read(pending.map(({ reference }) => reference));
  return withSettingsSecrets(
    settings,
    pending.map((slot, index) => ({ ...slot, value: values[index] ?? "" })),
  );
});

export class SettingsSecretUnresolvedError extends Schema.TaggedError<SettingsSecretUnresolvedError>()(
  "SettingsSecretUnresolvedError",
  { provider: Schema.String },
) {
  override get message(): string {
    return `Could not read the credential from the secret provider "${this.provider}". Unlock or fix it in Settings, then try again.`;
  }
}

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
    return yield* new SettingsSecretUnresolvedError({ provider: value.provider });
  }
  return secret;
});
