// @effect-diagnostics nodeBuiltinImport:off -- fixtures use Node builtins
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
  replayQueryRunnerError,
  sanitizedReplayCwd,
} from "./ClaudeAdapterV2.testkit.ts";
import {
  ClaudeAgentSdkReplayError,
  type ClaudeAgentSdkReplayTranscript,
  type ClaudeOutboundFrame,
  type ClaudeQueryRunner,
  ClaudeReplayExhaustedError,
  ClaudeReplayFrameMismatchError,
  ClaudeReplayIncompleteError,
  ClaudeReplayRuntimeExitError,
  ClaudeReplayUnexpectedOutboundError,
  type ClaudeSessionForkedFrame,
  type ClaudeSubagentFoundFrame,
  isClaudePermissionRequestFrame,
  makeClaudePermissionResponseFrame,
  makeClaudePromptOfferFrame,
  makeClaudeQueryOpenFrame,
  makeClaudeSessionForkFrame,
  makeCursorSignal,
  permissionRequestOptionsFromFrame,
  sameFrame,
  sdkMessageFromReplayFrame,
  waitForCursorAdvance,
  waitForReplayDelay,
} from "./ClaudeAdapterV2-part2.testkit.ts";

export function makeReplayQueryRunner(
  transcript: ClaudeAgentSdkReplayTranscript,
  replayOptions: { readonly replayGate?: ProviderReplayGate } = {},
): ClaudeQueryRunner {
  let cursor = 0;
  let failure: ClaudeAgentSdkReplayError | null = null;
  let cursorAdvanced = makeCursorSignal();
  const iteratorAbortControllers = new Set<AbortController>();

  const abortReplayIterators = () => {
    for (const abortController of iteratorAbortControllers) {
      abortController.abort();
    }
  };

  const fail = (error: ClaudeAgentSdkReplayError): never => {
    failure = error;
    abortReplayIterators();
    replayOptions.replayGate?.releaseAll();
    cursorAdvanced.resolve();
    throw error;
  };

  const throwIfFailed = () => {
    if (failure !== null) {
      throw failure;
    }
  };

  const advance = () => {
    cursor += 1;
    const signal = cursorAdvanced;
    cursorAdvanced = makeCursorSignal();
    signal.resolve();
  };

  async function* replayMessages(
    options: ClaudeAdapterV2.ClaudeAgentSdkQueryOptions,
    signal: AbortSignal,
  ): AsyncGenerator<SDKMessage, void> {
    while (true) {
      throwIfFailed();

      const entry = transcript.entries[cursor];
      if (entry === undefined) {
        return;
      }

      if (entry.type === "emit_inbound") {
        if (replayOptions.replayGate !== undefined) {
          await replayOptions.replayGate.beforeEmit(entry.label, signal);
          throwIfFailed();
          if (signal.aborted) {
            return;
          }
        }
        if (entry.afterMs !== undefined && entry.afterMs > 0) {
          await waitForReplayDelay(entry.afterMs, signal);
          throwIfFailed();
          if (signal.aborted) {
            return;
          }
        }
        if (isClaudePermissionRequestFrame(entry.frame)) {
          const request = entry.frame;
          const invokeCanUseTool = options.canUseTool;
          if (invokeCanUseTool === undefined) {
            const error = new ClaudeReplayUnexpectedOutboundError({
              scenario: transcript.scenario,
              cursor,
              expectedType: "permission.request",
              actual: request,
            });
            return fail(error);
          }
          advance();
          let result: PermissionResult | null;
          try {
            result = await invokeCanUseTool(
              request.toolName,
              request.input,
              permissionRequestOptionsFromFrame(request, signal),
            );
          } catch (cause) {
            throwIfFailed();
            if (signal.aborted) {
              return;
            }
            throw cause;
          }
          throwIfFailed();
          if (signal.aborted) {
            return;
          }
          if (result === null) {
            const error = new ClaudeReplayUnexpectedOutboundError({
              scenario: transcript.scenario,
              cursor,
              expectedType: "permission.response",
              actual: null,
            });
            return fail(error);
          }
          assertNextOutboundFrame(makeClaudePermissionResponseFrame(result));
          continue;
        }
        advance();
        yield sdkMessageFromReplayFrame(withReplayedPromptUuids(entry.frame));
        continue;
      }

      if (entry.type === "runtime_exit") {
        advance();
        if (entry.status === "success") {
          return;
        }
        fail(
          new ClaudeReplayRuntimeExitError({
            scenario: transcript.scenario,
            cursor: cursor - 1,
            status: entry.status,
            ...(entry.error === undefined ? {} : { error: entry.error }),
          }),
        );
      }

      if (entry.type === "expect_outbound") {
        await waitForCursorAdvance(cursorAdvanced.promise, signal);
        throwIfFailed();
        if (signal.aborted) {
          return;
        }
        continue;
      }
    }
  }

  const replayMessagesWithGateCleanup = (
    options: ClaudeAdapterV2.ClaudeAgentSdkQueryOptions,
  ): AsyncIterable<SDKMessage> => ({
    [Symbol.asyncIterator]: () => {
      const abortController = new AbortController();
      iteratorAbortControllers.add(abortController);
      const iterator = replayMessages(options, abortController.signal);
      return {
        next: async () => {
          try {
            const result = await iterator.next();
            if (result.done) {
              iteratorAbortControllers.delete(abortController);
            }
            return result;
          } catch (cause) {
            iteratorAbortControllers.delete(abortController);
            throw cause;
          }
        },
        return: async () => {
          abortController.abort();
          replayOptions.replayGate?.releaseAll();
          try {
            return await iterator.return();
          } finally {
            iteratorAbortControllers.delete(abortController);
          }
        },
      };
    },
  });

  // Prompt uuids differ on replay; rewrite inbound echoes and acknowledgements to match.
  const promptUuidReplacements = new Map<string, string>();
  const replayedPromptUuid = (value: string): string => promptUuidReplacements.get(value) ?? value;
  const withReplayedPromptUuids = (frame: unknown): unknown => {
    if (promptUuidReplacements.size === 0 || typeof frame !== "object" || frame === null) {
      return frame;
    }
    const uuid: unknown = Reflect.get(frame, "user_message_uuid");
    const uuids: unknown = Reflect.get(frame, "user_message_uuids");
    const commandUuid: unknown = Reflect.get(frame, "command_uuid");
    if (typeof uuid !== "string" && !Array.isArray(uuids) && typeof commandUuid !== "string") {
      return frame;
    }
    return {
      ...frame,
      ...(typeof commandUuid === "string" ? { command_uuid: replayedPromptUuid(commandUuid) } : {}),
      ...(typeof uuid === "string" ? { user_message_uuid: replayedPromptUuid(uuid) } : {}),
      ...(Array.isArray(uuids)
        ? {
            user_message_uuids: uuids.map((entry) =>
              typeof entry === "string" ? replayedPromptUuid(entry) : entry,
            ),
          }
        : {}),
    };
  };
  const promptOfferUuid = (frame: unknown): string | undefined => {
    if (
      typeof frame !== "object" ||
      frame === null ||
      Reflect.get(frame, "type") !== "prompt.offer"
    ) {
      return undefined;
    }
    const message: unknown = Reflect.get(frame, "message");
    const uuid: unknown =
      typeof message === "object" && message !== null ? Reflect.get(message, "uuid") : undefined;
    return typeof uuid === "string" ? uuid : undefined;
  };
  const withoutPromptOfferUuid = (frame: unknown): unknown => {
    if (promptOfferUuid(frame) === undefined || typeof frame !== "object" || frame === null) {
      return frame;
    }
    const message = Reflect.get(frame, "message") as Record<string, unknown>;
    const { uuid: _uuid, ...rest } = message;
    return { ...frame, message: rest };
  };

  const assertNextOutboundFrame = (actual: ClaudeOutboundFrame) => {
    if (failure !== null) {
      throw failure;
    }
    const entry = transcript.entries[cursor];
    if (entry === undefined) {
      return fail(
        new ClaudeReplayExhaustedError({
          scenario: transcript.scenario,
          cursor,
          actual,
        }),
      );
    }
    if (entry.type !== "expect_outbound") {
      return fail(
        new ClaudeReplayUnexpectedOutboundError({
          scenario: transcript.scenario,
          cursor,
          expectedType: entry.type,
          actual,
        }),
      );
    }

    const expected = entry.frame;
    const expectedUuid = promptOfferUuid(expected);
    const actualUuid = promptOfferUuid(actual);
    if (
      !sameFrame(withoutPromptOfferUuid(expected), withoutPromptOfferUuid(actual)) ||
      (expectedUuid !== undefined && actualUuid === undefined)
    ) {
      fail(
        new ClaudeReplayFrameMismatchError({
          scenario: transcript.scenario,
          cursor,
          ...(entry.label === undefined ? {} : { label: entry.label }),
          expected,
          actual,
        }),
      );
    }
    if (expectedUuid !== undefined && actualUuid !== undefined) {
      promptUuidReplacements.set(expectedUuid, actualUuid);
    }

    advance();
  };

  const assertNextReplyFrame = <Frame extends ClaudeSessionForkedFrame | ClaudeSubagentFoundFrame>(
    type: Frame["type"],
    isValid: (frame: object) => boolean,
  ): Frame => {
    const entry = transcript.entries[cursor];
    if (entry === undefined) {
      return fail(
        new ClaudeReplayExhaustedError({
          scenario: transcript.scenario,
          cursor,
          actual: { type },
        }),
      );
    }
    if (entry.type !== "emit_inbound") {
      return fail(
        new ClaudeReplayUnexpectedOutboundError({
          scenario: transcript.scenario,
          cursor,
          expectedType: entry.type,
          actual: { type },
        }),
      );
    }
    if (
      typeof entry.frame !== "object" ||
      entry.frame === null ||
      Reflect.get(entry.frame, "type") !== type ||
      !isValid(entry.frame)
    ) {
      return fail(
        new ClaudeReplayFrameMismatchError({
          scenario: transcript.scenario,
          cursor,
          expected: { type },
          actual: entry.frame,
        }),
      );
    }

    const frame = entry.frame as Frame;
    advance();
    return frame;
  };

  const replayEffect = (tryEffect: () => void) =>
    Effect.try({
      try: tryEffect,
      catch: (cause) => replayQueryRunnerError(transcript, cause),
    });

  return {
    open: (input) => {
      assertNextOutboundFrame(makeClaudeQueryOpenFrame(input));
      return {
        messages: Stream.fromAsyncIterable(replayMessagesWithGateCleanup(input.options), (cause) =>
          replayQueryRunnerError(transcript, cause),
        ),
        offer: (message) =>
          replayEffect(() => {
            assertNextOutboundFrame(makeClaudePromptOfferFrame(message));
          }),
        setModel: (model) =>
          replayEffect(() => {
            assertNextOutboundFrame({
              type: "query.set_model",
              model,
            });
          }),
        applyFlagSettings: (settings) =>
          replayEffect(() => {
            assertNextOutboundFrame({
              type: "query.apply_flag_settings",
              settings,
            });
          }),
        setPermissionMode: (mode) =>
          replayEffect(() => {
            assertNextOutboundFrame({
              type: "query.set_permission_mode",
              mode,
            });
          }),
        stopTask: (taskId) =>
          replayEffect(() => {
            assertNextOutboundFrame({ type: "query.stop_task", taskId });
          }),
        backgroundTasks: (toolUseId) =>
          replayEffect(() => {
            assertNextOutboundFrame({ type: "query.background_tasks", toolUseId });
          }).pipe(Effect.as(true)),
        interrupt: replayEffect(() => {
          assertNextOutboundFrame({ type: "query.interrupt" });
        }),
        close: Effect.void,
      };
    },
    forkSession: (input) => {
      assertNextOutboundFrame(makeClaudeSessionForkFrame(input, transcript.scenario));
      return assertNextReplyFrame<ClaudeSessionForkedFrame>(
        "session.forked",
        (frame) => typeof Reflect.get(frame, "sessionId") === "string",
      );
    },
    subagentLaunchToolUseId: (input) => {
      assertNextOutboundFrame({
        type: "subagent.lookup",
        sessionId: input.sessionId,
        agentId: input.agentId,
      });
      return assertNextReplyFrame<ClaudeSubagentFoundFrame>("subagent.found", (frame) => {
        const toolUseId = Reflect.get(frame, "toolUseId");
        return toolUseId === null || typeof toolUseId === "string";
      }).toolUseId;
    },
    assertComplete: () => {
      if (failure !== null) {
        throw failure;
      }
      if (cursor !== transcript.entries.length) {
        replayOptions.replayGate?.releaseAll();
        throw new ClaudeReplayIncompleteError({
          scenario: transcript.scenario,
          cursor,
          remaining: transcript.entries.length - cursor,
        });
      }
    },
  };
}
