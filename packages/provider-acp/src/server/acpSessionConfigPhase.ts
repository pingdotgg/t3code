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
import {
  configOptionCurrentValueMatches,
  defaultSessionLoadReplayIdleGap,
  defaultSessionLoadTimeout,
  formatConfigOptionValue,
  sessionConfigOptionsFromSetup,
} from "./acpSessionRuntimeSupport.ts";
import type { AcpSessionRequestLogEvent, AcpSessionRuntimeOptions, AcpSessionRuntimeStartResult } from "./AcpSessionRuntime.ts";
import type { AcpStartedState } from "./acpSessionRuntimeSupport.ts";
import type { AcpSessionRuntimeState } from "./acpSessionRuntimeSupport.ts";

export interface MakeAcpSessionConfigPhaseDeps {
  readonly state: AcpSessionRuntimeState;
  readonly acp: Parameters<typeof EffectAcpClient.AcpClient.of>[0];
  readonly ensureConnected: Effect.Effect<void, EffectAcpErrors.AcpError>;
  readonly logRequest: (event: AcpSessionRequestLogEvent) => Effect.Effect<void>;
  readonly options: AcpSessionRuntimeOptions;
  readonly runLoggedRequest: <A>(method: string, payload: unknown, effect: Effect.Effect<A, EffectAcpErrors.AcpError>) => Effect.Effect<A, EffectAcpErrors.AcpError>;
}

export const makeAcpSessionConfigPhase = Effect.fn("makeAcpSessionConfigPhase")(function* (
  deps: MakeAcpSessionConfigPhaseDeps,
) {
  const {
    runtimeScope,
    eventQueue,
    modeStateRef,
    toolCallsRef,
    assistantSegmentRef,
    configOptionsRef,
    startStateRef,
    sessionLoadSemaphore,
    sessionLoadGateRef,
    configOptionUpdates,
  } = deps.state;
  const { acp, ensureConnected, logRequest, options, runLoggedRequest } = deps;

  const getStartedState = Effect.gen(function* () {
    yield* ensureConnected;
    const state = yield* Ref.get(startStateRef);
    if (state._tag === "Started") {
      return state.result;
    }
    return yield* new EffectAcpErrors.AcpTransportError({
      detail: "ACP session runtime has not been started",
      cause: "ACP session runtime has not been started",
    });
  });

  const validateConfigOptionValue = Effect.fn("AcpSessionRuntime.validateConfigOptionValue")(
    function* (
      configId: string,
      value: string | boolean,
      allowUnlistedValue: boolean,
    ): Effect.fn.Return<void, EffectAcpErrors.AcpError> {
      const configOptions = yield* SubscriptionRef.get(configOptionsRef);
      const configOption = findSessionConfigOption(configOptions, configId);
      if (!configOption) {
        return;
      }
      if (configOption.type === "boolean") {
        if (typeof value === "boolean") {
          return;
        }
        return yield* new EffectAcpErrors.AcpRequestError({
          code: -32602,
          errorMessage: `Invalid value ${formatConfigOptionValue(value)} for session config option "${configOption.id}": expected boolean`,
          data: {
            configId: configOption.id,
            expectedType: "boolean",
            receivedValue: value,
          },
        });
      }
      if (typeof value !== "string") {
        return yield* new EffectAcpErrors.AcpRequestError({
          code: -32602,
          errorMessage: `Invalid value ${formatConfigOptionValue(value)} for session config option "${configOption.id}": expected string`,
          data: {
            configId: configOption.id,
            expectedType: "string",
            receivedValue: value,
          },
        });
      }
      const allowedValues = collectSessionConfigOptionValues(configOption);
      if (allowUnlistedValue || allowedValues.includes(value)) {
        return;
      }
      if (
        configOption === findModelConfigOption(configOptions) &&
        options.customModels?.includes(value)
      ) {
        return;
      }
      return yield* new EffectAcpErrors.AcpRequestError({
        code: -32602,
        errorMessage: `Invalid value ${formatConfigOptionValue(value)} for session config option "${configOption.id}": expected one of ${allowedValues.join(", ")}`,
        data: {
          configId: configOption.id,
          allowedValues,
          receivedValue: value,
        },
      });
    },
  );

  const updateConfigOptions = Effect.fn("AcpSessionRuntime.updateConfigOptions")(function* (
    response:
      | EffectAcpSchema.SetSessionConfigOptionResponse
      | EffectAcpSchema.ForkSessionResponse
      | EffectAcpSchema.LoadSessionResponse
      | EffectAcpSchema.NewSessionResponse
      | EffectAcpSchema.ResumeSessionResponse,
  ) {
    const configOptions = sessionConfigOptionsFromSetup(response);
    yield* SubscriptionRef.set(configOptionsRef, configOptions);
    yield* Queue.offer(eventQueue, {
      _tag: "ConfigOptionsUpdated",
      configOptions,
      rawPayload: response,
    });
  });

  const updateCurrentModeId = (modeId: string): Effect.Effect<void> =>
    Ref.update(modeStateRef, (current) =>
      current ? { ...current, currentModeId: modeId } : current,
    );

  const adoptSession = Effect.fn("AcpSessionRuntime.adoptSession")(function* (
    sessionId: string,
    sessionSetupResult:
      | EffectAcpSchema.ForkSessionResponse
      | EffectAcpSchema.LoadSessionResponse
      | EffectAcpSchema.NewSessionResponse
      | EffectAcpSchema.ResumeSessionResponse,
  ): Effect.fn.Return<AcpSessionRuntimeStartResult, EffectAcpErrors.AcpError> {
    const current = yield* getStartedState;
    const meta = sessionSetupResult._meta;
    const syntheticReplayIdle =
      meta !== null &&
      typeof meta === "object" &&
      !Array.isArray(meta) &&
      (meta as { readonly t3SessionLoadReady?: unknown }).t3SessionLoadReady === "replay_idle";
    const extractedModelConfigId = extractModelConfigId(sessionSetupResult);
    const nextModelConfigId =
      extractedModelConfigId ?? (syntheticReplayIdle ? current.modelConfigId : undefined);
    const nextModeState = parseSessionModeState(sessionSetupResult);
    if (nextModeState !== undefined) {
      yield* Ref.set(modeStateRef, nextModeState);
    } else if (!syntheticReplayIdle) {
      yield* Ref.set(modeStateRef, undefined);
    }
    // Synthetic replay-idle load responses only carry initialize model/mode
    // meta; preserve live configOptions so setConfigOption still validates.
    if (
      sessionSetupResult.configOptions !== undefined &&
      sessionSetupResult.configOptions !== null
    ) {
      yield* SubscriptionRef.set(
        configOptionsRef,
        sessionConfigOptionsFromSetup(sessionSetupResult),
      );
    } else if (!syntheticReplayIdle) {
      yield* SubscriptionRef.set(
        configOptionsRef,
        sessionConfigOptionsFromSetup(sessionSetupResult),
      );
    }
    const nextState = {
      sessionId,
      initializeResult: current.initializeResult,
      sessionSetupResult,
      modelConfigId: nextModelConfigId,
    } satisfies AcpStartedState;
    yield* Ref.set(toolCallsRef, new Map());
    yield* Ref.set(assistantSegmentRef, { nextSegmentIndex: 0 });
    yield* Ref.set(startStateRef, { _tag: "Started", result: nextState });
    return nextState;
  });

  const runLoadSessionWithReplayIdle = (
    loadPayload: EffectAcpSchema.LoadSessionRequest,
    initializeResult: EffectAcpSchema.InitializeResponse,
  ): Effect.Effect<EffectAcpSchema.LoadSessionResponse, EffectAcpErrors.AcpError> =>
    sessionLoadSemaphore.withPermits(1)(
      Effect.gen(function* () {
        const sessionLoadTimeout = Duration.fromInputUnsafe(
          options.sessionLoadTimeout ?? defaultSessionLoadTimeout,
        );
        const sessionLoadReplayIdleGap = Duration.fromInputUnsafe(
          options.sessionLoadReplayIdleGap ?? defaultSessionLoadReplayIdleGap,
        );

        yield* Ref.set(
          sessionLoadGateRef,
          Option.some({
            active: true,
            sessionId: loadPayload.sessionId,
            lastActivityAtMillis: undefined,
            idleGap: sessionLoadReplayIdleGap,
            initializeResult,
          }),
        );

        return yield* Effect.gen(function* () {
          yield* logRequest({
            method: "session/load",
            payload: loadPayload,
            status: "started",
          });

          const idleFiber = yield* waitForSessionLoadReplayIdle({
            gateRef: sessionLoadGateRef,
          }).pipe(Effect.forkIn(runtimeScope));
          const loaded = yield* Effect.raceFirst(
            acp.agent.loadSession(loadPayload),
            Fiber.join(idleFiber),
          ).pipe(
            Effect.ensuring(Fiber.interrupt(idleFiber).pipe(Effect.ignore)),
            Effect.timeoutOption(sessionLoadTimeout),
            Effect.flatMap((result) =>
              Effect.fromOption(
                result,
                () =>
                  new EffectAcpErrors.AcpTransportError({
                    operation: "call-rpc",
                    method: "session/load",
                    detail: "session/load timed out waiting for RPC response or replay idle gap",
                    cause: undefined,
                  }),
              ),
            ),
            Effect.tap((result) =>
              logRequest({
                method: "session/load",
                payload: loadPayload,
                status: "succeeded",
                result,
              }),
            ),
            Effect.onError((cause) =>
              logRequest({
                method: "session/load",
                payload: loadPayload,
                status: "failed",
                cause,
              }),
            ),
          );

          const gate = yield* Ref.get(sessionLoadGateRef);
          const candidateConfigOptions = Option.isSome(gate)
            ? gate.value.candidateConfigOptions
            : undefined;
          return loaded.configOptions == null && candidateConfigOptions !== undefined
            ? { ...loaded, configOptions: candidateConfigOptions }
            : loaded;
        }).pipe(Effect.ensuring(Ref.set(sessionLoadGateRef, Option.none())));
      }),
    );

  const setConfigOption = (
    configId: string,
    value: string | boolean,
    options?: { readonly allowUnlistedValue?: boolean },
  ): Effect.Effect<EffectAcpSchema.SetSessionConfigOptionResponse, EffectAcpErrors.AcpError> =>
    validateConfigOptionValue(configId, value, options?.allowUnlistedValue === true).pipe(
      Effect.andThen(getStartedState),
      Effect.flatMap((started) =>
        SubscriptionRef.get(configOptionsRef).pipe(
          Effect.flatMap((configOptions) => {
            const existing = findSessionConfigOption(configOptions, configId);
            if (existing && configOptionCurrentValueMatches(existing, value)) {
              return Effect.succeed({
                configOptions,
              } satisfies EffectAcpSchema.SetSessionConfigOptionResponse);
            }
            const requestPayload =
              typeof value === "boolean"
                ? ({
                    sessionId: started.sessionId,
                    configId,
                    type: "boolean",
                    value,
                  } satisfies EffectAcpSchema.SetSessionConfigOptionRequest)
                : ({
                    sessionId: started.sessionId,
                    configId,
                    value: String(value),
                  } satisfies EffectAcpSchema.SetSessionConfigOptionRequest);
            // An update the agent pushed while the write was in flight is
            // newer than its result: Kiro 2.32 answers a `model` write
            // without `model`, then advertises it, and that update can be
            // handled before this fiber resumes. The result then stays out.
            return Ref.get(configOptionUpdates).pipe(
              Effect.flatMap((updatesBefore) =>
                runLoggedRequest(
                  "session/set_config_option",
                  requestPayload,
                  acp.agent.setSessionConfigOption(requestPayload),
                ).pipe(
                  Effect.tap((response) =>
                    Ref.get(configOptionUpdates).pipe(
                      Effect.flatMap((updatesNow) =>
                        updatesNow === updatesBefore ? updateConfigOptions(response) : Effect.void,
                      ),
                    ),
                  ),
                ),
              ),
            );
          }),
        ),
      ),
    );
  return { getStartedState, validateConfigOptionValue, updateConfigOptions, updateCurrentModeId, adoptSession, runLoadSessionWithReplayIdle, setConfigOption };
});
