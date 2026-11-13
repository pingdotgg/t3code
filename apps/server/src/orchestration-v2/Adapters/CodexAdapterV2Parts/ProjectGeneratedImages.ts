import { pipe } from "effect/Function";
import { appendGeneratedImageEmbeds } from "@t3tools/shared/generatedImageMarkdown";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import { backgroundWorkNotification } from "@t3tools/provider-core/server/notification";
import type { CodexAdapterScope } from "../CodexAdapterV2.ts";
import { CODEX_PROVIDER, codexBackgroundCommandDetail, codexItemStatus, codexMcpAppResourceUri } from "../CodexAdapterV2Prelude/CodexProviderCapabilitiesV2.ts";
import { type ActiveCodexTurnContext } from "../CodexAdapterV2Prelude/BuildCodexTurnStartParams.ts";
import type { RegisterRootTurnPart } from "./RegisterRootTurn.ts";
import type { EmitSubagentProviderTurnStartedPart } from "./EmitSubagentProviderTurnStarted.ts";
import type { RegisterSubagentThreadPart } from "./RegisterSubagentThread.ts";
import type { BuildAgentMessageArtifactsPart } from "./BuildAgentMessageArtifacts.ts";
import type { BuildUserInputRequestArtifactsPart } from "./BuildUserInputRequestArtifacts.ts";
import type { EmitRootTerminalPart } from "./EmitRootTerminal.ts";

type Deps = CodexAdapterScope & RegisterRootTurnPart & EmitSubagentProviderTurnStartedPart & RegisterSubagentThreadPart & BuildAgentMessageArtifactsPart & BuildUserInputRequestArtifactsPart & EmitRootTerminalPart;

export const installProjectGeneratedImages = Effect.fnUntraced(function* (deps: Deps) {
  const { agentMessageDeltas, awaitActiveTurn, buildAgentMessageArtifacts, buildCommandExecutionArtifacts, buildDynamicToolArtifacts, buildFileChangeArtifacts, buildUserInputRequestArtifacts, buildWebSearchArtifacts, captureMcpApp, clearRunningCommandItem, clearRunningDynamicTool, client, completeProviderRetry, completeReasoning, completedFinalAnswerTextsByTurn, continuationRequests, emitCompactionItem, emitImageWorkState, emitProviderEvent, emitSubagentTaskUpdate, emitSubagentUserMessage, finalAnswerItemIdsByTurn, imageTurn, imageTurns, interruptingNativeTurns, markSubagentUsage, offeredContinuationItemsByTurn, planDeltas, registerSubagentActivity, registerSubagentThreads, releaseSettledTurnIfIdle, resolveItemEventContext, resolveItemPosition, restoreAdditionalContext, scope, terminalizedNonCompletedNativeTurns, trackRunningCommandItem, trackRunningDynamicTool, turnTerminalizationPermit, updateSubagentStates } = deps;

yield* client.handleServerNotification("item/started", (payload) =>
        Effect.gen(function* () {
          const context = yield* awaitActiveTurn(payload.turnId);
          if (context === undefined) {
            return;
          }

          if (payload.item.type === "contextCompaction") {
            yield* emitCompactionItem(
              context,
              payload.item.id,
              "running",
              DateTime.makeUnsafe(payload.startedAtMs),
            );
            return;
          }

          if (payload.item.type === "userMessage") {
            yield* emitSubagentUserMessage(
              context,
              payload.item,
              DateTime.makeUnsafe(payload.startedAtMs),
            );
            return;
          }

          if (payload.item.type === "subAgentActivity") {
            markSubagentUsage(context);
            yield* registerSubagentActivity({
              context,
              item: payload.item,
            });
            return;
          }

          yield* completeProviderRetry(context, yield* DateTime.now);
          if (payload.item.type !== "reasoning") {
            yield* resolveItemPosition(
              context,
              payload.item.id,
              DateTime.makeUnsafe(payload.startedAtMs),
            );
          }

          if (payload.item.type === "fileChange") {
            context.fileChangeKindsByItem.set(
              payload.item.id,
              Object.fromEntries(payload.item.changes.map(({ path, kind }) => [path, kind])),
            );
            return;
          }

          if (payload.item.type === "agentMessage") {
            if (payload.item.phase == null || payload.item.phase === "final_answer") {
              yield* Ref.update(finalAnswerItemIdsByTurn, (current) => {
                const updated = new Map(current);
                const itemIds = new Set(updated.get(payload.turnId) ?? []);
                itemIds.add(payload.item.id);
                updated.set(payload.turnId, itemIds);
                return updated;
              });
            }
            return;
          }

          if (payload.item.type === "imageGeneration") {
            if (!(yield* Ref.get(interruptingNativeTurns)).has(payload.turnId)) {
              imageTurn(payload.turnId).running.add(payload.item.id);
              yield* emitImageWorkState(context, true);
            }
            return;
          }

          if (payload.item.type === "commandExecution") {
            if (!codexItemStatus(payload.item.status).completed) {
              yield* trackRunningCommandItem(payload.turnId, {
                id: payload.item.id,
                command: payload.item.command,
                ...(payload.item.aggregatedOutput === null ||
                payload.item.aggregatedOutput === undefined
                  ? {}
                  : { aggregatedOutput: payload.item.aggregatedOutput }),
                ...(typeof payload.item.processId === "string"
                  ? { processId: payload.item.processId }
                  : {}),
              });
            }
            const artifacts = yield* buildCommandExecutionArtifacts(context, payload.item);
            yield* emitProviderEvent({
              type: "node.updated",
              driver: CODEX_PROVIDER,
              node: artifacts.node,
            });
            yield* emitProviderEvent({
              type: "turn_item.updated",
              driver: CODEX_PROVIDER,
              turnItem: artifacts.turnItem,
            });
            return;
          }

          if (payload.item.type === "mcpToolCall" || payload.item.type === "dynamicToolCall") {
            if (!codexItemStatus(payload.item.status).completed) {
              yield* trackRunningDynamicTool(payload.turnId, payload.item);
            }
            const artifacts = yield* buildDynamicToolArtifacts(context, payload.item);
            yield* emitProviderEvent({
              type: "node.updated",
              driver: CODEX_PROVIDER,
              node: artifacts.node,
            });
            yield* emitProviderEvent({
              type: "turn_item.updated",
              driver: CODEX_PROVIDER,
              turnItem: artifacts.turnItem,
            });
            return;
          }

          if (payload.item.type !== "webSearch") {
            return;
          }

          const artifacts = yield* buildWebSearchArtifacts({
            context,
            item: payload.item,
            completed: false,
          });
          yield* emitProviderEvent({
            type: "node.updated",
            driver: CODEX_PROVIDER,
            node: artifacts.node,
          });
          yield* emitProviderEvent({
            type: "turn_item.updated",
            driver: CODEX_PROVIDER,
            turnItem: artifacts.turnItem,
          });
        }).pipe(Effect.orDie, turnTerminalizationPermit.withPermits(1)),
      );

yield* client.handleServerNotification("item/completed", (payload) =>
        Effect.gen(function* () {
          if (payload.item.type === "contextCompaction")
            // Fork requests off the notification reader so it can read their responses.
            yield* restoreAdditionalContext(payload.threadId).pipe(
              Effect.forkIn(scope, { startImmediately: true }),
            );
          if (
            (payload.item.type === "subAgentActivity" ||
              payload.item.type === "collabAgentToolCall") &&
            (yield* Ref.get(terminalizedNonCompletedNativeTurns)).has(payload.turnId)
          )
            return;
          // Child lifecycle notifications outlive the parent's turn context.
          if (payload.item.type === "subAgentActivity" && payload.item.kind !== "started") {
            yield* registerSubagentActivity({ item: payload.item });
            return;
          }
          if (payload.item.type === "collabAgentToolCall" && payload.item.tool !== "spawnAgent") {
            yield* updateSubagentStates({ item: payload.item });
            return;
          }
          const resolved = yield* resolveItemEventContext(payload.turnId);
          if (resolved === undefined) {
            return;
          }
          const { context, settled } = resolved;

          if (payload.item.type === "reasoning") {
            yield* completeReasoning(payload.turnId, payload.item);
            return;
          }

          if (payload.item.type === "contextCompaction") {
            yield* emitCompactionItem(
              context,
              payload.item.id,
              "completed",
              DateTime.makeUnsafe(payload.completedAtMs),
            );
            return;
          }

          if (payload.item.type === "userMessage") {
            if (yield* emitSubagentUserMessage(context, payload.item)) {
              return;
            }
          }

          if (payload.item.type === "commandExecution") {
            // Other tools can retain the context after thread closure.
            if (context.closedCommandItemIds?.has(payload.item.id)) return;
            const turnDrained = yield* clearRunningCommandItem(payload.turnId, payload.item.id);
            const artifacts = yield* buildCommandExecutionArtifacts(context, payload.item);
            yield* emitProviderEvent({
              type: "node.updated",
              driver: CODEX_PROVIDER,
              node: artifacts.node,
            });
            yield* emitProviderEvent({
              type: "turn_item.updated",
              driver: CODEX_PROVIDER,
              turnItem: artifacts.turnItem,
            });
            if (settled) {
              if (
                context.subagent === null &&
                continuationRequests !== undefined &&
                !(yield* Ref.get(interruptingNativeTurns)).has(payload.turnId)
              ) {
                const alreadyOffered = yield* Ref.modify(
                  offeredContinuationItemsByTurn,
                  (current) => {
                    const items = current.get(payload.turnId);
                    if (items !== undefined && items.has(payload.item.id)) {
                      return [true, current] as const;
                    }
                    const updated = new Map(current);
                    const updatedItems = new Set(items ?? []);
                    updatedItems.add(payload.item.id);
                    updated.set(payload.turnId, updatedItems);
                    return [false, updated] as const;
                  },
                );
                if (!alreadyOffered) {
                  yield* continuationRequests.offer({
                    threadId: context.projectionThreadId,
                    providerThreadId: context.providerThread.id,
                    driver: CODEX_PROVIDER,
                    // Codex starts a new turn from this text, so nothing is buffered.
                    delivery: "message_text",
                    detail: codexBackgroundCommandDetail(payload.item),
                    notification: {
                      ...backgroundWorkNotification([
                        {
                          kind: "command",
                          label: payload.item.command,
                          outcome:
                            payload.item.exitCode === 0
                              ? "completed"
                              : payload.item.exitCode == null
                                ? "unknown"
                                : "failed",
                          exitCode: payload.item.exitCode ?? undefined,
                        },
                      ]),
                      detail: payload.item.command,
                    },
                  });
                }
              }
              if (turnDrained) {
                yield* releaseSettledTurnIfIdle(payload.turnId);
              }
            }
            return;
          }

          if (payload.item.type === "mcpToolCall" || payload.item.type === "dynamicToolCall") {
            yield* clearRunningDynamicTool(payload.turnId, payload.item.id);
            const appResourceUri = codexMcpAppResourceUri(payload.item);
            if (appResourceUri !== undefined && payload.item.type === "mcpToolCall") {
              yield* captureMcpApp(context, payload.turnId, payload.item, appResourceUri);
              return;
            }
            const artifacts = yield* buildDynamicToolArtifacts(context, payload.item);
            yield* emitProviderEvent({
              type: "node.updated",
              driver: CODEX_PROVIDER,
              node: artifacts.node,
            });
            yield* emitProviderEvent({
              type: "turn_item.updated",
              driver: CODEX_PROVIDER,
              turnItem: artifacts.turnItem,
            });
            if (settled) {
              yield* releaseSettledTurnIfIdle(payload.turnId);
            }
            return;
          }

          if (payload.item.type === "fileChange") {
            context.fileChangeKindsByItem.delete(payload.item.id);
            const artifacts = yield* buildFileChangeArtifacts(context, payload.item);
            if (artifacts === null) {
              return;
            }
            yield* emitProviderEvent({
              type: "node.updated",
              driver: CODEX_PROVIDER,
              node: artifacts.node,
            });
            yield* emitProviderEvent({
              type: "turn_item.updated",
              driver: CODEX_PROVIDER,
              turnItem: artifacts.turnItem,
            });
            return;
          }

          if (payload.item.type === "webSearch") {
            const artifacts = yield* buildWebSearchArtifacts({
              context,
              item: payload.item,
              completed: true,
            });
            yield* emitProviderEvent({
              type: "node.updated",
              driver: CODEX_PROVIDER,
              node: artifacts.node,
            });
            yield* emitProviderEvent({
              type: "turn_item.updated",
              driver: CODEX_PROVIDER,
              turnItem: artifacts.turnItem,
            });
            return;
          }

          if (payload.item.type === "plan") {
            yield* planDeltas.complete({
              turnId: payload.turnId,
              itemId: payload.item.id,
              ...(payload.item.text.length > 0 ? { finalText: payload.item.text } : {}),
            });
            return;
          }

          if (payload.item.type === "collabAgentToolCall") {
            if (payload.item.tool === "spawnAgent") markSubagentUsage(context);
            yield* registerSubagentThreads({
              context,
              item: payload.item,
            });
            yield* updateSubagentStates({
              item: payload.item,
            });
            return;
          }

          if (payload.item.type === "subAgentActivity") {
            markSubagentUsage(context);
            yield* registerSubagentActivity({
              context,
              item: payload.item,
            });
            return;
          }

          if (payload.item.type === "imageGeneration") {
            if ((yield* Ref.get(interruptingNativeTurns)).has(payload.turnId)) return;
            const { id, savedPath, status, failure } = payload.item;
            const state = imageTurn(payload.turnId);
            if (savedPath?.trim() && status === "completed" && failure == null) {
              state.saved.set(id, savedPath);
            }
            // Idle release runs concurrently, so keep this work pending through projection.
            if (settled) {
              yield* projectGeneratedImages(context, payload.turnId);
            }
            state.running.delete(id);
            yield* emitImageWorkState(context, state.running.size > 0 || state.saved.size > 0);
            if (settled) {
              yield* releaseSettledTurnIfIdle(payload.turnId);
            }
            return;
          }

          if (payload.item.type !== "agentMessage") {
            return;
          }

          if (payload.item.delivery === "async" && payload.item.questions?.length) {
            const artifacts = yield* buildUserInputRequestArtifacts({
              context,
              nativeItemId: payload.item.id,
              nativeRequestId: `async:${payload.item.id}`,
              responseMode: "message",
              questions: payload.item.questions.map((question, index) => ({
                id: String(index),
                header: "Question",
                question: question.title,
                options: (question.options ?? []).map((label) => ({ label, description: "" })),
              })),
            });
            yield* emitProviderEvent({
              type: "node.updated",
              driver: CODEX_PROVIDER,
              node: artifacts.node,
            });
            yield* emitProviderEvent({
              type: "turn_item.updated",
              driver: CODEX_PROVIDER,
              turnItem: artifacts.turnItem,
            });
            yield* emitProviderEvent({
              type: "runtime_request.updated",
              driver: CODEX_PROVIDER,
              threadId: artifacts.node.threadId,
              runtimeRequest: artifacts.request,
            });
            yield* Ref.update(finalAnswerItemIdsByTurn, (current) => {
              const ids = current.get(payload.turnId);
              if (!ids?.has(payload.item.id)) return current;
              const next = new Map(current);
              const remaining = new Set(ids);
              remaining.delete(payload.item.id);
              if (remaining.size === 0) next.delete(payload.turnId);
              else next.set(payload.turnId, remaining);
              return next;
            });
            return;
          }

          const finalAnswer = payload.item.phase == null || payload.item.phase === "final_answer";
          if (finalAnswer) {
            yield* Ref.update(finalAnswerItemIdsByTurn, (current) => {
              const updated = new Map(current);
              const itemIds = new Set(updated.get(payload.turnId) ?? []);
              itemIds.add(payload.item.id);
              updated.set(payload.turnId, itemIds);
              return updated;
            });
          }
          const completedTextsBefore =
            (yield* Ref.get(completedFinalAnswerTextsByTurn)).get(payload.turnId) ??
            new Set<string>();
          const text = yield* agentMessageDeltas.complete({
            turnId: payload.turnId,
            itemId: payload.item.id,
            finalText: payload.item.text,
          });
          yield* Ref.update(finalAnswerItemIdsByTurn, (current) => {
            const itemIds = current.get(payload.turnId);
            if (itemIds === undefined || !itemIds.has(payload.item.id)) {
              return current;
            }
            const updated = new Map(current);
            const remainingItemIds = new Set(itemIds);
            remainingItemIds.delete(payload.item.id);
            if (remainingItemIds.size === 0) {
              updated.delete(payload.turnId);
            } else {
              updated.set(payload.turnId, remainingItemIds);
            }
            return updated;
          });
          const emitted =
            !finalAnswer ||
            completedTextsBefore.size === 0 ||
            (text.length > 0 && !completedTextsBefore.has(text));
          if (emitted && context.subagent !== null && finalAnswer) {
            yield* emitSubagentTaskUpdate({
              subagent: context.subagent,
              status: context.subagent.task.status,
              result: text,
            });
          }
        }).pipe(Effect.orDie, turnTerminalizationPermit.withPermits(1)),
      );

const projectGeneratedImages = Effect.fn("CodexAdapterV2.projectGeneratedImages")(
        function* (context: ActiveCodexTurnContext, nativeTurnId: string) {
          const state = imageTurns.get(nativeTurnId);
          const firstImageItemId = state?.saved.keys().next().value;
          if (state === undefined || firstImageItemId === undefined) return;
          const finalAnswer = state.answer;
          const text = appendGeneratedImageEmbeds(finalAnswer?.text ?? "", state.saved.values());
          if (text === (finalAnswer?.text ?? "")) {
            state.saved.clear();
            return;
          }
          const message = { id: finalAnswer?.id ?? firstImageItemId, text };
          state.answer = message;
          const artifacts = yield* buildAgentMessageArtifacts(context, message, true);
          yield* emitProviderEvent({
            type: "node.updated",
            driver: CODEX_PROVIDER,
            node: artifacts.node,
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
          state.saved.clear();
        },
      );

  return { projectGeneratedImages };
});

export type ProjectGeneratedImagesPart = ReturnType<typeof installProjectGeneratedImages> extends Effect.Effect<infer A, infer _E, infer _R> ? A : ReturnType<typeof installProjectGeneratedImages>;
