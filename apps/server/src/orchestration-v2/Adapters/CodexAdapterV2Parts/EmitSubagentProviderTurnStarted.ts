import { pipe } from "effect/Function";
import { isOrchestrationV2WorkActive } from "@t3tools/contracts";
import type { OrchestrationV2ExecutionNode, OrchestrationV2ProviderThread, OrchestrationV2Subagent, OrchestrationV2TurnItem } from "@t3tools/contracts";
import * as Digest from "effect/crypto/Digest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import type { CodexAdapterScope } from "../CodexAdapterV2.ts";
import { getNativeThreadId, isPersistentCodexDynamicTool, type ActiveCodexTurnContext, type CodexSubagentThreadContext, type PendingCodexSubagentTurnStarted } from "../CodexAdapterV2Prelude/BuildCodexTurnStartParams.ts";
import { CODEX_PROVIDER, codexItemStatus, codexNativeItemRef, decodeCodexBackgroundTerminalTerminateResponse, decodeCodexBackgroundTerminalsListResponse, projectCodexDynamicToolItem, toProtocolError, type CodexBackgroundTerminalsListPage, type CodexDynamicToolItem } from "../CodexAdapterV2Prelude/CodexProviderCapabilitiesV2.ts";
import type { RegisterRootTurnPart } from "./RegisterRootTurn.ts";

type Deps = CodexAdapterScope & RegisterRootTurnPart;

export const installEmitSubagentProviderTurnStarted = Effect.fnUntraced(function* (deps: Deps) {
  const { activeTurns, beginTurnTokenUsage, client, completedFinalAnswerTextsByTurn, digest, emitProviderEvent, endSessionApprovalsOnModeChange, finalAnswerItemIdsByTurn, findActiveTurnByNativeThreadId, idAllocator, imageTurns, input, nextProviderTurnOrdinals, now, offeredContinuationItemsByTurn, pendingSubagentTurns, runningCommandItemsByTurn, runningDynamicToolsByTurn, scope, settledTurns, subagentThreads, terminalizedNonCompletedNativeTurns, turnHasRetainedBackgroundWork } = deps;

const releaseSettledTurnIfIdle =
        /* Provider events include streaming deltas; avoid a span for each update. */
        Effect.fnUntraced(function* (nativeTurnId: string) {
          if (yield* turnHasRetainedBackgroundWork(nativeTurnId)) {
            return;
          }
          yield* Ref.update(settledTurns, (current) => {
            if (!current.has(nativeTurnId)) {
              return current;
            }
            const updated = new Map(current);
            updated.delete(nativeTurnId);
            return updated;
          });
          yield* Ref.update(offeredContinuationItemsByTurn, (current) => {
            if (!current.has(nativeTurnId)) {
              return current;
            }
            const updated = new Map(current);
            updated.delete(nativeTurnId);
            return updated;
          });
          yield* Ref.update(completedFinalAnswerTextsByTurn, (current) => {
            if (!current.has(nativeTurnId)) {
              return current;
            }
            const updated = new Map(current);
            updated.delete(nativeTurnId);
            return updated;
          });
          imageTurns.delete(nativeTurnId);
          yield* Ref.update(finalAnswerItemIdsByTurn, (current) => {
            if (!current.has(nativeTurnId)) {
              return current;
            }
            const updated = new Map(current);
            updated.delete(nativeTurnId);
            return updated;
          });
        });

const terminalizeRunningCommandItems = Effect.fn(
        "CodexAdapterV2.terminalizeRunningCommandItems",
      )(function* (
        context: ActiveCodexTurnContext,
        nativeTurnId: string,
        status: "interrupted" | "failed",
        completedAt: DateTime.Utc,
      ) {
        const items = (yield* Ref.get(runningCommandItemsByTurn)).get(nativeTurnId);
        if (items === undefined || items.size === 0) {
          return;
        }
        for (const tracked of items.values()) {
          const nodeId = idAllocator.derive.nodeFromProviderItem({
            driver: CODEX_PROVIDER,
            nativeItemId: tracked.id,
          });
          const turnItemId = idAllocator.derive.turnItemFromProviderItem({
            driver: CODEX_PROVIDER,
            nativeItemId: tracked.id,
          });
          const { ordinal, startedAt } = yield* resolveItemPosition(context, tracked.id);
          const node: OrchestrationV2ExecutionNode = {
            id: nodeId,
            threadId: context.projectionThreadId,
            runId: context.projectionRunId,
            parentNodeId: context.itemParentNodeId,
            rootNodeId: context.rootNodeId,
            kind: "tool_call",
            status,
            countsForRun: false,
            providerThreadId: context.providerThread.id,
            providerTurnId: context.providerTurnId,
            nativeItemRef: codexNativeItemRef(tracked.id),
            runtimeRequestId: null,
            checkpointScopeId: null,
            startedAt,
            completedAt,
          };
          const turnItem: OrchestrationV2TurnItem = {
            id: turnItemId,
            threadId: context.projectionThreadId,
            runId: context.projectionRunId,
            nodeId,
            providerThreadId: context.providerThread.id,
            providerTurnId: context.providerTurnId,
            nativeItemRef: codexNativeItemRef(tracked.id),
            parentItemId: null,
            ordinal,
            status,
            title: null,
            startedAt,
            completedAt,
            updatedAt: completedAt,
            type: "command_execution",
            input: tracked.command,
            ...(tracked.aggregatedOutput === undefined
              ? {}
              : { output: tracked.aggregatedOutput }),
          };
          yield* emitProviderEvent({
            type: "node.updated",
            driver: CODEX_PROVIDER,
            node,
          });
          yield* emitProviderEvent({
            type: "turn_item.updated",
            driver: CODEX_PROVIDER,
            turnItem,
          });
        }
      });

const terminateBackgroundTerminal = Effect.fn("CodexAdapterV2.terminateBackgroundTerminal")(
        function* (nativeThreadId: string, processId: string) {
          const response = yield* client.raw
            .request("thread/backgroundTerminals/terminate", {
              threadId: nativeThreadId,
              processId,
            })
            .pipe(
              Effect.catchTags({
                CodexAppServerProcessExitedError: () => Effect.succeed({ terminated: true }),
                CodexAppServerInputStreamEndedError: () => Effect.succeed({ terminated: true }),
                // Unloading kills terminals, so "thread not found" means nothing remains to stop.
                CodexAppServerRequestError: (error) =>
                  error.code === -32600 && error.errorMessage.startsWith("thread not found:")
                    ? Effect.succeed({ terminated: true })
                    : Effect.fail(error),
              }),
            );
          const result = yield* decodeCodexBackgroundTerminalTerminateResponse(response);
          if (result.terminated) return;
          let cursor: string | null = null;
          while (true) {
            const response: unknown = yield* client.raw.request(
              "thread/backgroundTerminals/list",
              {
                threadId: nativeThreadId,
                ...(cursor === null ? {} : { cursor }),
              },
            );
            const page: CodexBackgroundTerminalsListPage =
              yield* decodeCodexBackgroundTerminalsListResponse(response);
            if (page.data.some((terminal) => terminal.processId === processId)) {
              return yield* toProtocolError(
                `Codex background terminal ${processId} remained active after termination.`,
              );
            }
            if (page.nextCursor === null) return;
            cursor = page.nextCursor;
          }
        },
        Effect.timeout("10 seconds"),
      );

const terminalizeRunningDynamicTools = Effect.fn(
        "CodexAdapterV2.terminalizeRunningDynamicTools",
      )(function* (
        context: ActiveCodexTurnContext,
        nativeTurnId: string,
        status: "cancelled" | "interrupted" | "failed",
        completedAt: DateTime.Utc,
        includePersistent: boolean,
      ) {
        const items = (yield* Ref.get(runningDynamicToolsByTurn)).get(nativeTurnId);
        if (items === undefined || items.size === 0) {
          return;
        }
        for (const tracked of items.values()) {
          if (!includePersistent && isPersistentCodexDynamicTool(tracked)) {
            continue;
          }
          const artifacts = yield* buildDynamicToolArtifacts(context, tracked);
          yield* emitProviderEvent({
            type: "node.updated",
            driver: CODEX_PROVIDER,
            node: {
              ...artifacts.node,
              status,
              completedAt,
            },
          });
          yield* emitProviderEvent({
            type: "turn_item.updated",
            driver: CODEX_PROVIDER,
            turnItem: {
              ...artifacts.turnItem,
              status,
              completedAt,
              updatedAt: completedAt,
            },
          });
        }
        yield* Ref.update(runningDynamicToolsByTurn, (current) => {
          if (!current.has(nativeTurnId)) {
            return current;
          }
          const remaining = new Map(current.get(nativeTurnId) ?? []);
          for (const tracked of remaining.values()) {
            if (includePersistent || !isPersistentCodexDynamicTool(tracked)) {
              remaining.delete(tracked.id);
            }
          }
          const updated = new Map(current);
          if (remaining.size === 0) {
            updated.delete(nativeTurnId);
          } else {
            updated.set(nativeTurnId, remaining);
          }
          return updated;
        });
      });

const resolveItemPosition =
        /* Provider events include streaming deltas; avoid a span for each update. */
        Effect.fnUntraced(function* (
          context: ActiveCodexTurnContext,
          nativeItemId: string,
          startedAt?: DateTime.Utc,
        ) {
          // Read the clock first so the lookup and the insert run without yielding.
          const now = startedAt ?? (yield* DateTime.now);
          const existing = context.itemPositions.get(nativeItemId);
          if (existing !== undefined) {
            return existing;
          }
          const position = {
            ordinal: context.providerTurnOrdinal * 100 + context.itemPositions.size + 1,
            startedAt: now,
          };
          context.itemPositions.set(nativeItemId, position);
          return position;
        });

const resolveItemOrdinal = (context: ActiveCodexTurnContext, nativeItemId: string) =>
        resolveItemPosition(context, nativeItemId).pipe(
          Effect.map((position) => position.ordinal),
        );

const nextProviderTurnOrdinal = (
        providerThreadId: OrchestrationV2ProviderThread["id"],
        minimum: number,
      ) =>
        Ref.modify(nextProviderTurnOrdinals, (current) => {
          const previous = current.get(String(providerThreadId));
          const next = previous === undefined ? minimum : Math.max(previous + 1, minimum);
          const updated = new Map(current);
          updated.set(String(providerThreadId), next);
          return [next, updated];
        });

const emitSubagentTaskUpdate =
        /* Provider events include streaming deltas; avoid a span for each update. */
        Effect.fnUntraced(function* (input: {
          readonly subagent: CodexSubagentThreadContext;
          readonly status: OrchestrationV2Subagent["status"];
          readonly result?: string | null;
          readonly completedAt?: DateTime.Utc | null;
          readonly startedAt?: DateTime.Utc;
          readonly reopen?: boolean;
        }) {
          const now = yield* DateTime.now;
          const prior = input.subagent.task;
          const settled = !isOrchestrationV2WorkActive(prior.status);
          // Late snapshots must not reopen completed children; only new turns may.
          if (settled && isOrchestrationV2WorkActive(input.status) && !input.reopen) return;
          const status = settled && !input.reopen ? prior.status : input.status;
          const completedAt = isOrchestrationV2WorkActive(status)
            ? null
            : (prior.completedAt ?? input.completedAt ?? now);
          const task = {
            ...prior,
            status,
            ...(input.reopen
              ? {
                  runId: input.subagent.parentContext.projectionRunId,
                  parentNodeId: input.subagent.parentContext.itemParentNodeId,
                }
              : {}),
            startedAt: input.startedAt ?? prior.startedAt,
            result: input.result === undefined ? input.subagent.task.result : input.result,
            completedAt,
            updatedAt: now,
          } satisfies OrchestrationV2Subagent;
          input.subagent.task = task;
          if (input.startedAt !== undefined) input.subagent.startedAt = input.startedAt;

          yield* emitProviderEvent({
            type: "subagent.updated",
            driver: CODEX_PROVIDER,
            subagent: task,
          });
          yield* emitProviderEvent({
            type: "turn_item.updated",
            driver: CODEX_PROVIDER,
            turnItem: {
              id: input.subagent.turnItemId,
              threadId: task.threadId,
              runId: task.runId,
              nodeId: task.id,
              providerThreadId: task.providerThreadId,
              providerTurnId: input.subagent.parentContext.providerTurnId,
              nativeItemRef: task.nativeTaskRef,
              parentItemId: null,
              ordinal: input.subagent.turnItemOrdinal,
              status: task.status,
              title: task.title,
              startedAt: task.startedAt,
              completedAt: task.completedAt,
              updatedAt: task.updatedAt,
              type: "subagent",
              subagentId: task.id,
              origin: task.origin,
              driver: task.driver,
              providerInstanceId: task.providerInstanceId,
              childThreadId: task.childThreadId,
              prompt: task.prompt,
              result: task.result,
            },
          });
        });

const emitSubagentProviderTurnStarted =
        /* Provider events include streaming deltas; avoid a span for each update. */
        Effect.fnUntraced(function* (
          subagent: CodexSubagentThreadContext,
          turn: PendingCodexSubagentTurnStarted,
        ) {
          if (subagent.nativeTurnIds.has(turn.nativeTurnId)) return;
          subagent.nativeTurnIds.add(turn.nativeTurnId);
          const parentNativeThreadId = yield* getNativeThreadId(
            subagent.parentContext.providerThread,
          );
          const currentParent = yield* findActiveTurnByNativeThreadId(parentNativeThreadId);
          if (currentParent !== undefined) subagent.parentContext = currentParent;
          const terminalizedNativeTurns = yield* Ref.get(terminalizedNonCompletedNativeTurns);
          let ancestor: ActiveCodexTurnContext | undefined = subagent.parentContext;
          while (ancestor !== undefined) {
            if (terminalizedNativeTurns.has(ancestor.nativeTurnId)) {
              const nativeThreadId = yield* getNativeThreadId(subagent.providerThread);
              // Fork requests off the notification reader so it can read their responses.
              yield* client
                .request("turn/interrupt", {
                  threadId: nativeThreadId,
                  turnId: turn.nativeTurnId,
                })
                .pipe(
                  Effect.catch((cause) =>
                    Effect.logWarning("orchestration-v2.codex-late-subagent-interrupt-failed", {
                      nativeThreadId,
                      nativeTurnId: turn.nativeTurnId,
                      cause,
                    }),
                  ),
                  Effect.timeoutOrElse({
                    duration: "10 seconds",
                    orElse: () =>
                      Effect.logWarning(
                        "orchestration-v2.codex-late-subagent-interrupt-timeout",
                        {
                          nativeThreadId,
                          nativeTurnId: turn.nativeTurnId,
                        },
                      ),
                  }),
                  Effect.forkIn(scope),
                );
              return;
            }
            ancestor = ancestor.subagent?.parentContext;
          }
          const providerTurnId = idAllocator.derive.providerTurn({
            driver: CODEX_PROVIDER,
            nativeTurnId: turn.nativeTurnId,
          });
          const providerTurnOrdinal = yield* nextProviderTurnOrdinal(
            subagent.providerThread.id,
            1,
          );
          const providerNodeId =
            providerTurnOrdinal === 1
              ? subagent.childRootNodeId
              : idAllocator.derive.nodeFromProviderItem({
                  driver: CODEX_PROVIDER,
                  nativeItemId: `${turn.nativeTurnId}:thread-root`,
                });
          const activeContext: ActiveCodexTurnContext = {
            input: subagent.parentContext.input,
            projectionAppThread: subagent.childThread,
            projectionThreadId: subagent.childThreadId,
            projectionRunId: null,
            nativeTurnId: turn.nativeTurnId,
            providerThread: subagent.providerThread,
            providerTurnId,
            providerTurnOrdinal,
            providerNodeId,
            providerNodeStartedAt: turn.startedAt,
            itemParentNodeId: providerNodeId,
            rootNodeId: providerNodeId,
            subagent,
            startedAt: turn.startedAt,
            itemPositions: new Map(),
            fileChangeKindsByItem: new Map(),
            runningCompactionItemIds: new Set(),
          };
          beginTurnTokenUsage(activeContext);
          endSessionApprovalsOnModeChange(activeContext);
          yield* Ref.update(activeTurns, (current) => {
            const updated = new Map(current);
            updated.set(turn.nativeTurnId, activeContext);
            return updated;
          });
          yield* emitSubagentTaskUpdate({
            subagent,
            status: "running",
            startedAt: turn.startedAt,
            ...(providerTurnOrdinal > 1 ? { reopen: true, result: null } : {}),
          });
          const now = yield* DateTime.now;
          yield* emitProviderEvent({
            type: "provider_thread.updated",
            driver: CODEX_PROVIDER,
            providerThread: {
              ...subagent.providerThread,
              status: "active",
              updatedAt: now,
            },
          });
          yield* emitProviderEvent({
            type: "provider_turn.updated",
            driver: CODEX_PROVIDER,
            threadId: subagent.childThreadId,
            providerTurn: {
              id: providerTurnId,
              providerThreadId: subagent.providerThread.id,
              nodeId: providerNodeId,
              runAttemptId: null,
              nativeTurnRef: {
                driver: CODEX_PROVIDER,
                nativeId: turn.nativeTurnId,
                strength: "strong",
              },
              ordinal: activeContext.providerTurnOrdinal,
              status: "running",
              startedAt: turn.startedAt,
              completedAt: null,
            },
          });
          yield* emitProviderEvent({
            type: "node.updated",
            driver: CODEX_PROVIDER,
            node: {
              id: providerNodeId,
              threadId: subagent.childThreadId,
              runId: null,
              parentNodeId: null,
              rootNodeId: providerNodeId,
              kind: "root_turn",
              status: "running",
              countsForRun: false,
              providerThreadId: subagent.providerThread.id,
              providerTurnId,
              nativeItemRef: subagent.task.nativeTaskRef,
              runtimeRequestId: null,
              checkpointScopeId: null,
              startedAt: turn.startedAt,
              completedAt: null,
            },
          });
        });

const rememberSubagentTurnStarted =
        /* Provider events include streaming deltas; avoid a span for each update. */
        Effect.fnUntraced(function* (input: {
          readonly nativeThreadId: string;
          readonly nativeTurnId: string;
          readonly startedAt: DateTime.Utc;
        }) {
          const subagent = (yield* Ref.get(subagentThreads)).get(input.nativeThreadId);
          if (subagent !== undefined) {
            yield* emitSubagentProviderTurnStarted(subagent, input);
            return;
          }
          yield* Ref.update(pendingSubagentTurns, (current) => {
            const updated = new Map(current);
            updated.set(input.nativeThreadId, [
              ...(updated.get(input.nativeThreadId) ?? []),
              { nativeTurnId: input.nativeTurnId, startedAt: input.startedAt },
            ]);
            return updated;
          });
        });

const buildDynamicToolArtifacts = Effect.fn("CodexAdapterV2.buildDynamicToolArtifacts")(
        function* (context: ActiveCodexTurnContext, item: CodexDynamicToolItem) {
          const updatedAt = yield* DateTime.now;
          const status = codexItemStatus(item.status);
          const completedAt = status.completed ? updatedAt : null;
          const nodeId = idAllocator.derive.nodeFromProviderItem({
            driver: CODEX_PROVIDER,
            nativeItemId: item.id,
          });
          const turnItemId = idAllocator.derive.turnItemFromProviderItem({
            driver: CODEX_PROVIDER,
            nativeItemId: item.id,
          });
          const { ordinal, startedAt } = yield* resolveItemPosition(context, item.id);
          const projection = yield* projectCodexDynamicToolItem(item).pipe(
            Effect.provideService(Digest.Digest, digest),
          );
          const node: OrchestrationV2ExecutionNode = {
            id: nodeId,
            threadId: context.projectionThreadId,
            runId: context.projectionRunId,
            parentNodeId: context.itemParentNodeId,
            rootNodeId: context.rootNodeId,
            kind: "tool_call",
            status: status.node,
            countsForRun: false,
            providerThreadId: context.providerThread.id,
            providerTurnId: context.providerTurnId,
            nativeItemRef: codexNativeItemRef(item.id),
            runtimeRequestId: null,
            checkpointScopeId: null,
            startedAt,
            completedAt,
          };
          const turnItem: OrchestrationV2TurnItem = {
            id: turnItemId,
            threadId: context.projectionThreadId,
            runId: context.projectionRunId,
            nodeId,
            providerThreadId: context.providerThread.id,
            providerTurnId: context.providerTurnId,
            nativeItemRef: codexNativeItemRef(item.id),
            parentItemId: null,
            ordinal,
            title: projection.title ?? null,
            startedAt,
            completedAt,
            updatedAt,
            type: "dynamic_tool",
            ...projection,
          };
          return { node, turnItem };
        },
      );

  return { releaseSettledTurnIfIdle, terminalizeRunningCommandItems, terminateBackgroundTerminal, terminalizeRunningDynamicTools, resolveItemPosition, resolveItemOrdinal, nextProviderTurnOrdinal, emitSubagentTaskUpdate, emitSubagentProviderTurnStarted, rememberSubagentTurnStarted, buildDynamicToolArtifacts };
});

export type EmitSubagentProviderTurnStartedPart = ReturnType<typeof installEmitSubagentProviderTurnStarted> extends Effect.Effect<infer A, infer _E, infer _R> ? A : ReturnType<typeof installEmitSubagentProviderTurnStarted>;
