import * as Schema from "effect/Schema";

import { EnvironmentId, IsoDateTime, NonNegativeInt } from "./baseSchemas.ts";
import { ExecutionEnvironmentPlatform, ThreadEnvMode } from "./environment.ts";
import { ProviderDriverKind, ProviderInstanceId } from "./providerInstance.ts";
import {
  BackgroundActivityProfile,
  BackgroundActivityProfileSelection,
  SourceControlWritingStyleMode,
} from "./settings.ts";
import {
  ServerProviderAuthStatus,
  ServerProviderAvailability,
  ServerProviderState,
} from "./server.ts";

export const ENVIRONMENT_MCP_DEFAULT_PROVIDER_LIMIT = 20;
export const ENVIRONMENT_MCP_MAX_PROVIDER_LIMIT = 32;
export const ENVIRONMENT_MCP_MAX_DIAGNOSTIC_CHARACTERS = 256;
export const ENVIRONMENT_MCP_MAX_WRITING_INSTRUCTIONS = 4_000;

export const EnvironmentMcpReadInput = Schema.Struct({
  providerCursor: Schema.optional(
    Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)).annotate({
      description: "Zero-based provider page offset. Defaults to 0.",
    }),
  ),
  providerLimit: Schema.optional(
    Schema.Int.check(
      Schema.isGreaterThanOrEqualTo(1),
      Schema.isLessThanOrEqualTo(ENVIRONMENT_MCP_MAX_PROVIDER_LIMIT),
    ).annotate({
      description: `Provider page size. Defaults to ${ENVIRONMENT_MCP_DEFAULT_PROVIDER_LIMIT}; maximum ${ENVIRONMENT_MCP_MAX_PROVIDER_LIMIT}.`,
    }),
  ),
});
export type EnvironmentMcpReadInput = typeof EnvironmentMcpReadInput.Type;

export const EnvironmentMcpSafeCapabilities = Schema.Struct({
  repositoryIdentity: Schema.Boolean,
  connectionProbe: Schema.Boolean,
  attachmentUploads: Schema.Boolean,
  fileAttachmentMaxUploadBytes: Schema.NullOr(Schema.Int),
  pullRequests: Schema.Boolean,
  threadSettlement: Schema.Boolean,
  threadSnooze: Schema.Boolean,
  environmentThemes: Schema.Boolean,
  threadPinning: Schema.Boolean,
  threadPinReorder: Schema.Boolean,
  threadTitleRegeneration: Schema.Boolean,
  threadVisitedTracking: Schema.Boolean,
  threadPullRequestLinking: Schema.Boolean,
});

export const EnvironmentMcpProviderSummary = Schema.Struct({
  instanceId: ProviderInstanceId,
  driver: ProviderDriverKind,
  displayName: Schema.NullOr(
    Schema.Struct({
      text: Schema.String,
      characters: NonNegativeInt,
      maximumCharacters: NonNegativeInt,
      truncated: Schema.Boolean,
    }),
  ),
  availability: ServerProviderAvailability,
  enabled: Schema.Boolean,
  installed: Schema.Boolean,
  state: ServerProviderState,
  authStatus: ServerProviderAuthStatus,
  version: Schema.NullOr(
    Schema.Struct({
      text: Schema.String,
      characters: NonNegativeInt,
      maximumCharacters: NonNegativeInt,
      truncated: Schema.Boolean,
    }),
  ),
  checkedAt: IsoDateTime,
  modelCount: NonNegativeInt,
  supportsInteractionMode: Schema.Boolean,
  requiresNewThreadForModelChange: Schema.Boolean,
});

export const EnvironmentMcpProviderHealth = Schema.Struct({
  status: Schema.Literals(["empty", "healthy", "degraded", "unavailable"]),
  total: NonNegativeInt,
  ready: NonNegativeInt,
  warning: NonNegativeInt,
  error: NonNegativeInt,
  disabled: NonNegativeInt,
  unavailable: NonNegativeInt,
  usable: NonNegativeInt,
});

export const EnvironmentMcpTextWindow = Schema.Struct({
  // Service producers bound this by Unicode code points. A UTF-16 length
  // check here would reject valid astral characters within that limit.
  text: Schema.String,
  characters: NonNegativeInt,
  maximumCharacters: NonNegativeInt,
  truncated: Schema.Boolean,
});

export const EnvironmentMcpPreferences = Schema.Struct({
  defaultThreadEnvMode: ThreadEnvMode,
  newWorktreesStartFromOrigin: Schema.Boolean,
  enableProviderUpdateChecks: Schema.Boolean,
  backgroundActivity: Schema.Struct({
    profile: BackgroundActivityProfileSelection,
    baseProfile: Schema.NullOr(BackgroundActivityProfile),
  }),
  sourceControlWritingStyle: Schema.Struct({
    mode: SourceControlWritingStyleMode,
    customInstructions: EnvironmentMcpTextWindow,
    followChangeRequestTemplates: Schema.Boolean,
  }),
});
export type EnvironmentMcpPreferences = typeof EnvironmentMcpPreferences.Type;

export const EnvironmentMcpReadResult = Schema.Struct({
  identity: Schema.Struct({
    environmentId: EnvironmentId,
    label: EnvironmentMcpTextWindow,
    platform: ExecutionEnvironmentPlatform,
    serverVersion: EnvironmentMcpTextWindow,
  }),
  capabilities: EnvironmentMcpSafeCapabilities,
  providerHealth: EnvironmentMcpProviderHealth,
  providers: Schema.Array(EnvironmentMcpProviderSummary),
  providerNextCursor: Schema.NullOr(NonNegativeInt),
  providerTotal: NonNegativeInt,
  preferences: EnvironmentMcpPreferences,
  preferenceScope: Schema.Literal("server_owned"),
});
export type EnvironmentMcpReadResult = typeof EnvironmentMcpReadResult.Type;

export class EnvironmentMcpFailure extends Schema.TaggedErrorClass<EnvironmentMcpFailure>()(
  "EnvironmentMcpFailure",
  {
    code: Schema.Literals([
      "capability_denied",
      "environment_unavailable",
      "provider_registry_unavailable",
      "settings_unavailable",
      "operation_failed",
    ]),
    message: Schema.String,
  },
) {}
