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
  recordMessagesUntilToolUse,
  recordMessagesUntilTurnResult,
  recordMessagesUntilTurnResultAndFinalize,
  recordMessagesUntilTurnResultWithCursor,
  requireAssistantCursor,
  sanitizedReplayCwd,
  serializeReplayError,
} from "./ClaudeAdapterV2.testkit.ts";

export async function recordClaudeResumeAtCursorQuery(input: {
  readonly scenario: string;
  readonly prompts: ReadonlyArray<string>;
  readonly modelSelection: ModelSelection;
  readonly cwd: string;
  readonly sessionId: string;
  readonly entries: Array<ProviderReplayEntry>;
  readonly metadata: Record<string, unknown>;
  readonly enableTools?: boolean;
  readonly tools?: ClaudeAdapterV2.ClaudeAgentSdkQueryTools;
  readonly permissionMode?: ClaudeAdapterV2.ClaudeAgentSdkQueryOptions["permissionMode"];
  readonly allowedTools?: ReadonlyArray<string>;
  readonly disallowedTools?: ReadonlyArray<string>;
  readonly allowDangerouslySkipPermissions?: boolean;
}): Promise<void> {
  if (input.prompts.length !== 3) {
    throw new Error(
      `Claude resume-at-cursor replay scenario ${input.scenario} requires exactly three prompts.`,
    );
  }

  const sourcePromptQueue = new RecordingPromptQueue();
  const sourceOptions = ClaudeAdapterV2.makeClaudeQueryOptions({
    modelSelection: input.modelSelection,
    nativeThreadId: input.sessionId,
    resume: false,
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
    label: "query.open:source",
    frame: makeClaudeQueryOpenFrame({ options: sourceOptions }),
  });
  const sourceRuntime = await openRecordingQuery({
    prompt: sourcePromptQueue,
    options: sourceOptions,
  });
  const sourceIterator = sourceRuntime[Symbol.asyncIterator]();

  try {
    const sourceCursors: Array<SDKAssistantMessage["uuid"]> = [];
    for (const [index, prompt] of input.prompts.slice(0, 2).entries()) {
      const message = ClaudeAdapterV2.makeClaudeUserMessage({ text: prompt });
      input.entries.push({
        type: "expect_outbound",
        label: `prompt.offer:${index + 1}`,
        frame: makeClaudePromptOfferFrame(message),
      });
      sourcePromptQueue.offer(message);
      const result = await recordMessagesUntilTurnResultWithCursor({
        iterator: sourceIterator,
        entries: input.entries,
        scenario: input.scenario,
      });
      if (!result.completed) {
        throw new Error(`Claude source query ended before prompt ${index + 1} completed.`);
      }
      sourceCursors.push(
        requireAssistantCursor({
          scenario: input.scenario,
          promptIndex: index + 1,
          cursor: result.assistantMessageUuid,
        }),
      );
    }
    sourcePromptQueue.close();
    sourceRuntime.close();
    input.entries.push({
      type: "runtime_exit",
      status: "success",
    });

    const resumeSessionAt = sourceCursors[0]!;
    input.metadata.resumeSessionAt = resumeSessionAt;
    input.metadata.sourceAssistantMessageUuids = sourceCursors;

    const resumedPromptQueue = new RecordingPromptQueue();
    const resumedOptions = {
      ...ClaudeAdapterV2.makeClaudeQueryOptions({
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
      }),
      resumeSessionAt,
    } satisfies ClaudeAdapterV2.ClaudeAgentSdkQueryOptions;
    input.entries.push({
      type: "expect_outbound",
      label: "query.open:resume_at_cursor",
      frame: makeClaudeQueryOpenFrame({ options: resumedOptions }),
    });
    const resumedMessage = ClaudeAdapterV2.makeClaudeUserMessage({ text: input.prompts[2]! });
    input.entries.push({
      type: "expect_outbound",
      label: "prompt.offer:3",
      frame: makeClaudePromptOfferFrame(resumedMessage),
    });

    const resumedRuntime = await openRecordingQuery({
      prompt: resumedPromptQueue,
      options: resumedOptions,
    });
    resumedPromptQueue.offer(resumedMessage);
    resumedPromptQueue.close();
    const resumedIterator = resumedRuntime[Symbol.asyncIterator]();
    const resumed = await recordMessagesUntilTurnResultAndFinalize({
      iterator: resumedIterator,
      entries: input.entries,
      scenario: input.scenario,
      finalize: () => {
        resumedPromptQueue.close();
        resumedRuntime.close();
      },
    });
    if (!resumed) {
      throw new Error("Claude resumed query ended before prompt 3 completed.");
    }
    input.entries.push({
      type: "runtime_exit",
      status: "success",
    });
  } catch (error) {
    sourcePromptQueue.close();
    sourceRuntime.close();
    input.entries.push({
      type: "runtime_exit",
      status: "error",
      error: serializeReplayError(error, input.scenario),
    });
    throw error;
  }
}

export async function recordClaudeForkSessionQuery(input: {
  readonly scenario: string;
  readonly prompts: ReadonlyArray<string>;
  readonly modelSelection: ModelSelection;
  readonly cwd: string;
  readonly sessionId: string;
  readonly entries: Array<ProviderReplayEntry>;
  readonly metadata: Record<string, unknown>;
  readonly forkFromPromptIndex?: 1 | 2;
  readonly sourcePromptCount?: number;
  readonly forkPromptGroups?: ReadonlyArray<ReadonlyArray<string>>;
  readonly sourceContinuationPromptCount?: number;
  readonly enableTools?: boolean;
  readonly tools?: ClaudeAdapterV2.ClaudeAgentSdkQueryTools;
  readonly permissionMode?: ClaudeAdapterV2.ClaudeAgentSdkQueryOptions["permissionMode"];
  readonly allowedTools?: ReadonlyArray<string>;
  readonly disallowedTools?: ReadonlyArray<string>;
  readonly allowDangerouslySkipPermissions?: boolean;
}): Promise<void> {
  if (input.prompts.length < 2) {
    throw new Error(
      `Claude fork-session replay scenario ${input.scenario} requires at least two prompts.`,
    );
  }
  const sourceContinuationPromptCount = input.sourceContinuationPromptCount ?? 0;
  const forkPromptEnd = input.prompts.length - sourceContinuationPromptCount;
  const sourcePromptCount = input.sourcePromptCount ?? forkPromptEnd - 1;
  if (
    sourceContinuationPromptCount < 0 ||
    sourceContinuationPromptCount >= input.prompts.length ||
    sourcePromptCount < 1 ||
    sourcePromptCount >= forkPromptEnd
  ) {
    throw new Error(
      `Claude fork-session replay scenario ${input.scenario} requires at least one source prompt and one fork prompt.`,
    );
  }
  const forkFromPromptIndex = input.forkFromPromptIndex ?? sourcePromptCount;
  if (forkFromPromptIndex > sourcePromptCount) {
    throw new Error(
      `Claude fork-session replay scenario ${input.scenario} cannot fork from prompt ${forkFromPromptIndex} after recording ${sourcePromptCount} source prompts.`,
    );
  }

  const sourcePromptQueue = new RecordingPromptQueue();
  const sourceOptions = ClaudeAdapterV2.makeClaudeQueryOptions({
    modelSelection: input.modelSelection,
    nativeThreadId: input.sessionId,
    resume: false,
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
    label: "query.open:source",
    frame: makeClaudeQueryOpenFrame({ options: sourceOptions }),
  });
  const sourceRuntime = await openRecordingQuery({
    prompt: sourcePromptQueue,
    options: sourceOptions,
  });
  const sourceIterator = sourceRuntime[Symbol.asyncIterator]();

  try {
    const sourceCursors: Array<SDKAssistantMessage["uuid"]> = [];
    for (const [index, prompt] of input.prompts.slice(0, sourcePromptCount).entries()) {
      const message = ClaudeAdapterV2.makeClaudeUserMessage({ text: prompt });
      input.entries.push({
        type: "expect_outbound",
        label: `prompt.offer:${index + 1}`,
        frame: makeClaudePromptOfferFrame(message),
      });
      sourcePromptQueue.offer(message);
      const result = await recordMessagesUntilTurnResultWithCursor({
        iterator: sourceIterator,
        entries: input.entries,
        scenario: input.scenario,
      });
      if (!result.completed) {
        throw new Error(`Claude source query ended before prompt ${index + 1} completed.`);
      }
      sourceCursors.push(
        requireAssistantCursor({
          scenario: input.scenario,
          promptIndex: index + 1,
          cursor: result.assistantMessageUuid,
        }),
      );
    }
    sourcePromptQueue.close();
    sourceRuntime.close();
    input.entries.push({
      type: "runtime_exit",
      status: "success",
    });

    const upToMessageId = sourceCursors[forkFromPromptIndex - 1]!;
    const forkPrompts = input.prompts.slice(sourcePromptCount, forkPromptEnd);
    const forkPromptGroups = input.forkPromptGroups ?? [forkPrompts];
    if (
      forkPromptGroups.length === 0 ||
      forkPromptGroups.some((group) => group.length === 0) ||
      forkPromptGroups.flat().join("\n") !== forkPrompts.join("\n")
    ) {
      throw new Error(
        `Claude fork-session replay scenario ${input.scenario} has invalid fork prompt groups.`,
      );
    }
    input.metadata.sourceAssistantMessageUuids = sourceCursors;
    input.metadata.forkUpToMessageId = upToMessageId;
    const forkedNativeSessionIds: Array<string> = [];
    let promptOrdinal = sourcePromptCount;
    for (const [groupIndex, forkPrompts] of forkPromptGroups.entries()) {
      const labelSuffix = forkPromptGroups.length === 1 ? "" : `:${groupIndex + 1}`;
      input.entries.push({
        type: "expect_outbound",
        label: `session.fork${labelSuffix}`,
        frame: {
          type: "session.fork",
          sessionId: input.sessionId,
          options: {
            dir: sanitizedReplayCwd(input.scenario),
            upToMessageId,
          },
        },
      });
      const forked = await forkSession(input.sessionId, {
        dir: input.cwd,
        upToMessageId,
      });
      forkedNativeSessionIds.push(forked.sessionId);
      input.entries.push({
        type: "emit_inbound",
        label: `session.forked${labelSuffix}`,
        frame: {
          type: "session.forked",
          sessionId: forked.sessionId,
        },
      });

      const targetPromptQueue = new RecordingPromptQueue();
      const targetOptions = ClaudeAdapterV2.makeClaudeQueryOptions({
        modelSelection: input.modelSelection,
        nativeThreadId: forked.sessionId,
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
        label: `query.open:fork${labelSuffix}`,
        frame: makeClaudeQueryOpenFrame({ options: targetOptions }),
      });
      const targetRuntime = await openRecordingQuery({
        prompt: targetPromptQueue,
        options: targetOptions,
      });
      const targetIterator = targetRuntime[Symbol.asyncIterator]();
      for (const prompt of forkPrompts) {
        promptOrdinal += 1;
        const targetMessage = ClaudeAdapterV2.makeClaudeUserMessage({ text: prompt });
        input.entries.push({
          type: "expect_outbound",
          label: `prompt.offer:${promptOrdinal}`,
          frame: makeClaudePromptOfferFrame(targetMessage),
        });
        targetPromptQueue.offer(targetMessage);
        const completed = await recordMessagesUntilTurnResult({
          iterator: targetIterator,
          entries: input.entries,
          scenario: input.scenario,
        });
        if (!completed) {
          throw new Error(`Claude fork query ended before prompt ${promptOrdinal} completed.`);
        }
      }
      targetPromptQueue.close();
      targetRuntime.close();
      input.entries.push({
        type: "runtime_exit",
        status: "success",
      });
    }
    input.metadata.forkedNativeSessionId = forkedNativeSessionIds[0];
    input.metadata.forkedNativeSessionIds = forkedNativeSessionIds;
    if (sourceContinuationPromptCount > 0) {
      const continuationPromptQueue = new RecordingPromptQueue();
      const continuationOptions = ClaudeAdapterV2.makeClaudeQueryOptions({
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
        label: "query.open:source-continuation",
        frame: makeClaudeQueryOpenFrame({ options: continuationOptions }),
      });
      const continuationRuntime = await openRecordingQuery({
        prompt: continuationPromptQueue,
        options: continuationOptions,
      });
      const continuationIterator = continuationRuntime[Symbol.asyncIterator]();
      for (const prompt of input.prompts.slice(forkPromptEnd)) {
        promptOrdinal += 1;
        const continuationMessage = ClaudeAdapterV2.makeClaudeUserMessage({ text: prompt });
        input.entries.push({
          type: "expect_outbound",
          label: `prompt.offer:${promptOrdinal}`,
          frame: makeClaudePromptOfferFrame(continuationMessage),
        });
        continuationPromptQueue.offer(continuationMessage);
        const completed = await recordMessagesUntilTurnResult({
          iterator: continuationIterator,
          entries: input.entries,
          scenario: input.scenario,
        });
        if (!completed) {
          throw new Error(
            `Claude source continuation ended before prompt ${promptOrdinal} completed.`,
          );
        }
      }
      continuationPromptQueue.close();
      continuationRuntime.close();
      input.entries.push({
        type: "runtime_exit",
        status: "success",
      });
      input.metadata.sourceContinuationPromptCount = sourceContinuationPromptCount;
    }
  } catch (error) {
    sourcePromptQueue.close();
    sourceRuntime.close();
    input.entries.push({
      type: "runtime_exit",
      status: "error",
      error: serializeReplayError(error, input.scenario),
    });
    throw error;
  }
}

export async function recordInterruptedClaudeQuery(input: {
  readonly scenario: string;
  readonly prompt: string;
  readonly modelSelection: ModelSelection;
  readonly cwd: string;
  readonly sessionId: string;
  readonly resume: boolean;
  readonly entries: Array<ProviderReplayEntry>;
  readonly queryOpenLabel: string;
  readonly promptOfferLabel: string;
  readonly interruptLabel: string;
  readonly interruptAfter?: "prompt_offer" | "tool_use";
  readonly interruptAfterToolUses?: number;
  readonly enableTools?: boolean;
  readonly tools?: ClaudeAdapterV2.ClaudeAgentSdkQueryTools;
  readonly permissionMode?: ClaudeAdapterV2.ClaudeAgentSdkQueryOptions["permissionMode"];
  readonly allowedTools?: ReadonlyArray<string>;
  readonly disallowedTools?: ReadonlyArray<string>;
  readonly allowDangerouslySkipPermissions?: boolean;
}): Promise<void> {
  const promptQueue = new RecordingPromptQueue();
  const options = ClaudeAdapterV2.makeClaudeQueryOptions({
    modelSelection: input.modelSelection,
    nativeThreadId: input.sessionId,
    resume: input.resume,
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
    label: input.queryOpenLabel,
    frame: makeClaudeQueryOpenFrame({ options }),
  });
  const runtime = await openRecordingQuery({
    prompt: promptQueue,
    options,
  });
  const iterator = runtime[Symbol.asyncIterator]();
  const message = ClaudeAdapterV2.makeClaudeUserMessage({ text: input.prompt });
  input.entries.push({
    type: "expect_outbound",
    label: input.promptOfferLabel,
    frame: makeClaudePromptOfferFrame(message),
  });
  promptQueue.offer(message);

  try {
    if (input.interruptAfter === "tool_use") {
      await recordMessagesUntilToolUse({
        iterator,
        entries: input.entries,
        scenario: input.scenario,
        toolUseCount: input.interruptAfterToolUses ?? 1,
      });
      await Effect.runPromise(Effect.sleep(Duration.millis(250)));
    }
    input.entries.push({
      type: "expect_outbound",
      label: input.interruptLabel,
      frame: { type: "query.interrupt" },
    });

    let cancelledError: unknown;
    try {
      await runtime.interrupt();
    } catch (error) {
      cancelledError = error;
    }
    promptQueue.close();
    runtime.close();
    try {
      await recordMessagesUntilIteratorDone({
        iterator,
        entries: input.entries,
        scenario: input.scenario,
      });
    } catch (error) {
      cancelledError = error;
    }
    input.entries.push({
      type: "runtime_exit",
      status: cancelledError === undefined ? "success" : "cancelled",
      ...(cancelledError === undefined
        ? {}
        : { error: serializeReplayError(cancelledError, input.scenario) }),
    });
  } catch (error) {
    promptQueue.close();
    runtime.close();
    input.entries.push({
      type: "runtime_exit",
      status: "error",
      error: serializeReplayError(error, input.scenario),
    });
    throw error;
  }
}

