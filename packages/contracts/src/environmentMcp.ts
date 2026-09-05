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

const EnvironmentMcpWritingInstructions = Schema.String.check(
  Schema.makeFilter((value) =>
    Array.from(value).length <= ENVIRONMENT_MCP_MAX_WRITING_INSTRUCTIONS
      ? undefined
      : `customInstructions must not exceed ${ENVIRONMENT_MCP_MAX_WRITING_INSTRUCTIONS} Unicode characters.`,
  ),
);

export const EnvironmentMcpPreferencesUpdateInput = Schema.Struct({
  defaultThreadEnvMode: Schema.optional(ThreadEnvMode).annotate({
    description: "Default execution environment for newly created threads.",
  }),
  newWorktreesStartFromOrigin: Schema.optional(Schema.Boolean).annotate({
    description: "Whether newly created worktrees start from the configured origin branch.",
  }),
  enableProviderUpdateChecks: Schema.optional(Schema.Boolean).annotate({
    description: "Whether the server performs its existing provider update checks.",
  }),
  backgroundActivity: Schema.optional(
    Schema.Struct({
      profile: BackgroundActivityProfile.annotate({
        description:
          "Apply one supported background-activity preset through the existing settings normalization path.",
      }),
    }),
  ),
  sourceControlWritingStyle: Schema.optional(
    Schema.Struct({
      mode: Schema.optional(SourceControlWritingStyleMode),
      customInstructions: Schema.optional(EnvironmentMcpWritingInstructions).annotate({
        description: `Replacement custom instructions, bounded to ${ENVIRONMENT_MCP_MAX_WRITING_INSTRUCTIONS} Unicode characters. An empty string clears them.`,
      }),
      followChangeRequestTemplates: Schema.optional(Schema.Boolean),
    }).check(
      Schema.makeFilter((value) =>
        value.mode !== undefined ||
        value.customInstructions !== undefined ||
        value.followChangeRequestTemplates !== undefined
          ? undefined
          : "sourceControlWritingStyle must include at least one field.",
      ),
    ),
  ),
}).check(
  Schema.makeFilter((value) =>
    value.defaultThreadEnvMode !== undefined ||
    value.newWorktreesStartFromOrigin !== undefined ||
    value.enableProviderUpdateChecks !== undefined ||
    value.backgroundActivity !== undefined ||
    value.sourceControlWritingStyle !== undefined
      ? undefined
      : "Provide at least one preference field.",
  ),
);
export type EnvironmentMcpPreferencesUpdateInput = typeof EnvironmentMcpPreferencesUpdateInput.Type;

export const EnvironmentMcpPreferencesUpdateResult = Schema.Struct({
  preferences: EnvironmentMcpPreferences,
});
export type EnvironmentMcpPreferencesUpdateResult =
  typeof EnvironmentMcpPreferencesUpdateResult.Type;

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
      "environment_mismatch",
      "provider_registry_unavailable",
      "settings_unavailable",
      "thread_not_found",
      "permission_denied",
      "operation_failed",
    ]),
  },
) {
  override get message(): string {
    switch (this.code) {
      case "capability_denied":
        return "This MCP credential does not grant environment capabilities.";
      case "environment_unavailable":
        return "The current environment service is unavailable.";
      case "environment_mismatch":
        return "The MCP credential does not belong to the running environment.";
      case "provider_registry_unavailable":
        return "The provider registry is unavailable.";
      case "settings_unavailable":
        return "Server-owned preferences are unavailable.";
      case "thread_not_found":
        return "The calling thread was not found.";
      case "permission_denied":
        return "Environment preference updates require a full-access caller with default interaction mode.";
      case "operation_failed":
        return "The environment operation failed.";
    }
  }
}
