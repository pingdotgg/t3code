// ACP session runtime handlers extracted from server/adapter.ts (part 2).

import {
  nativeThreadId,
  acpMcpActivation,
  forkFromTurnMetaFor,
  makeProviderThread,
} from "./acpThreadContext.ts";
import { ACP_PROTOCOL } from "./acpAdapterConfig.ts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as Ref from "effect/Ref";
import type { AcpSessionContext } from "./acpSessionContext.ts";

export const createAcpSessionRuntimeThreads = (
  ctx: AcpSessionContext,
): Pick<
  ProviderAdapter.ProviderAdapterV2SessionRuntime,
  "respondToRuntimeRequest" | "readThreadSnapshot" | "rollbackThread" | "forkThread"
> => {
  const runtimeObject: Pick<
  ProviderAdapter.ProviderAdapterV2SessionRuntime,
  "respondToRuntimeRequest" | "readThreadSnapshot" | "rollbackThread" | "forkThread"
> = {
    respondToRuntimeRequest: (requestInput) =>
      Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          yield* restore(ctx.runtimeTransitionPermit.take(1));
          return yield* Effect.gen(function* () {
            yield* ctx.awaitRuntimeTeardown();
            const generation = yield* Ref.get(ctx.runtimeCallbackGeneration);
            const pending = (yield* Ref.get(ctx.pendingRuntimeRequests)).get(
              String(requestInput.requestId),
            );
            if (pending === undefined || pending.generation !== generation) {
              return yield* new ProviderAdapter.ProviderAdapterProtocolError({
                driver: ctx.driver,
                detail: `No pending ACP runtime request ${requestInput.requestId}`,
              });
            }
            const settled =
              pending.type === "user_input"
                ? yield* Deferred.succeed(pending.answers, requestInput.answers ?? null)
                : requestInput.decision === undefined
                  ? yield* new ProviderAdapter.ProviderAdapterProtocolError({
                      driver: ctx.driver,
                      detail: `ACP approval request ${requestInput.requestId} requires a decision`,
                    })
                  : yield* Deferred.succeed(pending.decision, requestInput.decision);
            if (!settled) {
              return yield* new ProviderAdapter.ProviderAdapterProtocolError({
                driver: ctx.driver,
                detail: `ACP runtime request ${requestInput.requestId} was already resolved`,
              });
            }
            yield* ctx.awaitNativeResponseAcknowledgements([
              [pending.transportRequestId, pending.nativeResponseAcknowledgement],
            ]);
            yield* Deferred.await(pending.nativeResponseAcknowledgement);
          }).pipe(Effect.ensuring(ctx.runtimeTransitionPermit.release(1)));
        }),
      ).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderAdapter.ProviderAdapterRuntimeRequestResponseError({
              driver: ctx.driver,
              requestId: requestInput.requestId,
              cause,
            }),
        ),
      ),
    readThreadSnapshot: Effect.fn("AcpAdapterV2.readThreadSnapshot")(
      function* (snapshotInput) {
        return yield* ctx.runtimeTransitionPermit.withPermit(
          Effect.gen(function* () {
            yield* ctx.awaitRuntimeTeardown();
            ctx.useProviderThreadIdentity(snapshotInput.providerThread);
            yield* ctx.restartRuntimeAfterTeardownIfRequired(
              snapshotInput.providerThread.appThreadId,
            );
            const sessionId = yield* nativeThreadId(ctx.driver, snapshotInput.providerThread);
            if ((yield* Ref.get(ctx.activeSessionId)) !== sessionId) {
              if (!ctx.capabilities.threads.canReadThreadSnapshot) {
                return yield* new ProviderAdapter.ProviderAdapterProtocolError({
                  driver: ctx.driver,
                  detail: "ACP driver does not support session/load snapshots",
                });
              }
              yield* Ref.set(ctx.snapshot, {
                order: [],
                messages: new Map(),
                loadingRole: null,
                loadingMessageId: null,
                loadingIndex: 0,
              });
              const mcpContext = yield* ctx.readMcpContext(
                snapshotInput.providerThread.appThreadId,
              );
              ctx.prepareTerminalEnvironment(mcpContext, sessionId);
              const activated = yield* ctx.runtime.loadSession(
                sessionId,
                acpMcpActivation(mcpContext),
              );
              ctx.rememberTerminalEnvironment(
                activated.sessionId,
                yield* ctx.readMcpContext(snapshotInput.providerThread.appThreadId),
              );
              yield* Ref.set(ctx.activeSessionId, activated.sessionId);
              yield* ctx.setActiveSessionSetup(activated);
              yield* Ref.set(ctx.activeSelection, null);
              yield* Ref.set(ctx.activeInteractionMode, null);
            }
            const state = yield* Ref.get(ctx.snapshot);
            const now = yield* DateTime.now;
            return {
              providerThread: {
                ...snapshotInput.providerThread,
                providerSessionId: ctx.input.providerSessionId,
                status: "idle" as const,
                updatedAt: now,
              },
              providerTurns: [...(yield* Ref.get(ctx.providerTurns)).values()],
              messages: state.order.flatMap((key) => {
                const message = state.messages.get(key);
                return message === undefined ? [] : [message];
              }),
              runtimeRequests: [],
              providerPayload: { protocol: ACP_PROTOCOL, sessionId },
            };
          }),
        );
      },
      (effect, snapshotInput) =>
        effect.pipe(
          Effect.mapError(
            (cause) =>
              new ProviderAdapter.ProviderAdapterReadThreadSnapshotError({
                driver: ctx.driver,
                providerThreadId: snapshotInput.providerThread.id,
                cause,
              }),
          ),
        ),
    ),
    rollbackThread: (rollbackInput) =>
      ctx.runtimeTransitionPermit
        .withPermit(
          Effect.gen(function* () {
            const currentTurn = yield* Ref.get(ctx.activeTurn);
            if (currentTurn !== null) {
              return yield* new ProviderAdapter.ProviderAdapterProtocolError({
                driver: ctx.driver,
                detail: `Cannot roll back ACP provider thread ${rollbackInput.providerThread.id} while turn ${currentTurn.providerTurnId} is active`,
              });
            }
            yield* ctx.awaitRuntimeTeardown();
            ctx.itemIdentityVersion = 2;
            ctx.prepareTerminalEnvironment(
              yield* ctx.readMcpContext(rollbackInput.providerThread.appThreadId),
            );
            const replacement = yield* ctx.startReplacementAcpRuntime(
              rollbackInput.providerThread.appThreadId,
              (candidate) =>
                ctx.commitReplacementSession(rollbackInput.providerThread.appThreadId, candidate),
            ).pipe(Effect.retry({ times: 1 }));
            const now = yield* DateTime.now;
            return {
              providerThread: {
                ...rollbackInput.providerThread,
                nativeThreadRef: {
                  driver: ctx.driver,
                  nativeId: replacement.sessionId,
                  strength: "strong" as const,
                },
                nativeConversationHeadRef: null,
                nativeMetadata: {
                  ...rollbackInput.providerThread.nativeMetadata,
                  itemIdentityVersion: 2 as const,
                },
                status: "idle" as const,
                updatedAt: now,
              },
              providerTurns: [],
              messages: [],
              runtimeRequests: [],
            };
          }),
        )
        .pipe(
          Effect.mapError(
            (cause) =>
              new ProviderAdapter.ProviderAdapterRollbackThreadError({
                driver: ctx.driver,
                providerThreadId: rollbackInput.providerThread.id,
                checkpointId: rollbackInput.target.checkpointId,
                cause,
              }),
          ),
        ),
    forkThread: Effect.fn("AcpAdapterV2.forkThread")(
      function* (forkInput) {
        return yield* ctx.runtimeTransitionPermit.withPermit(
          Effect.gen(function* () {
            yield* ctx.awaitRuntimeTeardown();
            ctx.useProviderThreadIdentity(forkInput.sourceProviderThread);
            yield* ctx.restartRuntimeAfterTeardownIfRequired(
              forkInput.sourceProviderThread.appThreadId,
            );
            if (!ctx.capabilities.threads.canForkThread) {
              return yield* new ProviderAdapter.ProviderAdapterProtocolError({
                driver: ctx.driver,
                detail: "ACP driver did not negotiate session/fork",
              });
            }
            const forkMeta = forkFromTurnMetaFor({
              driver: ctx.driver,
              flavor: ctx.flavor,
              canForkFromTurn: ctx.capabilities.threads.canForkFromTurn,
              forkInput,
            });
            if (forkMeta === null) {
              return yield* new ProviderAdapter.ProviderAdapterProtocolError({
                driver: ctx.driver,
                detail: "ACP session/fork can only fork the current session head",
              });
            }
            const sourceSessionId = yield* nativeThreadId(
              ctx.driver,
              forkInput.sourceProviderThread,
            );
            const mcpContext = yield* ctx.readMcpContext(forkInput.targetThreadId);
            ctx.prepareTerminalEnvironment(mcpContext);
            const forked = yield* ctx.runtime.forkSession(
              sourceSessionId,
              acpMcpActivation(mcpContext),
              forkMeta,
            );
            ctx.rememberTerminalEnvironment(
              forked.sessionId,
              yield* ctx.readMcpContext(forkInput.targetThreadId),
            );
            yield* Ref.set(ctx.activeSessionId, forked.sessionId);
            yield* ctx.setActiveSessionSetup(forked);
            yield* Ref.set(ctx.activeSelection, null);
            yield* Ref.set(ctx.activeInteractionMode, null);
            ctx.itemIdentityVersion = 2;
            const now = yield* DateTime.now;
            const providerThread = makeProviderThread({
              driver: ctx.driver,
              providerInstanceId: ctx.options.instanceId,
              idAllocator: ctx.idAllocator,
              appThreadId: forkInput.targetThreadId,
              providerSessionId: ctx.input.providerSessionId,
              nativeThreadId: forked.sessionId,
              itemIdentityVersion: 2,
              ...(forkInput.ownerNodeId === undefined
                ? {}
                : { ownerNodeId: forkInput.ownerNodeId }),
              forkedFrom: {
                providerThreadId: forkInput.sourceProviderThread.id,
                ...(forkInput.providerTurnId === undefined
                  ? {}
                  : { providerTurnId: forkInput.providerTurnId }),
              },
              now,
            });
            yield* Ref.update(ctx.providerThreadByNativeSessionId, (current) =>
              new Map(current).set(forked.sessionId, providerThread),
            );
            return providerThread;
          }),
        );
      },
      (effect, forkInput) =>
        effect.pipe(
          Effect.mapError(
            (cause) =>
              new ProviderAdapter.ProviderAdapterForkThreadError({
                driver: ctx.driver,
                providerThreadId: forkInput.sourceProviderThread.id,
                cause,
              }),
          ),
        ),
    ),
  };
  return runtimeObject;
};
