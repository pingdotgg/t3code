import { pipe } from "effect/Function";
import { makeProviderTextDeltaCoalescer } from "../ProviderTextDeltaCoalescer.ts";
import type { OrchestrationV2ExecutionNode, OrchestrationV2PlanArtifact, OrchestrationV2PlanStep, OrchestrationV2RuntimeRequest, OrchestrationV2TurnItem, ProviderApprovalOption, ProviderRequestKind } from "@t3tools/contracts";
import * as CodexSchema from "effect-codex-app-server/schema";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import { resolveAttachmentPathById } from "../../../attachmentStore.ts";
import { MCP_APP_OUTPUT_KEY } from "@t3tools/shared/mcpApp";
import { snapshotMcpApp } from "../../../mcpApps/McpAppSnapshot.ts";
import type { CodexAdapterScope } from "../CodexAdapterV2.ts";
import { approvalOwnerCodexTurn, getNativeThreadId, type ActiveCodexTurnContext } from "../CodexAdapterV2Prelude/BuildCodexTurnStartParams.ts";
import { CODEX_PLAN_DELTA_FLUSH_INTERVAL_MS, CODEX_PROVIDER, MCP_APP_CAPTURE_TIMEOUT, codexNativeItemRef, nonEmptyText, toProtocolError, type CodexDynamicToolItem } from "../CodexAdapterV2Prelude/CodexProviderCapabilitiesV2.ts";
import type { RegisterRootTurnPart } from "./RegisterRootTurn.ts";
import type { EmitSubagentProviderTurnStartedPart } from "./EmitSubagentProviderTurnStarted.ts";
import type { RegisterSubagentThreadPart } from "./RegisterSubagentThread.ts";
import type { BuildAgentMessageArtifactsPart } from "./BuildAgentMessageArtifacts.ts";

type Deps = CodexAdapterScope & RegisterRootTurnPart & EmitSubagentProviderTurnStartedPart & RegisterSubagentThreadPart & BuildAgentMessageArtifactsPart;

export const installBuildUserInputRequestArtifacts = Effect.fnUntraced(function* (deps: Deps) {
  const { activeTurns, agentMessageDeltas, appendReasoning, awaitActiveTurn, buildDynamicToolArtifacts, client, completeProviderRetry, emitProviderEvent, fileSystem, idAllocator, input, pendingMcpAppCaptures, releaseSettledTurnIfIdle, resolveItemEventContext, resolveItemOrdinal, resolveItemPosition, resolvePlanId, scope, serverConfig, settledTurns, takePendingMcpAppCapture, terminalizedNonCompletedNativeTurns } = deps;

const captureMcpApp = Effect.fn("CodexAdapterV2.captureMcpApp")(function* (
        context: ActiveCodexTurnContext,
        nativeTurnId: string,
        item: Extract<CodexDynamicToolItem, { readonly type: "mcpToolCall" }>,
        resourceUri: string,
      ) {
        // Registered before it can run, so a turn ending right away sees it.
        const started = yield* Deferred.make<void>();
        const fiber = yield* Deferred.await(started).pipe(
          Effect.andThen(captureMcpAppItem(context, nativeTurnId, item, resourceUri)),
          Effect.forkIn(scope, { startImmediately: true }),
        );
        yield* Ref.update(pendingMcpAppCaptures, (current) => {
          const updated = new Map(current);
          updated.set(
            nativeTurnId,
            new Map(current.get(nativeTurnId) ?? []).set(item.id, { item, fiber }),
          );
          return updated;
        });
        yield* Deferred.succeed(started, undefined);
      });

const captureMcpAppItem = (
        context: ActiveCodexTurnContext,
        nativeTurnId: string,
        item: Extract<CodexDynamicToolItem, { readonly type: "mcpToolCall" }>,
        resourceUri: string,
      ) =>
        // Only reads and storage are cancellable; remove partial writes. Once stored, attach the app or delete it if the item settled.
        Effect.uninterruptibleMask((restore) =>
          Effect.gen(function* () {
            const reference =
              item.result != null && item.error == null
                ? yield* restore(
                    getNativeThreadId(context.providerThread).pipe(
                      Effect.flatMap((threadId) =>
                        client.request("mcpServer/resource/read", {
                          threadId,
                          server: item.server,
                          uri: resourceUri,
                        }),
                      ),
                      Effect.timeout(MCP_APP_CAPTURE_TIMEOUT),
                      Effect.flatMap((response) =>
                        snapshotMcpApp({
                          attachmentsDir: serverConfig.attachmentsDir,
                          threadId: context.projectionThreadId,
                          server: item.server,
                          tool: item.tool,
                          resourceUri,
                          contents: response.contents,
                        }),
                      ),
                      Effect.provideService(FileSystem.FileSystem, fileSystem),
                      // Convert failures and defects to plain tool rows; only interruption ends the capture fiber.
                      Effect.catchCauseIf(
                        (cause) => !Cause.hasInterruptsOnly(cause),
                        (cause) =>
                          Effect.logWarning(
                            "Failed to capture an MCP app; showing a plain tool row.",
                            { server: item.server, tool: item.tool, resourceUri, cause },
                          ).pipe(Effect.as(undefined)),
                      ),
                      Effect.orDie,
                    ),
                  )
                : undefined;
            const artifacts = yield* buildDynamicToolArtifacts(context, item);
            // Clear before emitting; ingestion rechecks pending work after each event.
            if (!(yield* takePendingMcpAppCapture(nativeTurnId, item.id))) {
              if (reference !== undefined) {
                const filePath = resolveAttachmentPathById({
                  attachmentsDir: serverConfig.attachmentsDir,
                  attachmentId: reference.attachmentId,
                });
                if (filePath !== null) {
                  yield* fileSystem.remove(filePath, { force: true }).pipe(Effect.ignore);
                }
              }
              return;
            }
            const turnItem =
              reference === undefined || artifacts.turnItem.type !== "dynamic_tool"
                ? artifacts.turnItem
                : {
                    ...artifacts.turnItem,
                    output: {
                      [MCP_APP_OUTPUT_KEY]: reference,
                      result:
                        item.status === "failed"
                          ? { ...item.result, isError: true }
                          : item.result,
                    },
                  };
            yield* emitProviderEvent({
              type: "node.updated",
              driver: CODEX_PROVIDER,
              node: artifacts.node,
            });
            yield* emitProviderEvent({
              type: "turn_item.updated",
              driver: CODEX_PROVIDER,
              turnItem,
            });
            if ((yield* Ref.get(settledTurns)).has(nativeTurnId)) {
              yield* releaseSettledTurnIfIdle(nativeTurnId);
            }
          }),
        );

const terminalizeMcpAppCaptures = Effect.fn("CodexAdapterV2.terminalizeMcpAppCaptures")(
        function* (context: ActiveCodexTurnContext, nativeTurnId: string) {
          const captures = (yield* Ref.get(pendingMcpAppCaptures)).get(nativeTurnId);
          if (captures === undefined) return;
          for (const { item, fiber } of captures.values()) {
            if (!(yield* takePendingMcpAppCapture(nativeTurnId, item.id))) continue;
            yield* Fiber.interrupt(fiber);
            const artifacts = yield* buildDynamicToolArtifacts(context, item);
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
          }
        },
      );

const buildProposedPlanArtifacts = Effect.fnUntraced(function* (input: {
        readonly context: ActiveCodexTurnContext;
        readonly nativeItemId: string;
        readonly status: OrchestrationV2PlanArtifact["status"];
        readonly markdown: string;
        readonly completed?: boolean;
      }) {
        const updatedAt = yield* DateTime.now;
        const completedAt = input.completed === true ? updatedAt : null;
        const planId = yield* resolvePlanId(input.context, input.nativeItemId);
        const nodeId = idAllocator.derive.nodeFromProviderItem({
          driver: CODEX_PROVIDER,
          nativeItemId: input.nativeItemId,
        });
        const turnItemId = idAllocator.derive.turnItemFromProviderItem({
          driver: CODEX_PROVIDER,
          nativeItemId: input.nativeItemId,
        });
        const { ordinal, startedAt } = yield* resolveItemPosition(
          input.context,
          input.nativeItemId,
        );
        const plan: OrchestrationV2PlanArtifact = {
          id: planId,
          threadId: input.context.projectionThreadId,
          runId: input.context.projectionRunId,
          nodeId,
          kind: "proposed_plan",
          status: input.status,
          markdown: input.markdown,
        };
        const node: OrchestrationV2ExecutionNode = {
          id: nodeId,
          threadId: input.context.projectionThreadId,
          runId: input.context.projectionRunId,
          parentNodeId: input.context.itemParentNodeId,
          rootNodeId: input.context.rootNodeId,
          kind: "plan",
          status: input.completed === true ? "completed" : "running",
          countsForRun: false,
          providerThreadId: input.context.providerThread.id,
          providerTurnId: input.context.providerTurnId,
          nativeItemRef: codexNativeItemRef(input.nativeItemId),
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
          nativeItemRef: codexNativeItemRef(input.nativeItemId),
          parentItemId: null,
          ordinal,
          status: input.completed === true ? "completed" : "running",
          title: null,
          startedAt,
          completedAt,
          updatedAt,
          type: "proposed_plan",
          planId,
          markdown: input.markdown,
          streaming: input.completed !== true,
        };
        return { node, plan, turnItem };
      });

const planDeltas = yield* makeProviderTextDeltaCoalescer({
        flushIntervalMs: CODEX_PLAN_DELTA_FLUSH_INTERVAL_MS,
        emit:
          /* Provider events include streaming deltas; avoid a span for each update. */
          Effect.fnUntraced(function* (update) {
            const resolved = yield* resolveItemEventContext(update.turnId);
            if (resolved === undefined) return;
            const interrupted = (yield* Ref.get(terminalizedNonCompletedNativeTurns)).has(
              update.turnId,
            );
            const artifacts = yield* buildProposedPlanArtifacts({
              context: resolved.context,
              nativeItemId: update.itemId,
              // A finished proposal stays active until Implement consumes it.
              status: "active",
              markdown: update.text,
              completed: update.completed && !interrupted,
            });
            yield* emitProviderEvent({
              type: "node.updated",
              driver: CODEX_PROVIDER,
              node: artifacts.node,
            });
            yield* emitProviderEvent({
              type: "plan.updated",
              driver: CODEX_PROVIDER,
              plan: artifacts.plan,
            });
            yield* emitProviderEvent({
              type: "turn_item.updated",
              driver: CODEX_PROVIDER,
              turnItem: artifacts.turnItem,
            });
          }, Effect.orDie),
      });

const buildTodoListArtifacts = Effect.fn("CodexAdapterV2.buildTodoListArtifacts")(
        function* (input: {
          readonly context: ActiveCodexTurnContext;
          readonly nativeItemId: string;
          readonly status: OrchestrationV2PlanArtifact["status"];
          readonly steps: ReadonlyArray<OrchestrationV2PlanStep>;
          readonly explanation?: string;
          readonly completed?: boolean;
        }) {
          const updatedAt = yield* DateTime.now;
          const completedAt = input.completed === true ? updatedAt : null;
          const planId = yield* resolvePlanId(input.context, input.nativeItemId);
          const nodeId = idAllocator.derive.nodeFromProviderItem({
            driver: CODEX_PROVIDER,
            nativeItemId: input.nativeItemId,
          });
          const turnItemId = idAllocator.derive.turnItemFromProviderItem({
            driver: CODEX_PROVIDER,
            nativeItemId: input.nativeItemId,
          });
          const { ordinal, startedAt } = yield* resolveItemPosition(
            input.context,
            input.nativeItemId,
          );
          const plan: OrchestrationV2PlanArtifact = {
            id: planId,
            threadId: input.context.projectionThreadId,
            runId: input.context.projectionRunId,
            nodeId,
            kind: "todo_list",
            status: input.status,
            steps: [...input.steps],
            ...(input.explanation === undefined ? {} : { explanation: input.explanation }),
          };
          const node: OrchestrationV2ExecutionNode = {
            id: nodeId,
            threadId: input.context.projectionThreadId,
            runId: input.context.projectionRunId,
            parentNodeId: input.context.itemParentNodeId,
            rootNodeId: input.context.rootNodeId,
            kind: "todo_list",
            status: input.completed === true ? "completed" : "running",
            countsForRun: false,
            providerThreadId: input.context.providerThread.id,
            providerTurnId: input.context.providerTurnId,
            nativeItemRef: codexNativeItemRef(input.nativeItemId),
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
            nativeItemRef: codexNativeItemRef(input.nativeItemId),
            parentItemId: null,
            ordinal,
            status: input.completed === true ? "completed" : "running",
            title: null,
            startedAt,
            completedAt,
            updatedAt,
            type: "todo_list",
            planId,
            steps: [...input.steps],
            ...(input.explanation === undefined ? {} : { explanation: input.explanation }),
          };
          return { node, plan, turnItem };
        },
      );

const buildApprovalRequestArtifacts = Effect.fn(
        "CodexAdapterV2.buildApprovalRequestArtifacts",
      )(function* (input: {
        readonly context: ActiveCodexTurnContext;
        readonly nativeItemId: string;
        readonly nativeRequestId: string;
        readonly requestKind: ProviderRequestKind;
        readonly prompt?: string | null;
        readonly appName?: string;
        readonly options?: ReadonlyArray<ProviderApprovalOption>;
      }) {
        const createdAt = yield* DateTime.now;
        const { owner, subagent } = approvalOwnerCodexTurn(input.context);
        const parentNodeId =
          subagent?.subagentNodeId ??
          idAllocator.derive.nodeFromProviderItem({
            driver: CODEX_PROVIDER,
            nativeItemId: input.nativeItemId,
          });
        const ordinal = yield* resolveItemOrdinal(
          owner,
          `${input.nativeItemId}:approval:${input.nativeRequestId}`,
        );
        const requestId = yield* idAllocator.allocate.runtimeRequest({
          driver: CODEX_PROVIDER,
          providerTurnId: owner.providerTurnId,
          nativeRequestId: input.nativeRequestId,
        });
        const nodeId = idAllocator.derive.approvalNode({ requestId });
        const providerSessionId = owner.input.providerThread.providerSessionId;
        if (providerSessionId === null) {
          return yield* toProtocolError(
            `Provider thread ${owner.providerThread.id} is missing a provider session id.`,
          );
        }
        const node: OrchestrationV2ExecutionNode = {
          id: nodeId,
          threadId: owner.projectionThreadId,
          runId: owner.projectionRunId,
          parentNodeId,
          rootNodeId: owner.rootNodeId,
          kind: "approval_request",
          status: "waiting",
          countsForRun: false,
          providerThreadId: owner.providerThread.id,
          providerTurnId: owner.providerTurnId,
          nativeItemRef: codexNativeItemRef(input.nativeItemId),
          runtimeRequestId: requestId,
          checkpointScopeId: null,
          startedAt: createdAt,
          completedAt: null,
        };
        const request: OrchestrationV2RuntimeRequest = {
          id: requestId,
          nodeId,
          providerTurnId: owner.providerTurnId,
          nativeRequestRef: {
            driver: CODEX_PROVIDER,
            nativeId: input.nativeRequestId,
            strength: "strong",
          },
          kind: input.requestKind,
          status: "pending",
          responseCapability: {
            type: "live",
            providerSessionId,
          },
          createdAt,
          resolvedAt: null,
        };
        const turnItem: OrchestrationV2TurnItem = {
          id: idAllocator.derive.approvalTurnItem({ requestId }),
          threadId: owner.projectionThreadId,
          runId: owner.projectionRunId,
          nodeId,
          providerThreadId: owner.providerThread.id,
          providerTurnId: owner.providerTurnId,
          nativeItemRef: codexNativeItemRef(input.nativeItemId),
          parentItemId: null,
          ordinal,
          status: "waiting",
          title: null,
          startedAt: createdAt,
          completedAt: null,
          updatedAt: createdAt,
          type: "approval_request",
          requestId,
          requestKind: input.requestKind,
          ...(input.prompt === null || input.prompt === undefined
            ? {}
            : { prompt: input.prompt }),
          ...(input.appName === undefined ? {} : { appName: input.appName }),
          ...(input.options === undefined ? {} : { options: input.options }),
        };
        return { node, request, turnItem };
      });

const buildUserInputRequestArtifacts = Effect.fn(
        "CodexAdapterV2.buildUserInputRequestArtifacts",
      )(function* (input: {
        readonly context: ActiveCodexTurnContext;
        readonly nativeItemId: string;
        readonly nativeRequestId: string;
        readonly questions: ReadonlyArray<CodexSchema.ToolRequestUserInputParams__ToolRequestUserInputQuestion>;
        readonly responseMode?: "message";
      }) {
        const createdAt = yield* DateTime.now;
        const requestId = yield* idAllocator.allocate.runtimeRequest({
          driver: CODEX_PROVIDER,
          providerTurnId: input.context.providerTurnId,
          nativeRequestId: input.nativeRequestId,
        });
        const providerSessionId = input.context.input.providerThread.providerSessionId;
        if (providerSessionId === null) {
          return yield* toProtocolError(
            `Provider thread ${input.context.providerThread.id} is missing a provider session id.`,
          );
        }
        const questions = input.questions.map((question, index) => ({
          id: nonEmptyText(question.id, `question-${index + 1}`),
          header: nonEmptyText(question.header, "Question"),
          question: nonEmptyText(question.question, "Choose an answer."),
          options:
            question.options?.map((option, optionIndex) => ({
              label: nonEmptyText(option.label, `Option ${optionIndex + 1}`),
              description: nonEmptyText(option.description, option.label),
            })) ?? [],
        }));
        const nodeId = idAllocator.derive.nodeFromProviderItem({
          driver: CODEX_PROVIDER,
          nativeItemId: input.nativeItemId,
        });
        const turnItemId = idAllocator.derive.turnItemFromProviderItem({
          driver: CODEX_PROVIDER,
          nativeItemId: input.nativeItemId,
        });
        const ordinal = yield* resolveItemOrdinal(input.context, input.nativeItemId);
        const node: OrchestrationV2ExecutionNode = {
          id: nodeId,
          threadId: input.context.projectionThreadId,
          runId: input.context.projectionRunId,
          parentNodeId: input.context.itemParentNodeId,
          rootNodeId: input.context.rootNodeId,
          kind: "user_input_request",
          status: "waiting",
          countsForRun: false,
          providerThreadId: input.context.providerThread.id,
          providerTurnId: input.context.providerTurnId,
          nativeItemRef: codexNativeItemRef(input.nativeItemId),
          runtimeRequestId: requestId,
          checkpointScopeId: null,
          startedAt: createdAt,
          completedAt: null,
        };
        const request: OrchestrationV2RuntimeRequest = {
          id: requestId,
          nodeId,
          providerTurnId: input.context.providerTurnId,
          nativeRequestRef: {
            driver: CODEX_PROVIDER,
            nativeId: input.nativeRequestId,
            strength: "strong",
          },
          kind: "user_input",
          status: "pending",
          responseCapability:
            input.responseMode === "message"
              ? { type: "message" }
              : { type: "live", providerSessionId },
          createdAt,
          resolvedAt: null,
        };
        const turnItem: OrchestrationV2TurnItem = {
          id: turnItemId,
          threadId: input.context.projectionThreadId,
          runId: input.context.projectionRunId,
          nodeId,
          providerThreadId: input.context.providerThread.id,
          providerTurnId: input.context.providerTurnId,
          nativeItemRef: codexNativeItemRef(input.nativeItemId),
          parentItemId: null,
          ordinal,
          status: "waiting",
          title: null,
          startedAt: createdAt,
          completedAt: null,
          updatedAt: createdAt,
          type: "user_input_request",
          requestId,
          questions,
          ...(input.responseMode === undefined ? {} : { responseMode: input.responseMode }),
        };
        return { node, request, turnItem };
      });

yield* client.handleServerNotification("item/agentMessage/delta", (payload) =>
        Effect.gen(function* () {
          const context = (yield* Ref.get(activeTurns)).get(payload.turnId);
          if (context !== undefined) {
            yield* completeProviderRetry(context, yield* DateTime.now);
          }
          yield* agentMessageDeltas.append({
            turnId: payload.turnId,
            itemId: payload.itemId,
            delta: payload.delta,
          });
        }),
      );

yield* client.handleServerNotification("item/commandExecution/outputDelta", (payload) =>
        Effect.gen(function* () {
          // Background commands emit deltas after settlement; item/started already registered their turn.
          const context =
            (yield* Ref.get(activeTurns)).get(payload.turnId) ??
            (yield* Ref.get(settledTurns)).get(payload.turnId);
          if (context === undefined) return;
          yield* emitProviderEvent({
            type: "command_output.delta",
            driver: CODEX_PROVIDER,
            threadId: context.projectionThreadId,
            itemId: idAllocator.derive.turnItemFromProviderItem({
              driver: CODEX_PROVIDER,
              nativeItemId: payload.itemId,
            }),
            chunk: payload.delta,
          });
        }),
      );

yield* client.handleServerNotification("item/reasoning/summaryTextDelta", (payload) =>
        appendReasoning(payload, "summary", payload.summaryIndex),
      );

yield* client.handleServerNotification("item/reasoning/textDelta", (payload) =>
        appendReasoning(payload, "content", payload.contentIndex),
      );

yield* client.handleServerNotification("item/plan/delta", (payload) =>
        Effect.gen(function* () {
          const context = yield* awaitActiveTurn(payload.turnId);
          if (context === undefined) {
            return;
          }
          yield* completeProviderRetry(context, yield* DateTime.now);
          yield* planDeltas.append({
            turnId: payload.turnId,
            itemId: payload.itemId,
            delta: payload.delta,
          });
        }).pipe(Effect.orDie),
      );

  return { captureMcpApp, captureMcpAppItem, terminalizeMcpAppCaptures, buildProposedPlanArtifacts, planDeltas, buildTodoListArtifacts, buildApprovalRequestArtifacts, buildUserInputRequestArtifacts };
});

export type BuildUserInputRequestArtifactsPart = ReturnType<typeof installBuildUserInputRequestArtifacts> extends Effect.Effect<infer A, infer _E, infer _R> ? A : ReturnType<typeof installBuildUserInputRequestArtifacts>;
