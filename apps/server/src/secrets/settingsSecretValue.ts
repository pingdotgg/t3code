import {
  isSecretReference,
  type ServerSettings,
  type SettingsSecretValue,
} from "@t3tools/contracts";
import type * as SecretResolver from "@t3tools/secret-provider-core/server/SecretResolver";
import * as Effect from "effect/Effect";

import { collectSourceControlHostSecretReferences } from "../sourceControl/sourceControlHostSecrets.ts";

/** An unreadable secret comes back as `""`, so a credential that is missing behaves as unset. */
export const resolveSettingsSecret = Effect.fn("SettingsSecrets.resolve")(function* (
  resolver: SecretResolver.SecretResolver["Service"],
  value: SettingsSecretValue,
) {
  if (!isSecretReference(value)) return value;
  const [secret] = yield* resolver.read([value]);
  return secret ?? "";
});

/** Settings that cannot be read clear every cached secret, so a refresh never keeps a stale one. */
export const invalidateSettingsSecrets = Effect.fn("SettingsSecrets.invalidate")(function* <E>(
  resolver: SecretResolver.SecretResolver["Service"],
  settings: Effect.Effect<Pick<ServerSettings, "sourceControlHosts">, E>,
) {
  const references = yield* settings.pipe(
    Effect.map((current) => collectSourceControlHostSecretReferences(current.sourceControlHosts)),
    Effect.orElseSucceed(() => undefined),
  );
  yield* resolver.invalidate(references);
});
