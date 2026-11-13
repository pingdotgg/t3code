// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as EffectAcpClient from "effect-acp/client";
import * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/compat";
import type * as EffectAcpProtocol from "effect-acp/protocol";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import { AgentScope, AgentScopeThreadId, RAISE_OOM_SCORE_LINE } from "@t3tools/shared/AgentScope";
import * as HostProcess from "@t3tools/shared/HostProcess";

import { signalProcessGroup } from "@t3tools/provider-core/server/processGroup";
import { appendAcpStderrTail, sanitizeAcpStderrExcerpt } from "./stderr.ts";
import {
  collectSessionConfigOptionValues,
  decideToolCallUpdateEmission,
  extractModelConfigId,
  findModelConfigOption,
  findSessionConfigOption,
  mergeToolCallState,
  toolCallProgressLength,
  parseSessionModeState,
  parseSessionUpdateEvent,
  sessionUpdateCountsAsLoadReplayActivity,
  sessionUpdateIsReplay,
  waitForSessionLoadReplayIdle,
  type SessionLoadGate,
  type AcpParsedSessionEvent,
  type AcpSessionModeState,
  type AcpToolCallState,
} from "./runtimeModel.ts";
import type {
  AcpSessionRuntimeEvent,
  AcpSessionRuntimeStartResult,
} from "./AcpSessionRuntime.ts";

export function selectAcpAgentAuthMethod(
  authMethods: ReadonlyArray<EffectAcpSchema.AuthMethod> | undefined,
  preferredMethodId?: string,
): EffectAcpSchema.AuthMethod | undefined {
  const preferred = preferredMethodId?.trim();
  if (preferred) {
    return authMethods?.find((method) => method.id === preferred);
  }
  return authMethods?.find((method) => method.type === undefined || method.type === "agent");
}

export function isAcpAuthenticationRequired(error: EffectAcpErrors.AcpError): boolean {
  return error._tag === "AcpRequestError" && error.code === -32000;
}

export const defaultCancelTimeout = Duration.seconds(15);
export const defaultSessionLoadTimeout = Duration.seconds(90);
export const defaultSessionLoadReplayIdleGap = Duration.seconds(2);

export function formatConfigOptionValue(value: string | boolean): string {
  return JSON.stringify(value);
}

export const maxStartupMetadataUpdates = 32;

export interface AcpSessionRuntimeState {
  readonly runtimeScope: Scope.Scope;
  readonly eventQueue: Queue.Queue<AcpSessionRuntimeEvent>;
  readonly modeStateRef: Ref.Ref<AcpSessionModeState | undefined>;
  readonly toolCallsRef: Ref.Ref<Map<string, AcpToolCallTrackedState>>;
  readonly shownToolCallIds: Set<string>;
  readonly assistantItemRuntimeId: string;
  readonly assistantSegmentRef: Ref.Ref<AcpAssistantSegmentState>;
  readonly configOptionsRef: SubscriptionRef.SubscriptionRef<
    ReadonlyArray<EffectAcpSchema.SessionConfigOption>
  >;
  readonly initializeStateRef: Ref.Ref<AcpInitializeState>;
  readonly startStateRef: Ref.Ref<AcpStartState>;
  readonly startupMetadataRef: Ref.Ref<ReadonlyArray<EffectAcpSchema.SessionNotification>>;
  readonly notificationSemaphore: Semaphore.Semaphore;
  readonly terminationErrorRef: Ref.Ref<Option.Option<EffectAcpErrors.AcpError>>;
  readonly stoppingRef: Ref.Ref<boolean>;
  readonly stderrFailure: Deferred.Deferred<never, EffectAcpErrors.AcpError>;
  readonly stderrTailRef: Ref.Ref<string>;
  readonly stderrDrained: Deferred.Deferred<void>;
  readonly runtimeClosed: Deferred.Deferred<void>;
  readonly promptSerializationSemaphore: Semaphore.Semaphore;
  readonly sessionLoadSemaphore: Semaphore.Semaphore;
  readonly promptDispatchSemaphore: Semaphore.Semaphore;
  readonly activePromptRef: Ref.Ref<Option.Option<AcpActivePrompt>>;
  readonly assistantUpdatesOpenRef: Ref.Ref<boolean>;
  readonly sessionLoadGateRef: Ref.Ref<Option.Option<SessionLoadGate>>;
  readonly configOptionUpdates: Ref.Ref<number>;
}

export interface AcpStartedState extends AcpSessionRuntimeStartResult {}

export type AcpStartState =
  | { readonly _tag: "NotStarted" }
  | {
      readonly _tag: "Starting";
      readonly deferred: Deferred.Deferred<AcpSessionRuntimeStartResult, EffectAcpErrors.AcpError>;
    }
  | { readonly _tag: "Started"; readonly result: AcpStartedState };

export type AcpInitializeState =
  | { readonly _tag: "NotStarted" }
  | {
      readonly _tag: "Starting";
      readonly deferred: Deferred.Deferred<
        EffectAcpSchema.InitializeResponse,
        EffectAcpErrors.AcpError
      >;
    }
  | { readonly _tag: "Started"; readonly result: EffectAcpSchema.InitializeResponse };



export interface AcpActivePrompt {
  readonly fiber: Fiber.Fiber<EffectAcpSchema.PromptResponse, EffectAcpErrors.AcpError>;
  readonly completed: Deferred.Deferred<void>;
}

export const MAX_SHOWN_TOOL_CALL_IDS = 256;

export interface AcpToolCallTrackedState {
  readonly state: AcpToolCallState;
  readonly lastEmittedDetailLength: number | undefined;
  readonly skippedSinceEmit: number;
}

export interface AcpAssistantSegmentState {
  readonly nextSegmentIndex: number;
  readonly activeItemId?: string;
}

export interface EnsureActiveAssistantSegmentResult {
  readonly itemId: string;
  readonly startedEvent?: Extract<AcpParsedSessionEvent, { readonly _tag: "AssistantItemStarted" }>;
}

export function sessionConfigOptionsFromSetup(
  response:
    | {
        readonly configOptions?: ReadonlyArray<EffectAcpSchema.SessionConfigOption> | null;
      }
    | undefined,
): ReadonlyArray<EffectAcpSchema.SessionConfigOption> {
  return response?.configOptions ?? [];
}

export function configOptionCurrentValueMatches(
  configOption: EffectAcpSchema.SessionConfigOption,
  value: string | boolean,
): boolean {
  const currentValue = configOption.currentValue;
  if (configOption.type === "boolean") {
    return currentValue === value;
  }
  if (typeof currentValue !== "string") {
    return false;
  }
  return currentValue.trim() === String(value).trim();
}

export function isStartupMetadataUpdate(notification: EffectAcpSchema.SessionNotification): boolean {
  switch (notification.update.sessionUpdate) {
    case "current_mode_update":
    case "config_option_update":
    case "available_commands_update":
      return true;
    default:
      return false;
  }
}

export const handleSessionUpdate =
  /* Provider events include streaming deltas; avoid a span for each update. */
  Effect.fnUntraced(function* ({
    queue,
    modeStateRef,
    configOptionsRef,
    toolCallsRef,
    shownToolCallIds,
    assistantSegmentRef,
    assistantItemRuntimeId,
    params,
  }: {
    readonly queue: Queue.Queue<AcpSessionRuntimeEvent>;
    readonly modeStateRef: Ref.Ref<AcpSessionModeState | undefined>;
    readonly configOptionsRef: SubscriptionRef.SubscriptionRef<
      ReadonlyArray<EffectAcpSchema.SessionConfigOption>
    >;
    readonly toolCallsRef: Ref.Ref<Map<string, AcpToolCallTrackedState>>;
    readonly shownToolCallIds: Set<string>;
    readonly assistantSegmentRef: Ref.Ref<AcpAssistantSegmentState>;
    readonly assistantItemRuntimeId: string;
    readonly params: EffectAcpSchema.SessionNotification;
  }): Effect.fn.Return<void> {
    if (params.update.sessionUpdate === "config_option_update") {
      const configOptions = params.update.configOptions;
      yield* SubscriptionRef.set(configOptionsRef, configOptions);
      yield* Ref.update(
        modeStateRef,
        (current) => parseSessionModeState({ configOptions }) ?? current,
      );
    }
    const parsed = parseSessionUpdateEvent(params);
    if (parsed.modeId) {
      yield* Ref.update(modeStateRef, (current) =>
        current === undefined ? current : updateModeState(current, parsed.modeId!),
      );
    }
    for (const event of parsed.events) {
      if (event._tag === "ToolCallUpdated") {
        const { merged, decision, active } = yield* Ref.modify(toolCallsRef, (current) => {
          const tracked = current.get(event.toolCall.toolCallId);
          const previous = tracked?.state;
          const nextToolCall = mergeToolCallState(previous, event.toolCall);
          const decision = decideToolCallUpdateEmission({
            previous,
            next: nextToolCall,
            lastEmittedDetailLength: tracked?.lastEmittedDetailLength,
            skippedSinceEmit: tracked?.skippedSinceEmit ?? 0,
          });
          const next = new Map(current);
          if (nextToolCall.status === "completed" || nextToolCall.status === "failed") {
            next.delete(nextToolCall.toolCallId);
          } else {
            next.set(nextToolCall.toolCallId, {
              state: nextToolCall,
              lastEmittedDetailLength: decision.emit
                ? toolCallProgressLength(nextToolCall)
                : tracked?.lastEmittedDetailLength,
              skippedSinceEmit: decision.skippedSinceEmit,
            });
          }
          return [{ merged: nextToolCall, decision, active: tracked !== undefined }, next] as const;
        });
        if (!decision.emit) {
          continue;
        }
        if (!shownToolCallIds.has(merged.toolCallId)) {
          shownToolCallIds.add(merged.toolCallId);
          if (shownToolCallIds.size > MAX_SHOWN_TOOL_CALL_IDS) {
            shownToolCallIds.delete(shownToolCallIds.values().next().value!);
          }
          if (!active) yield* closeActiveAssistantSegment({ queue, assistantSegmentRef });
        }
        yield* Queue.offer(queue, {
          _tag: "ToolCallUpdated",
          toolCall: merged,
          rawPayload: event.rawPayload,
        });
        continue;
      }
      if (event._tag === "ContentDelta") {
        if (event.text.trim().length === 0) {
          const assistantSegmentState = yield* Ref.get(assistantSegmentRef);
          if (!assistantSegmentState.activeItemId) {
            continue;
          }
        }
        const itemId = yield* ensureActiveAssistantSegment({
          queue,
          assistantSegmentRef,
          sessionId: params.sessionId,
          assistantItemRuntimeId,
        });
        yield* Queue.offer(queue, {
          ...event,
          itemId,
        });
        continue;
      }
      yield* Queue.offer(queue, event);
    }
  });

export function updateModeState(modeState: AcpSessionModeState, nextModeId: string): AcpSessionModeState {
  const normalized = nextModeId.trim();
  if (!normalized) {
    return modeState;
  }
  return modeState.availableModes.some((mode) => mode.id === normalized)
    ? {
        ...modeState,
        currentModeId: normalized,
      }
    : modeState;
}

export const assistantItemId = (sessionId: string, runtimeId: string, segmentIndex: number) =>
  `assistant:${sessionId}:runtime:${runtimeId}:segment:${segmentIndex}`;

export const ensureActiveAssistantSegment = ({
  queue,
  assistantSegmentRef,
  sessionId,
  assistantItemRuntimeId,
}: {
  readonly queue: Queue.Queue<AcpSessionRuntimeEvent>;
  readonly assistantSegmentRef: Ref.Ref<AcpAssistantSegmentState>;
  readonly sessionId: string;
  readonly assistantItemRuntimeId: string;
}) =>
  Ref.modify<AcpAssistantSegmentState, EnsureActiveAssistantSegmentResult>(
    assistantSegmentRef,
    (current) => {
      if (current.activeItemId) {
        return [{ itemId: current.activeItemId }, current] as const;
      }
      const itemId = assistantItemId(sessionId, assistantItemRuntimeId, current.nextSegmentIndex);
      return [
        {
          itemId,
          startedEvent: {
            _tag: "AssistantItemStarted",
            itemId,
          } satisfies Extract<AcpParsedSessionEvent, { readonly _tag: "AssistantItemStarted" }>,
        },
        {
          nextSegmentIndex: current.nextSegmentIndex + 1,
          activeItemId: itemId,
        } satisfies AcpAssistantSegmentState,
      ] as const;
    },
  ).pipe(
    Effect.flatMap((result) =>
      result.startedEvent
        ? Queue.offer(queue, result.startedEvent).pipe(Effect.as(result.itemId))
        : Effect.succeed(result.itemId),
    ),
  );

export const closeActiveAssistantSegment = ({
  queue,
  assistantSegmentRef,
}: {
  readonly queue: Queue.Queue<AcpSessionRuntimeEvent>;
  readonly assistantSegmentRef: Ref.Ref<AcpAssistantSegmentState>;
}) =>
  Ref.modify(assistantSegmentRef, (current) => {
    if (!current.activeItemId) {
      return [undefined, current] as const;
    }
    return [
      {
        _tag: "AssistantItemCompleted",
        itemId: current.activeItemId,
      } satisfies AcpParsedSessionEvent,
      {
        nextSegmentIndex: current.nextSegmentIndex,
      } satisfies AcpAssistantSegmentState,
    ] as const;
  }).pipe(Effect.flatMap((event) => (event ? Queue.offer(queue, event) : Effect.void)));
