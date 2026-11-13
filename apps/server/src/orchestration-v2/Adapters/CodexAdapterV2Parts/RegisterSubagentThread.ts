import { pipe } from "effect/Function";
import * as DocumentText from "../../../provider/DocumentText.ts";
import { modelSelectionsEqual } from "@t3tools/shared/model";
import type { ChatAttachment, OrchestrationV2ProviderThread, OrchestrationV2Subagent } from "@t3tools/contracts";
import * as CodexSchema from "effect-codex-app-server/schema";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Ref from "effect/Ref";
import { resolveAttachmentPath } from "../../../attachmentStore.ts";
import { isProviderNativeImageAttachment, providerMessageTextWithAttachmentPaths } from "@t3tools/provider-core/server/attachmentPrompt";
import { makeSubagentChildThread, makeSubagentConversationArtifacts, subagentThreadTitle } from "@t3tools/provider-core/server/subagentProjection";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import type { CodexAdapterScope } from "../CodexAdapterV2.ts";
import { CODEX_PROVIDER, codexNativeItemRef, codexSkillMentionText, toProtocolError } from "../CodexAdapterV2Prelude/CodexProviderCapabilitiesV2.ts";
import { type ActiveCodexTurnContext, type CodexCollabAgentToolCallItem, type CodexSubagentThreadContext } from "../CodexAdapterV2Prelude/BuildCodexTurnStartParams.ts";
import { CodexChildSelection, decodeCodexChildModel, decodeCodexChildThread, type CodexSubAgentActivityItem } from "../CodexAdapterV2Prelude/CreateCodexAdapterV2.ts";
import type { RegisterRootTurnPart } from "./RegisterRootTurn.ts";
import type { EmitSubagentProviderTurnStartedPart } from "./EmitSubagentProviderTurnStarted.ts";

type Deps = CodexAdapterScope & RegisterRootTurnPart & EmitSubagentProviderTurnStartedPart;

export const installRegisterSubagentThread = Effect.fnUntraced(function* (deps: Deps) {
  const { client, emitProviderEvent, emitSubagentProviderTurnStarted, emitSubagentTaskUpdate, fileSystem, idAllocator, input, now, pendingSubagentTurns, planIds, resolveItemOrdinal, scope, serverConfig, subagentSelections, subagentThreads } = deps;

const updateSubagentSelection = Effect.fnUntraced(function* (
        nativeThreadId: string,
        value: string | null,
        effort?: string | null,
        tier?: string | null,
      ) {
        const model = value?.trim();
        if (!model) return;
        const previous = subagentSelections.get(nativeThreadId);
        const previousOptions = previous?.options;
        const options =
          effort === undefined && tier === undefined
            ? previousOptions
            : [
                ...(previousOptions ?? []).filter(({ id }) =>
                  id === "reasoningEffort"
                    ? effort === undefined
                    : id === "serviceTier" && tier === undefined,
                ),
                ...[
                  { id: "reasoningEffort", value: effort },
                  { id: "serviceTier", value: tier },
                ].flatMap(({ id, value }) =>
                  value?.trim() ? [{ id, value: value.trim() }] : [],
                ),
              ];
        const selection = {
          model,
          ...(options === undefined ? {} : { options }),
        };
        subagentSelections.set(nativeThreadId, selection);
        const subagent = (yield* Ref.get(subagentThreads)).get(nativeThreadId);
        if (subagent === undefined) return;
        const modelSelection = { instanceId: subagent.task.providerInstanceId, ...selection };
        if (
          subagent.task.modelSelection &&
          modelSelectionsEqual(subagent.task.modelSelection, modelSelection)
        )
          return;
        subagent.task = {
          ...subagent.task,
          model,
          modelSelection,
          updatedAt: yield* DateTime.now,
        };
        yield* emitProviderEvent({
          type: "subagent.updated",
          driver: CODEX_PROVIDER,
          subagent: subagent.task,
        });
      });

const registerSubagentThread =
        /* Provider events include streaming deltas; avoid a span for each update. */
        Effect.fnUntraced(function* (input: {
          readonly context: ActiveCodexTurnContext;
          readonly nativeThreadId: string;
          readonly nativeItemId: string;
          readonly nativeToolCallId: string;
          readonly prompt: string;
          readonly title: string | null;
          readonly model: string | null;
          readonly reasoningEffort?: string | null | undefined;
          readonly ordinal: number;
          readonly emitInitialPrompt: boolean;
        }) {
          const registeredSubagents = yield* Ref.get(subagentThreads);
          if (input.model && !subagentSelections.has(input.nativeThreadId)) {
            yield* updateSubagentSelection(
              input.nativeThreadId,
              input.model,
              input.reasoningEffort,
            );
          }
          if (registeredSubagents.has(input.nativeThreadId)) {
            return;
          }

          const now = yield* DateTime.now;
          const subagentNodeId = idAllocator.derive.nodeFromProviderItem({
            driver: CODEX_PROVIDER,
            nativeItemId: input.nativeItemId,
          });
          const childRootNodeId = idAllocator.derive.nodeFromProviderItem({
            driver: CODEX_PROVIDER,
            nativeItemId: `${input.nativeItemId}:thread-root`,
          });
          const childThreadId = idAllocator.derive.threadFromProviderThread({
            driver: CODEX_PROVIDER,
            nativeThreadId: input.nativeThreadId,
          });
          const turnItemOrdinal = yield* resolveItemOrdinal(input.context, input.nativeItemId);
          const providerThread = {
            id: idAllocator.derive.providerThread({
              driver: CODEX_PROVIDER,
              nativeThreadId: input.nativeThreadId,
            }),
            driver: CODEX_PROVIDER,
            providerInstanceId: input.context.input.modelSelection.instanceId,
            providerSessionId: input.context.providerThread.providerSessionId,
            appThreadId: childThreadId,
            ownerNodeId: null,
            nativeThreadRef: {
              driver: CODEX_PROVIDER,
              nativeId: input.nativeThreadId,
              strength: "strong" as const,
            },
            nativeConversationHeadRef: null,
            status: "idle" as const,
            firstRunOrdinal: null,
            lastRunOrdinal: null,
            handoffIds: [],
            forkedFrom: {
              providerThreadId: input.context.providerThread.id,
              providerTurnId: input.context.providerTurnId,
            },
            createdAt: now,
            updatedAt: now,
          } satisfies OrchestrationV2ProviderThread;
          const reportedSelection = subagentSelections.get(input.nativeThreadId);
          const task = {
            id: subagentNodeId,
            threadId: input.context.projectionThreadId,
            runId: input.context.projectionRunId,
            parentNodeId: input.context.itemParentNodeId,
            origin: "provider_native",
            createdBy: "agent",
            driver: CODEX_PROVIDER,
            providerInstanceId: input.context.input.modelSelection.instanceId,
            providerThreadId: providerThread.id,
            childThreadId,
            nativeTaskRef: codexNativeItemRef(input.nativeItemId),
            prompt: input.prompt,
            title: input.title,
            model: reportedSelection?.model ?? input.model,
            modelSelection: reportedSelection
              ? {
                  instanceId: input.context.input.modelSelection.instanceId,
                  ...reportedSelection,
                }
              : undefined,
            status: "running",
            result: null,
            startedAt: now,
            completedAt: null,
            updatedAt: now,
          } satisfies OrchestrationV2Subagent;
          const childThread = makeSubagentChildThread({
            parentThread: input.context.projectionAppThread,
            childThreadId,
            parentNodeId: subagentNodeId,
            activeProviderThreadId: providerThread.id,
            providerInstanceId: input.context.input.modelSelection.instanceId,
            // A child's effort can differ from the parent's. Until Codex reports it, show none.
            modelSelection: task.modelSelection ?? {
              ...input.context.input.modelSelection,
              model: task.model ?? input.context.input.modelSelection.model,
              options: (input.context.input.modelSelection.options ?? []).filter(
                ({ id }) => id !== "reasoningEffort",
              ),
            },
            title: subagentThreadTitle({
              parentTitle: input.context.projectionAppThread.title,
              prompt: task.prompt,
              title: task.title,
              ordinal: input.ordinal,
            }),
            now,
            createdBy: "agent",
            creationSource: "provider",
          });
          const subagent = {
            parentContext: input.context,
            providerThread,
            childThread,
            subagentNodeId,
            childRootNodeId,
            childThreadId,
            nativeTurnIds: new Set<string>(),
            startedAt: now,
            turnItemId: idAllocator.derive.turnItemFromProviderItem({
              driver: CODEX_PROVIDER,
              nativeItemId: input.nativeItemId,
            }),
            turnItemOrdinal,
            task,
          } satisfies CodexSubagentThreadContext;

          yield* Ref.update(subagentThreads, (current) => {
            const updated = new Map(current);
            updated.set(input.nativeThreadId, subagent);
            return updated;
          });
          yield* emitProviderEvent({
            type: "app_thread.created",
            driver: CODEX_PROVIDER,
            appThread: childThread,
          });
          yield* emitProviderEvent({
            type: "node.updated",
            driver: CODEX_PROVIDER,
            node: {
              id: subagentNodeId,
              threadId: input.context.projectionThreadId,
              runId: input.context.projectionRunId,
              parentNodeId: input.context.itemParentNodeId,
              rootNodeId: input.context.rootNodeId,
              kind: "subagent",
              status: "running",
              countsForRun: false,
              providerThreadId: providerThread.id,
              providerTurnId: input.context.providerTurnId,
              nativeItemRef: codexNativeItemRef(input.nativeToolCallId),
              runtimeRequestId: null,
              checkpointScopeId: null,
              startedAt: now,
              completedAt: null,
            },
          });
          yield* emitProviderEvent({
            type: "node.updated",
            driver: CODEX_PROVIDER,
            node: {
              id: childRootNodeId,
              threadId: childThreadId,
              runId: null,
              parentNodeId: null,
              rootNodeId: childRootNodeId,
              kind: "root_turn",
              status: "running",
              countsForRun: false,
              providerThreadId: providerThread.id,
              providerTurnId: null,
              nativeItemRef: codexNativeItemRef(input.nativeItemId),
              runtimeRequestId: null,
              checkpointScopeId: null,
              startedAt: now,
              completedAt: null,
            },
          });
          yield* emitProviderEvent({
            type: "provider_thread.updated",
            driver: CODEX_PROVIDER,
            providerThread,
          });
          if (input.emitInitialPrompt && input.prompt.length > 0) {
            const promptNativeItemId = `${input.nativeItemId}:prompt`;
            const promptArtifacts = makeSubagentConversationArtifacts({
              senderThreadId: input.context.projectionThreadId,
              messageId: idAllocator.derive.messageFromProviderItem({
                driver: CODEX_PROVIDER,
                nativeItemId: promptNativeItemId,
              }),
              turnItemId: idAllocator.derive.turnItemFromProviderItem({
                driver: CODEX_PROVIDER,
                nativeItemId: promptNativeItemId,
              }),
              threadId: childThreadId,
              rootNodeId: childRootNodeId,
              providerThreadId: providerThread.id,
              providerTurnId: null,
              nativeItemRef: codexNativeItemRef(promptNativeItemId),
              role: "user",
              text: input.prompt,
              ordinal: 100,
              now,
            });
            yield* emitProviderEvent({
              type: "message.updated",
              driver: CODEX_PROVIDER,
              message: promptArtifacts.message,
            });
            yield* emitProviderEvent({
              type: "turn_item.updated",
              driver: CODEX_PROVIDER,
              turnItem: promptArtifacts.turnItem,
            });
          }
          yield* emitSubagentTaskUpdate({
            subagent,
            status: "running",
          });

          const pendingTurns = yield* Ref.modify(pendingSubagentTurns, (current) => {
            const pending = current.get(input.nativeThreadId) ?? [];
            const updated = new Map(current);
            updated.delete(input.nativeThreadId);
            return [pending, updated];
          });
          for (const pendingTurn of pendingTurns) {
            yield* emitSubagentProviderTurnStarted(subagent, pendingTurn);
          }
          if (task.model === null) {
            yield* client.raw
              .request("thread/read", { threadId: input.nativeThreadId, includeTurns: false })
              .pipe(
                Effect.flatMap(decodeCodexChildThread),
                Effect.map((response): typeof CodexChildSelection.Type | null =>
                  response.thread.id === input.nativeThreadId && response.thread.model?.trim()
                    ? {
                        thread: response.thread,
                        model: response.thread.model,
                        reasoningEffort: response.thread.reasoningEffort,
                      }
                    : null,
                ),
                Effect.orElseSucceed(() => null),
                Effect.filterOrElse(
                  (response) => !(response === null),
                  (_response) =>
                    client.raw
                      .request("thread/resume", {
                        threadId: input.nativeThreadId,
                        excludeTurns: true,
                      })
                      .pipe(Effect.flatMap(decodeCodexChildModel)),
                ),
                Effect.timeout("5 seconds"),
                Effect.flatMap((response) =>
                  response.thread.id === input.nativeThreadId &&
                  !subagentSelections.has(input.nativeThreadId)
                    ? updateSubagentSelection(
                        input.nativeThreadId,
                        response.model,
                        response.reasoningEffort,
                        response.serviceTier,
                      )
                    : Effect.void,
                ),
                Effect.ignore,
                Effect.forkIn(scope),
              );
          }
        });

const registerSubagentThreads =
        /* Provider events include streaming deltas; avoid a span for each update. */
        Effect.fnUntraced(function* (input: {
          readonly context: ActiveCodexTurnContext;
          readonly item: CodexCollabAgentToolCallItem;
        }) {
          if (input.item.tool !== "spawnAgent" || input.item.receiverThreadIds.length === 0) {
            return;
          }

          for (const [index, nativeThreadId] of input.item.receiverThreadIds.entries()) {
            const model =
              typeof input.item.model === "string" && input.item.model.length > 0
                ? input.item.model
                : null;
            yield* registerSubagentThread({
              context: input.context,
              nativeThreadId,
              nativeItemId: `${input.item.id}:${nativeThreadId}`,
              nativeToolCallId: input.item.id,
              prompt: input.item.prompt ?? "",
              title: null,
              model,
              reasoningEffort: input.item.reasoningEffort,
              ordinal: index + 1,
              emitInitialPrompt: true,
            });
          }
        });

const registerSubagentActivity =
        /* Provider events include streaming deltas; avoid a span for each update. */
        Effect.fnUntraced(function* (input: {
          readonly context?: ActiveCodexTurnContext;
          readonly item: CodexSubAgentActivityItem;
        }) {
          if (input.item.kind === "started") {
            const context = input.context;
            if (context === undefined) return;
            const registeredSubagents = yield* Ref.get(subagentThreads);
            const ordinal =
              Array.from(registeredSubagents.values()).filter(
                (subagent) => subagent.parentContext.rootNodeId === context.rootNodeId,
              ).length + 1;
            yield* registerSubagentThread({
              context,
              nativeThreadId: input.item.agentThreadId,
              nativeItemId: `${input.item.id}:${input.item.agentThreadId}`,
              nativeToolCallId: input.item.id,
              prompt: "",
              title: input.item.agentPath,
              model: null,
              ordinal,
              emitInitialPrompt: false,
            });
            return;
          }

          const subagent = (yield* Ref.get(subagentThreads)).get(input.item.agentThreadId);
          if (subagent === undefined) {
            return;
          }

          if (input.item.kind === "interrupted" || input.item.kind === "completed") {
            yield* emitSubagentTaskUpdate({
              subagent,
              status: input.item.kind,
            });
          }
        });

const updateSubagentStates =
        /* Provider events include streaming deltas; avoid a span for each update. */
        Effect.fnUntraced(function* (input: { readonly item: CodexCollabAgentToolCallItem }) {
          const subagents = yield* Ref.get(subagentThreads);
          for (const [nativeThreadId, state] of Object.entries(input.item.agentsStates)) {
            const subagent = subagents.get(nativeThreadId);
            if (subagent === undefined) {
              continue;
            }
            const statuses = {
              pendingInit: "pending",
              running: "running",
              interrupted: "interrupted",
              completed: "completed",
              errored: "failed",
              shutdown: "cancelled",
              notFound: "failed",
            } as const satisfies Record<
              CodexSchema.ServerNotification__CollabAgentStatus,
              OrchestrationV2Subagent["status"]
            >;
            const status = statuses[state.status];
            yield* emitSubagentTaskUpdate({
              subagent,
              status,
              ...(state.message === null ? {} : { result: state.message }),
            });
          }
        });

const resolvePlanId =
        /* Provider events include streaming deltas; avoid a span for each update. */
        Effect.fnUntraced(function* (context: ActiveCodexTurnContext, planKey: string) {
          const existing = (yield* Ref.get(planIds)).get(planKey);
          if (existing !== undefined) {
            return existing;
          }
          const planId = yield* idAllocator.allocate.plan({
            threadId: context.projectionThreadId,
            ...(context.projectionRunId === null ? {} : { runId: context.projectionRunId }),
            driver: CODEX_PROVIDER,
          });
          yield* Ref.update(planIds, (current) => {
            const updated = new Map(current);
            updated.set(planKey, planId);
            return updated;
          });
          return planId;
        });

const resolveCodexAttachment = Effect.fn("CodexAdapterV2.resolveCodexAttachment")(
        function* (attachment: ChatAttachment) {
          const attachmentPath = resolveAttachmentPath({
            attachmentsDir: serverConfig.attachmentsDir,
            attachment,
          });
          if (attachmentPath === null) {
            return yield* toProtocolError(`Invalid attachment id '${attachment.id}'`);
          }
          const bytes = yield* fileSystem.readFile(attachmentPath).pipe(
            Effect.mapError(
              (cause) =>
                new ProviderAdapter.ProviderAdapterProtocolError({
                  driver: CODEX_PROVIDER,
                  detail: `Failed to read attachment '${attachment.id}'.`,
                  reason: "attachment_unreadable",
                  payload: cause,
                }),
            ),
          );
          return {
            type: "image" as const,
            url: `data:${attachment.mimeType};base64,${Buffer.from(bytes).toString("base64")}`,
          } satisfies CodexSchema.V2TurnStartParams__UserInput;
        },
      );

const toCodexInput = Effect.fn("CodexAdapterV2.toCodexInput")(function* (
        turnInput: Pick<
          | ProviderAdapter.ProviderAdapterV2TurnInput
          | ProviderAdapter.ProviderAdapterV2SteerInput,
          "message"
        >,
      ) {
        const inputItems: Array<CodexSchema.V2TurnStartParams__UserInput> = [];
        const text = yield* providerMessageTextWithAttachmentPaths({
          text: codexSkillMentionText(turnInput.message.text),
          attachments: turnInput.message.attachments,
          resolveExtractedTextPath: (path) =>
            DocumentText.resolveExtractedTextPath(path).pipe(
              Effect.provideService(FileSystem.FileSystem, fileSystem),
            ),
          resolveAttachmentPath: (attachment) =>
            resolveAttachmentPath({ attachmentsDir: serverConfig.attachmentsDir, attachment }),
        });
        if (text.length > 0) {
          inputItems.push({
            type: "text",
            text,
          });
        }
        const attachmentItems = yield* Effect.forEach(
          turnInput.message.attachments.filter(isProviderNativeImageAttachment),
          resolveCodexAttachment,
          { concurrency: 1 },
        );
        inputItems.push(...attachmentItems);
        if (inputItems.length === 0) {
          return yield* toProtocolError("Turn requires non-empty text or attachments.");
        }
        return inputItems;
      });

  return { updateSubagentSelection, registerSubagentThread, registerSubagentThreads, registerSubagentActivity, updateSubagentStates, resolvePlanId, resolveCodexAttachment, toCodexInput };
});

export type RegisterSubagentThreadPart = ReturnType<typeof installRegisterSubagentThread> extends Effect.Effect<infer A, infer _E, infer _R> ? A : ReturnType<typeof installRegisterSubagentThread>;
