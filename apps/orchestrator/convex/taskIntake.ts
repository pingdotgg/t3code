"use node";

import { v } from "convex/values";

import {
  applyTeamAppMuteCommand,
  mentionsNonTeamAppSlackUser,
  mentionsTeamAppUser,
  shouldIgnoreTeamAppMessage,
  teamAppMuteCommandReaction,
} from "../src/domain/teamAppMessages.ts";
import { createTaskIntakeChatSdkBot } from "../src/taskIntake/chatSdk.ts";
import { createConvexChatSdkState } from "../src/taskIntake/convexChatSdkState.ts";
import type { TaskIntakeMessage } from "../src/taskIntake/contracts.ts";
import { handleTaskIntakeMessage } from "../src/taskIntake/ingress.ts";
import { chatSdkThreadIdForLifecycleReply } from "../src/taskIntake/lifecycleReplies.ts";
import {
  buildT3ThreadUrl,
  postablePullRequestStatus,
  postableReplyBody,
  postableTaskStartedStatus,
} from "../src/taskIntake/postableReply.ts";
import {
  buildInitialPromptContext,
  collectSlackThreadContext,
} from "../src/taskIntake/slackThreadContext.ts";
import { api, internal } from "./_generated/api.js";
import type { Id } from "./_generated/dataModel.js";
import { internalAction } from "./_generated/server.js";

const headerArg = v.object({
  name: v.string(),
  value: v.string(),
});

function t3WebAppBaseUrl() {
  return (
    process.env.T3_WEB_APP_BASE_URL?.trim() ||
    process.env.T3_EXECUTION_BRIDGE_BASE_URL?.trim() ||
    undefined
  );
}

function toConvexModelSelection(
  modelSelection:
    | {
        readonly instanceId: string;
        readonly model: string;
        readonly options?: readonly {
          readonly id: string;
          readonly value: string | boolean;
        }[];
      }
    | undefined,
) {
  if (modelSelection === undefined) return undefined;

  return {
    instanceId: modelSelection.instanceId,
    model: modelSelection.model,
    ...(modelSelection.options !== undefined
      ? {
          options: modelSelection.options.map((option) => ({
            id: option.id,
            value: option.value,
          })),
        }
      : {}),
  };
}

function stripTeamAppMention(text: string) {
  let next = text;
  const botUserId = process.env.SLACK_BOT_USER_ID?.trim();
  if (botUserId) {
    next = next.replace(new RegExp(`<@${botUserId}(?:\\|[^>]+)?>`, "gi"), "");
    next = next.replace(new RegExp(`(^|\\s)@${botUserId}\\b`, "gi"), " ");
  }
  const botUserName = process.env.SLACK_BOT_USERNAME?.trim() || "Vevin";
  next = next.replace(
    new RegExp(`(^|\\s)@${botUserName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "gi"),
    " ",
  );
  return next.replace(/[ \t]{2,}/g, " ").trim();
}

function buildUserInputAnswers(questionsJson: string, answerText: string) {
  const questions = JSON.parse(questionsJson) as Array<{ readonly id?: unknown }>;
  const questionIds = questions
    .map((question) => (typeof question.id === "string" ? question.id.trim() : ""))
    .filter((id) => id.length > 0);
  const ids = questionIds.length > 0 ? questionIds : ["answer"];
  return Object.fromEntries(ids.map((id) => [id, answerText]));
}

function errorSummary(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function logOrchestratorEvent(
  ctx: any,
  input: {
    readonly kind: string;
    readonly summary: string;
    readonly severity?: "debug" | "info" | "warn" | "error" | undefined;
    readonly eventKey?: string | undefined;
    readonly taskId?: Id<"tasks"> | undefined;
    readonly workSessionId?: Id<"workSessions"> | undefined;
    readonly externalId?: string | undefined;
    readonly payload?: unknown | undefined;
  },
) {
  console[input.severity === "error" ? "error" : input.severity === "warn" ? "warn" : "log"](
    input.kind,
    {
      summary: input.summary,
      ...(input.eventKey !== undefined ? { eventKey: input.eventKey } : {}),
      ...(input.taskId !== undefined ? { taskId: String(input.taskId) } : {}),
      ...(input.workSessionId !== undefined ? { workSessionId: String(input.workSessionId) } : {}),
      ...(input.externalId !== undefined ? { externalId: input.externalId } : {}),
      ...(input.payload !== undefined ? { payload: input.payload } : {}),
    },
  );
  return ctx
    .runMutation(internal.observability.append, {
      kind: input.kind,
      source: "slack",
      severity: input.severity ?? "info",
      summary: input.summary,
      ...(input.eventKey !== undefined ? { eventKey: input.eventKey } : {}),
      ...(input.taskId !== undefined ? { taskId: input.taskId } : {}),
      ...(input.workSessionId !== undefined ? { workSessionId: input.workSessionId } : {}),
      ...(input.externalId !== undefined ? { externalId: input.externalId } : {}),
      ...(input.payload !== undefined ? { payloadJson: JSON.stringify(input.payload) } : {}),
    })
    .catch((error: unknown) => {
      console.warn("observability.append.failed", {
        kind: input.kind,
        error: errorSummary(error),
      });
    });
}

function chatSdkState(ctx: any) {
  return createConvexChatSdkState({
    subscribe(threadId) {
      return ctx.runMutation(internal.chatSdkState.subscribe, { threadId });
    },
    unsubscribe(threadId) {
      return ctx.runMutation(internal.chatSdkState.unsubscribe, { threadId });
    },
    isSubscribed(threadId) {
      return ctx.runMutation(internal.chatSdkState.isSubscribed, { threadId });
    },
    acquireLock(input) {
      return ctx.runMutation(internal.chatSdkState.acquireLock, input);
    },
    releaseLock(lock) {
      return ctx.runMutation(internal.chatSdkState.releaseLock, {
        threadId: lock.threadId,
        token: lock.token,
      });
    },
    forceReleaseLock(threadId) {
      return ctx.runMutation(internal.chatSdkState.forceReleaseLock, { threadId });
    },
    extendLock(input) {
      return ctx.runMutation(internal.chatSdkState.extendLock, {
        threadId: input.lock.threadId,
        token: input.lock.token,
        ttlMs: input.ttlMs,
      });
    },
    get(key) {
      return ctx.runMutation(internal.chatSdkState.get, { key });
    },
    set(input) {
      return ctx.runMutation(internal.chatSdkState.set, input);
    },
    setIfNotExists(input) {
      return ctx.runMutation(internal.chatSdkState.setIfNotExists, input);
    },
    delete(key) {
      return ctx.runMutation(internal.chatSdkState.deleteKey, { key });
    },
    appendToList(input) {
      return ctx.runMutation(internal.chatSdkState.appendToList, input);
    },
    getList(key) {
      return ctx.runMutation(internal.chatSdkState.getList, { key });
    },
    enqueue(input) {
      return ctx.runMutation(internal.chatSdkState.enqueue, input);
    },
    dequeue(threadId) {
      return ctx.runMutation(internal.chatSdkState.dequeue, { threadId });
    },
    queueDepth(threadId) {
      return ctx.runMutation(internal.chatSdkState.queueDepth, { threadId });
    },
  });
}

async function shouldHandleSlackIntakeMessage(
  ctx: any,
  intakeMessage: TaskIntakeMessage,
  rawText?: string,
) {
  if (intakeMessage.source !== "slack") {
    return { handle: true as const };
  }

  const externalId = intakeMessage.conversation.externalId;
  const existingLink = await ctx.runQuery(api.taskExternalLinks.findTaskExternalLink, {
    kind: "slack_thread",
    externalId,
  });
  const mentionsBot = mentionsTeamAppUser({
    body: intakeMessage.text,
    botUserId: process.env.SLACK_BOT_USER_ID,
    botUserName: process.env.SLACK_BOT_USERNAME,
  });
  console.log("taskIntake.slack.policy.input", {
    eventId: intakeMessage.eventId,
    messageId: intakeMessage.messageId,
    externalId,
    hasExistingLink: existingLink !== null,
    isMuted: existingLink?.muted ?? false,
    mentionsBot,
    textPreview: intakeMessage.text.slice(0, 120),
  });
  const muteCommand = applyTeamAppMuteCommand({
    body: intakeMessage.text,
    isThreadMuted: existingLink?.muted ?? false,
    mentionsAiEngineer: mentionsBot,
  });
  if (muteCommand.command !== undefined) {
    if (existingLink !== null && muteCommand.changed) {
      await ctx.runMutation(api.taskExternalLinks.setTaskExternalLinkMuted, {
        kind: "slack_thread",
        externalId,
        muted: muteCommand.muted,
      });
    }
    console.log("taskIntake.slack.policy.ignore", {
      eventId: intakeMessage.eventId,
      reason: `slack_thread_${muteCommand.command}`,
      muted: muteCommand.muted,
      changed: muteCommand.changed,
    });
    await logOrchestratorEvent(ctx, {
      kind: "slack.policy.ignored",
      summary: "Slack message was handled as a mute/unmute command.",
      eventKey: `${intakeMessage.eventId}:slack-policy:${muteCommand.command}`,
      externalId,
      payload: {
        eventId: intakeMessage.eventId,
        reason: `slack_thread_${muteCommand.command}`,
        muted: muteCommand.muted,
        changed: muteCommand.changed,
      },
    });
    return { handle: false as const, reason: `slack_thread_${muteCommand.command}` };
  }

  const decision = shouldIgnoreTeamAppMessage({
    body: intakeMessage.text,
    isThreadMuted: existingLink?.muted ?? false,
    mentionsAiEngineer: mentionsBot,
  });
  if (decision.ignore) {
    console.log("taskIntake.slack.policy.ignore", {
      eventId: intakeMessage.eventId,
      reason: `slack_thread_${decision.reason}`,
    });
    await logOrchestratorEvent(ctx, {
      kind: "slack.policy.ignored",
      summary: "Slack message was ignored by Vevin policy.",
      eventKey: `${intakeMessage.eventId}:slack-policy:${decision.reason}`,
      externalId,
      payload: {
        eventId: intakeMessage.eventId,
        reason: `slack_thread_${decision.reason}`,
        hasExistingLink: existingLink !== null,
        isMuted: existingLink?.muted ?? false,
      },
    });
    return { handle: false as const, reason: `slack_thread_${decision.reason}` };
  }

  if (
    mentionsNonTeamAppSlackUser({
      body: intakeMessage.text,
      botUserId: process.env.SLACK_BOT_USER_ID,
    }) ||
    (rawText !== undefined &&
      mentionsNonTeamAppSlackUser({
        body: rawText,
        botUserId: process.env.SLACK_BOT_USER_ID,
      }))
  ) {
    console.log("taskIntake.slack.policy.ignore", {
      eventId: intakeMessage.eventId,
      reason: "slack_thread_other_user_mention",
    });
    await logOrchestratorEvent(ctx, {
      kind: "slack.policy.ignored",
      summary: "Slack message was ignored because it mentioned another user.",
      eventKey: `${intakeMessage.eventId}:slack-policy:other-user-mention`,
      externalId,
      payload: {
        eventId: intakeMessage.eventId,
        reason: "slack_thread_other_user_mention",
      },
    });
    return { handle: false as const, reason: "slack_thread_other_user_mention" };
  }

  if (existingLink === null && !mentionsBot) {
    console.log("taskIntake.slack.policy.ignore", {
      eventId: intakeMessage.eventId,
      reason: "slack_ambient_without_task_thread",
    });
    await logOrchestratorEvent(ctx, {
      kind: "slack.policy.ignored",
      summary:
        "Slack message was ignored because no task thread exists and Vevin was not mentioned.",
      eventKey: `${intakeMessage.eventId}:slack-policy:ambient`,
      externalId,
      payload: {
        eventId: intakeMessage.eventId,
        reason: "slack_ambient_without_task_thread",
      },
    });
    return { handle: false as const, reason: "slack_ambient_without_task_thread" };
  }

  console.log("taskIntake.slack.policy.accept", {
    eventId: intakeMessage.eventId,
    existingTaskThread: existingLink !== null,
    mentionsBot,
  });
  await logOrchestratorEvent(ctx, {
    kind: "slack.policy.accepted",
    summary: "Slack message was accepted for orchestration.",
    eventKey: `${intakeMessage.eventId}:slack-policy:accepted`,
    externalId,
    payload: {
      eventId: intakeMessage.eventId,
      existingTaskThread: existingLink !== null,
      mentionsBot,
    },
  });
  return { handle: true as const };
}

export const handleChatSdkWebhook = internalAction({
  args: {
    source: v.literal("slack"),
    url: v.string(),
    headers: v.array(headerArg),
    body: v.string(),
  },
  returns: v.object({
    status: v.number(),
    body: v.string(),
    contentType: v.optional(v.string()),
  }),
  handler: async (ctx, args) => {
    console.log("taskIntake.webhook.received", {
      source: args.source,
      bodyBytes: args.body.length,
    });
    await logOrchestratorEvent(ctx, {
      kind: "slack.webhook.action-received",
      summary: "Slack Chat SDK webhook action started.",
      eventKey: `slack:webhook:${crypto.randomUUID()}:received`,
      payload: {
        source: args.source,
        bodyBytes: args.body.length,
      },
    });
    const bot = createTaskIntakeChatSdkBot({
      sources: new Set([args.source]),
      state: chatSdkState(ctx),
      onAttachmentFetchFailure(failure) {
        void logOrchestratorEvent(ctx, {
          kind: "slack.attachment.fetch-failed",
          severity: "warn",
          summary: "Slack image attachment could not be fetched as native bytes.",
          eventKey: `slack:attachment-fetch-failed:${crypto.randomUUID()}`,
          payload: failure,
        });
      },
      async onMessage({ thread, message, intakeMessage }) {
        try {
          console.log("taskIntake.message.received", {
            source: intakeMessage.source,
            eventId: intakeMessage.eventId,
            messageId: intakeMessage.messageId,
            threadId: thread.id,
            messageThreadId: message.threadId,
            externalLinkKind: intakeMessage.conversation.externalLinkKind,
            externalId: intakeMessage.conversation.externalId,
            textPreview: intakeMessage.text.slice(0, 120),
            attachmentCount: intakeMessage.attachments?.length ?? 0,
            nativeImageAttachmentCount:
              intakeMessage.attachments?.filter((attachment) => "dataUrl" in attachment).length ??
              0,
          });
          await logOrchestratorEvent(ctx, {
            kind: "slack.message.received",
            summary: "Slack message received from Chat SDK.",
            eventKey: `${intakeMessage.eventId}:message-received`,
            externalId: intakeMessage.conversation.externalId,
            payload: {
              source: intakeMessage.source,
              eventId: intakeMessage.eventId,
              messageId: intakeMessage.messageId,
              threadId: thread.id,
              messageThreadId: message.threadId,
              externalLinkKind: intakeMessage.conversation.externalLinkKind,
              externalId: intakeMessage.conversation.externalId,
              isMention: message.isMention,
              textPreview: intakeMessage.text.slice(0, 120),
              chatSdkAttachmentCount: message.attachments.length,
              chatSdkAttachmentTypes: message.attachments.map((attachment) => ({
                type: attachment.type,
                name: attachment.name,
                mimeType: attachment.mimeType,
                hasFetchData: attachment.fetchData !== undefined,
              })),
              attachmentCount: intakeMessage.attachments?.length ?? 0,
              nativeImageAttachmentCount:
                intakeMessage.attachments?.filter((attachment) => "dataUrl" in attachment).length ??
                0,
            },
          });
          const rawSlackMessage = message.raw as {
            readonly text?: string;
            readonly thread_ts?: string;
            readonly ts?: string;
          };
          const slackDecision = await shouldHandleSlackIntakeMessage(
            ctx,
            intakeMessage,
            rawSlackMessage.text,
          );
          if (!slackDecision.handle) {
            if (
              slackDecision.reason === "slack_thread_mute" ||
              slackDecision.reason === "slack_thread_unmute"
            ) {
              const command = slackDecision.reason === "slack_thread_mute" ? "mute" : "unmute";
              const reaction = teamAppMuteCommandReaction(command);
              try {
                await thread.createSentMessageFromMessage(message).addReaction(reaction);
                console.log("taskIntake.reply.policyAcknowledged", {
                  eventId: intakeMessage.eventId,
                  reaction,
                  reason: slackDecision.reason,
                });
              } catch (error) {
                console.warn("taskIntake.reply.policyAcknowledgementFailed", {
                  eventId: intakeMessage.eventId,
                  reaction,
                  reason: slackDecision.reason,
                  error: errorSummary(error),
                });
              }
            }
            return;
          }

          const pendingUserInput = await ctx.runQuery(
            internal.taskEvents.findOpenTaskUserInputForExternalLink,
            {
              kind: "slack_thread",
              externalId: intakeMessage.conversation.externalId,
            },
          );
          if (pendingUserInput !== null) {
            const answerText = stripTeamAppMention(intakeMessage.text);
            if (answerText.length === 0) {
              await thread
                .post(
                  postableReplyBody({
                    kind: "slack_thread",
                    body: "I need a little more detail to answer Vevin's pending question.",
                  }),
                )
                .catch(() => undefined);
              return;
            }

            const answers = buildUserInputAnswers(pendingUserInput.questionsJson, answerText);
            const claim = await ctx.runMutation(internal.taskEvents.claimTaskUserInputAnswer, {
              taskId: pendingUserInput.taskId,
              workSessionId: pendingUserInput.workSessionId,
              requestId: pendingUserInput.requestId,
              sourceEventId: intakeMessage.eventId,
              answerText,
            });
            if (!claim.claimed) {
              return;
            }

            await logOrchestratorEvent(ctx, {
              kind: "task-intake.user-input-answer.claimed",
              summary: "Slack message is answering a pending provider user-input request.",
              eventKey: `${intakeMessage.eventId}:user-input-answer-claimed`,
              taskId: pendingUserInput.taskId,
              workSessionId: pendingUserInput.workSessionId,
              externalId: intakeMessage.conversation.externalId,
              payload: {
                requestId: pendingUserInput.requestId,
                answerPreview: answerText.slice(0, 120),
              },
            });

            try {
              const response = await ctx.runAction(api.t3Runtime.respondTaskRuntimeUserInput, {
                eventId: intakeMessage.eventId,
                taskId: pendingUserInput.taskId,
                workSessionId: pendingUserInput.workSessionId,
                t3ThreadId: pendingUserInput.t3ThreadId,
                requestId: pendingUserInput.requestId,
                answersJson: JSON.stringify(answers),
              });
              await ctx.runMutation(internal.taskEvents.recordTaskUserInputResolved, {
                taskId: pendingUserInput.taskId,
                workSessionId: pendingUserInput.workSessionId,
                requestId: pendingUserInput.requestId,
                answerEventKey: claim.eventKey,
                answersJson: JSON.stringify(answers),
              });
              await logOrchestratorEvent(ctx, {
                kind: "task-intake.user-input-answer.accepted",
                summary: "Provider user-input answer was accepted by T3.",
                eventKey: `${intakeMessage.eventId}:user-input-answer-accepted`,
                taskId: pendingUserInput.taskId,
                workSessionId: pendingUserInput.workSessionId,
                externalId: intakeMessage.conversation.externalId,
                payload: {
                  requestId: response.requestId,
                  t3ThreadId: response.t3ThreadId,
                  acceptedAt: response.acceptedAt,
                },
              });
            } catch (error) {
              await thread
                .post(
                  postableReplyBody({
                    kind: "slack_thread",
                    body: `I could not send that answer to Vevin: ${errorSummary(error)}`,
                  }),
                )
                .catch(() => undefined);
              await logOrchestratorEvent(ctx, {
                kind: "task-intake.user-input-answer.failed",
                severity: "error",
                summary: "Failed to send provider user-input answer to T3.",
                eventKey: `${intakeMessage.eventId}:user-input-answer-failed`,
                taskId: pendingUserInput.taskId,
                workSessionId: pendingUserInput.workSessionId,
                externalId: intakeMessage.conversation.externalId,
                payload: {
                  requestId: pendingUserInput.requestId,
                  error: errorSummary(error),
                },
              });
            }
            return;
          }

          const existingSlackLink = await ctx.runQuery(api.taskExternalLinks.findTaskExternalLink, {
            kind: "slack_thread",
            externalId: intakeMessage.conversation.externalId,
          });
          const isSlackThreadReply =
            rawSlackMessage.thread_ts !== undefined &&
            rawSlackMessage.thread_ts !== rawSlackMessage.ts;
          const collectedSlackThreadContext =
            existingSlackLink === null && message.isMention === true && isSlackThreadReply
              ? await collectSlackThreadContext(thread, message)
              : undefined;
          const slackThreadContext =
            collectedSlackThreadContext === undefined
              ? undefined
              : buildInitialPromptContext({ slackThreadContext: collectedSlackThreadContext });

          await handleTaskIntakeMessage(
            intakeMessage,
            {
              store: {
                async resolveMessage(input) {
                  const resolved = await ctx.runMutation(internal.tasks.resolveTaskIntakeMessage, {
                    eventId: input.message.eventId,
                    source: input.message.source,
                    externalLinkKind: input.externalLink.kind,
                    externalId: input.externalLink.externalId,
                    title: input.title,
                    text: input.message.text,
                    messageId: input.message.messageId,
                    receivedAt: input.message.receivedAt,
                    ...(input.message.url !== undefined ? { url: input.message.url } : {}),
                    ...(input.message.conversation.teamId !== undefined
                      ? { teamId: input.message.conversation.teamId }
                      : {}),
                    ...(input.message.conversation.channelId !== undefined
                      ? { channelId: input.message.conversation.channelId }
                      : {}),
                    ...(input.message.actor?.displayName !== undefined
                      ? { actorDisplayName: input.message.actor.displayName }
                      : {}),
                  });
                  console.log("taskIntake.store.resolved", {
                    eventId: input.message.eventId,
                    status: resolved.status,
                    taskId: "taskId" in resolved ? String(resolved.taskId) : undefined,
                    t3ThreadId: "t3ThreadId" in resolved ? resolved.t3ThreadId : undefined,
                    workSessionId:
                      "workSessionId" in resolved ? String(resolved.workSessionId) : undefined,
                  });
                  await logOrchestratorEvent(ctx, {
                    kind: "task-intake.store.resolved",
                    summary: "Task intake message resolved to task state.",
                    eventKey: `${input.message.eventId}:store-resolved`,
                    externalId: input.externalLink.externalId,
                    ...("taskId" in resolved ? { taskId: resolved.taskId as Id<"tasks"> } : {}),
                    ...("workSessionId" in resolved
                      ? { workSessionId: resolved.workSessionId as Id<"workSessions"> }
                      : {}),
                    payload: {
                      eventId: input.message.eventId,
                      status: resolved.status,
                      taskId: "taskId" in resolved ? String(resolved.taskId) : undefined,
                      t3ThreadId: "t3ThreadId" in resolved ? resolved.t3ThreadId : undefined,
                      workSessionId:
                        "workSessionId" in resolved ? String(resolved.workSessionId) : undefined,
                    },
                  });
                  return resolved;
                },
                async recordStartFailed(input) {
                  await ctx.runMutation(internal.tasks.markTaskIntakeStartFailed, {
                    eventId: input.message.eventId,
                    taskId: input.taskId as Id<"tasks">,
                    source: input.message.source,
                    summary: input.summary,
                  });
                },
              },
              runtime: {
                async materializeTaskRuntime(input) {
                  const convexModelSelection = toConvexModelSelection(input.modelSelection);
                  console.log("taskIntake.runtime.materialize.start", {
                    taskId: input.taskId,
                    modelSelection:
                      convexModelSelection === undefined
                        ? undefined
                        : {
                            instanceId: convexModelSelection.instanceId,
                            model: convexModelSelection.model,
                          },
                    promptPreview: input.initialPrompt.slice(0, 120),
                    attachmentCount: input.attachments?.length ?? 0,
                  });
                  await logOrchestratorEvent(ctx, {
                    kind: "task-intake.runtime.materialize-started",
                    summary: "Task intake requested T3 runtime materialization.",
                    taskId: input.taskId as Id<"tasks">,
                    payload: {
                      taskId: input.taskId,
                      startCodingAgent: input.startCodingAgent,
                      ...(convexModelSelection !== undefined
                        ? {
                            modelSelection: {
                              instanceId: convexModelSelection.instanceId,
                              model: convexModelSelection.model,
                            },
                          }
                        : {}),
                      promptPreview: input.initialPrompt.slice(0, 120),
                      attachmentCount: input.attachments?.length ?? 0,
                    },
                  });
                  const materializeArgs = {
                    taskId: input.taskId as Id<"tasks">,
                    initialPrompt: input.initialPrompt,
                    ...(input.attachments !== undefined
                      ? { attachments: [...input.attachments] }
                      : {}),
                    startCodingAgent: input.startCodingAgent,
                    ...(convexModelSelection !== undefined
                      ? { modelSelection: convexModelSelection }
                      : {}),
                  };
                  const materialized = await ctx.runAction(
                    api.t3Runtime.materializeTaskRuntime,
                    materializeArgs,
                  );
                  console.log("taskIntake.runtime.materialize.done", {
                    taskId: input.taskId,
                    t3ThreadId: materialized.t3ThreadId,
                    workSessionId: materialized.workSessionId,
                  });
                  await logOrchestratorEvent(ctx, {
                    kind: "task-intake.runtime.materialize-completed",
                    summary: "T3 runtime materialization completed.",
                    taskId: input.taskId as Id<"tasks">,
                    workSessionId: materialized.workSessionId as Id<"workSessions">,
                    payload: {
                      taskId: input.taskId,
                      t3ThreadId: materialized.t3ThreadId,
                      workSessionId: materialized.workSessionId,
                      environmentId: materialized.environmentId,
                      branch: materialized.branch,
                      worktreePath: materialized.worktreePath,
                    },
                  });
                  return materialized;
                },
                async continueTaskRuntime(input) {
                  console.log("taskIntake.runtime.continue.start", {
                    eventId: input.eventId,
                    taskId: input.taskId,
                    workSessionId: input.workSessionId,
                    t3ThreadId: input.t3ThreadId,
                    promptPreview: input.prompt.slice(0, 120),
                    attachmentCount: input.attachments?.length ?? 0,
                  });
                  await logOrchestratorEvent(ctx, {
                    kind: "task-intake.runtime.continue-started",
                    summary: "Task intake requested T3 runtime continuation.",
                    eventKey: `${input.eventId}:runtime-continue-started`,
                    taskId: input.taskId as Id<"tasks">,
                    workSessionId: input.workSessionId as Id<"workSessions">,
                    payload: {
                      eventId: input.eventId,
                      taskId: input.taskId,
                      workSessionId: input.workSessionId,
                      t3ThreadId: input.t3ThreadId,
                      promptPreview: input.prompt.slice(0, 120),
                      attachmentCount: input.attachments?.length ?? 0,
                    },
                  });
                  const continued = await ctx.runAction(api.t3Runtime.continueTaskRuntime, {
                    eventId: input.eventId,
                    taskId: input.taskId as Id<"tasks">,
                    workSessionId: input.workSessionId as Id<"workSessions">,
                    t3ThreadId: input.t3ThreadId,
                    prompt: input.prompt,
                    ...(input.attachments !== undefined
                      ? { attachments: [...input.attachments] }
                      : {}),
                  });
                  console.log("taskIntake.runtime.continue.done", {
                    eventId: input.eventId,
                    taskId: input.taskId,
                    workSessionId: input.workSessionId,
                    t3ThreadId: continued.t3ThreadId,
                  });
                  await logOrchestratorEvent(ctx, {
                    kind: "task-intake.runtime.continue-completed",
                    summary: "T3 runtime continuation was accepted.",
                    eventKey: `${input.eventId}:runtime-continue-completed`,
                    taskId: input.taskId as Id<"tasks">,
                    workSessionId: input.workSessionId as Id<"workSessions">,
                    payload: {
                      eventId: input.eventId,
                      taskId: input.taskId,
                      workSessionId: input.workSessionId,
                      t3ThreadId: continued.t3ThreadId,
                    },
                  });
                  return continued;
                },
              },
              replies: {
                async acknowledgeAccepted() {
                  await thread.createSentMessageFromMessage(message).addReaction("eyes");
                  console.log("taskIntake.reply.acknowledged", {
                    eventId: intakeMessage.eventId,
                    reaction: "eyes",
                  });
                  await logOrchestratorEvent(ctx, {
                    kind: "slack.reply.acknowledged",
                    summary: "Acknowledged initial Slack message with eyes reaction.",
                    eventKey: `${intakeMessage.eventId}:reaction:eyes`,
                    externalId: intakeMessage.conversation.externalId,
                    payload: {
                      eventId: intakeMessage.eventId,
                      reaction: "eyes",
                      externalMessageId: `${message.id}:reaction:eyes`,
                    },
                  });
                  return {
                    status: "posted",
                    externalMessageId: `${message.id}:reaction:eyes`,
                  };
                },
                async postTaskStartedCard({ taskId, materialization }) {
                  const claims = await ctx.runMutation(
                    internal.taskEvents.claimTaskStartedStatusReplies,
                    {
                      taskId: taskId as Id<"tasks">,
                      t3ThreadId: materialization.t3ThreadId,
                      ...(materialization.environmentId !== undefined
                        ? { environmentId: materialization.environmentId }
                        : {}),
                    },
                  );
                  if (claims.length === 0) {
                    return { status: "skipped", reason: "task started card already claimed" };
                  }

                  const claim = claims[0];
                  if (claim === undefined) {
                    return { status: "skipped", reason: "task started card already claimed" };
                  }

                  try {
                    const posted = await thread.post(
                      postableTaskStartedStatus({
                        kind: claim.kind,
                        t3ThreadUrl: buildT3ThreadUrl({
                          baseUrl: t3WebAppBaseUrl(),
                          environmentId: claim.environmentId,
                          t3ThreadId: claim.t3ThreadId,
                        }),
                      }),
                    );
                    await ctx.runMutation(
                      internal.taskEvents.recordTaskStartedStatusReplyDelivered,
                      {
                        taskId: claim.taskId,
                        claimEventKey: claim.claimEventKey,
                        linkId: claim.linkId,
                        externalMessageId: posted.id,
                      },
                    );
                    await logOrchestratorEvent(ctx, {
                      kind: "slack.reply.task-started-card-delivered",
                      summary: "Delivered task started Slack card.",
                      eventKey: `${claim.claimEventKey}:orchestrator-delivered`,
                      taskId: claim.taskId,
                      externalId: claim.externalId,
                      payload: {
                        claimEventKey: claim.claimEventKey,
                        linkId: claim.linkId,
                        t3ThreadId: claim.t3ThreadId,
                        environmentId: claim.environmentId,
                        externalMessageId: posted.id,
                      },
                    });
                    return {
                      status: "posted",
                      externalMessageId: posted.id,
                    };
                  } catch (error) {
                    await ctx.runMutation(internal.taskEvents.recordTaskStartedStatusReplyFailed, {
                      taskId: claim.taskId,
                      claimEventKey: claim.claimEventKey,
                      linkId: claim.linkId,
                      error: errorSummary(error),
                    });
                    await logOrchestratorEvent(ctx, {
                      kind: "slack.reply.task-started-card-failed",
                      severity: "error",
                      summary: "Failed to deliver task started Slack card.",
                      eventKey: `${claim.claimEventKey}:orchestrator-failed`,
                      taskId: claim.taskId,
                      externalId: claim.externalId,
                      payload: {
                        claimEventKey: claim.claimEventKey,
                        linkId: claim.linkId,
                        error: errorSummary(error),
                      },
                    });
                    return {
                      status: "failed",
                      error: errorSummary(error),
                    };
                  }
                },
                async postReply(reply) {
                  const posted = await thread.post(reply.body);
                  console.log("taskIntake.reply.posted", {
                    eventId: intakeMessage.eventId,
                    externalMessageId: posted.id,
                  });
                  await logOrchestratorEvent(ctx, {
                    kind: "slack.reply.posted",
                    summary: "Posted Slack reply through Chat SDK.",
                    eventKey: `${intakeMessage.eventId}:reply:${posted.id}`,
                    externalId: intakeMessage.conversation.externalId,
                    payload: {
                      eventId: intakeMessage.eventId,
                      externalMessageId: posted.id,
                    },
                  });
                  return {
                    status: "posted",
                    externalMessageId: posted.id,
                  };
                },
              },
            },
            slackThreadContext === undefined ? {} : { initialPromptContext: slackThreadContext },
          );
        } catch (error) {
          console.error("taskIntake.message.failed", {
            source: intakeMessage.source,
            eventId: intakeMessage.eventId,
            messageId: intakeMessage.messageId,
            error: errorSummary(error),
          });
          await logOrchestratorEvent(ctx, {
            kind: "slack.message.failed",
            severity: "error",
            summary: "Failed while handling Slack message.",
            eventKey: `${intakeMessage.eventId}:message-failed`,
            externalId: intakeMessage.conversation.externalId,
            payload: {
              source: intakeMessage.source,
              eventId: intakeMessage.eventId,
              messageId: intakeMessage.messageId,
              error: errorSummary(error),
            },
          });
          try {
            await thread.post(
              [
                "I hit an internal error while handling this message.",
                "",
                `Failure summary: ${errorSummary(error)}`,
              ].join("\n"),
            );
          } catch {
            // The webhook should still acknowledge the source event if only the error reply failed.
          }
        }
      },
    });

    const request = new Request(args.url, {
      method: "POST",
      headers: new Headers(args.headers.map((header) => [header.name, header.value])),
      body: args.body,
    });

    const webhook = bot.webhooks.slack;
    if (webhook === undefined) {
      throw new Error(`${args.source} Chat SDK webhook handler is not configured.`);
    }

    const pendingTasks: Promise<unknown>[] = [];
    const response = await webhook(request, {
      waitUntil(task) {
        pendingTasks.push(task);
      },
    });
    console.log("taskIntake.webhook.response", {
      source: args.source,
      status: response.status,
      pendingTasks: pendingTasks.length,
    });
    await Promise.all(pendingTasks);
    const contentType = response.headers.get("content-type") ?? undefined;
    await logOrchestratorEvent(ctx, {
      kind: "slack.webhook.action-completed",
      summary: "Slack Chat SDK webhook action completed.",
      payload: {
        source: args.source,
        status: response.status,
        pendingTasks: pendingTasks.length,
        contentType,
      },
    });

    return {
      status: response.status,
      body: await response.text(),
      ...(contentType !== undefined ? { contentType } : {}),
    };
  },
});

export const postTaskRuntimeLifecycleReply = internalAction({
  args: {
    taskId: v.id("tasks"),
    workSessionId: v.id("workSessions"),
    status: v.union(v.literal("completed"), v.literal("failed")),
    occurredAt: v.string(),
    t3ThreadId: v.optional(v.string()),
    t3TurnId: v.optional(v.string()),
    failureSummary: v.optional(v.string()),
    assistantResponse: v.optional(v.string()),
  },
  returns: v.object({
    posted: v.boolean(),
    reason: v.optional(v.string()),
    externalMessageId: v.optional(v.string()),
  }),
  handler: async (
    ctx,
    args,
  ): Promise<{
    readonly posted: boolean;
    readonly reason?: string;
    readonly externalMessageId?: string;
  }> => {
    const claims = await ctx.runMutation(internal.taskEvents.claimTaskLifecycleReplies, {
      taskId: args.taskId,
      workSessionId: args.workSessionId,
      status: args.status,
      occurredAt: args.occurredAt,
      ...(args.t3ThreadId !== undefined ? { t3ThreadId: args.t3ThreadId } : {}),
      ...(args.t3TurnId !== undefined ? { t3TurnId: args.t3TurnId } : {}),
      ...(args.failureSummary !== undefined ? { failureSummary: args.failureSummary } : {}),
      ...(args.assistantResponse !== undefined
        ? { assistantResponse: args.assistantResponse }
        : {}),
    });
    await logOrchestratorEvent(ctx, {
      kind: "task-intake.lifecycle-reply.claimed",
      summary: "Claimed lifecycle reply delivery targets.",
      taskId: args.taskId,
      workSessionId: args.workSessionId,
      payload: {
        status: args.status,
        claimCount: claims.length,
        slackClaimCount: claims.filter((claim) => claim.kind === "slack_thread").length,
      },
    });
    if (claims.length === 0) {
      return { posted: false, reason: "no_unclaimed_intake_links" };
    }
    const slackClaims = claims.filter((claim) => claim.kind === "slack_thread");
    if (slackClaims.length === 0) {
      return { posted: false, reason: "no_unclaimed_slack_links" };
    }

    const bot = createTaskIntakeChatSdkBot({
      sources: new Set(["slack"]),
      state: chatSdkState(ctx),
      async onMessage() {},
    });
    await bot.initialize();

    const postedIds: string[] = [];
    for (const claim of slackClaims) {
      try {
        await logOrchestratorEvent(ctx, {
          kind: "task-intake.lifecycle-reply.delivery-started",
          summary: "Posting lifecycle reply to Slack.",
          eventKey: `${claim.claimEventKey}:orchestrator-started`,
          taskId: claim.taskId,
          externalId: claim.externalId,
          payload: {
            claimEventKey: claim.claimEventKey,
            linkId: claim.linkId,
            status: args.status,
          },
        });
        const posted: { readonly id: string } = await bot
          .thread(
            chatSdkThreadIdForLifecycleReply({
              kind: claim.kind,
              externalId: claim.externalId,
            }),
          )
          .post(postableReplyBody({ kind: claim.kind, body: claim.body }));
        postedIds.push(posted.id);
        await ctx.runMutation(internal.taskEvents.recordTaskLifecycleReplyDelivered, {
          taskId: claim.taskId,
          claimEventKey: claim.claimEventKey,
          linkId: claim.linkId,
          status: args.status,
          externalMessageId: posted.id,
        });
        await logOrchestratorEvent(ctx, {
          kind: "task-intake.lifecycle-reply.delivered",
          summary: "Delivered lifecycle reply to Slack.",
          eventKey: `${claim.claimEventKey}:orchestrator-delivered`,
          taskId: claim.taskId,
          externalId: claim.externalId,
          payload: {
            claimEventKey: claim.claimEventKey,
            linkId: claim.linkId,
            status: args.status,
            externalMessageId: posted.id,
          },
        });
      } catch (error) {
        await ctx.runMutation(internal.taskEvents.recordTaskLifecycleReplyFailed, {
          taskId: claim.taskId,
          claimEventKey: claim.claimEventKey,
          linkId: claim.linkId,
          status: args.status,
          error: error instanceof Error ? error.message : String(error),
        });
        await logOrchestratorEvent(ctx, {
          kind: "task-intake.lifecycle-reply.failed",
          severity: "error",
          summary: "Failed to deliver lifecycle reply to Slack.",
          eventKey: `${claim.claimEventKey}:orchestrator-failed`,
          taskId: claim.taskId,
          externalId: claim.externalId,
          payload: {
            claimEventKey: claim.claimEventKey,
            linkId: claim.linkId,
            status: args.status,
            error: errorSummary(error),
          },
        });
      }
    }

    if (postedIds.length === 0) {
      return { posted: false, reason: "all_lifecycle_replies_failed" };
    }
    return {
      posted: true,
      ...(postedIds[0] !== undefined ? { externalMessageId: postedIds[0] } : {}),
    };
  },
});

export const postTaskPullRequestStatusReply = internalAction({
  args: {
    taskId: v.id("tasks"),
    workSessionId: v.id("workSessions"),
    pullRequestExternalId: v.string(),
    pullRequestUrl: v.string(),
    pullRequestStatus: v.optional(v.union(v.literal("created"), v.literal("existing"))),
    title: v.optional(v.string()),
    repo: v.optional(v.string()),
    headBranch: v.optional(v.string()),
    previewUrl: v.optional(v.string()),
    deploymentPreviewsJson: v.optional(v.string()),
  },
  returns: v.object({
    posted: v.boolean(),
    reason: v.optional(v.string()),
    externalMessageId: v.optional(v.string()),
  }),
  handler: async (
    ctx,
    args,
  ): Promise<{
    readonly posted: boolean;
    readonly reason?: string;
    readonly externalMessageId?: string;
  }> => {
    const claims = await ctx.runMutation(internal.taskEvents.claimTaskPullRequestStatusReplies, {
      taskId: args.taskId,
      workSessionId: args.workSessionId,
      pullRequestExternalId: args.pullRequestExternalId,
      pullRequestUrl: args.pullRequestUrl,
      ...(args.pullRequestStatus !== undefined
        ? { pullRequestStatus: args.pullRequestStatus }
        : {}),
      ...(args.title !== undefined ? { title: args.title } : {}),
      ...(args.repo !== undefined ? { repo: args.repo } : {}),
      ...(args.headBranch !== undefined ? { headBranch: args.headBranch } : {}),
      ...(args.previewUrl !== undefined ? { previewUrl: args.previewUrl } : {}),
      ...(args.deploymentPreviewsJson !== undefined
        ? { deploymentPreviewsJson: args.deploymentPreviewsJson }
        : {}),
    });
    await logOrchestratorEvent(ctx, {
      kind: "task-intake.pr-status-reply.claimed",
      summary: "Claimed pull request status reply delivery targets.",
      taskId: args.taskId,
      workSessionId: args.workSessionId,
      externalId: args.pullRequestExternalId,
      payload: {
        pullRequestExternalId: args.pullRequestExternalId,
        pullRequestUrl: args.pullRequestUrl,
        pullRequestStatus: args.pullRequestStatus,
        claimCount: claims.length,
        slackClaimCount: claims.filter((claim) => claim.kind === "slack_thread").length,
      },
    });
    if (claims.length === 0) {
      return { posted: false, reason: "no_unclaimed_pr_status_links" };
    }
    const slackClaims = claims.filter((claim) => claim.kind === "slack_thread");
    if (slackClaims.length === 0) {
      return { posted: false, reason: "no_unclaimed_slack_links" };
    }

    const bot = createTaskIntakeChatSdkBot({
      sources: new Set(["slack"]),
      state: chatSdkState(ctx),
      async onMessage() {},
    });
    await bot.initialize();

    const postedIds: string[] = [];
    for (const claim of slackClaims) {
      try {
        await logOrchestratorEvent(ctx, {
          kind: "task-intake.pr-status-reply.delivery-started",
          summary: "Posting pull request status card to Slack.",
          eventKey: `${claim.claimEventKey}:orchestrator-started`,
          taskId: claim.taskId,
          externalId: claim.externalId,
          payload: {
            claimEventKey: claim.claimEventKey,
            linkId: claim.linkId,
            pullRequestUrl: claim.pullRequestUrl,
            deploymentPreviewCount: claim.deploymentPreviews?.length ?? 0,
          },
        });
        const posted: { readonly id: string } = await bot
          .thread(
            chatSdkThreadIdForLifecycleReply({
              kind: claim.kind,
              externalId: claim.externalId,
            }),
          )
          .post(
            postablePullRequestStatus({
              kind: claim.kind,
              body: claim.body,
              pullRequestUrl: claim.pullRequestUrl,
              ...(claim.pullRequestStatus !== undefined
                ? { pullRequestStatus: claim.pullRequestStatus }
                : {}),
              ...(claim.title !== undefined ? { title: claim.title } : {}),
              ...(claim.repo !== undefined ? { repo: claim.repo } : {}),
              ...(claim.branch !== undefined ? { branch: claim.branch } : {}),
              t3ThreadUrl: buildT3ThreadUrl({
                baseUrl: t3WebAppBaseUrl(),
                environmentId: claim.environmentId,
                t3ThreadId: claim.t3ThreadId,
              }),
              ...(claim.previewUrl !== undefined ? { previewUrl: claim.previewUrl } : {}),
              ...(claim.deploymentPreviews !== undefined
                ? { deploymentPreviews: claim.deploymentPreviews }
                : {}),
            }),
          );
        postedIds.push(posted.id);
        await ctx.runMutation(internal.taskEvents.recordTaskPullRequestStatusReplyDelivered, {
          taskId: claim.taskId,
          claimEventKey: claim.claimEventKey,
          linkId: claim.linkId,
          externalMessageId: posted.id,
        });
        await logOrchestratorEvent(ctx, {
          kind: "task-intake.pr-status-reply.delivered",
          summary: "Delivered pull request status card to Slack.",
          eventKey: `${claim.claimEventKey}:orchestrator-delivered`,
          taskId: claim.taskId,
          externalId: claim.externalId,
          payload: {
            claimEventKey: claim.claimEventKey,
            linkId: claim.linkId,
            externalMessageId: posted.id,
          },
        });
      } catch (error) {
        await ctx.runMutation(internal.taskEvents.recordTaskPullRequestStatusReplyFailed, {
          taskId: claim.taskId,
          claimEventKey: claim.claimEventKey,
          linkId: claim.linkId,
          error: error instanceof Error ? error.message : String(error),
        });
        await logOrchestratorEvent(ctx, {
          kind: "task-intake.pr-status-reply.failed",
          severity: "error",
          summary: "Failed to deliver pull request status card to Slack.",
          eventKey: `${claim.claimEventKey}:orchestrator-failed`,
          taskId: claim.taskId,
          externalId: claim.externalId,
          payload: {
            claimEventKey: claim.claimEventKey,
            linkId: claim.linkId,
            error: errorSummary(error),
          },
        });
      }
    }

    if (postedIds.length === 0) {
      return { posted: false, reason: "all_pr_status_replies_failed" };
    }
    return {
      posted: true,
      ...(postedIds[0] !== undefined ? { externalMessageId: postedIds[0] } : {}),
    };
  },
});

export const postTaskRuntimeAssistantMessage = internalAction({
  args: {
    eventId: v.string(),
    taskId: v.id("tasks"),
    workSessionId: v.id("workSessions"),
    occurredAt: v.string(),
    t3ThreadId: v.string(),
    t3MessageId: v.string(),
    t3TurnId: v.optional(v.string()),
    assistantMessage: v.string(),
  },
  returns: v.object({
    posted: v.boolean(),
    reason: v.optional(v.string()),
    externalMessageId: v.optional(v.string()),
  }),
  handler: async (
    ctx,
    args,
  ): Promise<{
    readonly posted: boolean;
    readonly reason?: string;
    readonly externalMessageId?: string;
  }> => {
    const claims = await ctx.runMutation(internal.taskEvents.claimTaskAssistantMessageReplies, {
      eventId: args.eventId,
      taskId: args.taskId,
      workSessionId: args.workSessionId,
      occurredAt: args.occurredAt,
      t3ThreadId: args.t3ThreadId,
      t3MessageId: args.t3MessageId,
      ...(args.t3TurnId !== undefined ? { t3TurnId: args.t3TurnId } : {}),
      assistantMessage: args.assistantMessage,
    });
    await logOrchestratorEvent(ctx, {
      kind: "task-intake.assistant-message-reply.claimed",
      summary: "Claimed assistant message reply delivery targets.",
      eventKey: `${args.eventId}:assistant-message-claimed`,
      taskId: args.taskId,
      workSessionId: args.workSessionId,
      payload: {
        eventId: args.eventId,
        t3ThreadId: args.t3ThreadId,
        t3MessageId: args.t3MessageId,
        t3TurnId: args.t3TurnId,
        claimCount: claims.length,
        slackClaimCount: claims.filter((claim) => claim.kind === "slack_thread").length,
      },
    });
    if (claims.length === 0) {
      return { posted: false, reason: "no_unclaimed_intake_links" };
    }
    const slackClaims = claims.filter((claim) => claim.kind === "slack_thread");
    if (slackClaims.length === 0) {
      return { posted: false, reason: "no_unclaimed_slack_links" };
    }

    const bot = createTaskIntakeChatSdkBot({
      sources: new Set(["slack"]),
      state: chatSdkState(ctx),
      async onMessage() {},
    });
    await bot.initialize();

    const postedIds: string[] = [];
    for (const claim of slackClaims) {
      try {
        await logOrchestratorEvent(ctx, {
          kind: "task-intake.assistant-message-reply.delivery-started",
          summary: "Posting assistant message reply to Slack.",
          eventKey: `${claim.claimEventKey}:orchestrator-started`,
          taskId: claim.taskId,
          workSessionId: claim.workSessionId,
          externalId: claim.externalId,
          payload: {
            claimEventKey: claim.claimEventKey,
            linkId: claim.linkId,
          },
        });
        const posted: { readonly id: string } = await bot
          .thread(
            chatSdkThreadIdForLifecycleReply({
              kind: claim.kind,
              externalId: claim.externalId,
            }),
          )
          .post(postableReplyBody({ kind: claim.kind, body: claim.body }));
        postedIds.push(posted.id);
        await ctx.runMutation(internal.taskEvents.recordTaskAssistantMessageReplyDelivered, {
          taskId: claim.taskId,
          workSessionId: claim.workSessionId,
          claimEventKey: claim.claimEventKey,
          linkId: claim.linkId,
          externalMessageId: posted.id,
        });
        await logOrchestratorEvent(ctx, {
          kind: "task-intake.assistant-message-reply.delivered",
          summary: "Delivered assistant message reply to Slack.",
          eventKey: `${claim.claimEventKey}:orchestrator-delivered`,
          taskId: claim.taskId,
          workSessionId: claim.workSessionId,
          externalId: claim.externalId,
          payload: {
            claimEventKey: claim.claimEventKey,
            linkId: claim.linkId,
            externalMessageId: posted.id,
          },
        });
      } catch (error) {
        await ctx.runMutation(internal.taskEvents.recordTaskAssistantMessageReplyFailed, {
          taskId: claim.taskId,
          workSessionId: claim.workSessionId,
          claimEventKey: claim.claimEventKey,
          linkId: claim.linkId,
          error: error instanceof Error ? error.message : String(error),
        });
        await logOrchestratorEvent(ctx, {
          kind: "task-intake.assistant-message-reply.failed",
          severity: "error",
          summary: "Failed to deliver assistant message reply to Slack.",
          eventKey: `${claim.claimEventKey}:orchestrator-failed`,
          taskId: claim.taskId,
          workSessionId: claim.workSessionId,
          externalId: claim.externalId,
          payload: {
            claimEventKey: claim.claimEventKey,
            linkId: claim.linkId,
            error: errorSummary(error),
          },
        });
      }
    }

    if (postedIds.length === 0) {
      return { posted: false, reason: "all_assistant_message_replies_failed" };
    }
    return {
      posted: true,
      ...(postedIds[0] !== undefined ? { externalMessageId: postedIds[0] } : {}),
    };
  },
});

export const postTaskRuntimeUserInputRequest = internalAction({
  args: {
    eventId: v.string(),
    taskId: v.id("tasks"),
    workSessionId: v.id("workSessions"),
    occurredAt: v.string(),
    t3ThreadId: v.string(),
    t3TurnId: v.optional(v.string()),
    requestId: v.string(),
    questionsJson: v.string(),
  },
  returns: v.object({
    posted: v.boolean(),
    reason: v.optional(v.string()),
    externalMessageId: v.optional(v.string()),
  }),
  handler: async (
    ctx,
    args,
  ): Promise<{
    readonly posted: boolean;
    readonly reason?: string;
    readonly externalMessageId?: string;
  }> => {
    const claims = await ctx.runMutation(internal.taskEvents.claimTaskUserInputRequestReplies, {
      eventId: args.eventId,
      taskId: args.taskId,
      workSessionId: args.workSessionId,
      occurredAt: args.occurredAt,
      t3ThreadId: args.t3ThreadId,
      ...(args.t3TurnId !== undefined ? { t3TurnId: args.t3TurnId } : {}),
      requestId: args.requestId,
      questionsJson: args.questionsJson,
    });
    await logOrchestratorEvent(ctx, {
      kind: "task-intake.user-input-request.claimed",
      summary: "Claimed user-input request delivery targets.",
      eventKey: `${args.eventId}:user-input-request-claimed`,
      taskId: args.taskId,
      workSessionId: args.workSessionId,
      payload: {
        requestId: args.requestId,
        claimCount: claims.length,
      },
    });
    if (claims.length === 0) {
      return { posted: false, reason: "no_unclaimed_slack_links" };
    }

    const bot = createTaskIntakeChatSdkBot({
      sources: new Set(["slack"]),
      state: chatSdkState(ctx),
      async onMessage() {},
    });
    await bot.initialize();

    const postedIds: string[] = [];
    for (const claim of claims) {
      try {
        await logOrchestratorEvent(ctx, {
          kind: "task-intake.user-input-request.delivery-started",
          summary: "Posting user-input request to Slack.",
          eventKey: `${claim.claimEventKey}:orchestrator-started`,
          taskId: claim.taskId,
          workSessionId: claim.workSessionId,
          externalId: claim.externalId,
          payload: {
            claimEventKey: claim.claimEventKey,
            linkId: claim.linkId,
            requestId: args.requestId,
          },
        });
        const posted: { readonly id: string } = await bot
          .thread(
            chatSdkThreadIdForLifecycleReply({
              kind: claim.kind,
              externalId: claim.externalId,
            }),
          )
          .post(postableReplyBody({ kind: claim.kind, body: claim.body }));
        postedIds.push(posted.id);
        await ctx.runMutation(internal.taskEvents.recordTaskUserInputRequestReplyDelivered, {
          taskId: claim.taskId,
          claimEventKey: claim.claimEventKey,
          linkId: claim.linkId,
          externalMessageId: posted.id,
        });
        await logOrchestratorEvent(ctx, {
          kind: "task-intake.user-input-request.delivered",
          summary: "Delivered user-input request to Slack.",
          eventKey: `${claim.claimEventKey}:orchestrator-delivered`,
          taskId: claim.taskId,
          workSessionId: claim.workSessionId,
          externalId: claim.externalId,
          payload: {
            claimEventKey: claim.claimEventKey,
            linkId: claim.linkId,
            externalMessageId: posted.id,
          },
        });
      } catch (error) {
        await ctx.runMutation(internal.taskEvents.recordTaskUserInputRequestReplyFailed, {
          taskId: claim.taskId,
          claimEventKey: claim.claimEventKey,
          linkId: claim.linkId,
          error: errorSummary(error),
        });
        await logOrchestratorEvent(ctx, {
          kind: "task-intake.user-input-request.failed",
          severity: "error",
          summary: "Failed to deliver user-input request to Slack.",
          eventKey: `${claim.claimEventKey}:orchestrator-failed`,
          taskId: claim.taskId,
          workSessionId: claim.workSessionId,
          externalId: claim.externalId,
          payload: {
            claimEventKey: claim.claimEventKey,
            linkId: claim.linkId,
            error: errorSummary(error),
          },
        });
      }
    }

    if (postedIds.length === 0) {
      return { posted: false, reason: "all_user_input_request_replies_failed" };
    }
    return {
      posted: true,
      ...(postedIds[0] !== undefined ? { externalMessageId: postedIds[0] } : {}),
    };
  },
});
