import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { ProjectId, ThreadId, TrimmedNonEmptyString, TrimmedString } from "./baseSchemas.ts";
import { ProviderOptionDescriptor } from "./model.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

const AcpRegistryAgentId = TrimmedNonEmptyString.check(
  Schema.isMaxLength(128),
  Schema.isPattern(/^[a-z0-9][a-z0-9._-]*$/),
);

const ACP_REGISTRY_CDN_HOSTNAME = "cdn.agentclientprotocol.com";
const ACP_REGISTRY_AGENT_ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;

/** Derives the official Registry icon URL without trusting stored URL metadata. */
export function officialAcpRegistryIconUrlForAgentId(
  agentId: string | null | undefined,
): string | null {
  if (agentId === null || agentId === undefined || !ACP_REGISTRY_AGENT_ID_PATTERN.test(agentId)) {
    return null;
  }
  return `https://${ACP_REGISTRY_CDN_HOSTNAME}/registry/v1/latest/${agentId}.svg`;
}

/** Allows provider icons only from the credential-free official Registry CDN origin. */
export function resolveOfficialAcpRegistryIconUrl(icon: string | null | undefined): string | null {
  if (!icon) return null;
  try {
    const url = new URL(icon);
    if (
      url.protocol !== "https:" ||
      url.hostname !== ACP_REGISTRY_CDN_HOSTNAME ||
      url.port !== "" ||
      url.username !== "" ||
      url.password !== ""
    ) {
      return null;
    }
    return url.href;
  } catch {
    return null;
  }
}

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
  // Env-var methods may advertise where credentials can be created.
  link: Schema.optionalKey(AcpRegistryUrl),
});
export type AcpRegistryProbeAuthMethod = typeof AcpRegistryProbeAuthMethod.Type;

export const AcpRegistryUrlAuthAction = Schema.Struct({
  elicitationId: AcpRegistryProbeText,
  url: AcpRegistryUrl,
  message: Schema.String.check(Schema.isMaxLength(1_024)),
  // Optional for mixed-version clients. New servers include both timestamps
  // so a pending browser login remains understandable on another device.
  createdAt: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(128))),
  expiresAt: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(128))),
});
export type AcpRegistryUrlAuthAction = typeof AcpRegistryUrlAuthAction.Type;

export const AcpRegistryAcceptUrlAuthInput = Schema.Struct({
  instanceId: ProviderInstanceId,
  elicitationId: AcpRegistryProbeText,
});
export type AcpRegistryAcceptUrlAuthInput = typeof AcpRegistryAcceptUrlAuthInput.Type;

export const AcpRegistryAcceptUrlAuthResult = Schema.Struct({
  accepted: Schema.Boolean,
});
export type AcpRegistryAcceptUrlAuthResult = typeof AcpRegistryAcceptUrlAuthResult.Type;

const AcpRegistrySessionId = TrimmedNonEmptyString.check(Schema.isMaxLength(1_024));
const AcpRegistrySessionPath = TrimmedNonEmptyString.check(Schema.isMaxLength(4_096));

export const AcpRegistrySession = Schema.Struct({
  sessionId: AcpRegistrySessionId,
  cwd: AcpRegistrySessionPath,
  additionalDirectories: Schema.Array(AcpRegistrySessionPath).check(Schema.isMaxLength(32)),
  title: Schema.NullOr(Schema.String.check(Schema.isMaxLength(1_024))),
  updatedAt: Schema.NullOr(Schema.String.check(Schema.isMaxLength(128))),
  importedThreadId: Schema.NullOr(ThreadId),
});
export type AcpRegistrySession = typeof AcpRegistrySession.Type;

export const AcpRegistryListSessionsInput = Schema.Struct({
  instanceId: ProviderInstanceId,
  projectId: ProjectId,
  cursor: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(2_048))),
});
export type AcpRegistryListSessionsInput = typeof AcpRegistryListSessionsInput.Type;

export const AcpRegistryListSessionsResult = Schema.Struct({
  sessions: Schema.Array(AcpRegistrySession).check(Schema.isMaxLength(256)),
  nextCursor: Schema.NullOr(Schema.String.check(Schema.isMaxLength(2_048))),
  canLoad: Schema.Boolean,
  canResume: Schema.Boolean,
  canDelete: Schema.Boolean,
});
export type AcpRegistryListSessionsResult = typeof AcpRegistryListSessionsResult.Type;

export const AcpRegistryImportSessionInput = Schema.Struct({
  instanceId: ProviderInstanceId,
  projectId: ProjectId,
  sessionId: AcpRegistrySessionId,
  title: Schema.optionalKey(Schema.NullOr(TrimmedNonEmptyString.check(Schema.isMaxLength(1_024)))),
  updatedAt: Schema.optionalKey(
    Schema.NullOr(TrimmedNonEmptyString.check(Schema.isMaxLength(128))),
  ),
});
export type AcpRegistryImportSessionInput = typeof AcpRegistryImportSessionInput.Type;

export const AcpRegistryImportSessionResult = Schema.Struct({
  threadId: ThreadId,
  imported: Schema.Boolean,
});
export type AcpRegistryImportSessionResult = typeof AcpRegistryImportSessionResult.Type;

export const AcpRegistryDeleteSessionInput = Schema.Struct({
  instanceId: ProviderInstanceId,
  projectId: ProjectId,
  sessionId: AcpRegistrySessionId,
});
export type AcpRegistryDeleteSessionInput = typeof AcpRegistryDeleteSessionInput.Type;

export const AcpRegistryDeleteSessionResult = Schema.Struct({ deleted: Schema.Literal(true) });
export type AcpRegistryDeleteSessionResult = typeof AcpRegistryDeleteSessionResult.Type;

const AcpRegistryProviderId = TrimmedNonEmptyString.check(Schema.isMaxLength(256));
const AcpRegistryProviderProtocol = TrimmedNonEmptyString.check(Schema.isMaxLength(64));

export const AcpRegistryConfigurableProvider = Schema.Struct({
  providerId: AcpRegistryProviderId,
  supported: Schema.Array(AcpRegistryProviderProtocol).check(Schema.isMaxLength(16)),
  required: Schema.Boolean,
  current: Schema.NullOr(
    Schema.Struct({
      apiType: AcpRegistryProviderProtocol,
      baseUrl: AcpRegistryUrl,
    }),
  ),
});
export type AcpRegistryConfigurableProvider = typeof AcpRegistryConfigurableProvider.Type;

export const AcpRegistryListProvidersInput = Schema.Struct({
  instanceId: ProviderInstanceId,
  projectId: ProjectId,
});
export type AcpRegistryListProvidersInput = typeof AcpRegistryListProvidersInput.Type;

export const AcpRegistryListProvidersResult = Schema.Struct({
  providers: Schema.Array(AcpRegistryConfigurableProvider).check(Schema.isMaxLength(64)),
});
export type AcpRegistryListProvidersResult = typeof AcpRegistryListProvidersResult.Type;

export const AcpRegistrySetProviderInput = Schema.Struct({
  instanceId: ProviderInstanceId,
  projectId: ProjectId,
  providerId: AcpRegistryProviderId,
  apiType: AcpRegistryProviderProtocol,
  baseUrl: AcpRegistryUrl,
  // Write-only secrets. Provider list responses intentionally cannot carry headers.
  headers: Schema.optionalKey(
    Schema.Record(
      TrimmedNonEmptyString.check(Schema.isMaxLength(128)),
      Schema.String.check(Schema.isMaxLength(8_192)),
    ),
  ),
});
export type AcpRegistrySetProviderInput = typeof AcpRegistrySetProviderInput.Type;

export const AcpRegistrySetProviderResult = Schema.Struct({ configured: Schema.Literal(true) });
export type AcpRegistrySetProviderResult = typeof AcpRegistrySetProviderResult.Type;

export const AcpRegistryDisableProviderInput = Schema.Struct({
  instanceId: ProviderInstanceId,
  projectId: ProjectId,
  providerId: AcpRegistryProviderId,
});
export type AcpRegistryDisableProviderInput = typeof AcpRegistryDisableProviderInput.Type;

export const AcpRegistryDisableProviderResult = Schema.Struct({ disabled: Schema.Literal(true) });
export type AcpRegistryDisableProviderResult = typeof AcpRegistryDisableProviderResult.Type;

export const AcpRegistryLogoutInput = Schema.Struct({
  instanceId: ProviderInstanceId,
});
export type AcpRegistryLogoutInput = typeof AcpRegistryLogoutInput.Type;

export const AcpRegistryLogoutResult = Schema.Struct({
  loggedOut: Schema.Literal(true),
});
export type AcpRegistryLogoutResult = typeof AcpRegistryLogoutResult.Type;

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
  sessionManagement: Schema.Struct({
    canList: Schema.Boolean,
    canLoad: Schema.Boolean,
    canResume: Schema.Boolean,
    canLogout: Schema.Boolean,
    canDelete: Schema.Boolean,
    canConfigureProviders: Schema.Boolean,
  }).pipe(
    Schema.withDecodingDefault(
      Effect.succeed({
        canList: false,
        canLoad: false,
        canResume: false,
        canLogout: false,
        canDelete: false,
        canConfigureProviders: false,
      }),
    ),
  ),
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
  "instance_not_found",
  "logout_unsupported",
  "logout_failed",
  "probe_failed",
  "project_not_found",
  "registry_unavailable",
  "runner_unavailable",
  "session_import_failed",
  "session_delete_unsupported",
  "session_delete_failed",
  "session_list_unsupported",
  "session_resume_unsupported",
  "providers_unsupported",
  "providers_list_failed",
  "provider_configuration_failed",
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
    authAction: Schema.optionalKey(AcpRegistryUrlAuthAction),
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {}
