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
import { handleSessionUpdate, isStartupMetadataUpdate, maxStartupMetadataUpdates } from "./acpSessionRuntimeSupport.ts";
import type { AcpSessionRuntimeState } from "./acpSessionRuntimeSupport.ts";

export interface MakeAcpSessionUpdatePhaseDeps {
  readonly state: AcpSessionRuntimeState;
  readonly acp: Parameters<typeof EffectAcpClient.AcpClient.of>[0];
}

export const makeAcpSessionUpdatePhase = Effect.fn("makeAcpSessionUpdatePhase")(function* (
  deps: MakeAcpSessionUpdatePhaseDeps,
) {
  const {
    runtimeScope,
    eventQueue,
    modeStateRef,
    toolCallsRef,
    shownToolCallIds,
    assistantItemRuntimeId,
    assistantSegmentRef,
    configOptionsRef,
    startStateRef,
    startupMetadataRef,
    notificationSemaphore,
    terminationErrorRef,
    stoppingRef,
    runtimeClosed,
    assistantUpdatesOpenRef,
    sessionLoadGateRef,
    configOptionUpdates,
  } = deps.state;
  const { acp } = deps;
  const processSessionUpdate = (notification: EffectAcpSchema.SessionNotification) =>
    (notification.update.sessionUpdate === "config_option_update"
      ? Ref.update(configOptionUpdates, (count) => count + 1)
      : Effect.void
    ).pipe(
      Effect.andThen(
        handleSessionUpdate({
          queue: eventQueue,
          modeStateRef,
          configOptionsRef,
          toolCallsRef,
          shownToolCallIds,
          assistantSegmentRef,
          assistantItemRuntimeId,
          params: notification,
        }),
      ),
    );

  yield* acp.handleSessionUpdate((notification) =>
    notificationSemaphore.withPermit(
      Effect.gen(function* () {
        if (Option.isSome(yield* Ref.get(terminationErrorRef))) {
          return;
        }
        const gate = yield* Ref.get(sessionLoadGateRef);
        // A different session can still have an in-flight prompt while this
        // load replays history, so quarantine only the loading session.
        const loadingThisSession =
          Option.isSome(gate) &&
          gate.value.active &&
          notification.sessionId === gate.value.sessionId;
        if (
          loadingThisSession &&
          sessionUpdateCountsAsLoadReplayActivity(notification, gate.value.sessionId)
        ) {
          const lastActivityAtMillis = yield* Clock.currentTimeMillis;
          yield* Ref.set(
            sessionLoadGateRef,
            Option.some({
              ...gate.value,
              lastActivityAtMillis,
            }),
          );
        }
        if (sessionUpdateIsReplay(notification)) {
          return;
        }
        const startState = yield* Ref.get(startStateRef);
        if (startState._tag === "Starting") {
          if (isStartupMetadataUpdate(notification)) {
            yield* Ref.update(startupMetadataRef, (current) =>
              [
                ...current.filter(
                  (previous) =>
                    previous.sessionId !== notification.sessionId ||
                    previous.update.sessionUpdate !== notification.update.sessionUpdate,
                ),
                notification,
              ].slice(-maxStartupMetadataUpdates),
            );
          }
          return;
        }
        if (loadingThisSession) {
          if (notification.update.sessionUpdate === "config_option_update") {
            const candidateConfigOptions = notification.update.configOptions;
            yield* Ref.update(sessionLoadGateRef, (current) =>
              Option.isSome(current)
                ? Option.some({ ...current.value, candidateConfigOptions })
                : current,
            );
          }
          return;
        }
        // One runtime projects one root ACP session. Child-session updates need
        // explicit lineage routing and must never be flattened into this stream.
        if (
          startState._tag !== "Started" ||
          notification.sessionId !== startState.result.sessionId
        ) {
          return;
        }
        if (
          !(yield* Ref.get(assistantUpdatesOpenRef)) &&
          (notification.update.sessionUpdate === "agent_message_chunk" ||
            notification.update.sessionUpdate === "agent_thought_chunk")
        ) {
          return;
        }
        yield* processSessionUpdate(notification);
      }),
    ),
  );
  yield* Scope.addFinalizer(
    runtimeScope,
    Ref.set(stoppingRef, true).pipe(Effect.andThen(Deferred.succeed(runtimeClosed, undefined))),
  );
  return { processSessionUpdate };
});
