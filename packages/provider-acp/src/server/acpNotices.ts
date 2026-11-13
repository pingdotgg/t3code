// ACP session behaviour extracted from server/adapter.ts (notices).

import { nonEmptyText } from "./acpToolCallProjection.ts";
import { type AcpPlanUpdate } from "./runtimeModel.ts";
import { type ActiveAcpTurn } from "./acpTurnModel.ts";
import { type OrchestrationV2PlanArtifact, type OrchestrationV2PlanStep } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as EffectAcpSchema from "effect-acp/compat";
import * as Ref from "effect/Ref";
import type { AcpSessionCtx8 } from "./acpSessionContext.ts";

export const createAcpNotices = (ctx: AcpSessionCtx8) => {
  const emitNotice = Effect.fnUntraced(function* (
    context: ActiveAcpTurn,
    notice: { readonly title: string; readonly description?: string },
  ) {
    const nativeItemId = `${context.nativeTurnId}:notice:${context.itemOrdinals.size}`;
    const now = yield* DateTime.now;
    yield* ctx.emitProviderEvent({
      type: "turn_item.updated",
      driver: ctx.driver,
      turnItem: {
        id: ctx.providerTurnItemId(nativeItemId),
        threadId: context.input.threadId,
        runId: context.input.runId,
        nodeId: context.input.rootNodeId,
        providerThreadId: context.input.providerThread.id,
        providerTurnId: context.providerTurnId,
        nativeItemRef: { driver: ctx.driver, nativeId: nativeItemId, strength: "weak" },
        parentItemId: null,
        ordinal: yield* ctx.resolveItemOrdinal(context, nativeItemId),
        type: "system_notice",
        status: "completed",
        title: notice.title,
        message:
          notice.description === undefined
            ? notice.title
            : `${notice.title}\n\n${notice.description}`,
        startedAt: now,
        completedAt: now,
        updatedAt: now,
      },
    });
  });
  const emitPlan = Effect.fnUntraced(function* (
    context: ActiveAcpTurn,
    update: AcpPlanUpdate,
  ) {
    yield* ctx.closeTextStreams(context);
    const existing = context.plans.get(update.nativePlanId);
    if (update.kind === "removed" && existing === undefined) return;
    const nativeItemId = `${context.nativeTurnId}:plan:${encodeURIComponent(update.nativePlanId)}`;
    const ordinal = yield* ctx.resolveItemOrdinal(context, nativeItemId);
    const now = yield* DateTime.now;
    const nodeId = ctx.providerNodeId(nativeItemId);
    const turnItemId = ctx.providerTurnItemId(nativeItemId);
    const planState = existing ?? {
      id: yield* ctx.idAllocator.allocate.plan({
        threadId: context.input.threadId,
        runId: context.input.runId,
        driver: ctx.driver,
      }),
      startedAt: now,
      latest: null,
    };
    const planId = planState.id;
    const nativeItemRef = { driver: ctx.driver, nativeId: nativeItemId, strength: "weak" as const };
    const base = {
      id: planId,
      threadId: context.input.threadId,
      runId: context.input.runId,
      nodeId,
    } as const;
    let plan: OrchestrationV2PlanArtifact;
    if (update.kind === "removed") {
      if (planState.latest === null) return;
      plan = { ...planState.latest, status: "superseded" };
    } else if (update.kind === "items") {
      // A cancelled entry is not outstanding work, and plan steps have no
      // cancelled status, so drop it rather than show it as pending.
      const steps: ReadonlyArray<OrchestrationV2PlanStep> = update.plan.flatMap(
        (step, index) =>
          step.status === "cancelled"
            ? []
            : [
                {
                  id: `acp-step-${index + 1}`,
                  text: nonEmptyText(step.step, `Step ${index + 1}`),
                  status:
                    step.status === "inProgress"
                      ? "running"
                      : step.status === "completed"
                        ? "completed"
                        : "pending",
                },
              ],
      );
      const completed =
        update.plan.length > 0 && steps.every((step) => step.status === "completed");
      plan = {
        ...base,
        status: completed ? "completed" : "active",
        kind: "todo_list",
        steps,
        ...(update.explanation == null ? {} : { explanation: update.explanation }),
      };
    } else {
      const markdown =
        update.kind === "markdown"
          ? update.markdown
          : update.kind === "file"
            ? `Plan file: ${update.uri}`
            : `[Unsupported ACP plan content: ${update.contentType}]`;
      plan = {
        ...base,
        status: "active",
        kind: "proposed_plan",
        markdown,
      };
    }
    planState.latest = plan;
    context.plans.set(update.nativePlanId, planState);
    const completed = plan.status === "completed" || plan.status === "superseded";
    const nodeKind = plan.kind === "todo_list" ? "todo_list" : "plan";
    yield* ctx.emitProviderEvent({
      type: "node.updated",
      driver: ctx.driver,
      node: {
        id: nodeId,
        threadId: context.input.threadId,
        runId: context.input.runId,
        parentNodeId: context.input.rootNodeId,
        rootNodeId: context.input.rootNodeId,
        kind: nodeKind,
        status: completed ? "completed" : "running",
        countsForRun: false,
        providerThreadId: context.input.providerThread.id,
        providerTurnId: context.providerTurnId,
        nativeItemRef,
        runtimeRequestId: null,
        checkpointScopeId: null,
        startedAt: planState.startedAt,
        completedAt: completed ? now : null,
      },
    });
    yield* ctx.emitProviderEvent({ type: "plan.updated", driver: ctx.driver, plan });
    yield* ctx.emitProviderEvent({
      type: "turn_item.updated",
      driver: ctx.driver,
      turnItem: {
        id: turnItemId,
        threadId: context.input.threadId,
        runId: context.input.runId,
        nodeId,
        providerThreadId: context.input.providerThread.id,
        providerTurnId: context.providerTurnId,
        nativeItemRef,
        parentItemId: null,
        ordinal,
        status: completed ? "completed" : "running",
        title: null,
        startedAt: planState.startedAt,
        completedAt: completed ? now : null,
        updatedAt: now,
        ...(plan.kind === "todo_list"
          ? {
              type: "todo_list" as const,
              planId,
              steps: plan.steps,
              ...(plan.explanation === undefined ? {} : { explanation: plan.explanation }),
            }
          : {
              type: "proposed_plan" as const,
              planId,
              markdown: plan.markdown,
              streaming: !completed,
            }),
      },
    });
  });
  const appendLoadedHistory =
    /* Provider events include streaming deltas; avoid a span for each update. */
    Effect.fnUntraced(function* (
      notification: EffectAcpSchema.SessionNotification,
      role: "user" | "assistant" | "thought",
      text: string,
      replace = false,
    ) {
      if (text.length === 0 && !replace) return;
      const now = yield* DateTime.now;
      yield* Ref.update(ctx.snapshot, (current) => {
        const update = notification.update;
        const sourceMessageId =
          (update.sessionUpdate === "user_message_chunk" ||
            update.sessionUpdate === "agent_message_chunk" ||
            update.sessionUpdate === "agent_thought_chunk" ||
            update.sessionUpdate === "user_message" ||
            update.sessionUpdate === "agent_message" ||
            update.sessionUpdate === "agent_thought") &&
          update.messageId
            ? update.messageId
            : null;
        const startsNew =
          current.loadingRole !== role ||
          (sourceMessageId !== null && current.loadingMessageId !== sourceMessageId);
        const loadingIndex = startsNew ? current.loadingIndex + 1 : current.loadingIndex;
        const nativeItemId =
          sourceMessageId === null
            ? `${notification.sessionId}:history:${role}:${loadingIndex}`
            : `${notification.sessionId}:history:${role}:message:${sourceMessageId}`;
        const messageId = ctx.providerMessageId(nativeItemId);
        const key = String(messageId);
        const previous = current.messages.get(key);
        const messages = new Map(current.messages);
        messages.set(key, {
          createdBy: previous?.createdBy ?? (role === "user" ? "user" : "agent"),
          creationSource: previous?.creationSource ?? "provider",
          id: messageId,
          threadId: ctx.input.threadId,
          runId: null,
          nodeId: null,
          role: role === "user" ? "user" : "assistant",
          text: replace ? text : `${previous?.text ?? ""}${text}`,
          attachments: [],
          streaming: false,
          createdAt: previous?.createdAt ?? now,
          updatedAt: now,
        });
        return {
          order: current.order.includes(key) ? current.order : [...current.order, key],
          messages,
          loadingRole: role,
          loadingMessageId: sourceMessageId ?? (startsNew ? null : current.loadingMessageId),
          loadingIndex,
        };
      });
    });
  return {
    emitNotice,
    emitPlan,
    appendLoadedHistory,
  };
};
