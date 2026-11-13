/**
 * OpenCode session history surface: conversation rollback and thread forking.
 */
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import {
  openCodePermissionRules,
} from "../permissions.ts";
import {
  makeProviderThread,
  providerRef,
  unwrapData,
} from "../projection.ts";
import {
  nativeThreadId,
  protocolError,
} from "../protocol.ts";
import {
  OPENCODE_PROVIDER,
} from "../provider.ts";
import {
  openCodeBoundaryAfterProviderTurn,
} from "../tools.ts";
import type { Items } from "./items.ts";
import type { Turns } from "./turns.ts";
import type { Threads } from "./threads.ts";
import type { State } from "./base.ts";

type OpenCodeRuntimeHistory = Pick<ProviderAdapter.ProviderAdapterV2SessionRuntime, "rollbackThread" | "forkThread">;

export const makeRuntimeHistory = (deps: State & Items & Turns & Threads): OpenCodeRuntimeHistory => {
  const {
    options,
    input,
    client,
    idAllocator,
    now,
    threads,
    sdkCall,
  } = deps;
  const m = deps.mutable;
  const runtimeSession: OpenCodeRuntimeHistory = {
    rollbackThread: Effect.fn("OpencodeAdapter.rollbackThread")(
      function* (rollbackInput) {
        const sessionId = nativeThreadId(rollbackInput.providerThread);
        const state = threads.get(sessionId);
        if (state?.activeTurn !== null && state?.activeTurn !== undefined) {
          return yield* protocolError(
            `Cannot roll back OpenCode thread ${rollbackInput.providerThread.id} while a turn is active`,
          );
        }
        const response = yield* sdkCall("session.messages", { sessionID: sessionId }, () =>
          client.session.messages({ sessionID: sessionId }),
        );
        const messages = unwrapData("session.messages", response);
        let boundaryMessageId: string | undefined;
        if (rollbackInput.target.type === "thread_start") {
          boundaryMessageId = messages.find(({ info }) => info.role === "user")?.info.id;
        } else {
          boundaryMessageId = openCodeBoundaryAfterProviderTurn(
            rollbackInput.providerThreadTurns,
            rollbackInput.target.providerTurn.id,
          );
        }
        let retainedThread = rollbackInput.providerThread;
        if (boundaryMessageId !== undefined) {
          const boundaryIndex = messages.findIndex(
            ({ info }) => info.id === boundaryMessageId,
          );
          if (boundaryIndex < 0)
            return yield* protocolError(
              "The OpenCode rewind boundary is no longer available.",
            );
          const fork = unwrapData(
            "session.fork",
            yield* sdkCall(
              "session.fork",
              { sessionID: sessionId, messageID: boundaryMessageId },
              () =>
                client.session.fork({ sessionID: sessionId, messageID: boundaryMessageId }),
            ),
          );
          const retained = unwrapData(
            "session.messages",
            yield* sdkCall("session.messages", { sessionID: fork.id }, () =>
              client.session.messages({ sessionID: fork.id }),
            ),
          );
          if (retained.length !== boundaryIndex)
            return yield* protocolError(
              "OpenCode did not preserve the requested rewind boundary.",
            );
          yield* sdkCall("session.update", { sessionID: fork.id }, () =>
            client.session.update({
              sessionID: fork.id,
              permission: openCodePermissionRules(input.runtimePolicy),
            }),
          );
          retainedThread = {
            ...rollbackInput.providerThread,
            nativeThreadRef: providerRef(fork.id),
          };
          deps.registerThread(fork, retainedThread, state?.appThread ?? null);
        }
        const snapshot = yield* deps.readSnapshot(retainedThread);
        return {
          ...snapshot,
          providerThread: {
            ...snapshot.providerThread,
            nativeConversationHeadRef:
              rollbackInput.target.type === "provider_turn"
                ? rollbackInput.target.providerTurn.nativeTurnRef
                : null,
          },
        };
      },
      (effect, rollbackInput) =>
        effect.pipe(
          Effect.mapError(
            (cause) =>
              new ProviderAdapter.ProviderAdapterRollbackThreadError({
                driver: OPENCODE_PROVIDER,
                providerThreadId: rollbackInput.providerThread.id,
                checkpointId: rollbackInput.target.checkpointId,
                cause,
              }),
          ),
        ),
    ),
    forkThread: Effect.fn("OpencodeAdapter.forkThread")(
      function* (forkInput) {
        const sourceSessionId = nativeThreadId(forkInput.sourceProviderThread);
        const sourceState = threads.get(sourceSessionId);
        if (sourceState?.activeTurn !== null && sourceState?.activeTurn !== undefined) {
          return yield* protocolError(
            `Cannot fork OpenCode thread ${forkInput.sourceProviderThread.id} while a turn is active`,
          );
        }
        let boundaryMessageId: string | undefined;
        if (forkInput.providerTurnId !== undefined) {
          const sourceTurns = forkInput.sourceProviderTurns ?? [];
          const selected = sourceTurns.find((turn) => turn.id === forkInput.providerTurnId);
          if (selected === undefined) {
            return yield* protocolError(
              `OpenCode fork boundary turn ${forkInput.providerTurnId} was not found`,
            );
          }
          boundaryMessageId = openCodeBoundaryAfterProviderTurn(sourceTurns, selected.id);
        }
        const response = yield* sdkCall(
          "session.fork",
          {
            sessionID: sourceSessionId,
            ...(boundaryMessageId === undefined ? {} : { messageID: boundaryMessageId }),
          },
          () =>
            client.session.fork({
              sessionID: sourceSessionId,
              ...(boundaryMessageId === undefined ? {} : { messageID: boundaryMessageId }),
            }),
        );
        const nativeSession = unwrapData("session.fork", response);
        const forkedAt = yield* DateTime.now;
        const providerThread = makeProviderThread({
          idAllocator,
          providerInstanceId: options.instanceId,
          providerSessionId: input.providerSessionId,
          appThreadId: forkInput.targetThreadId,
          ...(forkInput.ownerNodeId === undefined
            ? {}
            : { ownerNodeId: forkInput.ownerNodeId }),
          nativeSession,
          forkedFrom: {
            providerThreadId: forkInput.sourceProviderThread.id,
            ...(forkInput.providerTurnId === undefined
              ? {}
              : { providerTurnId: forkInput.providerTurnId }),
          },
          now: forkedAt,
        });
        deps.registerThread(nativeSession, providerThread, null);
        return providerThread;
      },
      (effect, forkInput) =>
        effect.pipe(
          Effect.mapError(
            (cause) =>
              new ProviderAdapter.ProviderAdapterForkThreadError({
                driver: OPENCODE_PROVIDER,
                providerThreadId: forkInput.sourceProviderThread.id,
                cause,
              }),
          ),
        ),
    ),
  };
  return runtimeSession;
};
