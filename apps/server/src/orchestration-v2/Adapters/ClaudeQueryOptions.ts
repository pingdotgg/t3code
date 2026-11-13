// @effect-diagnostics nodeBuiltinImport:off -- the SDK takes a Node ChildProcess for the CLI.
import { text } from "../unknownField.ts";

import type {
  CanUseTool,
  EffortLevel,
  HookCallback,
  Options as ClaudeQueryOptions,
  PermissionMode,
  Query as ClaudeQuery,
  Settings as ClaudeSdkSettings,
} from "@anthropic-ai/claude-agent-sdk";

import { parseCliArgs } from "@t3tools/shared/cliArgs";

import { ClaudeSettings } from "@t3tools/contracts";
import type { ModelSelection, OrchestrationV2AppThread } from "@t3tools/contracts";

import { claudeLaunchArgDirectories } from "../../provider/Drivers/ClaudeSkills.ts";

import { compileClaudeModelSelection } from "../../claudeModelOptions.ts";
import type { CompiledClaudeModelSelection } from "../../claudeModelOptions.ts";

import {
  T3_CODE_DEVICE_TOOL_INSTRUCTIONS_WITH_TOOL_SEARCH,
  T3_CODE_ORCHESTRATION_INSTRUCTIONS,
} from "@t3tools/provider-core/server/orchestrationInstructions";

import { buildRuntimeInstructions } from "@t3tools/provider-core/server/runtimeInstructions";

import { CLAUDE_CODE_PRESET_TOOLS } from "./ClaudeQueryRunnerTypes.ts";
import { claudeAgentSdkQueryToolsForSdk } from "./ClaudeQueryRunnerTypes.ts";
import type { ClaudeAgentSdkQueryOptions } from "./ClaudeQueryRunnerTypes.ts";
import type { ClaudeAgentSdkQueryTools } from "./ClaudeQueryRunnerTypes.ts";
import type { ClaudeAgentSdkThreadIdentity } from "./ClaudeQueryRunnerTypes.ts";

export type ClaudeFlagSettings = Parameters<ClaudeQuery["applyFlagSettings"]>[0];

/** Thinking requires a new process. Clearing effort also requires one to reload user settings instead of model defaults. */
export function canApplyClaudeSelectionLive(
  live: CompiledClaudeModelSelection,
  next: CompiledClaudeModelSelection,
): boolean {
  return (
    live.settings.alwaysThinkingEnabled === next.settings.alwaysThinkingEnabled &&
    (next.effort !== undefined || live.effort === undefined)
  );
}

export function claudeLiveSelectionFlagSettings(
  selection: CompiledClaudeModelSelection,
): ClaudeFlagSettings {
  return {
    ...(selection.effort === undefined ? {} : { effortLevel: selection.effort as EffortLevel }),
    fastMode: selection.settings.fastMode ?? null,
    ultracode: selection.settings.ultracode ?? null,
  };
}

// A delegated child is its own SDK session, so Claude Code gives it the main-conversation cache
// TTL. When the user sets Claude's subagentPromptCacheTtl, the child follows it like a native
// subagent would. An explicit CLAUDE_CODE_PROMPT_CACHE_TTL on the instance still wins.
export function claudeQueryEnvironment(
  environment: NodeJS.ProcessEnv,
  appThread: Pick<OrchestrationV2AppThread, "lineage">,
  subagentPromptCacheTtl: "5m" | "1h" | undefined,
): NodeJS.ProcessEnv {
  if (
    appThread.lineage.relationshipToParent !== "subagent" ||
    subagentPromptCacheTtl === undefined ||
    environment.CLAUDE_CODE_PROMPT_CACHE_TTL !== undefined
  ) {
    return environment;
  }
  return { ...environment, CLAUDE_CODE_PROMPT_CACHE_TTL: subagentPromptCacheTtl };
}

// Claude Code's auto tool search sends every MCP schema in full while they fit under a share of the
// context window, which T3's tools do on 1M models. auto:0 already means on and auto:100 off.
export function claudeToolSearchOverride(value: string | undefined): "true" | undefined {
  if (value === undefined) return undefined;
  if (value === "auto") return "true";
  if (!value.startsWith("auto:")) return undefined;
  const percent = parseClaudeInteger(value.slice("auto:".length));
  // Claude Code treats an unparsable auto:N as auto, and clamps N to 0..100.
  if (Number.isNaN(percent)) return "true";
  const clamped = Math.min(100, Math.max(0, percent));
  return clamped > 0 && clamped < 100 ? "true" : undefined;
}

// Claude Code 2.1.310's integer parsing for auto:N. Scientific notation counts only when it is an
// integer, grouped digits (1_000, 1,000, or 1 000) are joined, and anything else uses parseInt.
export const CLAUDE_SCIENTIFIC_INTEGER = /^[+-]?(\d+(\.\d*)?|\.\d+)[eE][+-]?\d+$/;
export const CLAUDE_GROUPED_INTEGER = /^[+-]?\d{1,3}([_,\u00A0\u202F ])\d{3}(?:\1\d{3})*$/;
export function parseClaudeInteger(text: string): number {
  const value = text.trim();
  if (value.length <= 32 && CLAUDE_SCIENTIFIC_INTEGER.test(value)) {
    const number = Number(value);
    return Number.isInteger(number) ? number : Number.NaN;
  }
  if (value.length <= 32 && CLAUDE_GROUPED_INTEGER.test(value)) {
    return Number.parseInt(value.replace(/[_,\u00A0\u202F ]/g, ""), 10);
  }
  return Number.parseInt(value, 10);
}

// Claude Code defers MCP tools behind ToolSearch, so the agent only finds
// t3_background_wait when the system prompt says when to reach for it.
export const CLAUDE_BACKGROUND_WAIT_INSTRUCTIONS = `

### Background work you wait on

To wait for a background command or Monitor you started (tests, a build), call \`t3_background_wait\` with its task ID before you end your turn. Do not mark work you leave running, or PRs. T3 MCP tools are deferred: load one with ToolSearch before you call it.
`;

// Native subagents start from their task, not this session's system prompt.
export const subagentDeviceInstructions: HookCallback = () =>
  Promise.resolve({
    hookSpecificOutput: {
      hookEventName: "SubagentStart",
      additionalContext: T3_CODE_DEVICE_TOOL_INSTRUCTIONS_WITH_TOOL_SEARCH,
    },
  });

export function makeClaudeQueryOptions(input: {
  readonly modelSelection: ModelSelection;
  readonly nativeThreadId: string;
  readonly title?: string;
  readonly resume: boolean;
  readonly resumeSessionAt?: string;
  readonly cwd: string | null;
  readonly attachmentsDir?: string;
  readonly settings?: ClaudeSettings;
  readonly sdkSettings?: string | ClaudeSdkSettings;
  readonly environment?: NodeJS.ProcessEnv;
  readonly mcpServers?: ClaudeQueryOptions["mcpServers"];
  /** The thread's T3 MCP session holds the `device` capability. */
  readonly deviceToolsAvailable?: boolean;
  readonly tools?: ClaudeAgentSdkQueryTools;
  readonly allowedTools?: ReadonlyArray<string>;
  readonly disallowedTools?: ReadonlyArray<string>;
  readonly permissionMode?: PermissionMode;
  readonly canUseTool?: CanUseTool;
  readonly onUserDialog?: ClaudeQueryOptions["onUserDialog"];
  readonly onElicitation?: ClaudeQueryOptions["onElicitation"];
  readonly supportedDialogKinds?: ClaudeQueryOptions["supportedDialogKinds"];
  readonly allowDangerouslySkipPermissions?: boolean;
  readonly appendSystemPromptFileText?: string;
  // Flag settings, because a user's settings.json env beats the process env in Claude Code.
  readonly toolSearchOverride?: "true";
}): ClaudeAgentSdkQueryOptions {
  const compiledSelection = compileClaudeModelSelection(input.modelSelection);
  const {
    // claudeLaunchArgDirectories reads every --add-dir into additionalDirectories.
    "add-dir": _launchArgAddDir,
    "permission-mode": launchArgPermissionMode,
    "dangerously-skip-permissions": launchArgSkipPermissions,
    "append-system-prompt": launchArgAppendSystemPrompt,
    "append-system-prompt-file": _launchArgAppendSystemPromptFile,
    // The SDK replaces this flag with options.settings, so it arrives read as sdkSettings.
    settings: _launchArgSettings,
    ...extraArgs
  } = input.settings === undefined ? {} : parseCliArgs(input.settings.launchArgs).flags;
  // Claude Code overwrites its CLI append text with the SDK's initialize
  // appendSystemPrompt, so launch-argument text has to travel in that value.
  // The CLI puts file text before inline text and trims one trailing newline.
  const launchAppendSystemPrompt = [
    input.appendSystemPromptFileText?.replace(/\r?\n$/, ""),
    launchArgAppendSystemPrompt,
  ].filter((text): text is string => typeof text === "string" && text.length > 0);
  const requestThinkingSummaries =
    compiledSelection.settings.alwaysThinkingEnabled !== false &&
    extraArgs["thinking-display"] !== "omitted";
  if (requestThinkingSummaries && extraArgs["thinking-display"] === undefined) {
    extraArgs["thinking-display"] = "summarized";
  }
  const threadIdentity: ClaudeAgentSdkThreadIdentity = input.resume
    ? { resume: input.nativeThreadId }
    : { sessionId: input.nativeThreadId };
  const selectedTools = input.tools ?? CLAUDE_CODE_PRESET_TOOLS;
  const selectionSettings =
    Object.keys(compiledSelection.settings).length === 0
      ? undefined
      : (compiledSelection.settings as ClaudeSdkSettings);
  const querySettings =
    selectionSettings === undefined
      ? input.sdkSettings
      : typeof input.sdkSettings === "object" && input.sdkSettings !== null
        ? ({ ...input.sdkSettings, ...selectionSettings } as ClaudeSdkSettings)
        : selectionSettings;
  const compactQuerySettings =
    input.settings?.autoCompactWindow === undefined || input.settings.autoCompactWindow.length === 0
      ? querySettings
      : ({
          ...(typeof querySettings === "object" && querySettings !== null ? querySettings : {}),
          autoCompactWindow: Number(input.settings.autoCompactWindow),
        } as ClaudeSdkSettings);
  // A settings file path cannot take extra keys, so it goes through unchanged.
  const effectiveQuerySettings =
    input.toolSearchOverride === undefined || typeof compactQuerySettings === "string"
      ? compactQuerySettings
      : ({
          ...compactQuerySettings,
          env: { ...compactQuerySettings?.env, ENABLE_TOOL_SEARCH: input.toolSearchOverride },
        } as ClaudeSdkSettings);
  const deviceInstructions = input.mcpServers !== undefined && input.deviceToolsAvailable === true;
  const options: ClaudeAgentSdkQueryOptions = {
    model: compiledSelection.apiModelId,
    // T3 names threads; a supplied title skips Claude's redundant naming request.
    ...(input.title === undefined ? {} : { title: input.title }),
    tools: claudeAgentSdkQueryToolsForSdk(selectedTools),
    permissionMode:
      (launchArgPermissionMode as PermissionMode | null | undefined) ??
      (launchArgSkipPermissions === null || launchArgSkipPermissions === "true"
        ? "bypassPermissions"
        : (input.permissionMode ?? "default")),
    includePartialMessages: true,
    ...(compiledSelection.effort === undefined
      ? {}
      : {
          effort: compiledSelection.effort as NonNullable<ClaudeQueryOptions["effort"]>,
        }),
    ...threadIdentity,
    ...(input.resumeSessionAt === undefined ? {} : { resumeSessionAt: input.resumeSessionAt }),
    ...(input.allowedTools === undefined ? {} : { allowedTools: [...input.allowedTools] }),
    ...(input.disallowedTools === undefined ? {} : { disallowedTools: [...input.disallowedTools] }),
    ...(input.canUseTool === undefined ? {} : { canUseTool: input.canUseTool }),
    ...(input.allowDangerouslySkipPermissions === true
      ? { allowDangerouslySkipPermissions: true }
      : {}),
    ...(requestThinkingSummaries
      ? {
          thinking: { type: "adaptive" as const, display: "summarized" as const },
          settings:
            typeof effectiveQuerySettings === "string"
              ? effectiveQuerySettings
              : {
                  ...effectiveQuerySettings,
                  showThinkingSummaries: true,
                },
        }
      : effectiveQuerySettings === undefined
        ? {}
        : { settings: effectiveQuerySettings }),
    ...(input.onUserDialog === undefined ? {} : { onUserDialog: input.onUserDialog }),
    ...(input.onElicitation === undefined ? {} : { onElicitation: input.onElicitation }),
    ...(input.supportedDialogKinds === undefined
      ? {}
      : { supportedDialogKinds: input.supportedDialogKinds }),
    ...(input.settings?.binaryPath
      ? { pathToClaudeCodeExecutable: input.settings.binaryPath }
      : {}),
    ...(input.environment === undefined ? {} : { env: input.environment }),
    ...(input.mcpServers === undefined ? {} : { mcpServers: input.mcpServers }),
    systemPrompt: {
      type: "preset" as const,
      preset: "claude_code" as const,
      append: [
        buildRuntimeInstructions({ harness: "Claude Code" }) +
          (input.mcpServers === undefined
            ? ""
            : T3_CODE_ORCHESTRATION_INSTRUCTIONS +
              CLAUDE_BACKGROUND_WAIT_INSTRUCTIONS +
              (deviceInstructions
                ? `\n${T3_CODE_DEVICE_TOOL_INSTRUCTIONS_WITH_TOOL_SEARCH}\n`
                : "")),
        ...launchAppendSystemPrompt,
      ].join("\n\n"),
    },
    ...(deviceInstructions
      ? { hooks: { SubagentStart: [{ hooks: [subagentDeviceInstructions] }] } }
      : {}),
    ...(Object.keys(extraArgs).length === 0 ? {} : { extraArgs }),
  };
  const additionalDirectories = [
    ...(input.cwd === null ? [] : [input.cwd]),
    ...(input.attachmentsDir === undefined ? [] : [input.attachmentsDir]),
    ...claudeLaunchArgDirectories(input.settings?.launchArgs),
  ];
  const withDirectories =
    additionalDirectories.length === 0 ? options : { ...options, additionalDirectories };
  return input.cwd === null ? withDirectories : { ...withDirectories, cwd: input.cwd };
}

/**
 * Checks the append launch arguments the way the Claude CLI would and reads
 * the file relative to the process cwd. makeClaudeQueryOptions folds these
 * flags out of extraArgs, so a value the CLI would have rejected has to be
 * rejected here or it silently disappears.
 */
