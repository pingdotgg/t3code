import { ClaudeSettings } from "@t3tools/contracts";
import {
  forkSession,
  query,
  type CanUseTool,
  type PermissionResult,
  type SDKAssistantMessage,
  type SDKMessage,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { SpawnExecutableResolution } from "@t3tools/shared/shell";
import {
  ProviderReplayEntry,
  type ModelSelection,
  type ProviderApprovalDecision,
  type ProviderReplayTranscript,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../../config.ts";
import {
  isWindowsClaudeLauncherShimPath,
  resolveClaudeSdkExecutablePath,
} from "../../provider/Drivers/ClaudeExecutable.ts";
import * as ClaudeAdapterV2 from "./ClaudeAdapterV2.ts";
import { claudeTaskOutputRoot } from "./ClaudeTaskOutputTail.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import { ProviderAdapterDriverCreateError } from "@t3tools/provider-core/server/adapterDriver";
import * as ProviderAdapterRegistry from "../ProviderAdapterRegistry.ts";
import { randomUuidV4 } from "@t3tools/provider-core/server/randomUuid";
import {
  makeReplayServerConfig,
  type OrchestratorV2ProviderReplayHarness,
} from "../testkit/ProviderReplayHarness.ts";
import type { ProviderReplayGate } from "@t3tools/provider-testing/replayGate";
import {
  CLAUDE_AGENT_SDK_REPLAY_PROTOCOL,
  ClaudeAgentSdkReplayError,
  ClaudeAgentSdkReplayTranscript,
  ClaudeOrchestratorReplayHarnessError,
  type ClaudePermissionRequestFrame,
  type ClaudeQueryRunner,
  ClaudeReplayDriverError,
  ClaudeReplayTranscriptDecodeError,
  DEFAULT_CLAUDE_SETTINGS,
  claudeBackgroundWakeResultLabel,
  makeClaudePermissionResponseFrame,
  makeClaudePromptOfferFrame,
  makeClaudeQueryOpenFrame,
} from "./ClaudeAdapterV2-part2.testkit.ts";
import { makeReplayQueryRunner } from "./ClaudeAdapterV2-part2b.testkit.ts";
export * from "./ClaudeAdapterV2-part2.testkit.ts";
export * from "./ClaudeAdapterV2-part2b.testkit.ts";

import {
  RecordingPromptQueue,
  openRecordingQuery,
  recordMessagesUntilIteratorDone,
  serializeReplayError,
} from "./ClaudeAdapterV2.testkit.ts";
import {
  recordClaudeStreamingQuery,
  recordClaudeActiveSteeringQuery,
  recordClaudeRestartingQueries,
} from "./ClaudeAdapterV2-part3.testkit.ts";
import {
  recordClaudeResumeAtCursorQuery,
  recordClaudeForkSessionQuery,
  recordInterruptedClaudeQuery,
} from "./ClaudeAdapterV2-part4.testkit.ts";

async function recordClaudeInterruptQuery(input: {
  readonly scenario: string;
  readonly prompts: ReadonlyArray<string>;
  readonly modelSelection: ModelSelection;
  readonly cwd: string;
  readonly sessionId: string;
  readonly entries: Array<ProviderReplayEntry>;
  readonly enableTools?: boolean;
  readonly tools?: ClaudeAdapterV2.ClaudeAgentSdkQueryTools;
  readonly permissionMode?: ClaudeAdapterV2.ClaudeAgentSdkQueryOptions["permissionMode"];
  readonly allowedTools?: ReadonlyArray<string>;
  readonly disallowedTools?: ReadonlyArray<string>;
  readonly allowDangerouslySkipPermissions?: boolean;
  readonly interruptAfter?: "prompt_offer" | "tool_use";
  readonly interruptAfterToolUses?: number;
}): Promise<void> {
  if (input.prompts.length !== 1) {
    throw new Error(
      `Claude interrupt replay scenario ${input.scenario} requires exactly one prompt.`,
    );
  }

  await recordInterruptedClaudeQuery({
    scenario: input.scenario,
    prompt: input.prompts[0]!,
    modelSelection: input.modelSelection,
    cwd: input.cwd,
    sessionId: input.sessionId,
    resume: false,
    entries: input.entries,
    queryOpenLabel: "query.open",
    promptOfferLabel: "prompt.offer:1",
    interruptLabel: "query.interrupt:1",
    ...(input.interruptAfter === undefined ? {} : { interruptAfter: input.interruptAfter }),
    ...(input.interruptAfterToolUses === undefined
      ? {}
      : { interruptAfterToolUses: input.interruptAfterToolUses }),
    ...(input.enableTools === undefined ? {} : { enableTools: input.enableTools }),
    ...(input.tools === undefined ? {} : { tools: input.tools }),
    ...(input.permissionMode === undefined ? {} : { permissionMode: input.permissionMode }),
    ...(input.allowedTools === undefined ? {} : { allowedTools: input.allowedTools }),
    ...(input.disallowedTools === undefined ? {} : { disallowedTools: input.disallowedTools }),
    ...(input.allowDangerouslySkipPermissions === undefined
      ? {}
      : { allowDangerouslySkipPermissions: input.allowDangerouslySkipPermissions }),
  });
}

async function recordClaudeInterruptRestartQuery(input: {
  readonly scenario: string;
  readonly prompts: ReadonlyArray<string>;
  readonly modelSelection: ModelSelection;
  readonly cwd: string;
  readonly sessionId: string;
  readonly entries: Array<ProviderReplayEntry>;
  readonly enableTools?: boolean;
  readonly tools?: ClaudeAdapterV2.ClaudeAgentSdkQueryTools;
  readonly permissionMode?: ClaudeAdapterV2.ClaudeAgentSdkQueryOptions["permissionMode"];
  readonly allowedTools?: ReadonlyArray<string>;
  readonly disallowedTools?: ReadonlyArray<string>;
  readonly allowDangerouslySkipPermissions?: boolean;
  readonly interruptAfter?: "prompt_offer" | "tool_use";
}): Promise<void> {
  if (input.prompts.length !== 2) {
    throw new Error(
      `Claude interrupt-restart replay scenario ${input.scenario} requires exactly two prompts.`,
    );
  }

  await recordInterruptedClaudeQuery({
    scenario: input.scenario,
    prompt: input.prompts[0]!,
    modelSelection: input.modelSelection,
    cwd: input.cwd,
    sessionId: input.sessionId,
    resume: false,
    entries: input.entries,
    queryOpenLabel: "query.open:1",
    promptOfferLabel: "prompt.offer:1",
    interruptLabel: "query.interrupt:1",
    ...(input.interruptAfter === undefined ? {} : { interruptAfter: input.interruptAfter }),
    ...(input.enableTools === undefined ? {} : { enableTools: input.enableTools }),
    ...(input.tools === undefined ? {} : { tools: input.tools }),
    ...(input.permissionMode === undefined ? {} : { permissionMode: input.permissionMode }),
    ...(input.allowedTools === undefined ? {} : { allowedTools: input.allowedTools }),
    ...(input.disallowedTools === undefined ? {} : { disallowedTools: input.disallowedTools }),
    ...(input.allowDangerouslySkipPermissions === undefined
      ? {}
      : { allowDangerouslySkipPermissions: input.allowDangerouslySkipPermissions }),
  });

  const secondPromptQueue = new RecordingPromptQueue();
  const secondOptions = ClaudeAdapterV2.makeClaudeQueryOptions({
    modelSelection: input.modelSelection,
    nativeThreadId: input.sessionId,
    resume: true,
    cwd: input.cwd,
    ...(input.enableTools === true
      ? {
          tools: input.tools ?? { type: "preset", preset: "claude_code" },
          permissionMode: input.permissionMode ?? "default",
          ...(input.allowedTools === undefined ? {} : { allowedTools: input.allowedTools }),
          ...(input.disallowedTools === undefined
            ? {}
            : { disallowedTools: input.disallowedTools }),
          ...(input.allowDangerouslySkipPermissions === true
            ? { allowDangerouslySkipPermissions: true }
            : {}),
        }
      : {}),
  });
  input.entries.push({
    type: "expect_outbound",
    label: "query.open:2",
    frame: makeClaudeQueryOpenFrame({ options: secondOptions }),
  });
  const secondMessage = ClaudeAdapterV2.makeClaudeUserMessage({ text: input.prompts[1]! });
  input.entries.push({
    type: "expect_outbound",
    label: "prompt.offer:2",
    frame: makeClaudePromptOfferFrame(secondMessage),
  });

  try {
    const secondRuntime = await openRecordingQuery({
      prompt: secondPromptQueue,
      options: secondOptions,
    });
    secondPromptQueue.offer(secondMessage);
    secondPromptQueue.close();
    const secondIterator = secondRuntime[Symbol.asyncIterator]();
    await recordMessagesUntilIteratorDone({
      iterator: secondIterator,
      entries: input.entries,
      scenario: input.scenario,
    });
    secondRuntime.close();
    input.entries.push({
      type: "runtime_exit",
      status: "success",
    });
  } catch (error) {
    secondPromptQueue.close();
    input.entries.push({
      type: "runtime_exit",
      status: "error",
      error: serializeReplayError(error, input.scenario),
    });
    throw error;
  }
}

export async function recordClaudeAgentSdkReplayTranscript(input: {
  readonly scenario: string;
  readonly prompts: ReadonlyArray<string>;
  readonly modelSelection: ModelSelection;
  readonly cwd: string;
  readonly sessionId?: string;
  readonly queryMode?:
    | "streaming"
    | "restart"
    | "resume_at_cursor"
    | "fork_session"
    | "fork_session_prior_turn"
    | "fork_session_merge_back_siblings"
    | "active_steering"
    | "interrupt"
    | "interrupt_restart";
  readonly enableTools?: boolean;
  readonly tools?: ClaudeAdapterV2.ClaudeAgentSdkQueryTools;
  readonly permissionMode?: ClaudeAdapterV2.ClaudeAgentSdkQueryOptions["permissionMode"];
  readonly allowedTools?: ReadonlyArray<string>;
  readonly disallowedTools?: ReadonlyArray<string>;
  readonly allowDangerouslySkipPermissions?: boolean;
  readonly enablePermissionCallback?: boolean;
  readonly permissionDecision?: ProviderApprovalDecision;
  readonly backgroundWakeCounts?: ReadonlyArray<number>;
  readonly offerNextPromptImmediately?: boolean;
  readonly interruptAfter?: "prompt_offer" | "tool_use";
  readonly interruptAfterToolUses?: number;
}): Promise<ClaudeAgentSdkReplayTranscript> {
  if (input.prompts.length === 0) {
    throw new Error(
      `Claude Agent SDK replay scenario ${input.scenario} needs at least one prompt.`,
    );
  }

  const entries: Array<ProviderReplayEntry> = [];
  const sessionId = input.sessionId ?? (await Effect.runPromise(randomUuidV4));
  const queryMode = input.queryMode ?? "streaming";
  const recordingMetadata: Record<string, unknown> = {};
  if (queryMode === "streaming") {
    await recordClaudeStreamingQuery({
      scenario: input.scenario,
      prompts: input.prompts,
      modelSelection: input.modelSelection,
      cwd: input.cwd,
      sessionId,
      entries,
      ...(input.enableTools === undefined ? {} : { enableTools: input.enableTools }),
      ...(input.tools === undefined ? {} : { tools: input.tools }),
      ...(input.permissionMode === undefined ? {} : { permissionMode: input.permissionMode }),
      ...(input.allowedTools === undefined ? {} : { allowedTools: input.allowedTools }),
      ...(input.disallowedTools === undefined ? {} : { disallowedTools: input.disallowedTools }),
      ...(input.allowDangerouslySkipPermissions === undefined
        ? {}
        : { allowDangerouslySkipPermissions: input.allowDangerouslySkipPermissions }),
      ...(input.enablePermissionCallback === undefined
        ? {}
        : { enablePermissionCallback: input.enablePermissionCallback }),
      ...(input.backgroundWakeCounts === undefined
        ? {}
        : { backgroundWakeCounts: input.backgroundWakeCounts }),
      ...(input.offerNextPromptImmediately === undefined
        ? {}
        : { offerNextPromptImmediately: input.offerNextPromptImmediately }),
      ...(input.permissionDecision === undefined
        ? {}
        : { permissionDecision: input.permissionDecision }),
    });
  } else if (queryMode === "active_steering") {
    await recordClaudeActiveSteeringQuery({
      scenario: input.scenario,
      prompts: input.prompts,
      modelSelection: input.modelSelection,
      cwd: input.cwd,
      sessionId,
      entries,
      ...(input.enableTools === undefined ? {} : { enableTools: input.enableTools }),
      ...(input.tools === undefined ? {} : { tools: input.tools }),
      ...(input.permissionMode === undefined ? {} : { permissionMode: input.permissionMode }),
      ...(input.allowedTools === undefined ? {} : { allowedTools: input.allowedTools }),
      ...(input.disallowedTools === undefined ? {} : { disallowedTools: input.disallowedTools }),
      ...(input.allowDangerouslySkipPermissions === undefined
        ? {}
        : { allowDangerouslySkipPermissions: input.allowDangerouslySkipPermissions }),
      ...(input.enablePermissionCallback === undefined
        ? {}
        : { enablePermissionCallback: input.enablePermissionCallback }),
      ...(input.permissionDecision === undefined
        ? {}
        : { permissionDecision: input.permissionDecision }),
    });
  } else if (queryMode === "restart") {
    await recordClaudeRestartingQueries({
      scenario: input.scenario,
      prompts: input.prompts,
      modelSelection: input.modelSelection,
      cwd: input.cwd,
      sessionId,
      entries,
      ...(input.enableTools === undefined ? {} : { enableTools: input.enableTools }),
      ...(input.tools === undefined ? {} : { tools: input.tools }),
      ...(input.permissionMode === undefined ? {} : { permissionMode: input.permissionMode }),
      ...(input.allowedTools === undefined ? {} : { allowedTools: input.allowedTools }),
      ...(input.disallowedTools === undefined ? {} : { disallowedTools: input.disallowedTools }),
      ...(input.allowDangerouslySkipPermissions === undefined
        ? {}
        : { allowDangerouslySkipPermissions: input.allowDangerouslySkipPermissions }),
    });
  } else if (queryMode === "resume_at_cursor") {
    await recordClaudeResumeAtCursorQuery({
      scenario: input.scenario,
      prompts: input.prompts,
      modelSelection: input.modelSelection,
      cwd: input.cwd,
      sessionId,
      entries,
      metadata: recordingMetadata,
      ...(input.enableTools === undefined ? {} : { enableTools: input.enableTools }),
      ...(input.tools === undefined ? {} : { tools: input.tools }),
      ...(input.permissionMode === undefined ? {} : { permissionMode: input.permissionMode }),
      ...(input.allowedTools === undefined ? {} : { allowedTools: input.allowedTools }),
      ...(input.disallowedTools === undefined ? {} : { disallowedTools: input.disallowedTools }),
      ...(input.allowDangerouslySkipPermissions === undefined
        ? {}
        : { allowDangerouslySkipPermissions: input.allowDangerouslySkipPermissions }),
    });
  } else if (
    queryMode === "fork_session" ||
    queryMode === "fork_session_prior_turn" ||
    queryMode === "fork_session_merge_back_siblings"
  ) {
    await recordClaudeForkSessionQuery({
      scenario: input.scenario,
      prompts: input.prompts,
      modelSelection: input.modelSelection,
      cwd: input.cwd,
      sessionId,
      entries,
      metadata: recordingMetadata,
      ...(queryMode === "fork_session_prior_turn" ? { forkFromPromptIndex: 1 as const } : {}),
      ...(queryMode === "fork_session_merge_back_siblings"
        ? {
            sourcePromptCount: 1,
            forkPromptGroups: [[input.prompts[1]!], [input.prompts[2]!]],
            sourceContinuationPromptCount: 3,
          }
        : {}),
      ...(input.enableTools === undefined ? {} : { enableTools: input.enableTools }),
      ...(input.tools === undefined ? {} : { tools: input.tools }),
      ...(input.permissionMode === undefined ? {} : { permissionMode: input.permissionMode }),
      ...(input.allowedTools === undefined ? {} : { allowedTools: input.allowedTools }),
      ...(input.disallowedTools === undefined ? {} : { disallowedTools: input.disallowedTools }),
      ...(input.allowDangerouslySkipPermissions === undefined
        ? {}
        : { allowDangerouslySkipPermissions: input.allowDangerouslySkipPermissions }),
    });
  } else if (queryMode === "interrupt") {
    await recordClaudeInterruptQuery({
      scenario: input.scenario,
      prompts: input.prompts,
      modelSelection: input.modelSelection,
      cwd: input.cwd,
      sessionId,
      entries,
      ...(input.enableTools === undefined ? {} : { enableTools: input.enableTools }),
      ...(input.tools === undefined ? {} : { tools: input.tools }),
      ...(input.permissionMode === undefined ? {} : { permissionMode: input.permissionMode }),
      ...(input.allowedTools === undefined ? {} : { allowedTools: input.allowedTools }),
      ...(input.disallowedTools === undefined ? {} : { disallowedTools: input.disallowedTools }),
      ...(input.allowDangerouslySkipPermissions === undefined
        ? {}
        : { allowDangerouslySkipPermissions: input.allowDangerouslySkipPermissions }),
      ...(input.interruptAfter === undefined ? {} : { interruptAfter: input.interruptAfter }),
      ...(input.interruptAfterToolUses === undefined
        ? {}
        : { interruptAfterToolUses: input.interruptAfterToolUses }),
    });
  } else {
    await recordClaudeInterruptRestartQuery({
      scenario: input.scenario,
      prompts: input.prompts,
      modelSelection: input.modelSelection,
      cwd: input.cwd,
      sessionId,
      entries,
      ...(input.enableTools === undefined ? {} : { enableTools: input.enableTools }),
      ...(input.tools === undefined ? {} : { tools: input.tools }),
      ...(input.permissionMode === undefined ? {} : { permissionMode: input.permissionMode }),
      ...(input.allowedTools === undefined ? {} : { allowedTools: input.allowedTools }),
      ...(input.disallowedTools === undefined ? {} : { disallowedTools: input.disallowedTools }),
      ...(input.allowDangerouslySkipPermissions === undefined
        ? {}
        : { allowDangerouslySkipPermissions: input.allowDangerouslySkipPermissions }),
      ...(input.interruptAfter === undefined ? {} : { interruptAfter: input.interruptAfter }),
    });
  }

  return {
    provider: ClaudeAdapterV2.CLAUDE_PROVIDER,
    protocol: CLAUDE_AGENT_SDK_REPLAY_PROTOCOL,
    version: "0.2.111",
    scenario: input.scenario,
    metadata: {
      prompts: [...input.prompts],
      model: input.modelSelection.model,
      nativeSessionId: sessionId,
      queryMode,
      tools: input.enableTools === true ? (input.tools ?? "claude_code") : "none",
      ...(input.permissionMode === undefined ? {} : { permissionMode: input.permissionMode }),
      ...(input.allowedTools === undefined ? {} : { allowedTools: input.allowedTools }),
      ...(input.disallowedTools === undefined ? {} : { disallowedTools: input.disallowedTools }),
      ...(input.enablePermissionCallback === undefined
        ? {}
        : { enablePermissionCallback: input.enablePermissionCallback }),
      ...(input.permissionDecision === undefined
        ? {}
        : { permissionDecision: input.permissionDecision }),
      ...(input.backgroundWakeCounts === undefined
        ? {}
        : { backgroundWakeCounts: [...input.backgroundWakeCounts] }),
      ...(input.offerNextPromptImmediately === true ? { offerNextPromptImmediately: true } : {}),
      ...(input.interruptAfter === undefined ? {} : { interruptAfter: input.interruptAfter }),
      ...(input.interruptAfterToolUses === undefined
        ? {}
        : { interruptAfterToolUses: input.interruptAfterToolUses }),
      generatedBy: "recordClaudeAgentSdkReplayTranscript",
      ...recordingMetadata,
    },
    entries,
  };
}

