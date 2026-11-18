import type { BrowserLoginField, SecretProviderKind } from "@t3tools/contracts";
import type * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import type * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type { ChildProcessSpawner } from "effect/process";

import type { SecretProviderDefinition } from "../shared/definition.ts";

/** What the server gives every driver. A driver builds anything else it needs itself. */
export type SecretProviderDriverServices =
  | ChildProcessSpawner.ChildProcessSpawner
  | FileSystem.FileSystem
  | SecureRandom.SecureRandom;

/** Metadata only: a login item's values never pass through this shape. */
export interface SecretProviderLogin {
  readonly id: string;
  readonly title: string;
  readonly urls: ReadonlyArray<string>;
}

export interface SecretProviderLoginDetail extends SecretProviderLogin {
  /** A reference `read` accepts for each field the login can fill. */
  readonly fields: Readonly<Partial<Record<BrowserLoginField, string>>>;
}

export class SecretProviderLoginsError extends Schema.TaggedError<SecretProviderLoginsError>()(
  "SecretProviderLoginsError",
  { reason: Schema.Literals(["unavailable", "vaultNotFound", "itemNotFound"]) },
) {}

export interface SecretProviderVault {
  readonly id: string;
  readonly name: string;
}

export interface SecretProviderLogins<Config = unknown> {
  /** None when the provider's account cannot list vaults, as 1Password Connect cannot. */
  readonly vaults: (
    config: Config,
  ) => Effect.Effect<
    Option.Option<ReadonlyArray<SecretProviderVault>>,
    SecretProviderLoginsError,
    SecretProviderDriverServices
  >;
  readonly list: (
    config: Config,
    vault: string,
  ) => Effect.Effect<
    ReadonlyArray<SecretProviderLogin>,
    SecretProviderLoginsError,
    SecretProviderDriverServices
  >;
  readonly get: (
    config: Config,
    vault: string,
    itemId: string,
  ) => Effect.Effect<
    SecretProviderLoginDetail,
    SecretProviderLoginsError,
    SecretProviderDriverServices
  >;
}

export interface SecretProviderDriver {
  readonly kind: SecretProviderKind;
  readonly definition: SecretProviderDefinition;
  /**
   * Values in input order; `undefined` marks a reference that could not be read. `config` has
   * decoded with the definition's `configSchema` and every reference passed its `isReference`.
   */
  readonly read: (
    config: unknown,
    references: ReadonlyArray<string>,
  ) => Effect.Effect<ReadonlyArray<string | undefined>, never, SecretProviderDriverServices>;
  /** Login items in a vault, for filling browser logins. Absent when the provider has none. */
  readonly logins?: SecretProviderLogins;
}

export const defineSecretProviderDriver = <Config>(driver: {
  readonly kind: SecretProviderKind;
  readonly definition: SecretProviderDefinition<Config>;
  readonly read: (
    config: Config,
    references: ReadonlyArray<string>,
  ) => Effect.Effect<ReadonlyArray<string | undefined>, never, SecretProviderDriverServices>;
  readonly logins?: SecretProviderLogins<Config>;
}): SecretProviderDriver => {
  const isConfig = Schema.is(driver.definition.configSchema);
  const unavailable = new SecretProviderLoginsError({ reason: "unavailable" });
  const logins = driver.logins;
  return {
    kind: driver.kind,
    definition: driver.definition,
    read: (config, references) =>
      isConfig(config)
        ? driver.read(config, references)
        : Effect.succeed(references.map(() => undefined)),
    ...(logins === undefined
      ? {}
      : {
          logins: {
            vaults: (config) =>
              isConfig(config) ? logins.vaults(config) : Effect.fail(unavailable),
            list: (config, vault) =>
              isConfig(config) ? logins.list(config, vault) : Effect.fail(unavailable),
            get: (config, vault, itemId) =>
              isConfig(config) ? logins.get(config, vault, itemId) : Effect.fail(unavailable),
          },
        }),
  };
};
