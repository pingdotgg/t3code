/**
 * PluginCatalog - Wire schemas for managing the trusted local plugins an
 * environment runs.
 *
 * A plugin is installed by adding a directory on the server's machine. The
 * server reads its manifest and computes a digest of the directory's exact
 * bytes; nothing in the directory runs until someone consents to that digest
 * and enables the installation. Any later byte change moves the installation
 * back to needing consent and stops it. Disable and remove are always allowed.
 *
 * Installations are environment-local: the same plugin on two environments is
 * two records. `installationId` is the identity; `generation` counts how many
 * times the server has registered the installation to run, so a consumer can
 * tell a replacement from the registration it was talking to.
 *
 * @module PluginCatalog
 */
import * as Schema from "effect/Schema";

import {
  ForwardCompatibleOptional,
  IsoDateTime,
  NonNegativeInt,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { PluginHostState } from "./plugin.ts";
import { PluginEventDeliveryState } from "./pluginEvents.ts";

export const PluginInstallationId = TrimmedNonEmptyString.check(Schema.isMaxLength(64)).pipe(
  Schema.brand("PluginInstallationId"),
);
export type PluginInstallationId = typeof PluginInstallationId.Type;

/** `sha256:` and the hex digest of every file in the plugin directory. */
const PluginSourceDigest = Schema.String.check(Schema.isPattern(/^sha256:[0-9a-f]{64}$/));

/**
 * What the manifest said when the server last read it. Ids and capability
 * names are plain strings here so an older client keeps rows whose values a
 * newer server accepts.
 */
const PluginInstallationManifest = Schema.Struct({
  id: TrimmedNonEmptyString.pipe(Schema.brand("PluginId")),
  name: Schema.String,
  /** Display metadata only; never proof of the installed bytes. */
  version: Schema.String,
  description: Schema.optionalKey(Schema.String),
  capabilities: Schema.Array(Schema.String),
  proposedApi: Schema.Boolean,
});
export type PluginInstallationManifest = typeof PluginInstallationManifest.Type;

/** The exact bytes the server found at its last inspection. */
const PluginSource = Schema.Struct({
  digest: PluginSourceDigest,
  files: NonNegativeInt,
  bytes: NonNegativeInt,
});
export type PluginSource = typeof PluginSource.Type;

/** Consent to run one exact source with the capabilities its manifest declared. */
const PluginConsent = Schema.Struct({
  digest: PluginSourceDigest,
  capabilities: Schema.Array(Schema.String),
  grantedAt: IsoDateTime,
});

export const PluginInstallation = Schema.Struct({
  installationId: PluginInstallationId,
  generation: NonNegativeInt,
  /** Absolute path on the server's machine. */
  directory: Schema.String,
  /** From the last inspection that could read the manifest. */
  manifest: Schema.NullOr(PluginInstallationManifest),
  /** Null when the last inspection failed; `problem` says why. */
  source: Schema.NullOr(PluginSource),
  problem: Schema.NullOr(Schema.String),
  /** When the current manifest, source, and problem were found; a check that finds the same keeps it. */
  inspectedAt: IsoDateTime,
  consent: Schema.NullOr(PluginConsent),
  /** Registered to run. Only true while `consent.digest` matches `source.digest`. */
  enabled: Schema.Boolean,
  /**
   * The plugin process's state while enabled. Absent when disabled, and also
   * when this client does not know the state a newer server sent: treat
   * absence on an enabled installation as unknown, never as idle or stopped.
   */
  hostState: ForwardCompatibleOptional(PluginHostState),
  /**
   * Event delivery while enabled, for a plugin that declares `events`. Absent
   * otherwise, from a server without it, and when this client does not know
   * the state a newer server sent: treat absence as unknown, never as healthy.
   */
  eventDelivery: ForwardCompatibleOptional(PluginEventDeliveryState),
  addedAt: IsoDateTime,
});
export type PluginInstallation = typeof PluginInstallation.Type;

type PluginInstallationStatus = "unavailable" | "needs-consent" | "enabled" | "disabled";

/** What the user can do next with an installation. */
export const pluginInstallationStatus = (
  installation: Pick<PluginInstallation, "source" | "problem" | "consent" | "enabled">,
): PluginInstallationStatus => {
  if (installation.problem !== null || installation.source === null) return "unavailable";
  if (installation.consent?.digest !== installation.source.digest) return "needs-consent";
  return installation.enabled ? "enabled" : "disabled";
};

export const PluginCatalogSnapshot = Schema.Struct({
  installations: Schema.Array(PluginInstallation),
});
export type PluginCatalogSnapshot = typeof PluginCatalogSnapshot.Type;

export const PluginAddInput = Schema.Struct({
  /** Absolute path of the plugin directory on the server's machine. */
  directory: TrimmedNonEmptyString.check(Schema.isMaxLength(4096)),
});
export type PluginAddInput = typeof PluginAddInput.Type;

export const PluginInstallationInput = Schema.Struct({
  installationId: PluginInstallationId,
});
export type PluginInstallationInput = typeof PluginInstallationInput.Type;

export const PluginRefreshInput = Schema.Struct({
  /** Omit to inspect every installation. */
  installationId: Schema.optionalKey(PluginInstallationId),
});
export type PluginRefreshInput = typeof PluginRefreshInput.Type;

export const PluginConsentInput = Schema.Struct({
  installationId: PluginInstallationId,
  /** The digest the user was shown. Consent fails if the bytes have changed since. */
  digest: PluginSourceDigest,
});
export type PluginConsentInput = typeof PluginConsentInput.Type;

export const PluginInstallationResult = Schema.Struct({
  installation: PluginInstallation,
});
export type PluginInstallationResult = typeof PluginInstallationResult.Type;

export const PluginRemoveResult = Schema.Struct({
  installationId: PluginInstallationId,
});
export type PluginRemoveResult = typeof PluginRemoveResult.Type;

/**
 * `reason` is an open set so newer servers can add cases: `not-found`,
 * `invalid-directory`, `already-added`, `source-changed`, `consent-required`,
 * `plugin-id-conflict`, `unavailable`, `storage`, `generation-changed`.
 */
export class PluginCatalogError extends Schema.TaggedError<PluginCatalogError>()(
  "PluginCatalogError",
  {
    reason: Schema.String,
    message: Schema.String,
    installationId: Schema.optionalKey(PluginInstallationId),
  },
) {}
