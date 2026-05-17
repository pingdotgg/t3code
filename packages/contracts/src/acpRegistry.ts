import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";

export const AcpRegistryBinaryPlatform = Schema.Literals([
  "darwin-aarch64",
  "darwin-x86_64",
  "linux-aarch64",
  "linux-x86_64",
  "windows-aarch64",
  "windows-x86_64",
]);
export type AcpRegistryBinaryPlatform = typeof AcpRegistryBinaryPlatform.Type;

const EnvMap = Schema.Record(TrimmedNonEmptyString, Schema.String);
const ArgsArray = Schema.Array(Schema.String);

export const AcpRegistryBinaryTarget = Schema.Struct({
  archive: TrimmedNonEmptyString,
  sha256: Schema.optionalKey(TrimmedNonEmptyString),
  cmd: TrimmedNonEmptyString,
  args: Schema.optionalKey(ArgsArray),
  env: Schema.optionalKey(EnvMap),
});
export type AcpRegistryBinaryTarget = typeof AcpRegistryBinaryTarget.Type;

export const AcpRegistryBinaryDistribution = Schema.Struct({
  "darwin-aarch64": Schema.optionalKey(AcpRegistryBinaryTarget),
  "darwin-x86_64": Schema.optionalKey(AcpRegistryBinaryTarget),
  "linux-aarch64": Schema.optionalKey(AcpRegistryBinaryTarget),
  "linux-x86_64": Schema.optionalKey(AcpRegistryBinaryTarget),
  "windows-aarch64": Schema.optionalKey(AcpRegistryBinaryTarget),
  "windows-x86_64": Schema.optionalKey(AcpRegistryBinaryTarget),
});
export type AcpRegistryBinaryDistribution = typeof AcpRegistryBinaryDistribution.Type;

export const AcpRegistryPackageDistribution = Schema.Struct({
  package: TrimmedNonEmptyString,
  args: Schema.optionalKey(ArgsArray),
  env: Schema.optionalKey(EnvMap),
});
export type AcpRegistryPackageDistribution = typeof AcpRegistryPackageDistribution.Type;

export const AcpRegistryDistribution = Schema.Struct({
  binary: Schema.optionalKey(AcpRegistryBinaryDistribution),
  npx: Schema.optionalKey(AcpRegistryPackageDistribution),
  uvx: Schema.optionalKey(AcpRegistryPackageDistribution),
});
export type AcpRegistryDistribution = typeof AcpRegistryDistribution.Type;

export const AcpRegistryEntry = Schema.Struct({
  id: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
  version: TrimmedNonEmptyString,
  description: TrimmedNonEmptyString,
  repository: Schema.optionalKey(TrimmedNonEmptyString),
  website: Schema.optionalKey(TrimmedNonEmptyString),
  authors: Schema.optionalKey(Schema.Array(TrimmedNonEmptyString)),
  license: Schema.optionalKey(TrimmedNonEmptyString),
  icon: Schema.optionalKey(TrimmedNonEmptyString),
  distribution: AcpRegistryDistribution,
});
export type AcpRegistryEntry = typeof AcpRegistryEntry.Type;

export const AcpRegistryDocument = Schema.Struct({
  version: Schema.String,
  agents: Schema.Array(AcpRegistryEntry),
});
export type AcpRegistryDocument = typeof AcpRegistryDocument.Type;

export const AcpRegistryDistributionKind = Schema.Literals(["binary", "npx", "uvx"]);
export type AcpRegistryDistributionKind = typeof AcpRegistryDistributionKind.Type;

/**
 * Auth method advertised by an ACP-conforming agent via its `initialize`
 * response. Captured by the install-time probe and surfaced to clients on
 * `ServerProviderAuth` so the auth UI can render the right login affordances.
 */
export const AcpAuthMethod = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  description: Schema.optional(Schema.String),
});
export type AcpAuthMethod = typeof AcpAuthMethod.Type;

export const AcpRegistryCachedModel = Schema.Struct({
  slug: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
});
export type AcpRegistryCachedModel = typeof AcpRegistryCachedModel.Type;

export const AcpRegistryInstallState = Schema.Struct({
  version: TrimmedNonEmptyString,
  installedAt: Schema.String,
  authMethods: Schema.optionalKey(Schema.Array(AcpAuthMethod)),
  distribution: AcpRegistryDistributionKind,
  binaryPath: Schema.optionalKey(TrimmedNonEmptyString),
  cachedModels: Schema.optionalKey(Schema.Array(AcpRegistryCachedModel)),
  // Count of consecutive boot-time discovery failures. When >= 3 we stop retrying on every
  // boot — user can force a retry via "Reload models" or by sending a first chat message.
  discoveryFailureCount: Schema.optionalKey(Schema.Number),
  // ISO timestamp of the last discovery attempt — for telemetry / future manual retry UI.
  lastDiscoveryAttemptAt: Schema.optionalKey(Schema.String),
});
export type AcpRegistryInstallState = typeof AcpRegistryInstallState.Type;

export const AcpRegistryInstallStatus = Schema.Literals([
  "installed",
  "not_installed",
  "unsupported",
  "update_available",
]);
export type AcpRegistryInstallStatus = typeof AcpRegistryInstallStatus.Type;

export const AcpRegistryEntryWithStatus = Schema.Struct({
  entry: AcpRegistryEntry,
  status: AcpRegistryInstallStatus,
  installed: Schema.optionalKey(AcpRegistryInstallState),
  availableChannels: Schema.Array(AcpRegistryDistributionKind),
});
export type AcpRegistryEntryWithStatus = typeof AcpRegistryEntryWithStatus.Type;

export class AcpRegistryError extends Schema.TaggedErrorClass<AcpRegistryError>()(
  "AcpRegistryError",
  {
    operation: Schema.String,
    agentId: Schema.optional(Schema.String),
    detail: Schema.String,
    platform: Schema.optional(Schema.String),
    path: Schema.optional(Schema.String),
    url: Schema.optional(Schema.String),
    status: Schema.optional(Schema.Number),
    statusText: Schema.optional(Schema.String),
    expectedChecksum: Schema.optional(Schema.String),
    actualChecksum: Schema.optional(Schema.String),
    command: Schema.optional(Schema.String),
    args: Schema.optional(Schema.Array(Schema.String)),
    exitCode: Schema.optional(Schema.NullOr(Schema.Number)),
    stderr: Schema.optional(Schema.String),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    const prefix = this.agentId ? `[${this.agentId}] ` : "";
    return `${prefix}ACP registry ${this.operation} failed: ${this.detail}`;
  }
}

// A registry agent `gemini` registers as driver kind `acp-gemini`. The prefix
// namespaces it away from the four bespoke driver kinds.
export const ACP_REGISTRY_DRIVER_PREFIX = "acp-" as const;

export const acpRegistryDriverKindFor = (id: string): string =>
  `${ACP_REGISTRY_DRIVER_PREFIX}${id}`;

export const acpRegistryIdFromDriverKind = (driverKind: string): string | undefined =>
  driverKind.startsWith(ACP_REGISTRY_DRIVER_PREFIX)
    ? driverKind.slice(ACP_REGISTRY_DRIVER_PREFIX.length)
    : undefined;
