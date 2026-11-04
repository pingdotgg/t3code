import {
  type ExecutionEnvironmentCapabilities,
  type PluginInstallation,
  type PluginInstallationId,
  type PluginNpmAddInput,
  type PluginNpmListResult,
  type PluginNpmPackage,
  PluginNpmPackageName,
  type PluginNpmStagedUpdate,
  PluginNpmVersionRequest,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

/** Whether an environment's server installs plugins from npm; older servers omit the flag. */
export const supportsPluginNpm = (
  capabilities: Pick<ExecutionEnvironmentCapabilities, "pluginNpm"> | null | undefined,
) => capabilities?.pluginNpm === true;

const PLUGIN_NPM_DEFAULT_REGISTRY = "https://registry.npmjs.org";

/** Shown before any npm package is approved: what installing does and does not do. */
export const PLUGIN_NPM_SCRIPTS_STATEMENT =
  "T3 Code never runs package scripts and never installs dependencies, so a plugin package must bundle everything it needs. Downloading runs nothing; the plugin's code runs only after you approve these exact files.";

/** What the registry checksum shows, and what it does not. */
export const PLUGIN_NPM_INTEGRITY_STATEMENT =
  "The download matched the registry's sha512 checksum: these are the bytes the registry published. It does not show who published them.";

const isPackageName = Schema.is(PluginNpmPackageName);
const isVersionRequest = Schema.is(PluginNpmVersionRequest);

const VERSION_HELP =
  "Enter an exact version such as 1.2.3, or a tag such as latest. Ranges are not accepted.";

/** What an install or update form may send now. */
type PluginNpmRequest<A> =
  | { readonly _tag: "ready"; readonly input: A }
  | { readonly _tag: "invalid"; readonly message: string }
  | { readonly _tag: "blocked" };

/** An empty version means `latest`. */
function versionRequest(version: string): PluginNpmVersionRequest | null {
  const trimmed = version.trim();
  const request = trimmed.length === 0 ? "latest" : trimmed;
  return isVersionRequest(request) ? request : null;
}

/**
 * The `plugins.npm.add` input to send, why the form cannot send it, or
 * `blocked` while management is off or a step is running. Every submit path
 * goes through this, so a form that lost access while open sends nothing.
 */
export function pluginNpmInstallRequest(input: {
  readonly canManage: boolean;
  readonly busy: boolean;
  readonly name: string;
  readonly version: string;
  readonly registry: string;
}): PluginNpmRequest<PluginNpmAddInput> {
  if (!input.canManage || input.busy) return { _tag: "blocked" };
  const name = input.name.trim();
  if (name.length === 0) return { _tag: "blocked" };
  if (!isPackageName(name))
    return {
      _tag: "invalid",
      message: "Enter an npm package name, such as t3-notifier or @acme/t3-notifier.",
    };
  const version = versionRequest(input.version);
  if (version === null) return { _tag: "invalid", message: VERSION_HELP };
  const registry = input.registry.trim();
  if (registry.length > 2048) return { _tag: "invalid", message: "The registry URL is too long." };
  return {
    _tag: "ready",
    input: { name, version, ...(registry.length === 0 ? {} : { registry }) },
  };
}

/** The version request for `plugins.npm.stageUpdate`, gated like an install. */
export function pluginNpmUpdateRequest(input: {
  readonly canManage: boolean;
  readonly busy: boolean;
  readonly version: string;
}): PluginNpmRequest<PluginNpmVersionRequest> {
  if (!input.canManage || input.busy) return { _tag: "blocked" };
  const version = versionRequest(input.version);
  return version === null
    ? { _tag: "invalid", message: VERSION_HELP }
    : { _tag: "ready", input: version };
}

/** One environment's npm provenance list as a screen sees it. */
export type PluginNpmPackagesState =
  | { readonly _tag: "unsupported" }
  | { readonly _tag: "loading" }
  | { readonly _tag: "failed"; readonly message: string }
  | { readonly _tag: "available"; readonly list: PluginNpmListResult };

export function resolvePluginNpmPackagesState(input: {
  readonly supported: boolean;
  readonly data: PluginNpmListResult | null;
  readonly error: string | null;
}): PluginNpmPackagesState {
  if (!input.supported) return { _tag: "unsupported" };
  if (input.error !== null) return { _tag: "failed", message: input.error };
  if (input.data === null) return { _tag: "loading" };
  return { _tag: "available", list: input.data };
}

/**
 * Made by `settlePluginNpmStep` when an npm step settles: the list held then,
 * and the step's reply (null after a failure). The list is a query, so until a
 * list read after the step arrives, the reply is newer than it; after a
 * failure nothing is known until then.
 */
export interface PluginNpmStepMarker {
  readonly list: PluginNpmListResult | null;
  readonly reply: PluginNpmPackage | null;
}

/**
 * The npm list is read again after every npm step and whenever this key
 * changes: installations come and go, and an applied update changes the
 * installed files. A staged update changes no catalogue row, so a screen also
 * reads the list again after its own steps.
 */
export function pluginNpmListKey(installations: ReadonlyArray<PluginInstallation>): string {
  return installations
    .map((installation) => `${installation.installationId}:${installation.source?.digest ?? ""}`)
    .join("|");
}

export type PluginNpmProvenance =
  /** Known not to be from npm, or the server has no npm support. */
  | { readonly _tag: "none" }
  /** The list is loading or did not load, so where the files came from is not known. */
  | { readonly _tag: "unknown" }
  /** Waiting for a list read after a step whose outcome is unknown. */
  | { readonly _tag: "checking" }
  | { readonly _tag: "found"; readonly package: PluginNpmPackage };

/** Where one installation came from, preferring a step's reply until a later list arrives. */
export function resolvePluginNpmProvenance(input: {
  readonly state: PluginNpmPackagesState;
  readonly installationId: PluginInstallationId;
  readonly step: PluginNpmStepMarker | null;
}): PluginNpmProvenance {
  const { state, step } = input;
  if (state._tag === "unsupported") return { _tag: "none" };
  const list = state._tag === "available" ? state.list : null;
  // The same object means no list was read since the step settled.
  if (step !== null && step.list === list) {
    if (step.reply === null) return { _tag: "checking" };
    if (step.reply.installationId === input.installationId)
      return { _tag: "found", package: step.reply };
  }
  if (list === null) return { _tag: "unknown" };
  const found = list.packages.find((entry) => entry.installationId === input.installationId);
  return found ? { _tag: "found", package: found } : { _tag: "none" };
}

/**
 * Whether a screen knows, and so shows, where an installation's files came
 * from. Approving waits for it: an npm download's package, checksum, and
 * scripts policy belong on the consent screen.
 */
export const pluginNpmProvenanceKnown = (provenance: PluginNpmProvenance) =>
  provenance._tag === "none" || provenance._tag === "found";

/** Shown in place of Approve's disclosure while provenance is not known. */
export const PLUGIN_NPM_PROVENANCE_PENDING =
  "You can approve once T3 Code shows whether these files were downloaded from npm.";

/**
 * What removing an installation deletes, as far as the screen knows where its
 * files came from. Saved settings and storage always go.
 */
export function pluginRemoveDescription(provenance: PluginNpmProvenance, label: string): string {
  const forgets =
    "T3 Code stops the plugin, forgets your approval, and deletes its saved settings and storage.";
  switch (provenance._tag) {
    case "found":
      return `${forgets} It also deletes the copy of ${provenance.package.source.name} it downloaded to ${label}'s machine.`;
    case "none":
      return `${forgets} Its directory stays on ${label}'s machine.`;
    default:
      return `${forgets} A plugin added from a directory keeps it; one downloaded from npm has its copy deleted from ${label}'s machine.`;
  }
}

function displayRegistry(registry: string): string | null {
  return registry === PLUGIN_NPM_DEFAULT_REGISTRY ? null : registry;
}

/** `name@version`, with the registry when it is not npm's own. */
export function describePluginNpmSource(pkg: PluginNpmPackage): string {
  const registry = displayRegistry(pkg.source.registry);
  return `${pkg.source.name}@${pkg.source.version}${registry ? ` from ${registry}` : ""}`;
}

/** What a downloaded update changes, for the screen that asks to apply it. */
interface PluginNpmUpdatePresentation {
  readonly update: PluginNpmStagedUpdate;
  /** The download is the version already installed, byte for byte. */
  readonly sameAsInstalled: boolean;
  readonly addedCapabilities: ReadonlyArray<string>;
  readonly removedCapabilities: ReadonlyArray<string>;
  /** Shown beside the acknowledgement, before Apply: what installing a package does and what applying does. */
  readonly disclosure: ReadonlyArray<string>;
}

const PLUGIN_NPM_APPLY_STATEMENT =
  "Applying approves these files in place of the installed ones. If anything fails before that, the installed version stays. A server restart discards the download.";

export function presentPluginNpmUpdate(
  installation: PluginInstallation,
  pkg: PluginNpmPackage,
): PluginNpmUpdatePresentation | null {
  const update = pkg.stagedUpdate;
  if (update === null) return null;
  const current = installation.manifest?.capabilities ?? [];
  const next = update.manifest.capabilities;
  return {
    update,
    sameAsInstalled: update.source.digest === installation.source?.digest,
    addedCapabilities: next.filter((capability) => !current.includes(capability)),
    removedCapabilities: current.filter((capability) => !next.includes(capability)),
    disclosure: [PLUGIN_NPM_SCRIPTS_STATEMENT, PLUGIN_NPM_APPLY_STATEMENT],
  };
}

/** A short line for a plugin list row: where it came from and any update waiting. */
export function pluginNpmRowLabel(pkg: PluginNpmPackage): string {
  const source = `npm · ${describePluginNpmSource(pkg)}`;
  // A download of the installed version still waits to be applied or discarded.
  if (pkg.stagedUpdate === null) return source;
  return pkg.stagedUpdate.version === pkg.source.version
    ? `${source} · Download ready to review`
    : `${source} · Update ${pkg.stagedUpdate.version} ready to review`;
}
