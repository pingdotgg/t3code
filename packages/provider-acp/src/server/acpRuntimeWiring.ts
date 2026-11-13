// ACP session behaviour extracted from server/adapter.ts (runtimeWiring).

import { acpClientExecuteDisposition } from "./clientPolicy.ts";
import { embeddedTerminalIdsFromSessionUpdate } from "./runtimeModel.ts";
import { resolveEmbeddedTerminalContent } from "./clientTerminals.ts";
import { type AcpMcpOverAcpBridge } from "./mcpOverAcpBridge.ts";
import * as AcpSessionRuntime from "./AcpSessionRuntime.ts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as EffectAcpErrors from "effect-acp/errors";
import * as EffectAcpSchema from "effect-acp/compat";
import * as Ref from "effect/Ref";
import type { AcpSessionCtx14 } from "./acpSessionContext.ts";

export const createAcpRuntimeWiring = (ctx: AcpSessionCtx14) => {
  const markPromptStarted = Effect.fnUntraced(function* (
    notification: EffectAcpSchema.SessionNotification,
  ) {
    const promptStarts = ctx.flavor.cancelAfterPromptStarts?.isStart;
    if (promptStarts === undefined) return;
    const context = yield* Ref.get(ctx.activeTurn);
    if (context === null || context.nativeThreadId !== notification.sessionId) return;
    if (!(yield* Deferred.isDone(context.promptDispatched))) return;
    if (!promptStarts(notification.update)) return;
    yield* Deferred.succeed(context.promptStarted, undefined);
  });
  const projectAcpRuntimeSessionUpdateEffect =
    /* Provider events include streaming deltas; avoid a span for each update. */
    Effect.fnUntraced(
      function* (rawNotification: EffectAcpSchema.SessionNotification) {
        if (ctx.flavor.ignoreSessionUpdate?.(rawNotification) === true) return;
        const nativePromptId = ctx.flavor.forkFromTurn?.nativeTurnId(rawNotification);
        if (nativePromptId !== undefined) {
          const context = yield* Ref.get(ctx.activeTurn);
          if (context !== null && context.nativeThreadId === rawNotification.sessionId) {
            context.nativePromptId ??= nativePromptId;
          }
        }
        const injectedSteerId = ctx.flavor.steering?.injectedSteerId(rawNotification);
        if (injectedSteerId !== undefined) {
          yield* Deferred.succeed(ctx.steerInjection(injectedSteerId), undefined);
        }
        yield* markPromptStarted(rawNotification);
        const embedded = embeddedTerminalIdsFromSessionUpdate(rawNotification);
        if (embedded !== undefined) {
          ctx.rememberEmbeddedTerminals({
            ...embedded,
            sessionId: rawNotification.sessionId,
          });
        }
        const notification =
          ctx.late.clientTerminals === undefined
            ? rawNotification
            : resolveEmbeddedTerminalContent(
                rawNotification,
                ctx.late.clientTerminals.readOutputSnapshot,
              );
        if (notification.update.sessionUpdate === "available_commands_update") {
          yield* (
            ctx.flavor.onAvailableCommandsUpdate?.(notification.update.availableCommands) ??
              Effect.void
          );
        }
        if (
          notification.update.sessionUpdate === "config_option_update" ||
          notification.update.sessionUpdate === "current_mode_update"
        ) {
          yield* (
            ctx.flavor.onSessionConfigurationUpdate?.(
              yield* ctx.runtime.getConfigOptions,
              yield* ctx.runtime.getModeState,
              (yield* Ref.get(ctx.activeSessionSetup))?.sessionSetupResult.models,
            ) ?? Effect.void
          );
        }
        yield* ctx.handleSessionUpdate(
          ctx.flavor.normalizeSessionUpdate?.(notification) ?? notification,
        );
      },
      Effect.mapError(
        (cause) =>
          new EffectAcpErrors.AcpTransportError({
            detail: "Failed to project an ACP session update",
            cause,
          }),
      ),
    );
  const projectAcpRuntimeSessionUpdate = (
    handlerGeneration: number,
    rawNotification: EffectAcpSchema.SessionNotification,
  ) =>
    ctx.runRuntimeCallbackAtGeneration(
      handlerGeneration,
      projectAcpRuntimeSessionUpdateEffect(rawNotification),
    ).pipe(Effect.asVoid);
  const clientPolicyContext = Effect.map(Ref.get(ctx.activeTurn), (context) => ({
    policy: context?.input.runtimePolicy ?? ctx.latestRuntimePolicy,
    turnKey: context === null ? null : String(context.providerTurnId),
  }));
  const denyClientRequest = (operation: string, disposition: "ask" | "deny") =>
    Effect.logWarning("ACP client policy denied a client-mediated operation", {
      operation,
      disposition,
    }).pipe(
      Effect.andThen(
        Effect.fail(
          EffectAcpErrors.AcpRequestError.internalError(
            disposition === "ask"
              ? `The active T3 runtime policy requires approval for ${operation}. Request permission with session/request_permission before retrying.`
              : `The active T3 runtime policy does not allow ${operation}.`,
          ),
        ),
      ),
    );
  const guardClientTerminalCreate = clientPolicyContext.pipe(
    Effect.flatMap(({ policy, turnKey }) => {
      const disposition = acpClientExecuteDisposition(policy);
      if (
        disposition === "allow" ||
        (disposition === "ask" && ctx.clientPolicyGrants.allowsExecute(turnKey))
      ) {
        return Effect.void;
      }
      return denyClientRequest("terminal/create", disposition);
    }),
  );
  const wireAcpRuntimeTerminalHandlers = Effect.fnUntraced(function* (
    targetRuntime: AcpSessionRuntime.AcpSessionRuntime["Service"],
  ) {
    const clientTerminals = ctx.late.clientTerminals;
    if (clientTerminals === undefined) return;
    yield* targetRuntime.handleCreateTerminal((request) =>
      guardClientTerminalCreate.pipe(Effect.andThen(clientTerminals.create(request))),
    );
    yield* targetRuntime.handleTerminalOutput(clientTerminals.output);
    yield* targetRuntime.handleTerminalWaitForExit(clientTerminals.waitForExit);
    yield* targetRuntime.handleTerminalKill(clientTerminals.kill);
    yield* targetRuntime.handleTerminalRelease(clientTerminals.release);
  });
  const wireAcpRuntimeMcpHandlers = Effect.fnUntraced(function* (
    targetRuntime: AcpSessionRuntime.AcpSessionRuntime["Service"],
    mcpBridge: AcpMcpOverAcpBridge | undefined,
  ) {
    if (mcpBridge === undefined) return;
    const mapMcpBridgeError = Effect.mapError(
      (error: Error) =>
        new EffectAcpErrors.AcpRequestError({
          code: -32603,
          errorMessage: error.message,
          cause: error,
        }),
    );
    yield* targetRuntime.handleMcpConnect((request) =>
      mcpBridge.connect(request).pipe(mapMcpBridgeError),
    );
    yield* targetRuntime.handleMcpMessage((request) =>
      mcpBridge.message(request).pipe(mapMcpBridgeError),
    );
    yield* targetRuntime.handleMcpNotification((request) =>
      mcpBridge.notification(request).pipe(mapMcpBridgeError),
    );
    yield* targetRuntime.handleMcpDisconnect((request) =>
      mcpBridge.disconnect(request).pipe(mapMcpBridgeError),
    );
  });
  return {
    markPromptStarted,
    projectAcpRuntimeSessionUpdateEffect,
    projectAcpRuntimeSessionUpdate,
    clientPolicyContext,
    denyClientRequest,
    guardClientTerminalCreate,
    wireAcpRuntimeTerminalHandlers,
    wireAcpRuntimeMcpHandlers,
  };
};
