// @effect-diagnostics nodeBuiltinImport:off -- the SDK takes a Node ChildProcess for the CLI.
import { text } from "../unknownField.ts";

import { mergeClaudeWorkflowProgress } from "./claudeWorkflowProgress.ts";

import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";

import type {
  OrchestrationV2ExecutionNode,
  OrchestrationV2PlanArtifact,
  OrchestrationV2PlanStep,
  OrchestrationV2Subagent,
  OrchestrationV2WorkflowRunHandles,
  OrchestrationV2TurnItem,
  RunId,
} from "@t3tools/contracts";

import * as DateTime from "effect/DateTime";

import * as Deferred from "effect/Deferred";

import * as Effect from "effect/Effect";

import * as Ref from "effect/Ref";

import { compileClaudeModelSelection } from "../../claudeModelOptions.ts";

import {
  makeSubagentChildThread,
  subagentThreadTitle,
} from "@t3tools/provider-core/server/subagentProjection";
import type { Deps as PrevDeps } from "./claudeSessionWorkflow.ts";
import { installWorkflow } from "./claudeSessionWorkflow.ts";
import { CLAUDE_PROVIDER } from "./ClaudeProviderIdentity.ts";
import { claudeSubagentModelSelection } from "./ClaudeSessionTypes.ts";
import { normalizeClaudeResultText } from "./ClaudeProviderMessages.ts";
import type { ActiveClaudeSubagent } from "./ClaudeAssistantArtifacts.ts";
import type { ActiveClaudeTurnContext } from "./ClaudeAssistantArtifacts.ts";

export type Deps = PrevDeps & ReturnType<typeof installWorkflow>;

export const installSubagentNode = (s: Deps) => {
  const { idAllocator, subagentModelCatalog, input } = s.env;
  const {
    now,
    latestPlanByKind,
    planIdsByNativeItem,
    sessionSubagentsByTaskId,
    sessionSubagentTaskIdsByToolUseId,
    subagentToolCalls,
    subagentStopOutcomes,
    appliedSubagentOutcomes,
    emitProviderEvent,
    claudeSubagentIds,
    resolveItemOrdinal,
    withWorkflowMemberThreadIds,
    emitSubagentConversationMessage,
    projectClaudeWorkflowMembers,
    confirmedSubagentOutcome,
    endToolCalls,
  } = s;
  const updateClaudeSubagentNode = Effect.fnUntraced(function* (input: {
    readonly context: ActiveClaudeTurnContext;
    readonly taskId: string;
    readonly toolUseId?: string;
    readonly prompt?: string;
    readonly title?: string;
    readonly model?: string;
    readonly effort?: string;
    readonly owner?: ActiveClaudeSubagent;
    readonly nativeTaskType?: string;
    readonly progress?: string;
    readonly workflowFrame?: unknown;
    readonly workflowName?: string;
    readonly workflowRunHandles?: OrchestrationV2WorkflowRunHandles;
    readonly result?: string;
    readonly status: Extract<
      OrchestrationV2ExecutionNode["status"],
      "running" | "completed" | "failed" | "cancelled"
    >;
    readonly reopen?: boolean;
    readonly nativeOutcome?: Extract<
      SDKMessage,
      { readonly type: "system"; readonly subtype: "task_notification" }
    >;
    // The process that ran it exited, which confirms the outcome as a native one would.
    readonly processExited?: true;
    readonly onlyIfRunningInRun?: RunId | null;
  }) {
    const registeredSubagent = (yield* Ref.get(sessionSubagentsByTaskId)).get(input.taskId);
    const existingSubagent =
      input.onlyIfRunningInRun !== undefined
        ? registeredSubagent
        : (input.context.subagentsByTaskId.get(input.taskId) ??
          (input.toolUseId === undefined
            ? undefined
            : input.context.subagentsByToolUseId.get(input.toolUseId)) ??
          registeredSubagent);
    if (existingSubagent === undefined && input.status !== "running") {
      return;
    }
    if (
      input.onlyIfRunningInRun !== undefined &&
      (existingSubagent?.task.status !== "running" ||
        existingSubagent.task.runId !== input.onlyIfRunningInRun)
    )
      return;
    // Only task_started may reopen a terminal task id on resume; late task_progress must not.
    const isReopen =
      input.reopen === true &&
      existingSubagent !== undefined &&
      existingSubagent.task.status !== "running" &&
      input.status === "running";
    if (
      existingSubagent !== undefined &&
      existingSubagent.task.status !== "running" &&
      input.status === "running" &&
      !isReopen
    ) {
      return;
    }
    // Resume task_started uses the SendMessage tool_use_id and sent message as its prompt.
    const resumeToolUseId =
      input.reopen === true &&
      existingSubagent !== undefined &&
      input.toolUseId !== undefined &&
      input.toolUseId !== existingSubagent.runToolUseId &&
      input.prompt !== undefined
        ? input.toolUseId
        : null;
    const lifecycleChanged =
      existingSubagent === undefined ||
      existingSubagent.task.status !== input.status ||
      (input.reopen === true && input.status === "running");

    const now = yield* DateTime.now;
    const nativeItemId = `task:${input.taskId}`;
    const derivedIds = claudeSubagentIds(input.context, input.taskId);
    const nodeId = existingSubagent?.task.id ?? derivedIds.nodeId;
    const childRootNodeId = existingSubagent?.childRootNodeId ?? derivedIds.childRootNodeId;
    const childThreadId = existingSubagent?.childThreadId ?? derivedIds.childThreadId;
    const turnItemOrdinal =
      existingSubagent?.turnItemOrdinal ??
      (yield* resolveItemOrdinal(input.context, `${nativeItemId}:subagent`));
    const priorTask =
      existingSubagent === undefined
        ? undefined
        : isReopen
          ? (({ progress: _staleProgress, ...rest }) => ({ ...rest, result: null }))(
              existingSubagent.task,
            )
          : existingSubagent.task;
    const workflow = mergeClaudeWorkflowProgress({
      previous: priorTask?.workflow,
      ...(input.workflowName === undefined ? {} : { name: input.workflowName }),
      ...(input.workflowRunHandles === undefined ? {} : { runHandles: input.workflowRunHandles }),
      message: input.workflowFrame,
    });
    const workflowWithThreads =
      workflow === undefined ? undefined : withWorkflowMemberThreadIds(workflow, childThreadId);
    const effort =
      existingSubagent === undefined
        ? (input.effort ??
          input.owner?.effort ??
          compileClaudeModelSelection(input.context.input.modelSelection).effort)
        : existingSubagent.effort;
    const model = input.model ?? priorTask?.model ?? null;
    const task = {
      ...(priorTask ?? {
        id: nodeId,
        threadId: input.context.input.threadId,
        runId: input.context.input.runId,
        parentNodeId: input.owner?.task.id ?? input.context.input.rootNodeId,
        origin: "provider_native" as const,
        createdBy: "agent" as const,
        driver: CLAUDE_PROVIDER,
        providerInstanceId: input.context.input.modelSelection.instanceId,
        providerThreadId: null,
        childThreadId,
        nativeTaskRef: {
          driver: CLAUDE_PROVIDER,
          nativeId: input.taskId,
          strength: "strong" as const,
        },
        prompt: input.prompt ?? "",
        title: input.title ?? null,
        model: input.model ?? null,
        result: null,
        startedAt: now,
      }),
      status: input.status,
      ...(input.reopen === true && input.status === "running" && existingSubagent !== undefined
        ? { runId: input.context.input.runId }
        : {}),
      ...(input.prompt === undefined ? {} : { prompt: input.prompt }),
      ...(input.title === undefined ? {} : { title: input.title }),
      model,
      ...(existingSubagent === undefined || existingSubagent.task.modelSelection !== undefined
        ? {
            modelSelection: claudeSubagentModelSelection(
              subagentModelCatalog,
              input.context.input.modelSelection.instanceId,
              model || input.context.input.modelSelection.model,
              effort,
            ),
          }
        : {}),
      ...(input.progress === undefined ? {} : { progress: input.progress }),
      ...(workflowWithThreads === undefined ? {} : { workflow: workflowWithThreads }),
      ...(input.result === undefined ? {} : { result: input.result }),
      ...(isReopen ? { startedAt: now } : {}),
      completedAt: input.status === "running" ? null : (priorTask?.completedAt ?? now),
      updatedAt: now,
    } satisfies OrchestrationV2Subagent;
    const subagent = {
      task,
      nativeTaskType: input.nativeTaskType ?? existingSubagent?.nativeTaskType,
      confirmedOutcome:
        input.nativeOutcome !== undefined || input.processExited === true
          ? confirmedSubagentOutcome(task)
          : isReopen
            ? undefined
            : existingSubagent?.confirmedOutcome,
      rootNodeId: existingSubagent?.rootNodeId ?? input.context.input.rootNodeId,
      childThreadId,
      childRootNodeId,
      turnItemId: existingSubagent?.turnItemId ?? derivedIds.turnItemId,
      turnItemOrdinal,
      runToolUseId:
        existingSubagent === undefined
          ? (input.toolUseId ?? null)
          : (resumeToolUseId ?? existingSubagent.runToolUseId),
      childThread: existingSubagent?.childThread ?? null,
      effort,
      nextChildItemOrdinal: existingSubagent?.nextChildItemOrdinal ?? 100,
      resultItemOrdinal: existingSubagent?.resultItemOrdinal ?? null,
      lastAssistantText:
        input.reopen === true ? null : (existingSubagent?.lastAssistantText ?? null),
      lastAssistantMessageId:
        input.reopen === true ? null : (existingSubagent?.lastAssistantMessageId ?? null),
    } satisfies ActiveClaudeSubagent;
    // Ingestion can terminalize after lookup; reopen only that generation to preserve newer results.
    const accepted = yield* Ref.modify(sessionSubagentsByTaskId, (current) => {
      const registered = current.get(input.taskId);
      if (
        (input.onlyIfRunningInRun !== undefined &&
          (registered?.task.status !== "running" ||
            registered.task.runId !== input.onlyIfRunningInRun)) ||
        (registered !== undefined &&
          registered.task.status !== "running" &&
          input.status === "running" &&
          !(isReopen && registered === existingSubagent))
      ) {
        return [false, current] as const;
      }
      return [true, new Map(current).set(input.taskId, subagent)] as const;
    });
    if (!accepted) return;
    if (input.nativeOutcome !== undefined) appliedSubagentOutcomes.add(input.nativeOutcome);
    if (existingSubagent !== undefined && input.status !== "running") {
      const openCalls = [...subagentToolCalls.values()].filter(
        (toolCall) => toolCall.threadId === existingSubagent.childThreadId,
      );
      yield* endToolCalls({
        context: input.context,
        toolCalls: openCalls,
        status: input.status === "cancelled" ? "interrupted" : "failed",
        completedAt: yield* DateTime.now,
      });
      for (const toolCall of openCalls) {
        subagentToolCalls.delete(toolCall.nativeItemId);
      }
    }
    input.context.subagentsByTaskId.set(input.taskId, subagent);
    if (input.toolUseId !== undefined) {
      input.context.subagentsByToolUseId.set(input.toolUseId, subagent);
      const toolUseId = input.toolUseId;
      yield* Ref.update(sessionSubagentTaskIdsByToolUseId, (current) =>
        current.get(toolUseId) === input.taskId
          ? current
          : new Map(current).set(toolUseId, input.taskId),
      );
    }

    if (subagent.childThread === null) {
      const childThread = makeSubagentChildThread({
        parentThread: input.context.input.appThread,
        childThreadId,
        parentNodeId: nodeId,
        activeProviderThreadId: null,
        providerInstanceId: input.context.input.modelSelection.instanceId,
        modelSelection: task.modelSelection ?? input.context.input.modelSelection,
        title: subagentThreadTitle({
          parentTitle: input.context.input.appThread.title,
          prompt: task.prompt,
          title:
            workflowWithThreads === undefined
              ? task.title
              : `Workflow · ${workflowWithThreads.name ?? task.title ?? "Untitled"}`,
          ordinal: input.context.subagentsByTaskId.size,
        }),
        now,
        createdBy: "agent",
        creationSource: "provider",
      });
      // Recovery cannot tell whether the child thread was already persisted.
      yield* emitProviderEvent({
        type: "app_thread.created",
        driver: CLAUDE_PROVIDER,
        appThread: childThread,
        ...(existingSubagent === undefined ? {} : { createOnly: true }),
      });
      subagent.childThread = childThread;
    }

    if (lifecycleChanged) {
      yield* emitProviderEvent({
        type: "node.updated",
        driver: CLAUDE_PROVIDER,
        node: {
          id: nodeId,
          threadId: task.threadId,
          runId: task.runId,
          parentNodeId: task.parentNodeId,
          rootNodeId: subagent.rootNodeId,
          kind: "subagent",
          status: input.status,
          countsForRun: false,
          providerThreadId: input.context.input.providerThread.id,
          providerTurnId: input.context.providerTurnId,
          nativeItemRef: {
            driver: CLAUDE_PROVIDER,
            nativeId: input.taskId,
            strength: "strong",
          },
          runtimeRequestId: null,
          checkpointScopeId: null,
          startedAt: task.startedAt,
          completedAt: task.completedAt,
        },
      });
    }
    // Emit before child records so the resumed run can adopt the child thread.
    yield* emitProviderEvent({
      type: "subagent.updated",
      driver: CLAUDE_PROVIDER,
      subagent: task,
    });
    if (lifecycleChanged) {
      yield* emitProviderEvent({
        type: "node.updated",
        driver: CLAUDE_PROVIDER,
        node: {
          id: childRootNodeId,
          threadId: childThreadId,
          runId: null,
          parentNodeId: null,
          rootNodeId: childRootNodeId,
          kind: "root_turn",
          status: input.status,
          countsForRun: false,
          providerThreadId: null,
          providerTurnId: null,
          nativeItemRef: task.nativeTaskRef,
          runtimeRequestId: null,
          checkpointScopeId: null,
          startedAt: task.startedAt,
          completedAt: task.completedAt,
        },
      });
    }
    const promptNativeItemId =
      existingSubagent === undefined
        ? `${nativeItemId}:prompt`
        : resumeToolUseId === null
          ? null
          : `${nativeItemId}:prompt:${resumeToolUseId}`;
    if (promptNativeItemId !== null) {
      yield* emitSubagentConversationMessage({
        nativeItemId: promptNativeItemId,
        senderThreadId: input.context.input.threadId,
        threadId: childThreadId,
        rootNodeId: childRootNodeId,
        role: "user",
        text: task.prompt,
        // Workflow prompts are collapsed scripts; clients open with the plan. A brief must not be mistaken for a script.
        ...(existingSubagent === undefined ? { workflowScript: task.workflow !== undefined } : {}),
        ordinal: existingSubagent === undefined ? 100 : ++subagent.nextChildItemOrdinal,
        now,
      });
    }
    if (workflowWithThreads !== undefined) {
      yield* projectClaudeWorkflowMembers({
        coordinator: subagent,
        workflow: workflowWithThreads,
      });
      if ((yield* Ref.get(sessionSubagentsByTaskId)).get(input.taskId) !== subagent) return;
    }
    yield* emitProviderEvent({
      type: "turn_item.updated",
      driver: CLAUDE_PROVIDER,
      turnItem: {
        id: subagent.turnItemId,
        threadId: task.threadId,
        runId: task.runId,
        nodeId: task.id,
        providerThreadId: input.context.input.providerThread.id,
        providerTurnId: input.context.providerTurnId,
        nativeItemRef: task.nativeTaskRef,
        parentItemId: null,
        ordinal: subagent.turnItemOrdinal,
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
        ...(task.progress === undefined ? {} : { progress: task.progress }),
        result: task.result,
      },
    });

    if (input.nativeOutcome !== undefined && subagent.confirmedOutcome !== undefined) {
      const outcome = subagentStopOutcomes.get(input.taskId);
      if (outcome !== undefined) yield* Deferred.succeed(outcome, subagent.confirmedOutcome);
    }

    const resultAlreadyShown =
      input.status === "completed" &&
      input.result !== undefined &&
      normalizeClaudeResultText(subagent.lastAssistantText ?? "") ===
        normalizeClaudeResultText(input.result);
    if (
      input.result !== undefined &&
      input.result.trim().length > 0 &&
      input.status !== "running" &&
      !resultAlreadyShown
    ) {
      const resultNativeItemId = `${nativeItemId}:result`;
      const resultItemOrdinal = subagent.resultItemOrdinal ?? ++subagent.nextChildItemOrdinal;
      subagent.resultItemOrdinal = resultItemOrdinal;
      yield* emitSubagentConversationMessage({
        nativeItemId: resultNativeItemId,
        threadId: childThreadId,
        rootNodeId: childRootNodeId,
        role: "assistant",
        text: input.result,
        ordinal: resultItemOrdinal,
        now,
      });
    }
  });

  const emitClaudePlanProjection = Effect.fnUntraced(function* (input: {
    readonly context: ActiveClaudeTurnContext;
    readonly nativeItemId: string;
    readonly kind: "todo_list" | "proposed_plan";
    readonly steps?: ReadonlyArray<OrchestrationV2PlanStep>;
    readonly markdown?: string;
  }) {
    const updatedAt = yield* DateTime.now;
    const projectionNativeItemId = `${input.kind}:${input.nativeItemId}`;
    const planKey = `${input.context.input.threadId}:${projectionNativeItemId}`;
    const existingPlanId = (yield* Ref.get(planIdsByNativeItem)).get(planKey);
    const planId =
      existingPlanId ??
      (yield* idAllocator.allocate.plan({
        threadId: input.context.input.threadId,
        runId: input.context.input.runId,
        driver: CLAUDE_PROVIDER,
      }));
    if (existingPlanId === undefined) {
      yield* Ref.update(planIdsByNativeItem, (current) => {
        const updated = new Map(current);
        updated.set(planKey, planId);
        return updated;
      });
    }
    const nodeId = idAllocator.derive.nodeFromProviderItem({
      driver: CLAUDE_PROVIDER,
      nativeItemId: projectionNativeItemId,
    });
    const nativeItemRef = {
      driver: CLAUDE_PROVIDER,
      nativeId: input.nativeItemId,
      strength: "strong" as const,
    };
    const ordinal = yield* resolveItemOrdinal(input.context, projectionNativeItemId);
    const steps = [...(input.steps ?? [])];
    const todoStatus = steps.every((step) => step.status === "completed") ? "completed" : "active";
    const plan: OrchestrationV2PlanArtifact =
      input.kind === "todo_list"
        ? {
            id: planId,
            threadId: input.context.input.threadId,
            runId: input.context.input.runId,
            nodeId,
            kind: "todo_list",
            status: todoStatus,
            steps,
          }
        : {
            id: planId,
            threadId: input.context.input.threadId,
            runId: input.context.input.runId,
            nodeId,
            kind: "proposed_plan",
            status: "active",
            markdown: input.markdown ?? "",
          };
    const node: OrchestrationV2ExecutionNode = {
      id: nodeId,
      threadId: input.context.input.threadId,
      runId: input.context.input.runId,
      parentNodeId: input.context.input.rootNodeId,
      rootNodeId: input.context.input.rootNodeId,
      kind: input.kind === "todo_list" ? "todo_list" : "plan",
      status: "completed",
      countsForRun: false,
      providerThreadId: input.context.input.providerThread.id,
      providerTurnId: input.context.providerTurnId,
      nativeItemRef,
      runtimeRequestId: null,
      checkpointScopeId: null,
      startedAt: updatedAt,
      completedAt: updatedAt,
    };
    const common = {
      id: idAllocator.derive.turnItemFromProviderItem({
        driver: CLAUDE_PROVIDER,
        nativeItemId: projectionNativeItemId,
      }),
      threadId: input.context.input.threadId,
      runId: input.context.input.runId,
      nodeId,
      providerThreadId: input.context.input.providerThread.id,
      providerTurnId: input.context.providerTurnId,
      nativeItemRef,
      parentItemId: null,
      ordinal,
      status: "completed" as const,
      title: null,
      startedAt: updatedAt,
      completedAt: updatedAt,
      updatedAt,
    };
    const turnItem: OrchestrationV2TurnItem =
      input.kind === "todo_list"
        ? { ...common, type: "todo_list", planId, steps }
        : {
            ...common,
            type: "proposed_plan",
            planId,
            markdown: input.markdown ?? "",
            streaming: false,
          };
    const latestPlanKey = `${input.context.input.threadId}:${input.kind}`;
    const previousPlan = (yield* Ref.get(latestPlanByKind)).get(latestPlanKey);
    yield* Effect.all(
      [
        ...(previousPlan === undefined ||
        previousPlan.id === plan.id ||
        (previousPlan.kind !== "todo_list" && previousPlan.status === "completed")
          ? []
          : [
              emitProviderEvent({
                type: "plan.updated" as const,
                driver: CLAUDE_PROVIDER,
                plan: { ...previousPlan, status: "superseded" as const },
              }),
            ]),
        emitProviderEvent({ type: "node.updated", driver: CLAUDE_PROVIDER, node }),
        emitProviderEvent({ type: "plan.updated", driver: CLAUDE_PROVIDER, plan }),
        emitProviderEvent({ type: "turn_item.updated", driver: CLAUDE_PROVIDER, turnItem }),
      ],
      { concurrency: 1 },
    );
    yield* Ref.update(latestPlanByKind, (current) => {
      const updated = new Map(current);
      updated.set(latestPlanKey, plan);
      return updated;
    });
  });

  return {
    updateClaudeSubagentNode,
    emitClaudePlanProjection,
  };
};
