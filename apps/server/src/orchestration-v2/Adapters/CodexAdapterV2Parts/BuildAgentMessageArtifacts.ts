import { makeProviderTextDeltaCoalescer } from "../ProviderTextDeltaCoalescer.ts";
import type { OrchestrationV2ConversationMessage, OrchestrationV2ExecutionNode, OrchestrationV2TurnItem } from "@t3tools/contracts";
import * as CodexSchema from "effect-codex-app-server/schema";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import { makeSubagentConversationArtifacts } from "@t3tools/provider-core/server/subagentProjection";
import type { CodexAdapterScope } from "../CodexAdapterV2.ts";
import { type ActiveCodexTurnContext } from "../CodexAdapterV2Prelude/BuildCodexTurnStartParams.ts";
import { CODEX_ASSISTANT_DELTA_FLUSH_INTERVAL_MS, CODEX_PROVIDER, codexItemStatus, codexNativeItemRef, codexUserMessageText, type CodexWebSearchItem, webSearchPatterns } from "../CodexAdapterV2Prelude/CodexProviderCapabilitiesV2.ts";
import type { RegisterRootTurnPart } from "./RegisterRootTurn.ts";
import type { EmitSubagentProviderTurnStartedPart } from "./EmitSubagentProviderTurnStarted.ts";
import type { RegisterSubagentThreadPart } from "./RegisterSubagentThread.ts";

type Deps = CodexAdapterScope & RegisterRootTurnPart & EmitSubagentProviderTurnStartedPart & RegisterSubagentThreadPart;

export const installBuildAgentMessageArtifacts = Effect.fnUntraced(function* (deps: Deps) {
  const { awaitActiveTurn, completeProviderRetry, completedFinalAnswerTextsByTurn, emitProviderEvent, finalAnswerItemIdsByTurn, idAllocator, imageTurn, input, resolveItemOrdinal, resolveItemPosition, terminalizedNonCompletedNativeTurns } = deps;

const buildAgentMessageArtifacts = Effect.fnUntraced(function* (
        context: ActiveCodexTurnContext,
        item: { readonly id: string; readonly text: string },
        completed: boolean,
      ) {
        const updatedAt = yield* DateTime.now;
        const completedAt = completed ? updatedAt : null;
        const nodeId = idAllocator.derive.nodeFromProviderItem({
          driver: CODEX_PROVIDER,
          nativeItemId: item.id,
        });
        const { ordinal, startedAt } = yield* resolveItemPosition(context, item.id);
        const messageId = idAllocator.derive.messageFromProviderItem({
          driver: CODEX_PROVIDER,
          nativeItemId: item.id,
        });
        const turnItemId = idAllocator.derive.turnItemFromProviderItem({
          driver: CODEX_PROVIDER,
          nativeItemId: item.id,
        });
        const node: OrchestrationV2ExecutionNode = {
          id: nodeId,
          threadId: context.projectionThreadId,
          runId: context.projectionRunId,
          parentNodeId: context.itemParentNodeId,
          rootNodeId: context.rootNodeId,
          kind: "assistant_message",
          status: completed ? "completed" : "running",
          countsForRun: false,
          providerThreadId: context.providerThread.id,
          providerTurnId: context.providerTurnId,
          nativeItemRef: codexNativeItemRef(item.id),
          runtimeRequestId: null,
          checkpointScopeId: null,
          startedAt,
          completedAt,
        };
        const message: OrchestrationV2ConversationMessage = {
          createdBy: "agent",
          creationSource: "provider",
          id: messageId,
          threadId: context.projectionThreadId,
          runId: context.projectionRunId,
          nodeId,
          role: "assistant",
          text: item.text,
          attachments: [],
          streaming: !completed,
          createdAt: startedAt,
          updatedAt,
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
          status: completed ? "completed" : "running",
          title: null,
          startedAt,
          completedAt,
          updatedAt,
          type: "assistant_message",
          messageId,
          text: item.text,
          streaming: !completed,
        };
        return { node, message, turnItem };
      });

const reasoningParts = new Map<
        string,
        { turnId: string; nativeItemId: string; stream: "summary" | "content"; index: number }
      >();

const reasoningDeltas = yield* makeProviderTextDeltaCoalescer({
        flushIntervalMs: CODEX_ASSISTANT_DELTA_FLUSH_INTERVAL_MS,
        emit:
          /* Provider events include streaming deltas; avoid a span for each update. */
          Effect.fnUntraced(function* (update) {
            const part = reasoningParts.get(update.itemId);
            if (part === undefined) return;
            const context = yield* awaitActiveTurn(update.turnId);
            if (context === undefined) return;
            const artifacts = yield* buildAgentMessageArtifacts(
              context,
              { id: update.itemId, text: update.text },
              update.completed,
            );
            const interrupted = (yield* Ref.get(terminalizedNonCompletedNativeTurns)).has(
              update.turnId,
            );
            const { messageId: _messageId, ...item } = artifacts.turnItem;
            const nativeItemRef = codexNativeItemRef(part.nativeItemId);
            yield* emitProviderEvent({
              type: "node.updated",
              driver: CODEX_PROVIDER,
              node: {
                ...artifacts.node,
                kind: "reasoning",
                nativeItemRef,
                ...(interrupted ? { status: "interrupted" as const } : {}),
              },
            });
            yield* emitProviderEvent({
              type: "turn_item.updated",
              driver: CODEX_PROVIDER,
              turnItem: {
                ...item,
                type: "reasoning",
                nativeItemRef,
                ...(interrupted ? { status: "interrupted" as const } : {}),
              },
            });
          }),
      });

const reasoningPartKey = (
        turnId: string,
        nativeItemId: string,
        stream: "summary" | "content",
        index: number,
      ) => {
        const key = JSON.stringify([turnId, nativeItemId, stream, index]);
        reasoningParts.set(key, { turnId, nativeItemId, stream, index });
        return key;
      };

const appendReasoning = Effect.fn("CodexAdapterV2.appendReasoning")(function* (
        payload: { turnId: string; itemId: string; delta: string },
        stream: "summary" | "content",
        index: number,
      ) {
        const context = yield* awaitActiveTurn(payload.turnId);
        if (context === undefined || payload.delta.length === 0) return;
        yield* completeProviderRetry(context, yield* DateTime.now);
        const itemId = reasoningPartKey(payload.turnId, payload.itemId, stream, index);
        // Reserve positions before delayed flushes so later tools stay after them.
        yield* resolveItemOrdinal(context, itemId);
        yield* reasoningDeltas.append({ turnId: payload.turnId, itemId, delta: payload.delta });
      });

const completeReasoning = Effect.fn("CodexAdapterV2.completeReasoning")(function* (
        turnId: string,
        item: { id: string; summary?: ReadonlyArray<string>; content?: ReadonlyArray<string> },
      ) {
        for (const stream of ["summary", "content"] as const) {
          for (const [index] of (item[stream] ?? []).entries()) {
            reasoningPartKey(turnId, item.id, stream, index);
          }
        }
        for (const [key, part] of reasoningParts) {
          if (part.turnId !== turnId || part.nativeItemId !== item.id) continue;
          const finalText = item[part.stream]?.[part.index];
          yield* reasoningDeltas.complete({
            turnId,
            itemId: key,
            ...(finalText ? { finalText } : {}),
            emitEmpty: false,
          });
          reasoningParts.delete(key);
        }
      });

const agentMessageDeltas = yield* makeProviderTextDeltaCoalescer({
        flushIntervalMs: CODEX_ASSISTANT_DELTA_FLUSH_INTERVAL_MS,
        emit:
          /* Provider events include streaming deltas; avoid a span for each update. */
          Effect.fnUntraced(function* (update) {
            const context = yield* awaitActiveTurn(update.turnId);
            if (context === undefined) {
              return;
            }
            const finalAnswerItem = (yield* Ref.get(finalAnswerItemIdsByTurn))
              .get(update.turnId)
              ?.has(update.itemId);
            if (finalAnswerItem) {
              const finalAnswerItemIds = (yield* Ref.get(finalAnswerItemIdsByTurn)).get(
                update.turnId,
              );
              const completedTexts =
                (yield* Ref.get(completedFinalAnswerTextsByTurn)).get(update.turnId) ??
                new Set<string>();
              const firstFinalAnswerItemId = finalAnswerItemIds?.values().next().value;
              const duplicateCompletion =
                update.completed &&
                completedTexts.size > 0 &&
                (update.text.length === 0 || completedTexts.has(update.text));
              const deferredStreamingUpdate =
                !update.completed &&
                (completedTexts.size > 0 || firstFinalAnswerItemId !== update.itemId);
              if (deferredStreamingUpdate || duplicateCompletion) {
                return;
              }
            }
            const artifacts = yield* buildAgentMessageArtifacts(
              context,
              { id: update.itemId, text: update.text },
              update.completed,
            );
            yield* emitProviderEvent({
              type: "node.updated",
              driver: CODEX_PROVIDER,
              node: artifacts.node,
            });
            if (update.completed) {
              yield* emitProviderEvent({
                type: "message.updated",
                driver: CODEX_PROVIDER,
                message: artifacts.message,
              });
            }
            yield* emitProviderEvent({
              type: "turn_item.updated",
              driver: CODEX_PROVIDER,
              turnItem: artifacts.turnItem,
            });
            if (finalAnswerItem && update.completed) {
              imageTurn(update.turnId).answer = { id: update.itemId, text: update.text };
              yield* Ref.update(completedFinalAnswerTextsByTurn, (current) => {
                const updated = new Map(current);
                const texts = new Set(updated.get(update.turnId) ?? []);
                texts.add(update.text);
                updated.set(update.turnId, texts);
                return updated;
              });
            }
          }),
      });

const emitSubagentUserMessage =
        /* Provider events include streaming deltas; avoid a span for each update. */
        Effect.fnUntraced(function* (
          context: ActiveCodexTurnContext,
          item: Extract<
            | CodexSchema.V2ItemStartedNotification__ThreadItem
            | CodexSchema.V2ItemCompletedNotification__ThreadItem,
            { type: "userMessage" }
          >,
          nativeStartedAt?: DateTime.Utc,
        ) {
          if (context.subagent === null || context.providerTurnOrdinal === 1) {
            return false;
          }
          const text = codexUserMessageText(item.content);
          if (text.length === 0) {
            return false;
          }
          const { ordinal, startedAt } = yield* resolveItemPosition(
            context,
            item.id,
            nativeStartedAt,
          );
          const artifacts = makeSubagentConversationArtifacts({
            senderThreadId: context.subagent.parentContext.projectionThreadId,
            messageId: idAllocator.derive.messageFromProviderItem({
              driver: CODEX_PROVIDER,
              nativeItemId: item.id,
            }),
            turnItemId: idAllocator.derive.turnItemFromProviderItem({
              driver: CODEX_PROVIDER,
              nativeItemId: item.id,
            }),
            threadId: context.projectionThreadId,
            rootNodeId: context.rootNodeId,
            providerThreadId: context.providerThread.id,
            providerTurnId: context.providerTurnId,
            nativeItemRef: codexNativeItemRef(item.id),
            role: "user",
            text,
            ordinal,
            now: startedAt,
          });
          yield* emitProviderEvent({
            type: "message.updated",
            driver: CODEX_PROVIDER,
            message: artifacts.message,
          });
          yield* emitProviderEvent({
            type: "turn_item.updated",
            driver: CODEX_PROVIDER,
            turnItem: artifacts.turnItem,
          });
          return true;
        });

const buildCommandExecutionArtifacts = Effect.fn(
        "CodexAdapterV2.buildCommandExecutionArtifacts",
      )(function* (
        context: ActiveCodexTurnContext,
        item: Extract<
          | CodexSchema.V2ItemStartedNotification__ThreadItem
          | CodexSchema.V2ItemCompletedNotification__ThreadItem,
          { type: "commandExecution" }
        >,
      ) {
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
          status: status.turnItem,
          title: null,
          startedAt,
          completedAt,
          updatedAt,
          type: "command_execution",
          input: item.command,
          ...(item.aggregatedOutput === null || item.aggregatedOutput === undefined
            ? {}
            : { output: item.aggregatedOutput }),
          ...(item.exitCode === null || item.exitCode === undefined
            ? {}
            : { exitCode: item.exitCode }),
        };
        return { node, turnItem };
      });

const buildFileChangeArtifacts = Effect.fn("CodexAdapterV2.buildFileChangeArtifacts")(
        function* (
          context: ActiveCodexTurnContext,
          item: Extract<
            CodexSchema.V2ItemCompletedNotification__ThreadItem,
            { type: "fileChange" }
          >,
        ) {
          const firstChange = item.changes[0];
          if (firstChange === undefined) {
            return null;
          }

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
            status: status.turnItem,
            title: null,
            startedAt,
            completedAt,
            updatedAt,
            type: "file_change",
            fileName: firstChange.path,
            diffStr: firstChange.diff,
            changes: item.changes.map((change) => {
              const movePath = change.kind.type === "update" ? change.kind.move_path : undefined;
              return movePath
                ? { operation: change.kind.type, path: movePath, oldPath: change.path }
                : { operation: change.kind.type, path: change.path };
            }),
          };
          return { node, turnItem };
        },
      );

const buildWebSearchArtifacts = Effect.fn("CodexAdapterV2.buildWebSearchArtifacts")(
        function* (input: {
          readonly context: ActiveCodexTurnContext;
          readonly item: CodexWebSearchItem;
          readonly completed: boolean;
        }) {
          const updatedAt = yield* DateTime.now;
          const completedAt = input.completed ? updatedAt : null;
          const nodeId = idAllocator.derive.nodeFromProviderItem({
            driver: CODEX_PROVIDER,
            nativeItemId: input.item.id,
          });
          const turnItemId = idAllocator.derive.turnItemFromProviderItem({
            driver: CODEX_PROVIDER,
            nativeItemId: input.item.id,
          });
          const { ordinal, startedAt } = yield* resolveItemPosition(input.context, input.item.id);
          const patterns = webSearchPatterns(input.item);
          const status = input.completed ? "completed" : "running";
          const node: OrchestrationV2ExecutionNode = {
            id: nodeId,
            threadId: input.context.projectionThreadId,
            runId: input.context.projectionRunId,
            parentNodeId: input.context.itemParentNodeId,
            rootNodeId: input.context.rootNodeId,
            kind: "tool_call",
            status,
            countsForRun: false,
            providerThreadId: input.context.providerThread.id,
            providerTurnId: input.context.providerTurnId,
            nativeItemRef: codexNativeItemRef(input.item.id),
            runtimeRequestId: null,
            checkpointScopeId: null,
            startedAt,
            completedAt,
          };
          const turnItem: OrchestrationV2TurnItem = {
            id: turnItemId,
            threadId: input.context.projectionThreadId,
            runId: input.context.projectionRunId,
            nodeId,
            providerThreadId: input.context.providerThread.id,
            providerTurnId: input.context.providerTurnId,
            nativeItemRef: codexNativeItemRef(input.item.id),
            parentItemId: null,
            ordinal,
            status,
            title: null,
            startedAt,
            completedAt,
            updatedAt,
            type: "web_search",
            ...(patterns.length === 0 ? {} : { patterns: [...patterns] }),
          };
          return { node, turnItem };
        },
      );

  return { buildAgentMessageArtifacts, reasoningParts, reasoningDeltas, reasoningPartKey, appendReasoning, completeReasoning, agentMessageDeltas, emitSubagentUserMessage, buildCommandExecutionArtifacts, buildFileChangeArtifacts, buildWebSearchArtifacts };
});

export type BuildAgentMessageArtifactsPart = ReturnType<typeof installBuildAgentMessageArtifacts> extends Effect.Effect<infer A, infer _E, infer _R> ? A : ReturnType<typeof installBuildAgentMessageArtifacts>;
