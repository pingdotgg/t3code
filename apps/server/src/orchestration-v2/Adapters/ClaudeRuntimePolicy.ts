// @effect-diagnostics nodeBuiltinImport:off -- the SDK takes a Node ChildProcess for the CLI.
import type {
  Options as ClaudeQueryOptions,
  PermissionMode,
  Settings as ClaudeSdkSettings,
  SDKAssistantMessage,
} from "@anthropic-ai/claude-agent-sdk";

import { fromLenientJson } from "@t3tools/shared/schemaJson";

import * as Option from "effect/Option";

import * as Schema from "effect/Schema";

import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";

import { CLAUDE_READ_ONLY_ALLOWED_TOOLS } from "./ClaudeQueryRunnerTypes.ts";
import { jsonStringifyForTool } from "./ClaudeToolClassification.ts";
import type { ActiveClaudeTurnContext } from "./ClaudeAssistantArtifacts.ts";
import type { ClaudeAgentSdkQueryTools } from "./ClaudeQueryRunnerTypes.ts";
import type { ClaudeUserContentBlock } from "./ClaudeUserMessage.ts";

export type ClaudeAssistantContentBlock = SDKAssistantMessage["message"]["content"][number];
export type ClaudeToolUseContentBlock = Extract<
  ClaudeAssistantContentBlock,
  {
    readonly id: string;
    readonly name: string;
    readonly input: unknown;
  }
>;
export type ClaudeAssistantToolResultContentBlock = Extract<
  ClaudeAssistantContentBlock,
  {
    readonly tool_use_id: string;
  }
>;
export type ClaudeUserToolResultContentBlock = Extract<
  ClaudeUserContentBlock,
  {
    readonly tool_use_id: string;
  }
>;
export type ClaudeToolResultContentBlock =
  | ClaudeAssistantToolResultContentBlock
  | ClaudeUserToolResultContentBlock;
export type ClaudeTypedToolResultContentBlock = Exclude<
  ClaudeToolResultContentBlock,
  { readonly type: "mcp_tool_result" | "tool_result" }
>;
export type ClaudeTypedToolResultContent = ClaudeTypedToolResultContentBlock["content"];
export type ClaudeToolResultOutput =
  | Extract<ClaudeToolResultContentBlock, { readonly type: "tool_result" }>["content"]
  | Extract<ClaudeToolResultContentBlock, { readonly type: "mcp_tool_result" }>["content"]
  | ClaudeTypedToolResultContent;

export function assertNever(value: never): never {
  throw new Error(`Unhandled Claude SDK variant: ${jsonStringifyForTool(value)}`);
}

export const ClaudeRuntimeSandboxPolicyKind = Schema.Struct({
  type: Schema.Literals(["dangerFullAccess", "externalSandbox", "readOnly", "workspaceWrite"]),
});
export type ClaudeRuntimeSandboxPolicy = typeof ClaudeRuntimeSandboxPolicyKind.Type;
export type ClaudeRuntimeSandboxPolicyKindName = ClaudeRuntimeSandboxPolicy["type"];
export const isClaudeRuntimeSandboxPolicyKind = Schema.is(ClaudeRuntimeSandboxPolicyKind);

export const ClaudeRuntimeReadOnlyFullAccessSandboxPolicy = Schema.Struct({
  type: Schema.Literal("readOnly"),
  access: Schema.Struct({
    type: Schema.Literal("fullAccess"),
  }),
});
export const isClaudeRuntimeReadOnlyFullAccessSandboxPolicy = Schema.is(
  ClaudeRuntimeReadOnlyFullAccessSandboxPolicy,
);

export function sandboxPolicyKindForClaudeRuntimePolicy(
  runtimePolicy: ProviderAdapter.ProviderAdapterV2RuntimePolicy,
): ClaudeRuntimeSandboxPolicyKindName | undefined {
  return runtimePolicy.sandboxPolicy !== undefined &&
    isClaudeRuntimeSandboxPolicyKind(runtimePolicy.sandboxPolicy)
    ? runtimePolicy.sandboxPolicy.type
    : undefined;
}

export function readOnlyPolicyAllowsGlobalReads(
  runtimePolicy: ProviderAdapter.ProviderAdapterV2RuntimePolicy,
): boolean {
  return (
    runtimePolicy.sandboxPolicy !== undefined &&
    isClaudeRuntimeReadOnlyFullAccessSandboxPolicy(runtimePolicy.sandboxPolicy)
  );
}

export function permissionModeForClaudeRuntimePolicy(
  runtimePolicy: ProviderAdapter.ProviderAdapterV2RuntimePolicy,
): PermissionMode {
  if (runtimePolicy.interactionMode === "plan") {
    return "plan";
  }
  if (runtimePolicy.approvalPolicy === "never") {
    switch (sandboxPolicyKindForClaudeRuntimePolicy(runtimePolicy)) {
      case "readOnly":
        return "dontAsk";
      case "dangerFullAccess":
      case "externalSandbox":
        return "bypassPermissions";
      case "workspaceWrite":
      case undefined:
        return runtimePolicy.runtimeMode === "approval-required"
          ? "dontAsk"
          : runtimePolicy.runtimeMode === "auto-accept-edits"
            ? "acceptEdits"
            : "bypassPermissions";
    }
  }
  if (runtimePolicy.approvalPolicy !== undefined && runtimePolicy.approvalPolicy !== "never") {
    return "default";
  }

  switch (sandboxPolicyKindForClaudeRuntimePolicy(runtimePolicy)) {
    case "readOnly":
      return "dontAsk";
    case "dangerFullAccess":
      return runtimePolicy.runtimeMode === "approval-required" ? "default" : "bypassPermissions";
    case "externalSandbox":
    case "workspaceWrite":
    case undefined:
      break;
  }

  switch (runtimePolicy.runtimeMode) {
    case "approval-required":
      return "default";
    case "auto-accept-edits":
      return "acceptEdits";
    case "auto":
      return "auto";
    case "full-access":
      return "bypassPermissions";
  }
}

export interface ClaudeRuntimeQueryPolicy {
  readonly permissionMode: PermissionMode;
  readonly tools?: ClaudeAgentSdkQueryTools;
  readonly allowedTools?: ReadonlyArray<string>;
  readonly allowDangerouslySkipPermissions?: true;
  readonly installPermissionCallback: boolean;
}

export interface ClaudeBypassAvailability {
  readonly bypassDisabled: boolean;
  readonly autoDisabled: boolean;
}

export const CLAUDE_BYPASS_FULLY_AVAILABLE: ClaudeBypassAvailability = {
  bypassDisabled: false,
  autoDisabled: false,
};

export function claudeRuntimeQueryPolicyForRuntimePolicy(
  runtimePolicy: ProviderAdapter.ProviderAdapterV2RuntimePolicy,
  availability: ClaudeBypassAvailability = CLAUDE_BYPASS_FULLY_AVAILABLE,
): ClaudeRuntimeQueryPolicy {
  const requestedMode = permissionModeForClaudeRuntimePolicy(runtimePolicy);
  const downgraded = requestedMode === "bypassPermissions" && availability.bypassDisabled;
  const permissionMode = downgraded
    ? availability.autoDisabled
      ? "default"
      : "auto"
    : requestedMode;
  const readOnlyTools =
    sandboxPolicyKindForClaudeRuntimePolicy(runtimePolicy) === "readOnly"
      ? CLAUDE_READ_ONLY_ALLOWED_TOOLS
      : undefined;
  const allowedTools =
    readOnlyTools !== undefined && readOnlyPolicyAllowsGlobalReads(runtimePolicy)
      ? readOnlyTools
      : undefined;
  // acceptEdits approves edits before the callback; the callback must ask for everything else.
  const installPermissionCallback =
    downgraded ||
    (runtimePolicy.approvalPolicy === undefined
      ? runtimePolicy.runtimeMode === "approval-required" ||
        runtimePolicy.runtimeMode === "auto-accept-edits"
      : runtimePolicy.approvalPolicy !== "never");

  if (permissionMode === "plan") {
    return {
      permissionMode,
      ...(readOnlyTools === undefined ? {} : { tools: readOnlyTools }),
      ...(allowedTools === undefined ? {} : { allowedTools }),
      // Claude routes Plan-mode writes to the callback even in Auto or Full access.
      installPermissionCallback: true,
    };
  }

  return {
    permissionMode,
    ...(readOnlyTools === undefined ? {} : { tools: readOnlyTools }),
    ...(allowedTools === undefined ? {} : { allowedTools }),
    ...(permissionMode === "bypassPermissions" ? { allowDangerouslySkipPermissions: true } : {}),
    installPermissionCallback,
  };
}

export const ClaudeBypassSettings = Schema.StructWithRest(
  Schema.Struct({
    disableAutoMode: Schema.optionalKey(Schema.Literals(["disable", false])),
    permissions: Schema.optionalKey(
      Schema.StructWithRest(
        Schema.Struct({
          disableBypassPermissionsMode: Schema.optionalKey(Schema.Literals(["disable", false])),
          disableAutoMode: Schema.optionalKey(Schema.Literals(["disable", false])),
        }),
        [Schema.Record(Schema.String, Schema.Unknown)],
      ),
    ),
  }),
  [Schema.Record(Schema.String, Schema.Unknown)],
);
export const decodeClaudeBypassSettings = Schema.decodeUnknownEffect(
  fromLenientJson(ClaudeBypassSettings),
);
export const decodeClaudeLaunchArgBypassSettings = Schema.decodeUnknownEffect(ClaudeBypassSettings);

export function claudeSdkBypassSettings(settings: typeof ClaudeBypassSettings.Type) {
  const { disableAutoMode, permissions, ...rest } = settings;
  const {
    disableBypassPermissionsMode,
    disableAutoMode: nestedAutoMode,
    ...permissionRest
  } = permissions ?? {};
  return {
    ...rest,
    ...(disableAutoMode === "disable" ? { disableAutoMode } : {}),
    ...(permissions
      ? {
          permissions: {
            ...permissionRest,
            ...(disableBypassPermissionsMode === "disable" ? { disableBypassPermissionsMode } : {}),
            ...(nestedAutoMode === "disable" ? { disableAutoMode: nestedAutoMode } : {}),
          },
        }
      : {}),
  };
}

// --settings travels to the SDK as options.settings, whose type only allows "disable".
// Shapes the schema rejects keep their current pass-through; resolveBypassAvailability
// already treats them as a bypass failure.
export const decodeClaudeLaunchArgBypassSettingsOption =
  Schema.decodeUnknownOption(ClaudeBypassSettings);
export function claudeSdkLaunchArgSettings(settings: ClaudeSdkSettings): ClaudeSdkSettings {
  const decoded = decodeClaudeLaunchArgBypassSettingsOption(settings);
  return Option.isNone(decoded)
    ? settings
    : (claudeSdkBypassSettings(decoded.value) as ClaudeSdkSettings);
}

export const ClaudePromptCacheTtl = Schema.Literals(["5m", "1h"]);
export const decodeClaudePromptCacheTtl = Schema.decodeUnknownOption(ClaudePromptCacheTtl);
export const decodeClaudeSubagentCacheSettings = Schema.decodeUnknownEffect(
  fromLenientJson(
    Schema.StructWithRest(
      Schema.Struct({ subagentPromptCacheTtl: Schema.optionalKey(ClaudePromptCacheTtl) }),
      [Schema.Record(Schema.String, Schema.Unknown)],
    ),
  ),
);
export const decodeClaudeEnvSettings = Schema.decodeUnknownEffect(
  fromLenientJson(
    Schema.StructWithRest(
      Schema.Struct({ env: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)) }),
      [Schema.Record(Schema.String, Schema.Unknown)],
    ),
  ),
);

export function claudeBypassAvailability(
  settings: typeof ClaudeBypassSettings.Type,
): ClaudeBypassAvailability {
  return {
    bypassDisabled: settings.permissions?.disableBypassPermissionsMode === "disable",
    autoDisabled:
      settings.disableAutoMode === "disable" || settings.permissions?.disableAutoMode === "disable",
  };
}

export function requiresClaudeApproval(context: ActiveClaudeTurnContext): boolean {
  // CLI-forwarded requests need a person's decision even under bypass (ask rules,
  // safety checks, or settings fallback). Do not wait for queued init/status updates.
  const policy = context.queryPolicy;
  return policy.installPermissionCallback || policy.permissionMode === "bypassPermissions";
}

export function claudeRuntimeQueryPolicyKey(policy: ClaudeRuntimeQueryPolicy): string {
  return JSON.stringify({
    permissionMode: policy.permissionMode,
    tools: policy.tools,
    allowedTools: policy.allowedTools,
    allowDangerouslySkipPermissions: policy.allowDangerouslySkipPermissions,
    installPermissionCallback: policy.installPermissionCallback,
  });
}

// Live-query reuse must include MCP pre-approvals, which can differ for the same policy key.
export function claudeEffectiveQueryPolicyKey(
  queryPolicy: ClaudeRuntimeQueryPolicy,
  mcpOverrides: {
    readonly allowedTools?: ReadonlyArray<string>;
    readonly mcpServers?: ClaudeQueryOptions["mcpServers"];
  },
): string {
  return JSON.stringify({
    runtimePolicy: claudeRuntimeQueryPolicyKey({
      ...queryPolicy,
      ...(mcpOverrides.allowedTools === undefined
        ? {}
        : { allowedTools: mcpOverrides.allowedTools }),
    }),
    mcpServers: mcpOverrides.mcpServers,
  });
}
