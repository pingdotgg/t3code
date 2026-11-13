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
import type { AcpSessionRuntimeOptions, AcpSessionRuntimeStartResult } from "./AcpSessionRuntime.ts";
import { closeActiveAssistantSegment, defaultCancelTimeout } from "./acpSessionRuntimeSupport.ts";
import { makeAcpSpawnContainment } from "./acpSpawnContainment.ts";
import type { AcpSessionRuntimeState } from "./acpSessionRuntimeSupport.ts";

export interface MakeAcpSessionCancelPhaseDeps {
  readonly state: AcpSessionRuntimeState;
  readonly acp: Parameters<typeof EffectAcpClient.AcpClient.of>[0];
  readonly adoptSession: (sessionId: string, response: EffectAcpSchema.LoadSessionResponse | EffectAcpSchema.ResumeSessionResponse | EffectAcpSchema.ForkSessionResponse) => Effect.Effect<AcpSessionRuntimeStartResult, EffectAcpErrors.AcpError>;
  readonly getStartedState: Effect.Effect<AcpSessionRuntimeStartResult, EffectAcpErrors.AcpError>;
  readonly initialize: Effect.Effect<EffectAcpSchema.InitializeResponse, EffectAcpErrors.AcpError>;
  readonly recordTermination: (error: EffectAcpErrors.AcpError) => Effect.Effect<void>;
  readonly options: AcpSessionRuntimeOptions;
  readonly child: Parameters<typeof makeAcpSpawnContainment>[0] extends never ? never : Effect.Success<ReturnType<typeof makeAcpSpawnContainment>>["child"];
}

export const makeAcpSessionCancelPhase = Effect.fn("makeAcpSessionCancelPhase")(function* (
  deps: MakeAcpSessionCancelPhaseDeps,
) {
  const {
    runtimeScope,
    eventQueue,
    modeStateRef,
    configOptionsRef,
    startStateRef,
    notificationSemaphore,
    terminationErrorRef,
    stoppingRef,
    runtimeClosed,
    activePromptRef,
    assistantSegmentRef,
    assistantUpdatesOpenRef,
    promptSerializationSemaphore,
  } = deps.state;
  const { acp, adoptSession, getStartedState, initialize, recordTermination, child, options } = deps;

  const drainEvents = Effect.gen(function* () {
    if (yield* Ref.get(stoppingRef)) {
      return;
    }
    const acknowledge = yield* Deferred.make<void>();
    yield* notificationSemaphore.withPermit(
      Effect.gen(function* () {
        if (Option.isNone(yield* Ref.get(activePromptRef))) {
          yield* Ref.set(assistantUpdatesOpenRef, false);
          yield* closeActiveAssistantSegment({ queue: eventQueue, assistantSegmentRef });
        }
        yield* Queue.offer(eventQueue, { _tag: "EventStreamBarrier", acknowledge });
      }),
    );
    yield* Effect.raceFirst(Deferred.await(acknowledge), Deferred.await(runtimeClosed));
  });

  const retireRuntime = Effect.fn("AcpSessionRuntime.retireRuntime")(function* (
    error: EffectAcpErrors.AcpError,
  ) {
    yield* recordTermination(error);
    yield* child.kill({ forceKillAfter: "1 second" }).pipe(Effect.ignore);
  });

  const cancel = Effect.gen(function* () {
    const started = yield* getStartedState;
    const activePrompt = yield* Ref.get(activePromptRef);
    const cancelPayload = {
      sessionId: started.sessionId,
      ...(options.cancelMeta === undefined ? {} : { _meta: options.cancelMeta }),
    } satisfies EffectAcpSchema.CancelNotification;
    if (options.cancelBehavior !== "wait-for-prompt") {
      if (options.interruptPromptOnCancel === false) {
        return yield* acp.agent.cancel(cancelPayload);
      }
      if (Option.isSome(activePrompt)) {
        yield* Fiber.interrupt(activePrompt.value.fiber).pipe(Effect.ignore);
      }
      // Write cancel before a replacement prompt can reach the agent.
      yield* acp.agent.cancel(cancelPayload).pipe(Effect.ignore);
      return;
    }

    yield* acp.agent.cancel(cancelPayload);
    if (Option.isNone(activePrompt)) {
      return;
    }
    const completed = yield* Effect.gen(function* () {
      const result = yield* Fiber.await(activePrompt.value.fiber);
      yield* Deferred.await(activePrompt.value.completed);
      if (Option.isNone(yield* Ref.get(terminationErrorRef))) {
        yield* drainEvents;
      }
      return result;
    }).pipe(Effect.timeoutOption(options.cancelTimeout ?? defaultCancelTimeout));
    if (Option.isNone(completed)) {
      const error = new EffectAcpErrors.AcpTransportError({
        operation: "call-rpc",
        method: "session/cancel",
        detail: "The ACP agent did not finish cancellation. Its process was stopped.",
        cause: undefined,
      });
      yield* retireRuntime(error);
      return yield* error;
    }
    if (Exit.isFailure(completed.value)) {
      return yield* Effect.failCause(completed.value.cause);
    }
  });
  return { drainEvents, retireRuntime, cancel };
});
