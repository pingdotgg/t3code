// @effect-diagnostics nodeBuiltinImport:off -- the SDK takes a Node ChildProcess for the CLI.
import { text } from "../unknownField.ts";

import type {
  SpawnOptions as ClaudeSpawnOptions,
  SpawnedProcess as ClaudeSpawnedProcess,
} from "@anthropic-ai/claude-agent-sdk";

import * as NodeChildProcess from "node:child_process";

import { defaultInstanceIdForDriver, ProviderDriverKind } from "@t3tools/contracts";
import type { OrchestrationV2ProviderCapabilities } from "@t3tools/contracts";

import * as DateTime from "effect/DateTime";

import * as Duration from "effect/Duration";

import { signalProcessGroup } from "@t3tools/provider-core/server/processGroup";

export const CLAUDE_PROVIDER = ProviderDriverKind.make("claudeAgent");
export const CLAUDE_AGENT_SDK_QUERY_PROTOCOL = "claude-agent-sdk.query" as const;

export interface ClaudeCacheCreation {
  readonly ephemeral_1h_input_tokens: number;
  readonly ephemeral_5m_input_tokens: number;
}

export function claudePromptCacheTtlMs(
  cacheCreation: ClaudeCacheCreation | null | undefined,
): number | undefined {
  if (!cacheCreation) return undefined;
  if (cacheCreation.ephemeral_1h_input_tokens > 0) return 60 * 60_000;
  if (cacheCreation.ephemeral_5m_input_tokens > 0) return 5 * 60_000;
  return undefined;
}

// Claude caps the window at the model's context, so a setting at or above it never applies.
// Below that, Claude compacts 33,000 tokens short of the window: Claude Code 2.1.305's
// getContextUsage reports a 150,000 window as a 117,000 threshold, for every catalog model.
export const CLAUDE_AUTO_COMPACT_RESERVE_TOKENS = 33_000;

export function claudeAutoCompactThreshold(autoCompactWindow: string, maxTokens: number | null) {
  const windowTokens = Number(autoCompactWindow);
  return windowTokens > 0 && (maxTokens === null || windowTokens < maxTokens)
    ? { autoCompactThreshold: windowTokens - CLAUDE_AUTO_COMPACT_RESERVE_TOKENS }
    : {};
}

export function claudeMessageInputTokens(usage: {
  readonly input_tokens: number;
  readonly cache_creation_input_tokens?: number | null;
  readonly cache_read_input_tokens?: number | null;
}): number {
  return (
    usage.input_tokens +
    (usage.cache_creation_input_tokens ?? 0) +
    (usage.cache_read_input_tokens ?? 0)
  );
}

export function claudeProviderTurnTokenUsage(
  usage: {
    readonly input_tokens: number;
    readonly cache_creation_input_tokens?: number | null;
    readonly cache_read_input_tokens?: number | null;
    readonly cache_creation?: ClaudeCacheCreation | null;
    readonly output_tokens: number;
  },
  maxTokens: number | null,
  updatedAt: string,
  autoCompactWindow = "",
  requestedAt?: DateTime.Utc,
) {
  const inputTokens = claudeMessageInputTokens(usage);
  const outputTokens = usage.output_tokens;
  const promptCacheTtlMs = claudePromptCacheTtlMs(usage.cache_creation);
  // The cache lifetime starts with the request, not when its response ends.
  const promptCacheExpiresAt =
    promptCacheTtlMs === undefined || requestedAt === undefined
      ? undefined
      : DateTime.formatIso(DateTime.add(requestedAt, { milliseconds: promptCacheTtlMs }));
  return {
    usedTokens: inputTokens + outputTokens,
    maxTokens,
    inputTokens,
    cachedInputTokens: usage.cache_read_input_tokens ?? 0,
    outputTokens,
    reasoningOutputTokens: 0,
    ...(promptCacheTtlMs === undefined ? {} : { promptCacheTtlMs }),
    ...claudeAutoCompactThreshold(autoCompactWindow, maxTokens),
    ...(promptCacheExpiresAt === undefined ? {} : { promptCacheExpiresAt }),
    updatedAt,
  };
}

export type ClaudeMessageUsage = Parameters<typeof claudeProviderTurnTokenUsage>[0];

// message_delta usage is per-message cumulative; null or absent fields retain message_start values and zeros replace them.
export function mergeClaudeStreamUsage(
  current: ClaudeMessageUsage,
  delta: {
    readonly input_tokens?: number | null;
    readonly cache_creation_input_tokens?: number | null;
    readonly cache_read_input_tokens?: number | null;
    readonly output_tokens: number;
  },
): ClaudeMessageUsage {
  return {
    ...current,
    input_tokens: delta.input_tokens ?? current.input_tokens,
    cache_creation_input_tokens:
      delta.cache_creation_input_tokens ?? current.cache_creation_input_tokens ?? null,
    cache_read_input_tokens:
      delta.cache_read_input_tokens ?? current.cache_read_input_tokens ?? null,
    output_tokens: delta.output_tokens,
  };
}
export const CLAUDE_DEFAULT_INSTANCE_ID = defaultInstanceIdForDriver(CLAUDE_PROVIDER);
export const CLAUDE_SCRIPT_EXTENSIONS = [".js", ".mjs", ".tsx", ".ts", ".jsx"];
// The SDK has no control-request deadline; the CLI waits up to 30 s per MCP server.
export const CLAUDE_MCP_REGISTRATION_TIMEOUT = "90 seconds";
// Claude can consume a subagent result before the launching turn ends, leaving
// its notification with no native wake turn to answer the continuation.
export const CLAUDE_WAKE_TURN_START_DEADLINE = "2 minutes";
// Claude Code flushes transcript writes every 100 ms, so a workflow member's
// reply can land after the progress frame that settles it. Its transcript
// stays the source of its answer this long after it settles.
export const WORKFLOW_MEMBER_TRANSCRIPT_FLUSH_MS = 500;
// A steer waits at most this long, from its request, for its foreground
// subagents to move to the background before it is sent.
export const BACKGROUND_MOVE_TIMEOUT_MS = 5_000;
// How long a Stop waits for the CLI to exit before the user is offered Force stop.
export const CLAUDE_STOP_CONFIRM_TIMEOUT_MS = 10_000;
// Matches the stderr tail the SDK keeps for a CLI it spawns itself.
export const CLAUDE_STDERR_TAIL_LENGTH = 2_048;
// The process group is killed on exit, so its stderr closes promptly.
export const CLAUDE_STDERR_DRAIN_TIMEOUT = Duration.seconds(1);
// Claude Code's refusal of bypassPermissions as root, which it explains only on stderr.
export const CLAUDE_ROOT_REFUSAL =
  "--dangerously-skip-permissions cannot be used with root/sudo privileges for security reasons";

export const CLAUDE_GROUP_WATCH_SCRIPT = [
  "{ trap '' TERM; read -r _ <&3; kill -TERM 0; sleep 5; kill -KILL 0; } </dev/null >/dev/null 2>&1 &",
  'exec "$@" 3<&-',
].join("\n");

/**
 * Kill the CLI's group on exit to stop MCP grandchildren; `onExit` stops its agent scope for
 * setsid daemons. The CLI keeps working after its pipes close, so a watcher stops the group on
 * EOF from a pipe only this server holds, including when the server crashes.
 */
export function spawnClaudeProcessGroup(
  options: ClaudeSpawnOptions,
  onExit?: () => void,
  onStderr: (text: string) => void = () => {},
  onStderrClose: () => void = () => {},
): ClaudeSpawnedProcess {
  const child = NodeChildProcess.spawn(
    "/bin/sh",
    ["-c", CLAUDE_GROUP_WATCH_SCRIPT, "t3-claude", options.command, ...options.args],
    {
      cwd: options.cwd,
      env: options.env,
      signal: options.signal,
      stdio: ["pipe", "pipe", "pipe", "pipe"],
      detached: true,
    },
  );
  // Always drained, so a chatty CLI never blocks on a full stderr pipe.
  child.stderr?.setEncoding("utf8").on("data", onStderr).once("close", onStderrClose);
  child.once("exit", () => {
    try {
      signalProcessGroup(child.pid ?? 0, "SIGKILL");
    } catch {}
    onExit?.();
  });
  // Node's typings make stdin and stdout nullable once stdio has a fourth entry; both are pipes.
  return child as ClaudeSpawnedProcess;
}

export const ClaudeProviderCapabilitiesV2 = {
  sessions: {
    supportsMultipleProviderThreadsPerSession: false,
    supportsModelSwitchInSession: true,
    supportsProviderSwitchingViaHandoff: true,
    supportsRuntimeModeSwitchInSession: false,
    pendingRequestsSurviveRestart: false,
  },
  threads: {
    canCreateEmptyThread: true,
    canReadThreadSnapshot: false,
    canRollbackThread: true,
    canForkThread: true,
    canForkFromTurn: true,
    canForkFromSubagentThread: false,
    exposesNativeThreadId: true,
  },
  turns: {
    exposesNativeTurnId: false,
    emitsTurnStarted: true,
    emitsTurnCompleted: true,
    supportsInterrupt: true,
    supportsActiveSteering: true,
    activeSteeringInterruptsTools: true,
    supportsSteeringByInterruptRestart: false,
    supportsQueuedMessages: true,
    terminalStatusQuality: "strong",
  },
  streaming: {
    streamsAssistantText: true,
    streamsReasoning: true,
    streamsToolOutput: false,
    streamsPlanText: false,
    emitsMessageCompleted: true,
  },
  tools: {
    exposesToolItemIds: true,
    emitsToolStarted: true,
    emitsToolCompleted: true,
    emitsToolOutput: true,
    supportsMcpTools: true,
    supportsDynamicToolCallbacks: true,
  },
  approvals: {
    supportsCommandApproval: true,
    supportsFileReadApproval: true,
    supportsFileChangeApproval: true,
    supportsApplyPatchApproval: false,
    approvalsHaveNativeRequestIds: true,
    approvalCallbacksAreLiveOnly: true,
    approvalsCanOriginateFromSubagents: false,
  },
  planning: {
    emitsPlanUpdated: true,
    emitsTodoList: true,
    emitsProposedPlan: true,
    supportsStructuredQuestions: true,
    planDeltasHaveItemIds: false,
  },
  subagents: {
    supportsSubagents: true,
    exposesSubagentThreadIds: false,
    emitsSubagentLifecycle: true,
    canWaitForSubagents: false,
    canCloseSubagents: false,
    canForkSubagentThread: false,
  },
  context: {
    acceptsSystemContext: true,
    acceptsDeveloperContext: true,
    acceptsSyntheticUserContext: true,
    canGenerateSummaries: true,
    canConsumeHandoffSummaries: true,
    supportsDeltaHandoff: true,
    supportsFullThreadHandoff: true,
    maxRecommendedHandoffChars: null,
  },
  checkpointing: {
    appCanCheckpointFilesystem: true,
    supportsNestedCheckpointScopes: true,
    providerCanRollbackConversation: true,
    providerRollbackReturnsSnapshot: true,
    providerCanReadConversationSnapshot: false,
  },
  identity: {
    nativeThreadIds: "strong",
    nativeTurnIds: "weak",
    nativeItemIds: "strong",
    nativeRequestIds: "strong",
  },
  runtimePolicy: {
    enforcement: "native",
  },
} satisfies OrchestrationV2ProviderCapabilities;
