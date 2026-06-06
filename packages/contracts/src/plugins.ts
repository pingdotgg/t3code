import * as Schema from "effect/Schema";

import { IsoDateTime, NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const PLUGIN_CATALOG_INVALIDATED_EVENT_TYPE = "t3.pluginCatalog.invalidated";

const PLUGIN_ID_MAX_CHARS = 96;
const PLUGIN_ROUTE_ID_MAX_CHARS = 64;
const PLUGIN_UI_PLACEMENT_ID_MAX_CHARS = 64;
const PLUGIN_COMPOSER_ACTION_ID_MAX_CHARS = 64;
const PLUGIN_COMMAND_MAX_CHARS = 128;
const PLUGIN_SLUG_PATTERN = /^[a-zA-Z][a-zA-Z0-9_.-]*$/;

export const PluginId = TrimmedNonEmptyString.check(
  Schema.isMaxLength(PLUGIN_ID_MAX_CHARS),
  Schema.isPattern(PLUGIN_SLUG_PATTERN),
).pipe(Schema.brand("PluginId"));
export type PluginId = typeof PluginId.Type;

export const PluginRouteId = TrimmedNonEmptyString.check(
  Schema.isMaxLength(PLUGIN_ROUTE_ID_MAX_CHARS),
  Schema.isPattern(PLUGIN_SLUG_PATTERN),
).pipe(Schema.brand("PluginRouteId"));
export type PluginRouteId = typeof PluginRouteId.Type;

export const PluginUiPlacementId = TrimmedNonEmptyString.check(
  Schema.isMaxLength(PLUGIN_UI_PLACEMENT_ID_MAX_CHARS),
  Schema.isPattern(PLUGIN_SLUG_PATTERN),
).pipe(Schema.brand("PluginUiPlacementId"));
export type PluginUiPlacementId = typeof PluginUiPlacementId.Type;

export const PluginComposerActionId = TrimmedNonEmptyString.check(
  Schema.isMaxLength(PLUGIN_COMPOSER_ACTION_ID_MAX_CHARS),
  Schema.isPattern(PLUGIN_SLUG_PATTERN),
).pipe(Schema.brand("PluginComposerActionId"));
export type PluginComposerActionId = typeof PluginComposerActionId.Type;

export const PluginCommandName = TrimmedNonEmptyString.check(
  Schema.isMaxLength(PLUGIN_COMMAND_MAX_CHARS),
  Schema.isPattern(PLUGIN_SLUG_PATTERN),
).pipe(Schema.brand("PluginCommandName"));
export type PluginCommandName = typeof PluginCommandName.Type;

export const PluginKeybindingCommandName = PluginCommandName.check(
  Schema.isPattern(/^[^.]+$/),
).pipe(Schema.brand("PluginKeybindingCommandName"));
export type PluginKeybindingCommandName = typeof PluginKeybindingCommandName.Type;

export const PluginRouteSurface = Schema.Literals(["app", "settings"]);
export type PluginRouteSurface = typeof PluginRouteSurface.Type;

export const PluginRouteContribution = Schema.Struct({
  id: PluginRouteId,
  label: TrimmedNonEmptyString,
  surface: PluginRouteSurface,
});
export type PluginRouteContribution = typeof PluginRouteContribution.Type;

export const PluginUiPlacementPosition = Schema.Literals([
  "sidebar.primary",
  "sidebar.footer",
  "settings.sidebar",
  "commandPalette.actions",
]);
export type PluginUiPlacementPosition = typeof PluginUiPlacementPosition.Type;

export const PluginUiPlacementContribution = Schema.Struct({
  id: PluginUiPlacementId,
  position: PluginUiPlacementPosition,
  label: TrimmedNonEmptyString,
  routeId: PluginRouteId,
  description: Schema.optional(TrimmedNonEmptyString),
  order: Schema.optional(NonNegativeInt),
  badgeCount: Schema.optional(NonNegativeInt),
});
export type PluginUiPlacementContribution = typeof PluginUiPlacementContribution.Type;

export const PluginComposerActionPosition = Schema.Literals(["composer.footer.left"]);
export type PluginComposerActionPosition = typeof PluginComposerActionPosition.Type;

export const PluginComposerActionContribution = Schema.Struct({
  id: PluginComposerActionId,
  position: PluginComposerActionPosition,
  label: TrimmedNonEmptyString,
  description: Schema.optional(TrimmedNonEmptyString),
  order: Schema.optional(NonNegativeInt),
});
export type PluginComposerActionContribution = typeof PluginComposerActionContribution.Type;

export const PluginUiContributions = Schema.Struct({
  placements: Schema.Array(PluginUiPlacementContribution),
  composerActions: Schema.optional(Schema.Array(PluginComposerActionContribution)),
});
export type PluginUiContributions = typeof PluginUiContributions.Type;

export const PluginCommandTarget = Schema.Literals(["server", "client"]);
export type PluginCommandTarget = typeof PluginCommandTarget.Type;

export const PluginServerCommandContribution = Schema.Struct({
  name: PluginCommandName,
  target: Schema.Literal("server"),
  label: TrimmedNonEmptyString,
  keybinding: Schema.optional(Schema.Literal(false)),
});
export type PluginServerCommandContribution = typeof PluginServerCommandContribution.Type;

export const PluginClientCommandContribution = Schema.Struct({
  name: PluginCommandName,
  target: Schema.Literal("client"),
  label: TrimmedNonEmptyString,
  keybinding: Schema.optional(Schema.Literal(false)),
});
export type PluginClientCommandContribution = typeof PluginClientCommandContribution.Type;

export const PluginClientKeybindingCommandContribution = Schema.Struct({
  name: PluginKeybindingCommandName,
  target: Schema.Literal("client"),
  label: TrimmedNonEmptyString,
  keybinding: Schema.Literal(true),
});
export type PluginClientKeybindingCommandContribution =
  typeof PluginClientKeybindingCommandContribution.Type;

export const PluginCommandContribution = Schema.Union([
  PluginServerCommandContribution,
  PluginClientCommandContribution,
  PluginClientKeybindingCommandContribution,
]);
export type PluginCommandContribution = typeof PluginCommandContribution.Type;

export const PluginManifest = Schema.Struct({
  id: PluginId,
  name: TrimmedNonEmptyString,
  version: TrimmedNonEmptyString,
  routes: Schema.Array(PluginRouteContribution),
  ui: PluginUiContributions,
  commands: Schema.Array(PluginCommandContribution),
});
export type PluginManifest = typeof PluginManifest.Type;

export const PluginStatus = Schema.Struct({
  pluginId: PluginId,
  status: Schema.Literals(["active", "failed", "disabled"]),
  diagnostics: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
});
export type PluginStatus = typeof PluginStatus.Type;

export const PluginDiscoveryFailureStatus = Schema.Struct({
  pluginId: Schema.optional(PluginId),
  status: Schema.Literal("failed"),
  diagnostics: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
});
export type PluginDiscoveryFailureStatus = typeof PluginDiscoveryFailureStatus.Type;

export const PluginDiscoveryFailure = Schema.Struct({
  pluginId: Schema.optional(PluginId),
  packageName: Schema.optional(TrimmedNonEmptyString),
  packageVersion: Schema.optional(TrimmedNonEmptyString),
  packageRoot: TrimmedNonEmptyString,
});
export type PluginDiscoveryFailure = typeof PluginDiscoveryFailure.Type;

export const PluginManifestCatalogEntry = Schema.Struct({
  manifest: PluginManifest,
  status: PluginStatus,
  assets: Schema.Struct({
    client: TrimmedNonEmptyString,
  }),
});
export type PluginManifestCatalogEntry = typeof PluginManifestCatalogEntry.Type;

export const PluginDiscoveryFailureCatalogEntry = Schema.Struct({
  discovery: PluginDiscoveryFailure,
  status: PluginDiscoveryFailureStatus,
});
export type PluginDiscoveryFailureCatalogEntry = typeof PluginDiscoveryFailureCatalogEntry.Type;

export const PluginCatalogEntry = Schema.Union([
  PluginManifestCatalogEntry,
  PluginDiscoveryFailureCatalogEntry,
]);
export type PluginCatalogEntry = typeof PluginCatalogEntry.Type;

export const PluginsListInput = Schema.Struct({});
export type PluginsListInput = typeof PluginsListInput.Type;

export const PluginsListResult = Schema.Struct({
  plugins: Schema.Array(PluginCatalogEntry),
});
export type PluginsListResult = typeof PluginsListResult.Type;

export const PluginsInvokeInput = Schema.Struct({
  pluginId: PluginId,
  command: PluginCommandName,
  input: Schema.Unknown,
});
export type PluginsInvokeInput = typeof PluginsInvokeInput.Type;

export const PluginsInvokeResult = Schema.Struct({
  output: Schema.Unknown,
});
export type PluginsInvokeResult = typeof PluginsInvokeResult.Type;

export const PluginsSubscribeInput = Schema.Struct({
  pluginId: Schema.optional(PluginId),
});
export type PluginsSubscribeInput = typeof PluginsSubscribeInput.Type;

export const PluginSubscriptionEvent = Schema.Struct({
  pluginId: PluginId,
  type: TrimmedNonEmptyString,
  payload: Schema.Unknown,
  createdAt: IsoDateTime,
});
export type PluginSubscriptionEvent = typeof PluginSubscriptionEvent.Type;

export class PluginRpcError extends Schema.TaggedErrorClass<PluginRpcError>()("PluginRpcError", {
  message: TrimmedNonEmptyString,
  pluginId: Schema.optional(PluginId),
  command: Schema.optional(PluginCommandName),
  cause: Schema.optional(Schema.Defect),
}) {}
