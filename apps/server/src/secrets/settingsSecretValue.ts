import { secretReferencesInSettings } from "@t3tools/contracts";
import type * as SecretResolver from "@t3tools/secret-provider-core/server/SecretResolver";
import * as Effect from "effect/Effect";
import type * as Schema from "effect/Schema";

/**
 * Replaces each reference in the fields `schema` declares as `SettingsSecretValue` with the secret
 * it names, read in one batch. An unreadable secret comes back as `""`, so it behaves as unset.
 */
export const resolveSettingsSecrets = Effect.fn("SettingsSecrets.resolve")(function* <
  Settings extends Readonly<Record<string, unknown>>,
>(resolver: SecretResolver.SecretResolver["Service"], schema: Schema.Top, settings: Settings) {
  const pending = secretReferencesInSettings(schema, settings);
  if (pending.length === 0) return settings;
  const values = yield* resolver.read(pending.map(({ reference }) => reference));
  const resolved = Object.fromEntries(
    pending.map(({ field }, index) => [field, values[index] ?? ""] as const),
  );
  return { ...settings, ...resolved };
});
