import type { SecretProviderKind } from "@t3tools/contracts";
import type * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import type { ChildProcessSpawner } from "effect/process";

import type { SecretProviderDefinition } from "../shared/definition.ts";

/** What the server gives every driver. A driver builds anything else it needs itself. */
export type SecretProviderDriverServices =
  | ChildProcessSpawner.ChildProcessSpawner
  | FileSystem.FileSystem
  | Crypto.Crypto;

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
}

export const defineSecretProviderDriver = <Config>(driver: {
  readonly kind: SecretProviderKind;
  readonly definition: SecretProviderDefinition<Config>;
  readonly read: (
    config: Config,
    references: ReadonlyArray<string>,
  ) => Effect.Effect<ReadonlyArray<string | undefined>, never, SecretProviderDriverServices>;
}): SecretProviderDriver => {
  const isConfig = Schema.is(driver.definition.configSchema);
  return {
    kind: driver.kind,
    definition: driver.definition,
    read: (config, references) =>
      isConfig(config)
        ? driver.read(config, references)
        : Effect.succeed(references.map(() => undefined)),
  };
};
