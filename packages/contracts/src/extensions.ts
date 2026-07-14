import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { IsoDateTime, TrimmedNonEmptyString, TrimmedString } from "./baseSchemas.ts";
import { ProviderDriverKind, ProviderInstanceId } from "./providerInstance.ts";

export const ExtensionArtifactType = Schema.Literals(["skill", "plugin"]);
export type ExtensionArtifactType = typeof ExtensionArtifactType.Type;

export const ExtensionMarketplaceKind = Schema.Literals([
  "agent-skills-repo",
  "codex-plugin-marketplace",
  "local",
]);
export type ExtensionMarketplaceKind = typeof ExtensionMarketplaceKind.Type;

export const ExtensionMarketplaceSource = Schema.Struct({
  id: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
  kind: ExtensionMarketplaceKind.pipe(
    Schema.withDecodingDefault(Effect.succeed("agent-skills-repo" as const)),
  ),
  sourceUrl: TrimmedNonEmptyString,
  enabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  trusted: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
});
export type ExtensionMarketplaceSource = typeof ExtensionMarketplaceSource.Type;

export const DEFAULT_EXTENSION_MARKETPLACES: ReadonlyArray<ExtensionMarketplaceSource> = [
  {
    id: "vercel-skills-cli",
    name: "Vercel Skills CLI",
    kind: "agent-skills-repo",
    sourceUrl: "https://github.com/vercel-labs/skills",
    enabled: true,
    trusted: true,
  },
  {
    id: "vercel-agent-skills",
    name: "Vercel Agent Skills",
    kind: "agent-skills-repo",
    sourceUrl: "https://github.com/vercel-labs/agent-skills",
    enabled: true,
    trusted: true,
  },
];

export const ExtensionInstallScope = Schema.Literals(["global", "provider"]);
export type ExtensionInstallScope = typeof ExtensionInstallScope.Type;

export const ExtensionInstallTarget = Schema.Struct({
  scope: ExtensionInstallScope,
  providerInstanceId: Schema.optionalKey(ProviderInstanceId),
});
export type ExtensionInstallTarget = typeof ExtensionInstallTarget.Type;

export const ExtensionCatalogItem = Schema.Struct({
  id: TrimmedNonEmptyString,
  marketplaceId: TrimmedNonEmptyString,
  type: ExtensionArtifactType,
  name: TrimmedNonEmptyString,
  displayName: Schema.optional(TrimmedNonEmptyString),
  description: Schema.optional(TrimmedString),
  sourceUrl: TrimmedNonEmptyString,
  sourceSubpath: Schema.optional(TrimmedString),
  compatibility: Schema.Array(ProviderDriverKind).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  tags: Schema.Array(TrimmedNonEmptyString).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  installedTargets: Schema.Array(ExtensionInstallTarget).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
});
export type ExtensionCatalogItem = typeof ExtensionCatalogItem.Type;

export const ExtensionInstalledRecord = Schema.Struct({
  id: TrimmedNonEmptyString,
  marketplaceId: TrimmedNonEmptyString,
  type: ExtensionArtifactType,
  name: TrimmedNonEmptyString,
  displayName: Schema.optional(TrimmedNonEmptyString),
  description: Schema.optional(TrimmedString),
  sourceUrl: TrimmedNonEmptyString,
  sourceSubpath: Schema.optional(TrimmedString),
  compatibility: Schema.Array(ProviderDriverKind).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  targets: Schema.Array(ExtensionInstallTarget),
  installedAt: IsoDateTime,
});
export type ExtensionInstalledRecord = typeof ExtensionInstalledRecord.Type;

export const ExtensionSettings = Schema.Struct({
  marketplaces: Schema.Array(ExtensionMarketplaceSource).pipe(
    Schema.withDecodingDefault(Effect.succeed([...DEFAULT_EXTENSION_MARKETPLACES])),
  ),
  installed: Schema.Array(ExtensionInstalledRecord).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
});
export type ExtensionSettings = typeof ExtensionSettings.Type;

export const DEFAULT_EXTENSION_SETTINGS: ExtensionSettings = Schema.decodeSync(ExtensionSettings)(
  {},
);

export const ExtensionDiscoveryError = Schema.Struct({
  marketplaceId: TrimmedNonEmptyString,
  message: TrimmedNonEmptyString,
});
export type ExtensionDiscoveryError = typeof ExtensionDiscoveryError.Type;

export const ExtensionDiscoveryResult = Schema.Struct({
  marketplaces: Schema.Array(ExtensionMarketplaceSource),
  items: Schema.Array(ExtensionCatalogItem),
  installed: Schema.Array(ExtensionInstalledRecord),
  errors: Schema.Array(ExtensionDiscoveryError).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
});
export type ExtensionDiscoveryResult = typeof ExtensionDiscoveryResult.Type;

export const ExtensionInstallInput = Schema.Struct({
  marketplaceId: TrimmedNonEmptyString,
  itemId: TrimmedNonEmptyString,
  scope: ExtensionInstallScope,
  providerInstanceId: Schema.optionalKey(ProviderInstanceId),
});
export type ExtensionInstallInput = typeof ExtensionInstallInput.Type;

export const ExtensionUninstallInput = Schema.Struct({
  itemId: TrimmedNonEmptyString,
  scope: ExtensionInstallScope,
  providerInstanceId: Schema.optionalKey(ProviderInstanceId),
});
export type ExtensionUninstallInput = typeof ExtensionUninstallInput.Type;

export class ExtensionOperationError extends Schema.TaggedErrorClass<ExtensionOperationError>()(
  "ExtensionOperationError",
  {
    operation: Schema.Literals(["discover", "install", "uninstall"]),
    message: TrimmedNonEmptyString,
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {}

export const ExtensionOperationResult = Schema.Struct({
  discovery: ExtensionDiscoveryResult,
});
export type ExtensionOperationResult = typeof ExtensionOperationResult.Type;
