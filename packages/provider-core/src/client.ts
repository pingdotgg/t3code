/**
 * The client half of a provider package.
 *
 * Every provider package exports a `ProviderClientDefinition` from its
 * `./client` entry point. Clients render settings, labels, and badges from
 * these definitions plus the server's `ServerProvider` snapshots, so a new
 * provider needs no per-driver branches in web or mobile.
 *
 * Definitions are browser- and React Native-safe: plain data and Effect
 * schemas, no platform UI imports.
 *
 * @module provider-core/client
 */
import type { ProviderDriverKind } from "@t3tools/contracts";
import type * as Schema from "effect/Schema";

/**
 * A provider's instance settings schema. Fields carry `providerSettingsForm`
 * annotations, which the settings form renders generically.
 */
export type ProviderSettingsSchema = {
  readonly fields: Readonly<Record<string, Schema.Top>>;
} & Schema.Top;

/** An environment variable the settings UI offers for every instance of a driver. */
export interface ProviderEnvironmentField {
  readonly name: string;
  readonly label: string;
  readonly description?: string;
  readonly placeholder?: string;
  readonly sensitive?: boolean;
}

export interface ProviderClientDefinition {
  readonly driverKind: ProviderDriverKind;
  readonly label: string;
  readonly settingsSchema: ProviderSettingsSchema;
  readonly environmentFields?: ReadonlyArray<ProviderEnvironmentField>;
  /** Whether the driver has a default instance backed by legacy `providers.<kind>` settings. */
  readonly hasDefaultInstance?: boolean;
  /**
   * Short warning badge beside every instance of the driver, such as "Beta".
   * It marks the driver kind, so built-in and custom instances show it alike.
   */
  readonly badgeLabel?: string;
}

export function defineProviderClient<const Definition extends ProviderClientDefinition>(
  definition: Definition,
): Definition {
  return definition;
}

/** The provider definitions a client loaded, in presentation order. */
export interface ProviderClientRegistry {
  readonly definitions: ReadonlyArray<ProviderClientDefinition>;
  /** `undefined` for drivers this client does not ship, such as a fork's driver. */
  readonly get: (
    driverKind: ProviderDriverKind | undefined,
  ) => ProviderClientDefinition | undefined;
}

export function makeProviderClientRegistry(
  definitions: ReadonlyArray<ProviderClientDefinition>,
): ProviderClientRegistry {
  const byDriverKind = new Map<ProviderDriverKind, ProviderClientDefinition>();
  for (const definition of definitions) {
    if (byDriverKind.has(definition.driverKind)) {
      throw new Error(`Provider driver '${definition.driverKind}' is defined more than once.`);
    }
    byDriverKind.set(definition.driverKind, definition);
  }
  return {
    definitions,
    get: (driverKind) => (driverKind === undefined ? undefined : byDriverKind.get(driverKind)),
  };
}
