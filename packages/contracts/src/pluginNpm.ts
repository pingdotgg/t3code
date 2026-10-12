/**
 * PluginNpm - Wire schemas for installing trusted plugins from an npm
 * registry.
 *
 * Installing downloads one exact package version, checks its tarball against
 * the registry's sha512 integrity, and unpacks it into a directory the server
 * owns. No package script ever runs, and dependencies are never installed: a
 * plugin package must bundle everything it needs. The result is an ordinary
 * catalogue installation that still needs consent to its digest before any
 * of its code runs.
 *
 * An update downloads the new version next to the installed one without
 * touching it. Applying the update is the consent to its digest: the server
 * swaps the directories and restores the old one if anything fails before
 * the consent is recorded. Removing the installation through `plugins.remove`
 * deletes the server's copy.
 *
 * @module PluginNpm
 */
import * as Schema from "effect/Schema";

import { IsoDateTime, TrimmedNonEmptyString } from "./baseSchemas.ts";
import {
  PluginInstallation,
  PluginInstallationId,
  PluginInstallationManifest,
  PluginSource,
  PluginSourceDigest,
} from "./pluginCatalog.ts";

/** An npm package name, scoped or not, as the registry accepts it. */
export const PluginNpmPackageName = TrimmedNonEmptyString.check(
  Schema.isMaxLength(214),
  Schema.isPattern(/^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9~][a-z0-9._~-]*$/),
);

/** One exact version (`1.2.3`, `1.2.3-beta.1`), never a range. */
export const PluginNpmVersion = Schema.String.check(
  Schema.isMaxLength(256),
  Schema.isPattern(
    /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/,
  ),
);
export type PluginNpmVersion = typeof PluginNpmVersion.Type;

/**
 * What to install: an exact version, or a dist-tag such as `latest` that the
 * server resolves to one. Ranges are refused.
 */
export const PluginNpmVersionRequest = TrimmedNonEmptyString.check(
  Schema.isMaxLength(256),
  Schema.isPattern(
    /^(?:(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?|(?![xX]$)[A-Za-z][A-Za-z0-9._-]*)$/,
  ),
);
export type PluginNpmVersionRequest = typeof PluginNpmVersionRequest.Type;

/** A Subresource Integrity sha512 value, as npm records it. */
export const PluginNpmIntegrity = Schema.String.check(
  Schema.isPattern(/^sha512-[A-Za-z0-9+/]{86}==$/),
);
export type PluginNpmIntegrity = typeof PluginNpmIntegrity.Type;

/** Where an installed version came from. */
export const PluginNpmSource = Schema.Struct({
  /** Registry base URL, without credentials. */
  registry: Schema.String,
  name: PluginNpmPackageName,
  version: PluginNpmVersion,
  integrity: PluginNpmIntegrity,
  installedAt: IsoDateTime,
});
export type PluginNpmSource = typeof PluginNpmSource.Type;

/** A downloaded version waiting to replace the installed one. Nothing in it has run. */
const PluginNpmStagedUpdate = Schema.Struct({
  version: PluginNpmVersion,
  integrity: PluginNpmIntegrity,
  manifest: PluginInstallationManifest,
  /** Pass `source.digest` to `plugins.npm.applyUpdate` to consent to these bytes. */
  source: PluginSource,
  stagedAt: IsoDateTime,
});
export type PluginNpmStagedUpdate = typeof PluginNpmStagedUpdate.Type;

const PluginNpmPackage = Schema.Struct({
  installationId: PluginInstallationId,
  source: PluginNpmSource,
  /** Kept in memory only; a server restart discards it. */
  stagedUpdate: Schema.NullOr(PluginNpmStagedUpdate),
});
export type PluginNpmPackage = typeof PluginNpmPackage.Type;

export const PluginNpmListResult = Schema.Struct({
  packages: Schema.Array(PluginNpmPackage),
});
export type PluginNpmListResult = typeof PluginNpmListResult.Type;

export const PluginNpmAddInput = Schema.Struct({
  name: PluginNpmPackageName,
  version: PluginNpmVersionRequest,
  /** Defaults to the public npm registry. */
  registry: Schema.optionalKey(TrimmedNonEmptyString.check(Schema.isMaxLength(2048))),
});
export type PluginNpmAddInput = typeof PluginNpmAddInput.Type;

export const PluginNpmStageUpdateInput = Schema.Struct({
  installationId: PluginInstallationId,
  version: PluginNpmVersionRequest,
});
export type PluginNpmStageUpdateInput = typeof PluginNpmStageUpdateInput.Type;

export const PluginNpmApplyUpdateInput = Schema.Struct({
  installationId: PluginInstallationId,
  /** The staged update's digest the user was shown. */
  digest: PluginSourceDigest,
});
export type PluginNpmApplyUpdateInput = typeof PluginNpmApplyUpdateInput.Type;

export const PluginNpmPackageResult = Schema.Struct({
  package: PluginNpmPackage,
});
export type PluginNpmPackageResult = typeof PluginNpmPackageResult.Type;

export const PluginNpmInstallationResult = Schema.Struct({
  installation: PluginInstallation,
  package: PluginNpmPackage,
});
export type PluginNpmInstallationResult = typeof PluginNpmInstallationResult.Type;
