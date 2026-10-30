import { isSecretReference, type SettingsSecretValue } from "@t3tools/contracts";
import type * as SecretResolver from "@t3tools/secret-provider-core/server/SecretResolver";
import * as Effect from "effect/Effect";

/** An unreadable secret comes back as `""`, so a credential that is missing behaves as unset. */
export const resolveSettingsSecret = Effect.fn("SettingsSecrets.resolve")(function* (
  resolver: SecretResolver.SecretResolver["Service"],
  value: SettingsSecretValue,
) {
  if (!isSecretReference(value)) return value;
  const [secret] = yield* resolver.read([value]);
  return secret ?? "";
});
