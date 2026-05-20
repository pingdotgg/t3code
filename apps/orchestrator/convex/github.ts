"use node";

import { v } from "convex/values";

import {
  githubPullRequestExternalId,
  parseGitHubDeploymentReadyEvent,
  parseGitHubPullRequestMergedEvent,
  toVercelBranchDeploymentUrl,
} from "../src/github/webhook.ts";
import { createTaskIntakeChatSdkBot } from "../src/taskIntake/chatSdk.ts";
import { createConvexChatSdkState } from "../src/taskIntake/convexChatSdkState.ts";
import { chatSdkThreadIdForLifecycleReply } from "../src/taskIntake/lifecycleReplies.ts";
import {
  postableDeploymentReady,
  postablePullRequestMerged,
} from "../src/taskIntake/postableReply.ts";
import { internal } from "./_generated/api.js";
import type { Id } from "./_generated/dataModel.js";
import { internalAction } from "./_generated/server.js";

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
    readonly externalId?: string | undefined;
    readonly payload?: unknown | undefined;
  },
) {
  console[input.severity === "error" ? "error" : input.severity === "warn" ? "warn" : "log"](
    input.kind,
    {
      summary: input.summary,
      ...(input.eventKey !== undefined ? { eventKey: input.eventKey } : {}),
      ...(input.taskId !== undefined ? { taskId: input.taskId } : {}),
      ...(input.externalId !== undefined ? { externalId: input.externalId } : {}),
      ...(input.payload !== undefined ? { payload: input.payload } : {}),
    },
  );
  return ctx
    .runMutation(internal.observability.append, {
      kind: input.kind,
      source: "github",
      severity: input.severity ?? "info",
      summary: input.summary,
      ...(input.eventKey !== undefined ? { eventKey: input.eventKey } : {}),
      ...(input.taskId !== undefined ? { taskId: input.taskId } : {}),
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

export const handleWebhook = internalAction({
  args: {
    event: v.string(),
    deliveryId: v.string(),
    body: v.string(),
  },
  returns: v.object({
    handled: v.boolean(),
    reason: v.optional(v.string()),
    delivered: v.optional(v.number()),
  }),
  handler: async (ctx, args) => {
    await logOrchestratorEvent(ctx, {
      kind: "github.webhook.action-received",
      summary: "GitHub webhook action started.",
      eventKey: args.deliveryId ? `github:${args.deliveryId}:action-received` : undefined,
      externalId: args.deliveryId || undefined,
      payload: {
        event: args.event,
        deliveryId: args.deliveryId,
        bodyBytes: args.body.length,
      },
    });
    let payload: unknown;
    try {
      payload = JSON.parse(args.body);
    } catch {
      await logOrchestratorEvent(ctx, {
        kind: "github.webhook.invalid-json",
        severity: "warn",
        summary: "GitHub webhook body was not valid JSON.",
        eventKey: args.deliveryId ? `github:${args.deliveryId}:invalid-json` : undefined,
        externalId: args.deliveryId || undefined,
        payload: {
          event: args.event,
          deliveryId: args.deliveryId,
        },
      });
      return { handled: false, reason: "invalid_json" };
    }

    if (args.event === "deployment_status") {
      const event = parseGitHubDeploymentReadyEvent(payload);
      if (event === null) {
        await logOrchestratorEvent(ctx, {
          kind: "github.deployment-status.ignored",
          summary: "Ignored unsupported GitHub deployment_status event.",
          eventKey: args.deliveryId
            ? `github:${args.deliveryId}:deployment-status:ignored`
            : undefined,
          externalId: args.deliveryId || undefined,
          payload: {
            event: args.event,
            deliveryId: args.deliveryId,
          },
        });
        return { handled: false, reason: "unsupported_deployment_status" };
      }

      await logOrchestratorEvent(ctx, {
        kind: "github.deployment-status.parsed",
        summary: "Parsed successful GitHub deployment_status event.",
        eventKey: args.deliveryId
          ? `github:${args.deliveryId}:deployment-status:parsed`
          : undefined,
        externalId: args.deliveryId || undefined,
        payload: {
          owner: event.owner,
          repo: event.repo,
          headSha: event.headSha,
          deploymentId: event.deploymentId,
          statusId: event.statusId,
          environment: event.environment,
          url: event.url,
        },
      });

      const pullRequests = await ctx.runQuery(internal.githubData.findPullRequestsByHeadSha, {
        owner: event.owner,
        repo: event.repo,
        headSha: event.headSha,
      });
      if (pullRequests.length === 0) {
        await logOrchestratorEvent(ctx, {
          kind: "github.deployment-status.unlinked",
          severity: "warn",
          summary: "No linked pull request was found for GitHub deployment_status head SHA.",
          eventKey: args.deliveryId
            ? `github:${args.deliveryId}:deployment-status:unlinked`
            : undefined,
          externalId: args.deliveryId || undefined,
          payload: {
            owner: event.owner,
            repo: event.repo,
            headSha: event.headSha,
            deploymentId: event.deploymentId,
            statusId: event.statusId,
            environment: event.environment,
            url: event.url,
          },
        });
        return { handled: false, reason: "no_linked_pull_request_for_head_sha" };
      }

      const bot = createTaskIntakeChatSdkBot({
        sources: new Set(["slack"]),
        state: chatSdkState(ctx),
        async onMessage() {},
      });
      await bot.initialize();

      let delivered = 0;
      for (const pullRequest of pullRequests) {
        const branchUrl = toVercelBranchDeploymentUrl({
          url: event.url,
          ...(event.environment !== undefined ? { environment: event.environment } : {}),
          ...(pullRequest.headBranch !== undefined ? { branch: pullRequest.headBranch } : {}),
        });
        await logOrchestratorEvent(ctx, {
          kind: "github.deployment-status.delivery-claiming",
          summary: "Claiming GitHub deployment ready replies.",
          eventKey: args.deliveryId
            ? `github:${args.deliveryId}:deployment-status:claiming:${pullRequest.externalId}`
            : undefined,
          taskId: pullRequest.taskId,
          externalId: pullRequest.externalId,
          payload: {
            deploymentId: event.deploymentId,
            statusId: event.statusId,
            environment: event.environment,
            originalUrl: event.url,
            branchUrl,
            headBranch: pullRequest.headBranch,
          },
        });
        const claims = await ctx.runMutation(
          internal.taskEvents.claimGitHubDeploymentReadyReplies,
          {
            taskId: pullRequest.taskId,
            deploymentId: `${event.deploymentId}:${event.statusId ?? args.deliveryId}`,
            ...(event.environment !== undefined ? { environment: event.environment } : {}),
            url: branchUrl,
          },
        );
        await logOrchestratorEvent(ctx, {
          kind: "github.deployment-status.delivery-claimed",
          summary: "Claimed GitHub deployment ready delivery targets.",
          eventKey: args.deliveryId
            ? `github:${args.deliveryId}:deployment-status:claimed:${pullRequest.externalId}`
            : undefined,
          taskId: pullRequest.taskId,
          externalId: pullRequest.externalId,
          payload: {
            claimCount: claims.length,
            slackClaimCount: claims.filter((claim) => claim.kind === "slack_thread").length,
            url: branchUrl,
          },
        });

        for (const claim of claims.filter((claim) => claim.kind === "slack_thread")) {
          try {
            await logOrchestratorEvent(ctx, {
              kind: "github.deployment-status.slack-delivery-started",
              summary: "Posting GitHub deployment ready Slack card.",
              eventKey: `${claim.claimEventKey}:delivery-started`,
              taskId: claim.taskId,
              externalId: claim.externalId,
              payload: {
                claimEventKey: claim.claimEventKey,
                linkId: claim.linkId,
                environment: claim.environment,
                url: claim.url,
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
                postableDeploymentReady({
                  kind: claim.kind,
                  ...(claim.environment !== undefined ? { environment: claim.environment } : {}),
                  url: claim.url,
                }),
              );
            delivered += 1;
            await ctx.runMutation(internal.taskEvents.appendTaskEvent, {
              taskId: claim.taskId,
              eventKey: `${claim.claimEventKey}:delivered`,
              kind: "github-deployment-ready-reply.delivered",
              summary: "Delivered GitHub deployment ready reply.",
              payloadJson: JSON.stringify({
                claimEventKey: claim.claimEventKey,
                linkId: claim.linkId,
                externalMessageId: posted.id,
              }),
            });
            await logOrchestratorEvent(ctx, {
              kind: "github.deployment-status.slack-delivered",
              summary: "Delivered GitHub deployment ready Slack card.",
              eventKey: `${claim.claimEventKey}:delivery-delivered`,
              taskId: claim.taskId,
              externalId: claim.externalId,
              payload: {
                claimEventKey: claim.claimEventKey,
                linkId: claim.linkId,
                externalMessageId: posted.id,
              },
            });
          } catch (error) {
            await ctx.runMutation(internal.taskEvents.appendTaskEvent, {
              taskId: claim.taskId,
              eventKey: `${claim.claimEventKey}:failed`,
              kind: "github-deployment-ready-reply.failed",
              summary: "Failed to deliver GitHub deployment ready reply.",
              payloadJson: JSON.stringify({
                claimEventKey: claim.claimEventKey,
                linkId: claim.linkId,
                error: errorSummary(error),
              }),
            });
            await logOrchestratorEvent(ctx, {
              kind: "github.deployment-status.slack-delivery-failed",
              severity: "error",
              summary: "Failed to deliver GitHub deployment ready Slack card.",
              eventKey: `${claim.claimEventKey}:delivery-failed`,
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
      }

      return { handled: true, delivered };
    }

    if (args.event === "pull_request") {
      const event = parseGitHubPullRequestMergedEvent(payload);
      if (event === null) {
        await logOrchestratorEvent(ctx, {
          kind: "github.pull-request.ignored",
          summary: "Ignored unsupported GitHub pull_request event.",
          eventKey: args.deliveryId ? `github:${args.deliveryId}:pull-request:ignored` : undefined,
          externalId: args.deliveryId || undefined,
          payload: {
            event: args.event,
            deliveryId: args.deliveryId,
          },
        });
        return { handled: false, reason: "unsupported_pull_request_event" };
      }

      const externalId = githubPullRequestExternalId(event);
      await logOrchestratorEvent(ctx, {
        kind: "github.pull-request.merged-parsed",
        summary: "Parsed merged GitHub pull_request event.",
        eventKey: args.deliveryId
          ? `github:${args.deliveryId}:pull-request:merged-parsed`
          : undefined,
        externalId,
        payload: {
          owner: event.owner,
          repo: event.repo,
          number: event.number,
          url: event.url,
          title: event.title,
          headSha: event.headSha,
          headBranch: event.headBranch,
          mergedAt: event.mergedAt,
        },
      });
      const pullRequest = await ctx.runQuery(internal.githubData.findPullRequestByExternalId, {
        externalId,
      });
      if (pullRequest === null) {
        await logOrchestratorEvent(ctx, {
          kind: "github.pull-request.unlinked",
          severity: "warn",
          summary: "No linked pull request was found for merged GitHub pull_request event.",
          eventKey: args.deliveryId ? `github:${args.deliveryId}:pull-request:unlinked` : undefined,
          externalId,
          payload: {
            owner: event.owner,
            repo: event.repo,
            number: event.number,
            url: event.url,
          },
        });
        return { handled: false, reason: "no_linked_pull_request" };
      }

      await ctx.runMutation(internal.githubData.recordPullRequestMerged, {
        externalId,
        ...(event.mergedAt !== undefined ? { mergedAt: Date.parse(event.mergedAt) } : {}),
        ...(event.title !== undefined ? { title: event.title } : {}),
        ...(event.headSha !== undefined ? { headSha: event.headSha } : {}),
        ...(event.headBranch !== undefined ? { headBranch: event.headBranch } : {}),
      });

      const claims = await ctx.runMutation(
        internal.taskEvents.claimGitHubPullRequestMergedNotifications,
        {
          taskId: pullRequest.taskId,
          pullRequestExternalId: externalId,
          pullRequestUrl: event.url,
        },
      );
      await logOrchestratorEvent(ctx, {
        kind: "github.pull-request.merge-delivery-claimed",
        summary: "Claimed GitHub PR merged delivery targets.",
        eventKey: args.deliveryId
          ? `github:${args.deliveryId}:pull-request:claimed:${externalId}`
          : undefined,
        taskId: pullRequest.taskId,
        externalId,
        payload: {
          claimCount: claims.length,
          slackClaimCount: claims.filter((claim) => claim.kind === "slack_thread").length,
        },
      });
      const bot = createTaskIntakeChatSdkBot({
        sources: new Set(["slack"]),
        state: chatSdkState(ctx),
        async onMessage() {},
      });
      await bot.initialize();

      let delivered = 0;
      for (const claim of claims) {
        try {
          let externalMessageId: string | undefined;
          if (claim.kind === "slack_thread") {
            await logOrchestratorEvent(ctx, {
              kind: "github.pull-request.merge-slack-delivery-started",
              summary: "Posting GitHub PR merged Slack notification.",
              eventKey: `${claim.claimEventKey}:delivery-started`,
              taskId: claim.taskId,
              externalId: claim.externalId,
              payload: {
                claimEventKey: claim.claimEventKey,
                linkId: claim.linkId,
                pullRequestUrl: claim.pullRequestUrl,
              },
            });
            const threadId = chatSdkThreadIdForLifecycleReply({
              kind: claim.kind,
              externalId: claim.externalId,
            });
            const thread = bot.thread(threadId);
            const messageId = claim.externalId.split(":").at(-1);
            if (messageId === undefined) {
              throw new Error(`Invalid Slack thread external id: ${claim.externalId}`);
            }
            let reactionDelivered = false;
            try {
              await thread.adapter.addReaction(threadId, messageId, "white_check_mark");
              reactionDelivered = true;
            } catch (error) {
              await logOrchestratorEvent(ctx, {
                kind: "github.pull-request.merge-slack-reaction-failed",
                severity: "warn",
                summary: "Failed to react to original Slack message for merged PR.",
                eventKey: `${claim.claimEventKey}:reaction-failed`,
                taskId: claim.taskId,
                externalId: claim.externalId,
                payload: {
                  claimEventKey: claim.claimEventKey,
                  linkId: claim.linkId,
                  messageId,
                  error: errorSummary(error),
                },
              });
            }
            const posted: { readonly id: string } = await thread.post(
              postablePullRequestMerged({
                kind: claim.kind,
                pullRequestUrl: claim.pullRequestUrl,
                ...(event.title !== undefined ? { title: event.title } : {}),
              }),
            );
            externalMessageId = reactionDelivered
              ? `${messageId}:reaction:white_check_mark;${posted.id}`
              : posted.id;
          }
          delivered += 1;
          await ctx.runMutation(internal.taskEvents.appendTaskEvent, {
            taskId: claim.taskId,
            eventKey: `${claim.claimEventKey}:delivered`,
            kind: "github-pr-merged-notification.delivered",
            summary: "Delivered GitHub PR merged notification.",
            payloadJson: JSON.stringify({
              claimEventKey: claim.claimEventKey,
              linkId: claim.linkId,
              ...(externalMessageId !== undefined ? { externalMessageId } : {}),
            }),
          });
          await logOrchestratorEvent(ctx, {
            kind: "github.pull-request.merge-slack-delivered",
            summary: "Delivered GitHub PR merged Slack notification.",
            eventKey: `${claim.claimEventKey}:delivery-delivered`,
            taskId: claim.taskId,
            externalId: claim.externalId,
            payload: {
              claimEventKey: claim.claimEventKey,
              linkId: claim.linkId,
              ...(externalMessageId !== undefined ? { externalMessageId } : {}),
            },
          });
        } catch (error) {
          await ctx.runMutation(internal.taskEvents.appendTaskEvent, {
            taskId: claim.taskId,
            eventKey: `${claim.claimEventKey}:failed`,
            kind: "github-pr-merged-notification.failed",
            summary: "Failed to deliver GitHub PR merged notification.",
            payloadJson: JSON.stringify({
              claimEventKey: claim.claimEventKey,
              linkId: claim.linkId,
              error: errorSummary(error),
            }),
          });
          await logOrchestratorEvent(ctx, {
            kind: "github.pull-request.merge-slack-delivery-failed",
            severity: "error",
            summary: "Failed to deliver GitHub PR merged Slack notification.",
            eventKey: `${claim.claimEventKey}:delivery-failed`,
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

      return { handled: true, delivered };
    }

    if (args.event === "ping") {
      await logOrchestratorEvent(ctx, {
        kind: "github.webhook.ping",
        summary: "Handled GitHub webhook ping.",
        eventKey: args.deliveryId ? `github:${args.deliveryId}:ping` : undefined,
        externalId: args.deliveryId || undefined,
      });
      return { handled: true, reason: "ping", delivered: 0 };
    }

    await logOrchestratorEvent(ctx, {
      kind: "github.webhook.unsupported",
      summary: "Ignored unsupported GitHub webhook event type.",
      eventKey: args.deliveryId ? `github:${args.deliveryId}:unsupported` : undefined,
      externalId: args.deliveryId || undefined,
      payload: {
        event: args.event,
        deliveryId: args.deliveryId,
      },
    });
    return { handled: false, reason: "unsupported_event" };
  },
});
