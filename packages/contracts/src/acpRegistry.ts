import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString, TrimmedString } from "./baseSchemas.ts";
import { ProviderOptionDescriptor } from "./model.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

const AcpRegistryAgentId = TrimmedNonEmptyString.check(
  Schema.isMaxLength(128),
  Schema.isPattern(/^[a-z0-9][a-z0-9._-]*$/),
);

export const AcpRegistryDistribution = Schema.Literals(["binary", "npx", "uvx"]);
export type AcpRegistryDistribution = typeof AcpRegistryDistribution.Type;

export const AcpRegistryIntegrity = Schema.Literals(["sha256", "registry"]);
export type AcpRegistryIntegrity = typeof AcpRegistryIntegrity.Type;

export const AcpRegistrySearchInput = Schema.Struct({
  query: TrimmedString.check(Schema.isMaxLength(120)),
});
export type AcpRegistrySearchInput = typeof AcpRegistrySearchInput.Type;

const AcpRegistryUrl = Schema.String.check(Schema.isMaxLength(2_048));

export const AcpRegistrySearchAgent = Schema.Struct({
  id: AcpRegistryAgentId,
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(160)),
  version: TrimmedNonEmptyString.check(Schema.isMaxLength(128)),
  description: Schema.String.check(Schema.isMaxLength(1_024)),
  authors: Schema.Array(Schema.String.check(Schema.isMaxLength(256))).check(Schema.isMaxLength(16)),
  license: Schema.NullOr(Schema.String.check(Schema.isMaxLength(128))),
  website: Schema.NullOr(AcpRegistryUrl),
  repository: Schema.NullOr(AcpRegistryUrl),
  icon: Schema.NullOr(AcpRegistryUrl),
  distribution: AcpRegistryDistribution,
  integrity: AcpRegistryIntegrity,
});
export type AcpRegistrySearchAgent = typeof AcpRegistrySearchAgent.Type;

export const AcpRegistrySearchResult = Schema.Struct({
  agents: Schema.Array(AcpRegistrySearchAgent).check(Schema.isMaxLength(20)),
});
export type AcpRegistrySearchResult = typeof AcpRegistrySearchResult.Type;

export const AcpRegistryPrepareInput = Schema.Struct({
  agentId: AcpRegistryAgentId,
});
export type AcpRegistryPrepareInput = typeof AcpRegistryPrepareInput.Type;

export const AcpRegistryPrepareResult = Schema.Struct({
  agentId: AcpRegistryAgentId,
  version: TrimmedNonEmptyString.check(Schema.isMaxLength(128)),
  distribution: AcpRegistryDistribution,
  prepared: Schema.Literal(true),
});
export type AcpRegistryPrepareResult = typeof AcpRegistryPrepareResult.Type;

export const AcpRegistryManagedBinaryUninstallInput = Schema.Struct({
  agentId: AcpRegistryAgentId,
});
export type AcpRegistryManagedBinaryUninstallInput =
  typeof AcpRegistryManagedBinaryUninstallInput.Type;

export const AcpRegistryManagedBinaryUninstallResult = Schema.Struct({
  agentId: AcpRegistryAgentId,
  removed: Schema.Boolean,
});
export type AcpRegistryManagedBinaryUninstallResult =
  typeof AcpRegistryManagedBinaryUninstallResult.Type;

const AcpRegistryProbeText = TrimmedNonEmptyString.check(Schema.isMaxLength(256));
const AcpRegistryProbeDescription = Schema.NullOr(Schema.String.check(Schema.isMaxLength(1_024)));

export const AcpRegistryProbeAuthMethod = Schema.Struct({
  id: AcpRegistryProbeText,
  name: AcpRegistryProbeText,
  description: AcpRegistryProbeDescription,
  type: Schema.Literals(["agent", "env_var", "terminal"]),
  // Terminal methods: the full command line the user runs in a thread
  // terminal on the owning environment to complete interactive auth.
  command: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(2_048))),
  // Env-var methods: variable names the user sets on the provider instance.
  envVarNames: Schema.optionalKey(Schema.Array(AcpRegistryProbeText).check(Schema.isMaxLength(16))),
});
export type AcpRegistryProbeAuthMethod = typeof AcpRegistryProbeAuthMethod.Type;

export const AcpRegistryProbeModel = Schema.Struct({
  id: AcpRegistryProbeText,
  name: AcpRegistryProbeText,
  description: AcpRegistryProbeDescription,
});
export type AcpRegistryProbeModel = typeof AcpRegistryProbeModel.Type;

export const AcpRegistryProbeResult = Schema.Struct({
  instanceId: ProviderInstanceId,
  // `ready` is only returned after a disposable ACP session/new probe completes.
  // It does not imply that authentication was passively detected.
  ready: Schema.Literal(true),
  icon: Schema.NullOr(AcpRegistryUrl),
  authMethods: Schema.Array(AcpRegistryProbeAuthMethod).check(Schema.isMaxLength(32)),
  models: Schema.Array(AcpRegistryProbeModel).check(Schema.isMaxLength(256)),
  currentModelId: Schema.NullOr(AcpRegistryProbeText),
  // Non-model session config options and session modes, pre-mapped onto T3's
  // provider option descriptors so model capabilities can carry them directly.
  configOptions: Schema.Array(ProviderOptionDescriptor).check(Schema.isMaxLength(16)),
});
export type AcpRegistryProbeResult = typeof AcpRegistryProbeResult.Type;

export const AcpRegistryOperationErrorReason = Schema.Literals([
  "agent_not_configured",
  "agent_not_found",
  "archive_invalid",
  "authentication_failed",
  "checksum_mismatch",
  "download_failed",
  "install_failed",
  "probe_failed",
  "registry_unavailable",
  "runner_unavailable",
  "unsupported_distribution",
  "unsupported_platform",
]);
export type AcpRegistryOperationErrorReason = typeof AcpRegistryOperationErrorReason.Type;

export class AcpRegistryOperationError extends Schema.TaggedErrorClass<AcpRegistryOperationError>()(
  "AcpRegistryOperationError",
  {
    reason: AcpRegistryOperationErrorReason,
    message: Schema.String,
    authMethods: Schema.optionalKey(
      Schema.Array(AcpRegistryProbeAuthMethod).check(Schema.isMaxLength(32)),
    ),
  },
) {}
