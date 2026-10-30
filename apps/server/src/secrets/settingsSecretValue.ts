import {
  isSecretReference,
  type SecretReference,
  type ServerSettings,
  type SettingsSecretValue,
} from "@t3tools/contracts";
import type * as SecretResolverCore from "@t3tools/secret-provider-core/server/SecretResolver";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { collectSourceControlHostSecretReferences } from "../sourceControl/sourceControlHostSecrets.ts";

type SecretResolverShape = SecretResolverCore.SecretResolver["Service"];

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
  resolver: SecretResolverShape,
  value: SettingsSecretValue,
) {
  if (!isSecretReference(value)) return value;
  const [secret] = yield* resolver.read([value]);
  if (secret === undefined || secret.trim() === "") {
    return yield* new SettingsSecretUnresolvedError({ provider: value.provider });
  }
  return secret;
});

/** An unreadable secret comes back as `""`, for credentials whose documented fallback is acceptable. */
export const resolveSettingsSecret = Effect.fn("SettingsSecrets.resolve")(function* (
  resolver: SecretResolverShape,
  value: SettingsSecretValue,
) {
  return yield* requireSettingsSecret(resolver, value).pipe(
    Effect.catchTags({ SettingsSecretUnresolvedError: () => Effect.succeed("") }),
  );
});

const collectUsageLimitSecretReferences = (
  sources: ServerSettings["usageLimitSources"],
): ReadonlyArray<SecretReference> =>
  Object.values(sources).flatMap(({ managementKey }) =>
    isSecretReference(managementKey) ? [managementKey] : [],
  );

const collectEasSecretReferences = (
  hosts: ServerSettings["easDeviceHosts"],
): ReadonlyArray<SecretReference> =>
  hosts.flatMap(({ accessToken }) => (isSecretReference(accessToken) ? [accessToken] : []));

/** Settings that cannot be read clear every cached secret, so a refresh never keeps a stale one. */
export const invalidateSettingsSecrets = Effect.fn("SettingsSecrets.invalidate")(function* <E>(
  resolver: SecretResolverShape,
  settings: Effect.Effect<
    Pick<ServerSettings, "sourceControlHosts" | "usageLimitSources" | "easDeviceHosts">,
    E
  >,
) {
  const references = yield* settings.pipe(
    Effect.map((current) => [
      ...collectSourceControlHostSecretReferences(current.sourceControlHosts),
      ...collectUsageLimitSecretReferences(current.usageLimitSources),
      ...collectEasSecretReferences(current.easDeviceHosts),
    ]),
    Effect.orElseSucceed(() => undefined),
  );
  yield* resolver.invalidate(references);
});
