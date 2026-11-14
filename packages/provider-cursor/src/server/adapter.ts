import type { InteractionUpdate, McpServerConfig, SDKUserMessage } from "@cursor/sdk";
import * as HostProcess from "@t3tools/shared/HostProcess";
import {
  type ChatAttachment,
  type ModelSelection,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2PlanArtifact,
  type OrchestrationV2ProviderThread,
  type ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import { CursorTransportFailure } from "./transportFailure.ts";
import { cursorContextWindowTokens, cursorSdkModelSelection } from "./sdkModel.ts";
import { makeCursorAdapterProjection } from "./cursorAdapterProjection.ts";
import {
  discoverCursorSkills,
  hasCursorSkillMention,
  rewriteCursorSkillMentions,
} from "./skills.ts";
import { t3OrchestrationPrompt } from "@t3tools/provider-core/server/orchestrationInstructions";
import { buildRuntimeInstructions } from "@t3tools/provider-core/server/runtimeInstructions";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import { makeProviderFailure } from "@t3tools/provider-core/server/failure";
import { turnScopedSelectionTransition } from "@t3tools/provider-core/server/selectionTransition";
import {
  isProviderNativeImageAttachment,
  providerMessageTextWithAttachmentPaths,
} from "@t3tools/provider-core/server/attachmentPrompt";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as CursorAgentSdk from "./CursorAgentSdk.ts";
export { cursorSdkModelSelection } from "./sdkModel.ts";

import {
  CursorProviderCapabilitiesV2,
  cursorMcpServers,
  providerSession,
  makeProviderThread,
  nativeThreadId,
  makeCursorAgentOptions,
  classifyCursorModelRejection,
  textFromAgentMessage,
  type CursorProjectionTarget,
  type ActiveCursorTurn,
  type CursorLiveAgent,
} from "./adapterSupport.ts";

export * from "./adapterSupport.ts";
import { makeCursorTurnCompletion } from "./adapterTurnCompletion.ts";
import type { CursorAdapterV2Options } from "./adapterSupport.ts";

export const makeCursorAdapterV2 = Effect.fn("makeCursorAdapterV2")(function* (
  options: CursorAdapterV2Options,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const idAllocator = yield* IdAllocator.IdAllocatorV2;
  const runner = yield* CursorAgentSdk.CursorAgentSdkRunner;
  const platform = yield* HostProcess.Platform;
  const host = yield* ProviderHost.ProviderHost;
  const mcpSessions = yield* McpProviderSessions.McpProviderSessions;
  const adapterOptions = options;
  const apiKey = adapterOptions.environment.CURSOR_API_KEY?.trim() || undefined;

  return ProviderAdapter.ProviderAdapterV2.of({
    instanceId: adapterOptions.instanceId,
    driver: CursorAgentSdk.CURSOR_PROVIDER,
    getCapabilities: Effect.fn("CursorAdapter.getCapabilities")(function () {
      return Effect.succeed(CursorProviderCapabilitiesV2);
    }),
    planSelectionTransition: Effect.fn("CursorAdapter.planSelectionTransition")(function () {
      return Effect.succeed(turnScopedSelectionTransition());
    }),
    openSession: Effect.fn("CursorAdapterV2.openSession")(
      function* (input: ProviderAdapter.ProviderAdapterV2OpenSessionInput) {
        const sessionScope = yield* Effect.scope;
        const createdAt = yield* DateTime.now;
        const session = providerSession({
          providerSessionId: input.providerSessionId,
          providerInstanceId: adapterOptions.instanceId,
          cwd: input.runtimePolicy.cwd,
          model: input.modelSelection.model,
          now: createdAt,
        });
        const events = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
        const liveAgent = yield* Ref.make<CursorLiveAgent | null>(null);
        // What the native conversation was told since it started or was last compacted.
        const told = yield* Ref.make<{
          readonly agent: string;
          readonly orchestration: boolean;
          readonly device: boolean;
        } | null>(null);
        const warnedUnsupportedSandbox = yield* Ref.make(false);
        const activeTurn = yield* Ref.make<ActiveCursorTurn | null>(null);
        const planIds = yield* Ref.make(new Map<string, OrchestrationV2PlanArtifact["id"]>());

        const emitProviderEvent = (event: ProviderAdapter.ProviderAdapterV2Event) =>
          Queue.offer(events, event).pipe(Effect.asVoid);

        const resolveItemOrdinal = (context: ActiveCursorTurn, nativeItemId: string) =>
          Effect.sync(() => {
            const existing = context.itemOrdinals.get(nativeItemId);
            if (existing !== undefined) {
              return existing;
            }
            const ordinal = context.input.providerTurnOrdinal * 100 + context.itemOrdinals.size + 1;
            context.itemOrdinals.set(nativeItemId, ordinal);
            return ordinal;
          });

        const resolvePlanId = Effect.fnUntraced(function* (
          context: ActiveCursorTurn,
          nativeItemId: string,
        ) {
          const existing = (yield* Ref.get(planIds)).get(nativeItemId);
          if (existing !== undefined) {
            return existing;
          }
          const planId = yield* idAllocator.allocate.plan({
            threadId: context.input.threadId,
            runId: context.input.runId,
            driver: CursorAgentSdk.CURSOR_PROVIDER,
          });
          yield* Ref.update(planIds, (current) => {
            const updated = new Map(current);
            updated.set(nativeItemId, planId);
            return updated;
          });
          return planId;
        });

        const parentTarget = (context: ActiveCursorTurn): CursorProjectionTarget => ({
          threadId: context.input.threadId,
          runId: context.input.runId,
          rootNodeId: context.input.rootNodeId,
          parentNodeId: context.input.rootNodeId,
          providerThreadId: context.input.providerThread.id,
          providerTurnId: context.providerTurnId,
        });

        const {
          appendTextSegment,
          completeAssistant,
          completeReasoning,
          emitToolArtifacts,
          emitSubagent,
          handleInteractionUpdate,
        } = makeCursorAdapterProjection({
          idAllocator,
          createdAt,
          emitProviderEvent,
          parentTarget,
          resolvePlanId,
          resolveItemOrdinal,
          path,
        });
        const { finalizeTurn, providerTurnPayload, isResumeFailureAfterTurnEnded, terminalStatus } =
          makeCursorTurnCompletion({
            providerSessionId: session.id,
            activeTurn,
            emitProviderEvent,
            resolveItemOrdinal,
            projection: { emitToolArtifacts, emitSubagent, completeReasoning, completeAssistant },
          });

        const openAgent = Effect.fnUntraced(function* (openInput: {
          readonly operation: "create" | "resume";
          readonly threadId: ThreadId;
          readonly modelSelection: ModelSelection;
          readonly runtimePolicy: ProviderAdapter.ProviderAdapterV2RuntimePolicy;
          readonly agentId?: string;
        }) {
          const existing = yield* Ref.get(liveAgent);
          if (
            existing !== null &&
            openInput.operation === "resume" &&
            existing.nativeThreadId === openInput.agentId
          ) {
            return existing;
          }
          if (existing !== null) {
            yield* existing.session.close.pipe(Effect.ignore);
            yield* Ref.set(liveAgent, null);
          }
          const options = makeCursorAgentOptions({
            ...(apiKey === undefined ? {} : { apiKey }),
            modelSelection: openInput.modelSelection,
            runtimePolicy: openInput.runtimePolicy,
            platform,
            threadId: openInput.threadId,
            mcpSession: yield* mcpSessions.read(openInput.threadId),
          });
          if (
            platform === "win32" &&
            openInput.runtimePolicy.sandboxPolicy === undefined &&
            openInput.runtimePolicy.runtimeMode !== "full-access" &&
            options.local?.sandboxOptions?.enabled === false &&
            !(yield* Ref.getAndSet(warnedUnsupportedSandbox, true))
          ) {
            yield* Effect.logWarning(
              "Cursor cannot sandbox the filesystem on Windows; this thread runs without filesystem isolation.",
            );
          }
          const sdkSession = yield* runner
            .open({
              operation: openInput.operation,
              ...(openInput.agentId === undefined ? {} : { agentId: openInput.agentId }),
              options,
              threadId: openInput.threadId,
              providerSessionId: input.providerSessionId,
            })
            .pipe(Effect.mapError(classifyCursorModelRejection(openInput.modelSelection)));
          const next = {
            nativeThreadId: sdkSession.agentId,
            session: sdkSession,
          } satisfies CursorLiveAgent;
          yield* Ref.set(liveAgent, next);
          return next;
        });

        let cursorSkillNames: ReadonlySet<string> | undefined;
        const resolveUserMessage = Effect.fnUntraced(function* (
          turnInput: ProviderAdapter.ProviderAdapterV2TurnInput,
          mcpServers: Record<string, McpServerConfig> | undefined,
          hasDeviceTools: boolean,
          delivered: { readonly orchestration: boolean; readonly device: boolean },
        ) {
          const rawText = turnInput.message.text;
          if (rawText.trim() === "/compress" && turnInput.message.attachments.length === 0) {
            return "/compress";
          }
          if (hasCursorSkillMention(rawText) && cursorSkillNames === undefined) {
            const skills = yield* discoverCursorSkills(
              turnInput.runtimePolicy.cwd ?? undefined,
              adapterOptions.environment,
            ).pipe(
              Effect.provideService(FileSystem.FileSystem, fileSystem),
              Effect.provideService(Path.Path, path),
            );
            cursorSkillNames = new Set(
              skills
                .filter((skill) => skill.enabled && skill.userInvocable !== false)
                .map((skill) => skill.name),
            );
          }
          const userText = t3OrchestrationPrompt({
            prompt: yield* providerMessageTextWithAttachmentPaths({
              text:
                cursorSkillNames === undefined
                  ? rawText
                  : rewriteCursorSkillMentions(rawText, cursorSkillNames),
              attachments: turnInput.message.attachments,
              resolveAttachmentPath: host.resolveAttachmentPath,
              resolveExtractedTextPath: host.resolveExtractedTextPath,
            }),
            hasT3Mcp: mcpServers !== undefined,
            hasDeviceTools,
            orchestrationDelivered: delivered.orchestration,
            deviceInstructionsDelivered: delivered.device,
          });
          const images = yield* Effect.forEach(
            turnInput.message.attachments.filter(isProviderNativeImageAttachment),
            (attachment: ChatAttachment) =>
              Effect.gen(function* () {
                const path = host.resolveAttachmentPath(attachment);
                if (path === null) {
                  return yield* new ProviderAdapter.ProviderAdapterProtocolError({
                    driver: CursorAgentSdk.CURSOR_PROVIDER,
                    detail: `Invalid attachment id '${attachment.id}'.`,
                  });
                }
                const bytes = yield* fileSystem.readFile(path).pipe(
                  Effect.mapError(
                    (cause) =>
                      new ProviderAdapter.ProviderAdapterProtocolError({
                        driver: CursorAgentSdk.CURSOR_PROVIDER,
                        detail: `Failed to read attachment '${attachment.id}'.`,
                        reason: "attachment_unreadable",
                        payload: cause,
                      }),
                  ),
                );
                return {
                  data: Buffer.from(bytes).toString("base64"),
                  mimeType: attachment.mimeType,
                };
              }),
            { concurrency: 1 },
          );
          if (userText.length === 0 && images.length === 0) {
            return yield* new ProviderAdapter.ProviderAdapterProtocolError({
              driver: CursorAgentSdk.CURSOR_PROVIDER,
              detail: "Cursor turn requires non-empty text or attachments.",
            });
          }
          const text = `${userText}\n\n${buildRuntimeInstructions({ harness: "Cursor", model: turnInput.modelSelection.model })}`;
          return images.length === 0
            ? text
            : ({
                text,
                images,
              } satisfies SDKUserMessage);
        });

        const startTurn = Effect.fn("CursorAdapterV2.startTurn")(
          function* (turnInput: ProviderAdapter.ProviderAdapterV2TurnInput) {
            const current = yield* Ref.get(activeTurn);
            if (current !== null) {
              return yield* new ProviderAdapter.ProviderAdapterProtocolError({
                driver: CursorAgentSdk.CURSOR_PROVIDER,
                detail: `Cursor provider turn ${current.providerTurnId} is still active.`,
                reason: "previous_turn_active",
              });
            }
            const agentId = nativeThreadId(turnInput.providerThread);
            const agent = yield* openAgent({
              operation: "resume",
              agentId,
              threadId: turnInput.threadId,
              modelSelection: turnInput.modelSelection,
              runtimePolicy: turnInput.runtimePolicy,
            });
            const mcpSession = yield* mcpSessions.read(turnInput.threadId);
            const mcpServers = cursorMcpServers(mcpSession);
            const hasDeviceTools =
              mcpServers !== undefined && mcpSession?.capabilities?.has("device") === true;
            const known = yield* Ref.get(told);
            // A conversation this process has not sent to was told on its first run.
            const delivered =
              known?.agent === agent.nativeThreadId
                ? known
                : { orchestration: turnInput.runOrdinal > 1, device: false };
            const message = yield* resolveUserMessage(
              turnInput,
              mcpServers,
              hasDeviceTools,
              delivered,
            );
            const compacted = message === "/compress";
            const pendingUpdates: Array<InteractionUpdate> = [];
            let context: ActiveCursorTurn | null = null;
            // Create-time and send-time mcpServers merge with settingSources (SDK >= 1.0.39).
            const sdkRun = yield* agent.session
              .send({
                message,
                summarize: compacted,
                options: {
                  model: cursorSdkModelSelection(turnInput.modelSelection),
                  mode: turnInput.runtimePolicy.interactionMode === "plan" ? "plan" : "agent",
                  ...(mcpServers === undefined ? {} : { mcpServers }),
                },
                onDelta: (update) => {
                  if (context === null) {
                    return Effect.sync(() => {
                      pendingUpdates.push(update);
                    });
                  }
                  return handleInteractionUpdate(context, update);
                },
              })
              .pipe(Effect.mapError(classifyCursorModelRejection(turnInput.modelSelection)));
            yield* Ref.set(told, {
              agent: agent.nativeThreadId,
              orchestration: !compacted && (delivered.orchestration || mcpServers !== undefined),
              device: !compacted && hasDeviceTools,
            });
            const startedAt = yield* DateTime.now;
            const completed = yield* Deferred.make<void, never>();
            const providerTurnId = idAllocator.derive.providerTurn({
              driver: CursorAgentSdk.CURSOR_PROVIDER,
              nativeTurnId: sdkRun.runId,
            });
            context = {
              input: turnInput,
              run: sdkRun,
              providerTurnId,
              startedAt,
              completed,
              itemOrdinals: new Map(),
              tools: new Map(),
              subagents: new Map(),
              assistant: {
                current: null,
                nextSegment: 0,
              },
              assistantReply: new CursorTransportFailure(),
              reasoning: {
                current: null,
                nextSegment: 0,
              },
              interrupted: false,
              finalized: false,
              turnEnded: false,
            };
            yield* Ref.set(activeTurn, context);
            yield* emitProviderEvent({
              type: "provider_turn.updated",
              driver: CursorAgentSdk.CURSOR_PROVIDER,
              providerTurn: providerTurnPayload({
                context,
                status: "running",
                completedAt: null,
              }),
            });
            yield* emitProviderEvent({
              type: "provider_thread.updated",
              driver: CursorAgentSdk.CURSOR_PROVIDER,
              providerThread: {
                ...turnInput.providerThread,
                providerSessionId: session.id,
                status: "active",
                updatedAt: startedAt,
              },
            });
            for (const update of pendingUpdates) {
              yield* handleInteractionUpdate(context, update);
            }

            yield* sdkRun.wait.pipe(
              Effect.flatMap((result) =>
                Effect.gen(function* () {
                  if (
                    context !== null &&
                    context.assistant.nextSegment === 0 &&
                    // A summarize run's result is the summary, not an answer.
                    !compacted &&
                    // Text from a resume that made no progress is not the turn's answer.
                    !isResumeFailureAfterTurnEnded(context, result) &&
                    result.result !== undefined &&
                    result.result.length > 0
                  ) {
                    context.assistantReply.push(result.result);
                    yield* appendTextSegment({
                      context,
                      stream: context.assistant,
                      kind: "assistant",
                      text: result.result,
                    });
                  }
                  if (context !== null && isResumeFailureAfterTurnEnded(context, result)) {
                    yield* Effect.logWarning(
                      "orchestration-v2.cursor-resume-failed-after-turn-ended",
                      {
                        providerSessionId: input.providerSessionId,
                        providerThreadId: turnInput.providerThread.id,
                        providerTurnId,
                      },
                    );
                  }
                  if (context !== null) {
                    const transportFailure = context.assistantReply.failure;
                    const status =
                      transportFailure === undefined ? terminalStatus(context, result) : "failed";
                    yield* finalizeTurn({
                      context,
                      status,
                      ...(status === "failed"
                        ? {
                            failure:
                              transportFailure === undefined
                                ? makeProviderFailure({
                                    cause: result.error,
                                    // makeProviderFailure never reads a cause's own text.
                                    message: result.error?.message,
                                    class: CursorAgentSdk.isCursorUsageLimitError(result.error)
                                      ? "usage_limit"
                                      : "provider_error",
                                  })
                                : makeProviderFailure({
                                    cause: transportFailure,
                                    class: "transport_error",
                                  }),
                          }
                        : {}),
                    });
                  }
                }),
              ),
              Effect.catch((cause) =>
                Effect.gen(function* () {
                  if (context !== null) {
                    yield* finalizeTurn({
                      context,
                      status: context.interrupted ? "interrupted" : "failed",
                      ...(context.interrupted
                        ? {}
                        : {
                            failure: makeProviderFailure({
                              cause,
                              message: CursorAgentSdk.isCursorAgentSdkRunnerError(cause)
                                ? CursorAgentSdk.cursorSdkFailureMessage(cause)
                                : undefined,
                              class: CursorAgentSdk.isCursorUsageLimitError(cause)
                                ? "usage_limit"
                                : "transport_error",
                            }),
                          }),
                    });
                  }
                  yield* Effect.logWarning("orchestration-v2.cursor-run-failed", {
                    providerSessionId: input.providerSessionId,
                    providerThreadId: turnInput.providerThread.id,
                    providerTurnId,
                    cause,
                  });
                }),
              ),
              Effect.forkIn(sessionScope),
            );
          },
          (effect, turnInput) =>
            effect.pipe(
              Effect.mapError(
                (cause) =>
                  new ProviderAdapter.ProviderAdapterTurnStartError({
                    driver: CursorAgentSdk.CURSOR_PROVIDER,
                    threadId: turnInput.threadId,
                    providerThreadId: turnInput.providerThread.id,
                    runId: turnInput.runId,
                    cause,
                  }),
              ),
            ),
        );

        const closeSession = Effect.fnUntraced(function* () {
          const existing = yield* Ref.get(liveAgent);
          if (existing !== null) {
            yield* existing.session.close.pipe(Effect.ignore);
            yield* Ref.set(liveAgent, null);
          }
          yield* runner.assertComplete.pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("orchestration-v2.cursor-runner-incomplete", {
                providerSessionId: input.providerSessionId,
                cause,
              }),
            ),
          );
        });
        yield* Effect.addFinalizer(() => closeSession());

        const runtime: ProviderAdapter.ProviderAdapterV2SessionRuntime = {
          instanceId: adapterOptions.instanceId,
          driver: CursorAgentSdk.CURSOR_PROVIDER,
          providerSessionId: input.providerSessionId,
          providerSession: session,
          getModelContextWindow: (selection) =>
            selection.instanceId === adapterOptions.instanceId
              ? cursorContextWindowTokens(selection, adapterOptions.getModels?.() ?? [])
              : undefined,
          events: Stream.fromEffectRepeat(Queue.take(events)),
          ensureThread: Effect.fn("CursorAdapterV2.ensureThread")(
            function* (threadInput: ProviderAdapter.ProviderAdapterV2EnsureThreadInput) {
              const opened = yield* openAgent({
                operation: "create",
                threadId: threadInput.threadId,
                modelSelection: threadInput.modelSelection,
                runtimePolicy: threadInput.runtimePolicy,
              });
              const now = yield* DateTime.now;
              return makeProviderThread({
                idAllocator,
                providerInstanceId: adapterOptions.instanceId,
                appThreadId: threadInput.threadId,
                providerSessionId: input.providerSessionId,
                nativeThreadId: opened.nativeThreadId,
                now,
              });
            },
            (effect, threadInput) =>
              effect.pipe(
                Effect.mapError(
                  (cause) =>
                    new ProviderAdapter.ProviderAdapterEnsureThreadError({
                      driver: CursorAgentSdk.CURSOR_PROVIDER,
                      threadId: threadInput.threadId,
                      cause,
                    }),
                ),
              ),
          ),
          resumeThread: Effect.fn("CursorAdapterV2.resumeThread")(
            function* (threadInput: { readonly providerThread: OrchestrationV2ProviderThread }) {
              const agentId = nativeThreadId(threadInput.providerThread);
              yield* openAgent({
                operation: "resume",
                agentId,
                threadId: threadInput.providerThread.appThreadId ?? input.threadId,
                modelSelection: input.modelSelection,
                runtimePolicy: input.runtimePolicy,
              });
              const now = yield* DateTime.now;
              return {
                ...threadInput.providerThread,
                providerSessionId: input.providerSessionId,
                status: "idle" as const,
                updatedAt: now,
              };
            },
            (effect, threadInput) =>
              effect.pipe(
                Effect.mapError(
                  (cause) =>
                    new ProviderAdapter.ProviderAdapterResumeThreadError({
                      driver: CursorAgentSdk.CURSOR_PROVIDER,
                      providerSessionId: input.providerSessionId,
                      providerThreadId: threadInput.providerThread.id,
                      cause,
                    }),
                ),
              ),
          ),
          startTurn,
          compactThread: (turnInput) =>
            startTurn({
              ...turnInput,
              message: { ...turnInput.message, text: "/compress" },
            }),
          steerTurn: (turnInput) =>
            Effect.fail(
              new ProviderAdapter.ProviderAdapterSteerRunUnsupportedError({
                driver: CursorAgentSdk.CURSOR_PROVIDER,
                providerThreadId: turnInput.providerThread.id,
              }),
            ),
          interruptTurn: Effect.fn("CursorAdapterV2.interruptTurn")(
            function* (turnInput: ProviderAdapter.ProviderAdapterV2InterruptInput) {
              const context = yield* Ref.get(activeTurn);
              if (context === null && turnInput.requestRuntimeRestart === true) return;
              if (context?.providerTurnId !== turnInput.providerTurnId) {
                return yield* new ProviderAdapter.ProviderAdapterProtocolError({
                  driver: CursorAgentSdk.CURSOR_PROVIDER,
                  detail: `Cursor provider turn ${turnInput.providerTurnId} is not active.`,
                });
              }
              context.interrupted = true;
              yield* context.run.cancel;
              const stopped = yield* Deferred.await(context.completed).pipe(
                Effect.timeoutOption("10 seconds"),
              );
              if (Option.isSome(stopped)) {
                return;
              }
              yield* Effect.logWarning("orchestration-v2.cursor-interrupt-timeout", {
                providerSessionId: input.providerSessionId,
                providerThreadId: turnInput.providerThread.id,
                providerTurnId: turnInput.providerTurnId,
              });
              yield* finalizeTurn({ context, status: "interrupted" });
            },
            (effect, turnInput) =>
              effect.pipe(
                Effect.mapError(
                  (cause) =>
                    new ProviderAdapter.ProviderAdapterInterruptError({
                      driver: CursorAgentSdk.CURSOR_PROVIDER,
                      providerThreadId: turnInput.providerThread.id,
                      providerTurnId: turnInput.providerTurnId,
                      cause,
                    }),
                ),
              ),
          ),
          respondToRuntimeRequest: (requestInput) =>
            Effect.fail(
              new ProviderAdapter.ProviderAdapterRuntimeRequestResponseError({
                driver: CursorAgentSdk.CURSOR_PROVIDER,
                requestId: requestInput.requestId,
                cause: new ProviderAdapter.ProviderAdapterProtocolError({
                  driver: CursorAgentSdk.CURSOR_PROVIDER,
                  detail: "Cursor Agent SDK does not expose interactive approval requests.",
                }),
              }),
            ),
          readThreadSnapshot: Effect.fn("CursorAdapterV2.readThreadSnapshot")(
            function* (snapshotInput) {
              const requestedAgentId = nativeThreadId(snapshotInput.providerThread);
              const agent = yield* openAgent({
                operation: "resume",
                agentId: requestedAgentId,
                threadId: snapshotInput.providerThread.appThreadId ?? input.threadId,
                modelSelection: input.modelSelection,
                runtimePolicy: input.runtimePolicy,
              });
              const messages = yield* agent.session.listMessages;
              const now = yield* DateTime.now;
              const threadId = snapshotInput.providerThread.appThreadId ?? input.threadId;
              const projectedMessages: Array<OrchestrationV2ConversationMessage> = messages.flatMap(
                (message) => {
                  const text = textFromAgentMessage(message);
                  if (text.length === 0) {
                    return [];
                  }
                  return [
                    {
                      createdBy: message.type === "user" ? "user" : "agent",
                      creationSource: "provider",
                      id: idAllocator.derive.messageFromProviderItem({
                        driver: CursorAgentSdk.CURSOR_PROVIDER,
                        nativeItemId: message.uuid,
                      }),
                      threadId,
                      runId: null,
                      nodeId: null,
                      role: message.type,
                      text,
                      attachments: [],
                      streaming: false,
                      createdAt: now,
                      updatedAt: now,
                    },
                  ];
                },
              );
              return {
                providerThread: {
                  ...snapshotInput.providerThread,
                  providerSessionId: input.providerSessionId,
                  status: "idle" as const,
                  updatedAt: now,
                },
                providerTurns: [],
                messages: projectedMessages,
                runtimeRequests: [],
                providerPayload: {
                  agentId: requestedAgentId,
                  messages,
                },
              };
            },
            (effect, snapshotInput) =>
              effect.pipe(
                Effect.mapError(
                  (cause) =>
                    new ProviderAdapter.ProviderAdapterReadThreadSnapshotError({
                      driver: CursorAgentSdk.CURSOR_PROVIDER,
                      providerThreadId: snapshotInput.providerThread.id,
                      cause,
                    }),
                ),
              ),
          ),
          rollbackThread: (rollbackInput) =>
            Effect.fail(
              new ProviderAdapter.ProviderAdapterRollbackThreadError({
                driver: CursorAgentSdk.CURSOR_PROVIDER,
                providerThreadId: rollbackInput.providerThread.id,
                checkpointId: rollbackInput.target.checkpointId,
                cause: "Cursor Agent SDK does not expose conversation rollback.",
              }),
            ),
          forkThread: (forkInput) =>
            Effect.fail(
              new ProviderAdapter.ProviderAdapterForkThreadError({
                driver: CursorAgentSdk.CURSOR_PROVIDER,
                providerThreadId: forkInput.sourceProviderThread.id,
                cause: "Cursor Agent SDK does not expose native agent forks.",
              }),
            ),
        };
        return runtime;
      },
      (effect, input) =>
        effect.pipe(
          Effect.mapError(
            (cause) =>
              new ProviderAdapter.ProviderAdapterOpenSessionError({
                driver: CursorAgentSdk.CURSOR_PROVIDER,
                providerSessionId: input.providerSessionId,
                cause,
              }),
          ),
        ),
    ),
  });
});
