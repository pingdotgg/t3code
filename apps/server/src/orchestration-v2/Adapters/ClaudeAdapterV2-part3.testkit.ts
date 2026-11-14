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
  CLAUDE_RECORDING_WAKE_QUIET_MS,
  RecordingMessageReader,
  RecordingPromptQueue,
  isSystemInitFrame,
  isTaskNotificationOriginResultFrame,
  openRecordingQuery,
  permissionRequestFrame,
  permissionResultForRecording,
  recordMessagesUntilTurnResult,
  recordMessagesUntilTurnResults,
  sanitizeSdkMessageForReplay,
  serializeReplayError,
} from "./ClaudeAdapterV2.testkit.ts";

export async function recordClaudeStreamingQuery(input: {
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
  readonly enablePermissionCallback?: boolean;
  readonly permissionDecision?: ProviderApprovalDecision;
  readonly backgroundWakeCounts?: ReadonlyArray<number>;
  readonly offerNextPromptImmediately?: boolean;
}): Promise<void> {
  const promptQueue = new RecordingPromptQueue();
  const canUseTool: CanUseTool | undefined =
    input.enablePermissionCallback === true
      ? async (toolName, toolInput, callbackOptions) => {
          const requestFrame = permissionRequestFrame({
            toolName,
            toolInput,
            callbackOptions,
          });
          input.entries.push({
            type: "emit_inbound",
            label: `permission.request:${toolName}`,
            frame: requestFrame,
          });
          const result = permissionResultForRecording({
            decision: input.permissionDecision ?? "accept",
            toolInput,
            toolUseID: callbackOptions.toolUseID,
            ...(callbackOptions.suggestions === undefined
              ? {}
              : { suggestions: callbackOptions.suggestions }),
          });
          input.entries.push({
            type: "expect_outbound",
            label: `permission.response:${toolName}`,
            frame: makeClaudePermissionResponseFrame(result),
          });
          return result;
        }
      : undefined;
  const options = ClaudeAdapterV2.makeClaudeQueryOptions({
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
          ...(canUseTool === undefined ? {} : { canUseTool }),
        }
      : {}),
  });
  input.entries.push({
    type: "expect_outbound",
    label: "query.open",
    frame: makeClaudeQueryOpenFrame({ options }),
  });
  const queryRuntime = await openRecordingQuery({
    prompt: promptQueue,
    options,
  });
  const iterator = new RecordingMessageReader(queryRuntime[Symbol.asyncIterator]());
  let wakeNumber = 0;
  const recordTurn = async (promptNumber: number): Promise<"prompt" | "wake"> => {
    const completed = await recordMessagesUntilTurnResult({
      iterator,
      entries: input.entries,
      scenario: input.scenario,
    });
    if (!completed) {
      throw new Error(
        `Claude streaming query ended before prompt ${promptNumber} and its background wakes completed.`,
      );
    }
    const resultEntry = input.entries.at(-1);
    const resultFrame = resultEntry?.type === "emit_inbound" ? resultEntry.frame : undefined;
    if (!isTaskNotificationOriginResultFrame(resultFrame)) {
      return "prompt";
    }
    wakeNumber += 1;
    input.entries[input.entries.length - 1] = {
      type: "emit_inbound",
      label: claudeBackgroundWakeResultLabel(wakeNumber),
      frame: resultFrame,
    };
    return "wake";
  };
  try {
    for (const [index, prompt] of input.prompts.entries()) {
      const message = ClaudeAdapterV2.makeClaudeUserMessage({
        text: prompt,
        uuid: await Effect.runPromise(
          SecureRandom.SecureRandom.pipe(
            Effect.flatMap((random) => random.uuidV4()),
            Effect.filterOrFail(ClaudeAdapterV2.isClaudePromptUuid),
            Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
          ),
        ),
      });
      input.entries.push({
        type: "expect_outbound",
        label: `prompt.offer:${index + 1}`,
        frame: makeClaudePromptOfferFrame(message),
      });
      promptQueue.offer(message);
      // Wake turns can precede the prompt turn; identify results by origin.
      let promptSettled = false;
      let wakes = 0;
      const expectedWakes = input.backgroundWakeCounts?.[index] ?? 0;
      while (!promptSettled || wakes < expectedWakes) {
        if ((await recordTurn(index + 1)) === "prompt") {
          promptSettled = true;
        } else {
          wakes += 1;
        }
      }
      if (input.backgroundWakeCounts !== undefined && input.offerNextPromptImmediately !== true) {
        // system:init opens each turn; leave ongoing subagent frames for the next recording.
        while (isSystemInitFrame(await iterator.peekWithin(CLAUDE_RECORDING_WAKE_QUIET_MS))) {
          await recordTurn(index + 1);
        }
      }
    }
    promptQueue.close();
    queryRuntime.close();
    input.entries.push({
      type: "runtime_exit",
      status: "success",
    });
  } catch (error) {
    promptQueue.close();
    queryRuntime.close();
    input.entries.push({
      type: "runtime_exit",
      status: "error",
      error: serializeReplayError(error, input.scenario),
    });
    throw error;
  }
}

export async function recordClaudeActiveSteeringQuery(input: {
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
  readonly enablePermissionCallback?: boolean;
  readonly permissionDecision?: ProviderApprovalDecision;
}): Promise<void> {
  if (input.prompts.length < 2) {
    throw new Error("Claude active steering replay recording requires at least two prompts.");
  }

  const promptQueue = new RecordingPromptQueue();
  const offerPrompt = (index: number, priority?: SDKUserMessage["priority"]) => {
    const message = ClaudeAdapterV2.makeClaudeUserMessage({
      text: input.prompts[index]!,
      ...(priority === undefined ? {} : { priority }),
    });
    input.entries.push({
      type: "expect_outbound",
      label: `prompt.offer:${index + 1}`,
      frame: makeClaudePromptOfferFrame(message),
    });
    promptQueue.offer(message);
  };
  const offerSteeringPrompts = () => {
    for (let index = 1; index < input.prompts.length; index += 1) {
      offerPrompt(index, "now");
    }
  };

  const canUseTool: CanUseTool | undefined =
    input.enablePermissionCallback === true
      ? async (toolName, toolInput, callbackOptions) => {
          const requestFrame = permissionRequestFrame({
            toolName,
            toolInput,
            callbackOptions,
          });
          input.entries.push({
            type: "emit_inbound",
            label: `permission.request:${toolName}`,
            frame: requestFrame,
          });
          const result = permissionResultForRecording({
            decision: input.permissionDecision ?? "accept",
            toolInput,
            toolUseID: callbackOptions.toolUseID,
            ...(callbackOptions.suggestions === undefined
              ? {}
              : { suggestions: callbackOptions.suggestions }),
          });
          input.entries.push({
            type: "expect_outbound",
            label: `permission.response:${toolName}`,
            frame: makeClaudePermissionResponseFrame(result),
          });
          return result;
        }
      : undefined;
  const options = ClaudeAdapterV2.makeClaudeQueryOptions({
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
          ...(canUseTool === undefined ? {} : { canUseTool }),
        }
      : {}),
  });
  input.entries.push({
    type: "expect_outbound",
    label: "query.open",
    frame: makeClaudeQueryOpenFrame({ options }),
  });
  const queryRuntime = await openRecordingQuery({
    prompt: promptQueue,
    options,
  });
  const iterator = queryRuntime[Symbol.asyncIterator]();
  try {
    offerPrompt(0);
    offerSteeringPrompts();
    const completed = await recordMessagesUntilTurnResults({
      iterator,
      entries: input.entries,
      scenario: input.scenario,
      resultCount: input.prompts.length,
    });
    if (!completed) {
      throw new Error("Claude active steering query ended before the turn completed.");
    }
    promptQueue.close();
    queryRuntime.close();
    input.entries.push({
      type: "runtime_exit",
      status: "success",
    });
  } catch (error) {
    promptQueue.close();
    queryRuntime.close();
    input.entries.push({
      type: "runtime_exit",
      status: "error",
      error: serializeReplayError(error, input.scenario),
    });
    throw error;
  }
}

export async function recordClaudeRestartingQueries(input: {
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
}): Promise<void> {
  for (const [index, prompt] of input.prompts.entries()) {
    const promptQueue = new RecordingPromptQueue();
    const options = ClaudeAdapterV2.makeClaudeQueryOptions({
      modelSelection: input.modelSelection,
      nativeThreadId: input.sessionId,
      resume: index > 0,
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
      label: `query.open:${index + 1}`,
      frame: makeClaudeQueryOpenFrame({ options }),
    });
    const message = ClaudeAdapterV2.makeClaudeUserMessage({ text: prompt });
    input.entries.push({
      type: "expect_outbound",
      label: `prompt.offer:${index + 1}`,
      frame: makeClaudePromptOfferFrame(message),
    });

    try {
      const queryRuntime = await openRecordingQuery({
        prompt: promptQueue,
        options,
      });
      promptQueue.offer(message);
      promptQueue.close();
      const iterator = queryRuntime[Symbol.asyncIterator]();
      for (;;) {
        const next = await iterator.next();
        if (next.done === true) {
          break;
        }
        const replayMessage = sanitizeSdkMessageForReplay({
          message: next.value,
          scenario: input.scenario,
        });
        input.entries.push({
          type: "emit_inbound",
          label: replayMessage.type,
          frame: replayMessage,
        });
      }
      input.entries.push({
        type: "runtime_exit",
        status: "success",
      });
    } catch (error) {
      promptQueue.close();
      input.entries.push({
        type: "runtime_exit",
        status: "error",
        error: serializeReplayError(error, input.scenario),
      });
      throw error;
    }
  }
}

