import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { IsoDateTime, TrimmedNonEmptyString, TrimmedString } from "./baseSchemas.ts";

const SEMVER_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const HOST_API_RANGE_PATTERN = /^[~^]?\d+\.\d+\.\d+$/;
export const PLUGIN_ID_PATTERN_SOURCE = "[a-z][a-z0-9-]{1,40}";
const PLUGIN_ID_PATTERN = new RegExp(`^${PLUGIN_ID_PATTERN_SOURCE}$`);

export const HOST_API_VERSION = "1.0.0";

export const PluginId = TrimmedString.check(Schema.isPattern(PLUGIN_ID_PATTERN)).pipe(
  Schema.brand("PluginId"),
);
export type PluginId = typeof PluginId.Type;

export const PluginCapability = Schema.Literals([
  "agents",
  "vcs",
  "terminals",
  "database",
  "projections.read",
  "environments.read",
  "secrets",
  "http",
  "sourceControl",
  "textGeneration",
]);
export type PluginCapability = typeof PluginCapability.Type;

const SemverString = TrimmedNonEmptyString.check(Schema.isPattern(SEMVER_PATTERN));
const HostApiRange = TrimmedNonEmptyString.check(Schema.isPattern(HOST_API_RANGE_PATTERN));
const OptionalUrl = Schema.optionalKey(TrimmedNonEmptyString.check(Schema.isMaxLength(2048)));
const Sha256Hex = TrimmedNonEmptyString.check(Schema.isPattern(/^[a-f0-9]{64}$/i));

const RelativeEntryPath = TrimmedNonEmptyString.check(
  Schema.makeFilter<string>((entryPath) => {
    if (entryPath.startsWith("/") || entryPath.startsWith("\\")) {
      return "entry paths must be relative";
    }
    if (entryPath.split(/[\\/]/).includes("..")) {
      return "entry paths may not contain '..' segments";
    }
    return true;
  }),
);

const ManifestEntries = Schema.Struct({
  server: Schema.optionalKey(RelativeEntryPath),
  web: Schema.optionalKey(RelativeEntryPath),
}).check(
  Schema.makeFilter<{ readonly server?: string; readonly web?: string }>((entries) =>
    entries.server || entries.web ? true : "manifest entries must include server or web",
  ),
);
export type PluginManifestEntries = typeof ManifestEntries.Type;

const PluginAuthor = Schema.Struct({
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(100)),
  url: OptionalUrl,
});
export type PluginAuthor = typeof PluginAuthor.Type;

const PluginCapabilities = Schema.Array(PluginCapability)
  .check(
    Schema.makeFilter<ReadonlyArray<PluginCapability>>((capabilities) =>
      new Set(capabilities).size === capabilities.length ? true : "capabilities must be unique",
    ),
  )
  .pipe(Schema.withDecodingDefault(Effect.succeed([])));

interface PluginManifestShape {
  readonly id: PluginId;
  readonly name: string;
  readonly version: string;
  readonly description?: string | undefined;
  readonly author?: PluginAuthor | undefined;
  readonly homepage?: string | undefined;
  readonly license?: string | undefined;
  readonly hostApi: string;
  readonly minAppVersion?: string | undefined;
  readonly capabilities: ReadonlyArray<PluginCapability>;
  readonly entries: PluginManifestEntries;
}

export const PluginManifest = Schema.Struct({
  id: PluginId,
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(100)),
  version: SemverString,
  description: Schema.optionalKey(TrimmedString.check(Schema.isMaxLength(500))),
  author: Schema.optionalKey(PluginAuthor),
  homepage: OptionalUrl,
  license: Schema.optionalKey(TrimmedNonEmptyString.check(Schema.isMaxLength(128))),
  hostApi: HostApiRange,
  minAppVersion: Schema.optionalKey(SemverString),
  capabilities: PluginCapabilities,
  entries: ManifestEntries,
})
  .check(
    Schema.makeFilter<PluginManifestShape>((manifest) => {
      if (!manifest.entries.server && manifest.capabilities.length > 0) {
        return {
          path: ["capabilities"],
          issue: "web-only plugins may not declare server capabilities",
        };
      }
      return true;
    }),
  )
  .annotate({ parseOptions: { onExcessProperty: "error" } });
export type PluginManifest = typeof PluginManifest.Type;

export const PluginState = Schema.Literals([
  "active",
  "pending-remove",
  "pending-upgrade",
  "failed",
  "disabled",
  "disabled-by-host",
]);
export type PluginState = typeof PluginState.Type;

export class PluginRpcError extends Schema.TaggedErrorClass<PluginRpcError>()("PluginRpcError", {
  pluginId: PluginId,
  code: Schema.Literals(["not-found", "not-ready", "unauthorized", "invalid-method", "internal"]),
  message: Schema.String,
  data: Schema.optional(Schema.Unknown),
}) {}

export const PluginInfo = Schema.Struct({
  id: PluginId,
  name: TrimmedNonEmptyString,
  version: SemverString,
  state: PluginState,
  capabilities: Schema.Array(PluginCapability),
  hasWeb: Schema.Boolean,
  lastError: Schema.NullOr(Schema.String),
});
export type PluginInfo = typeof PluginInfo.Type;

export const PluginListResult = Schema.Struct({
  plugins: Schema.Array(PluginInfo),
});
export type PluginListResult = typeof PluginListResult.Type;

export const PluginSource = Schema.Struct({
  id: TrimmedNonEmptyString,
  url: TrimmedNonEmptyString,
  addedAt: IsoDateTime,
});
export type PluginSource = typeof PluginSource.Type;

export const MarketplaceVersion = Schema.Struct({
  version: SemverString,
  tarball: TrimmedNonEmptyString,
  sha256: Sha256Hex,
  hostApi: HostApiRange,
  minAppVersion: Schema.optionalKey(SemverString),
  publishedAt: IsoDateTime,
});
export type MarketplaceVersion = typeof MarketplaceVersion.Type;

export const MarketplaceEntry = Schema.Struct({
  id: PluginId,
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(100)),
  description: TrimmedString.check(Schema.isMaxLength(500)),
  author: Schema.optionalKey(PluginAuthor),
  capabilities: Schema.Array(PluginCapability),
  versions: Schema.Array(MarketplaceVersion),
});
export type MarketplaceEntry = typeof MarketplaceEntry.Type;

export const PluginInstallStaged = Schema.Struct({
  stageToken: TrimmedNonEmptyString,
  manifest: PluginManifest,
  capabilityDescriptions: Schema.Record(TrimmedNonEmptyString, TrimmedNonEmptyString),
});
export type PluginInstallStaged = typeof PluginInstallStaged.Type;

export const PluginSourceError = Schema.Struct({
  sourceId: TrimmedNonEmptyString,
  url: TrimmedNonEmptyString,
  message: TrimmedNonEmptyString,
});
export type PluginSourceError = typeof PluginSourceError.Type;

export const PluginSourcesListResult = Schema.Struct({
  sources: Schema.Array(PluginSource),
});
export type PluginSourcesListResult = typeof PluginSourcesListResult.Type;

export const PluginSourcesAddInput = Schema.Struct({
  url: TrimmedNonEmptyString,
});
export type PluginSourcesAddInput = typeof PluginSourcesAddInput.Type;

export const PluginSourcesAddResult = Schema.Struct({
  source: PluginSource,
});
export type PluginSourcesAddResult = typeof PluginSourcesAddResult.Type;

export const PluginSourcesRemoveInput = Schema.Struct({
  sourceId: TrimmedNonEmptyString,
});
export type PluginSourcesRemoveInput = typeof PluginSourcesRemoveInput.Type;

export const PluginCatalogInput = Schema.Struct({
  sourceId: Schema.optionalKey(TrimmedNonEmptyString),
});
export type PluginCatalogInput = typeof PluginCatalogInput.Type;

export const PluginCatalogResult = Schema.Struct({
  entries: Schema.Array(MarketplaceEntry),
  errors: Schema.Array(PluginSourceError),
});
export type PluginCatalogResult = typeof PluginCatalogResult.Type;

export const PluginInstallBeginInput = Schema.Struct({
  sourceId: TrimmedNonEmptyString,
  pluginId: PluginId,
  version: SemverString,
});
export type PluginInstallBeginInput = typeof PluginInstallBeginInput.Type;

export const PluginInstallConfirmInput = Schema.Struct({
  stageToken: TrimmedNonEmptyString,
});
export type PluginInstallConfirmInput = typeof PluginInstallConfirmInput.Type;

export const PluginInstallConfirmResult = Schema.Struct({
  plugin: PluginInfo,
});
export type PluginInstallConfirmResult = typeof PluginInstallConfirmResult.Type;

export const PluginInstallAbortInput = PluginInstallConfirmInput;
export type PluginInstallAbortInput = typeof PluginInstallAbortInput.Type;

export const PluginSetEnabledInput = Schema.Struct({
  pluginId: PluginId,
  enabled: Schema.Boolean,
});
export type PluginSetEnabledInput = typeof PluginSetEnabledInput.Type;

export const PluginUninstallInput = Schema.Struct({
  pluginId: PluginId,
  removeData: Schema.Boolean,
});
export type PluginUninstallInput = typeof PluginUninstallInput.Type;

export const PluginUpgradeBeginInput = Schema.Struct({
  pluginId: PluginId,
  version: SemverString,
});
export type PluginUpgradeBeginInput = typeof PluginUpgradeBeginInput.Type;

export const PluginUpgradeConfirmInput = PluginInstallConfirmInput;
export type PluginUpgradeConfirmInput = typeof PluginUpgradeConfirmInput.Type;

export const PluginUpgradeConfirmResult = Schema.Struct({
  plugin: PluginInfo,
});
export type PluginUpgradeConfirmResult = typeof PluginUpgradeConfirmResult.Type;

export const PluginUpdateInfo = Schema.Struct({
  pluginId: PluginId,
  currentVersion: SemverString,
  latestVersion: SemverString,
});
export type PluginUpdateInfo = typeof PluginUpdateInfo.Type;

export const PluginCheckUpdatesResult = Schema.Struct({
  updates: Schema.Array(PluginUpdateInfo),
});
export type PluginCheckUpdatesResult = typeof PluginCheckUpdatesResult.Type;

export class PluginManagementError extends Schema.TaggedErrorClass<PluginManagementError>()(
  "PluginManagementError",
  {
    code: Schema.Literals([
      "invalid-source",
      "source-not-found",
      "catalog-fetch-failed",
      "plugin-not-found",
      "version-not-found",
      "download-failed",
      "checksum-mismatch",
      "extract-failed",
      "manifest-invalid",
      "stage-not-found",
      "filesystem",
      "lockfile",
      "activation-failed",
    ]),
    message: Schema.String,
    data: Schema.optional(Schema.Unknown),
  },
) {}

export const PluginMethodInput = Schema.Struct({
  pluginId: PluginId,
  method: TrimmedNonEmptyString,
  payload: Schema.optionalKey(Schema.Unknown),
});
export type PluginMethodInput = typeof PluginMethodInput.Type;

export const PLUGINS_WS_METHODS = {
  list: "plugins.list",
  call: "plugins.call",
  subscribe: "plugins.subscribe",
  sourcesList: "plugins.sources.list",
  sourcesAdd: "plugins.sources.add",
  sourcesRemove: "plugins.sources.remove",
  catalog: "plugins.catalog",
  installBegin: "plugins.install.begin",
  installConfirm: "plugins.install.confirm",
  installAbort: "plugins.install.abort",
  setEnabled: "plugins.setEnabled",
  uninstall: "plugins.uninstall",
  upgradeBegin: "plugins.upgrade.begin",
  upgradeConfirm: "plugins.upgrade.confirm",
  checkUpdates: "plugins.checkUpdates",
} as const;

const LockfileSource = Schema.Struct({
  id: TrimmedNonEmptyString,
  url: TrimmedNonEmptyString,
  addedAt: IsoDateTime,
});
export type PluginLockfileSource = typeof LockfileSource.Type;

const LockfilePlugin = Schema.Struct({
  version: SemverString,
  sha256: TrimmedNonEmptyString,
  sourceId: TrimmedNonEmptyString,
  enabled: Schema.Boolean,
  state: PluginState,
  staged: Schema.optionalKey(
    Schema.Struct({
      version: SemverString,
      sha256: TrimmedNonEmptyString,
      stagedAt: IsoDateTime,
    }),
  ),
  activation: Schema.Struct({
    activatingSince: Schema.NullOr(IsoDateTime),
    crashCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  }),
  installedAt: IsoDateTime,
  lastError: Schema.NullOr(Schema.String),
});
export type PluginLockfilePlugin = typeof LockfilePlugin.Type;

export const PluginLockfile = Schema.Struct({
  sources: Schema.Array(LockfileSource),
  plugins: Schema.Record(PluginId, LockfilePlugin),
});
export type PluginLockfile = typeof PluginLockfile.Type;

export const EMPTY_PLUGIN_LOCKFILE: PluginLockfile = {
  sources: [],
  plugins: {},
};

interface ParsedSemver {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
}

function parseStrictSemver(value: string): ParsedSemver | null {
  const match = value.trim().match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  };
}

function compareSemver(left: ParsedSemver, right: ParsedSemver): number {
  if (left.major !== right.major) return left.major - right.major;
  if (left.minor !== right.minor) return left.minor - right.minor;
  return left.patch - right.patch;
}

export function hostApiSatisfies(range: string, version: string): boolean {
  const trimmedRange = range.trim();
  const operator =
    trimmedRange.startsWith("^") || trimmedRange.startsWith("~") ? trimmedRange[0] : "";
  const target = parseStrictSemver(operator ? trimmedRange.slice(1) : trimmedRange);
  const actual = parseStrictSemver(version);
  if (!target || !actual) return false;

  const compared = compareSemver(actual, target);
  if (operator === "") return compared === 0;
  if (compared < 0) return false;

  if (operator === "^") {
    if (target.major > 0) return actual.major === target.major;
    if (target.minor > 0) return actual.major === 0 && actual.minor === target.minor;
    return actual.major === 0 && actual.minor === 0 && actual.patch === target.patch;
  }

  return actual.major === target.major && actual.minor === target.minor;
}
