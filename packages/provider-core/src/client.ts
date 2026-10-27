import type { ProviderDriverKind } from "@t3tools/contracts";
import type * as Schema from "effect/Schema";

export type ProviderSettingsSchema = {
  readonly fields: Readonly<Record<string, Schema.Top>>;
} & Schema.Top;

export interface ProviderEnvironmentField {
  readonly name: string;
  readonly label: string;
  readonly description?: string;
  readonly placeholder?: string;
  readonly sensitive?: boolean;
}

export interface ProviderIcon {
  readonly viewBox: string;
  readonly fill: { readonly light: string; readonly dark: string };
  readonly paths: ReadonlyArray<{
    readonly d: string;
    readonly fillRule?: "evenodd" | "nonzero";
    readonly fill?: { readonly light: string; readonly dark: string };
    readonly gradient?: ProviderIconGradient;
  }>;
}

export interface ProviderIconGradient {
  readonly x1: number;
  readonly y1: number;
  readonly x2: number;
  readonly y2: number;
  readonly stops: ReadonlyArray<{ readonly offset: number; readonly color: string }>;
}

export interface ProviderClientDefinition {
  readonly driverKind: ProviderDriverKind;
  readonly label: string;
  readonly icon?: ProviderIcon;
  readonly settingsSchema: ProviderSettingsSchema;
  readonly environmentFields?: ReadonlyArray<ProviderEnvironmentField>;
  readonly hasDefaultInstance?: boolean;
  readonly badgeLabel?: string;
  /** `false` lists the provider under Add provider's "Show more" instead of up front. */
  readonly featured?: boolean;
  /** ACP Registry entries for this same agent, left out of Add provider's Registry list. */
  readonly acpRegistryAgentIds?: ReadonlyArray<string>;
}

export function defineProviderClient<const Definition extends ProviderClientDefinition>(
  definition: Definition,
): Definition {
  return definition;
}

export interface ProviderClientRegistry {
  readonly definitions: ReadonlyArray<ProviderClientDefinition>;
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
