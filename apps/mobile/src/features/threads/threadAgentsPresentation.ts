import { resolveLinkedThreadOpen } from "@t3tools/client-runtime/linked-thread";
import {
  formatSubagentDisplayTitle,
  resolveSubagentMetadata,
  subagentCardDetail,
  subagentDetailPreview,
} from "@t3tools/client-runtime/state/subagent-display";
import {
  isActiveSubagentStatus,
  promptTitle,
  type RuntimeSubagent,
  type SubagentWorkflowGroup,
} from "@t3tools/client-runtime/state/subagentRuntime";
import { REASONING_EFFORT_OPTION_IDS } from "@t3tools/client-runtime/state/thread-execution";
import type {
  EnvironmentId,
  OrchestrationV2Subagent,
  ServerProvider,
  ThreadId,
} from "@t3tools/contracts";
import { resolveSelectableModel } from "@t3tools/shared/model";
import { msg } from "gt-react-native";

import { m, type MessageResolver } from "../../i18n/messages";

export type SubagentRowTone = "working" | "completed" | "failed" | "stopped";

export interface SubagentRowPresentation {
  readonly title: string;
  readonly detail: string | null;
  readonly statusLabel: string;
  readonly tone: SubagentRowTone;
  readonly live: boolean;
  readonly canOpenThread: boolean;
  /** The linked environment the task runs in, when it runs in one. */
  readonly runsOn: string | null;
}

export interface SubagentThreadTarget {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  /** Set when the thread is read through the environment that links to it, not opened there. */
  readonly linked?: { readonly viaEnvironmentId: EnvironmentId; readonly label: string };
}

/**
 * Where an agent's thread opens: here, in the linked environment that runs it when this app is
 * connected there, or read-only through this environment's link. Once the link is gone a saved
 * environment opens in place, where the app can reconnect to it; with neither, the read-only view
 * says what to link again. Null when there is no thread.
 */
export function subagentThreadTarget(
  subagent: Pick<OrchestrationV2Subagent, "childThreadId" | "remoteChild">,
  environmentId: EnvironmentId,
  ownConnection: (environmentId: EnvironmentId) => { readonly connected: boolean } | undefined,
  /** Whether `environmentId` still holds a link to the given environment. */
  isLinked: (environmentId: EnvironmentId) => boolean,
): SubagentThreadTarget | null {
  if (subagent.childThreadId !== null) {
    return { environmentId, threadId: subagent.childThreadId };
  }
  const remote = subagent.remoteChild;
  if (remote?.threadId === undefined) return null;
  const target = { environmentId: remote.environmentId, threadId: remote.threadId };
  const open = resolveLinkedThreadOpen({
    environmentId: remote.environmentId,
    viaEnvironmentId: environmentId,
    own: ownConnection(remote.environmentId),
    linked: isLinked(remote.environmentId),
  });
  return open === "direct"
    ? target
    : { ...target, linked: { viaEnvironmentId: environmentId, label: remote.label } };
}

function rowTitle(
  subagent: Pick<OrchestrationV2Subagent, "title" | "prompt">,
  resolve: MessageResolver,
): string {
  const title = subagent.title?.trim();
  if (title) return formatSubagentDisplayTitle(title);
  const prompt = subagent.prompt.trim();
  if (prompt.length === 0) return resolve(msg("Subagent"));
  return promptTitle(prompt);
}

function rowTone(status: OrchestrationV2Subagent["status"]): SubagentRowTone {
  if (isActiveSubagentStatus(status)) return "working";
  if (status === "completed") return "completed";
  if (status === "failed") return "failed";
  return "stopped";
}

function rowStatusLabel(
  status: OrchestrationV2Subagent["status"],
  resolve: MessageResolver,
): string {
  switch (status) {
    case "pending":
    case "running":
      return resolve(msg("Working", { $context: "agent status" }));
    case "waiting":
      return resolve(msg("Waiting", { $context: "agent status" }));
    case "idle":
      return resolve(msg("Idle", { $context: "agent status" }));
    case "completed":
      return resolve(msg("Completed", { $context: "agent status" }));
    case "failed":
      return resolve(msg("Failed", { $context: "agent status" }));
    case "cancelled":
      return resolve(msg("Cancelled", { $context: "agent status" }));
    case "interrupted":
      return resolve(msg("Interrupted", { $context: "agent status" }));
  }
}

export function resolveSubagentRowPresentation(
  subagent: Pick<
    OrchestrationV2Subagent,
    "title" | "prompt" | "status" | "progress" | "result" | "childThreadId" | "remoteChild"
  >,
  canOpenRemote = false,
  resolve: MessageResolver = m,
): SubagentRowPresentation {
  const live = isActiveSubagentStatus(subagent.status);
  return {
    title: rowTitle(subagent, resolve),
    detail: subagentDetailPreview({
      ...subagent,
      result: subagent.remoteChild?.launchError ?? subagent.result,
    }),
    statusLabel:
      live && subagent.remoteChild !== undefined && subagent.remoteChild.threadId === undefined
        ? resolve(msg("Launching", { $context: "agent status" }))
        : rowStatusLabel(subagent.status, resolve),
    tone: rowTone(subagent.status),
    live,
    canOpenThread:
      subagent.childThreadId !== null ||
      (subagent.remoteChild?.threadId !== undefined && canOpenRemote),
    runsOn: subagent.remoteChild?.label ?? null,
  };
}

export type WorkflowRailTone = SubagentRowTone | "queued";

export interface WorkflowRailItem {
  readonly key: string;
  readonly title: string;
  readonly members: ReadonlyArray<RuntimeSubagent>;
  readonly completedCount: number;
  readonly tone: WorkflowRailTone;
}

function railTone(members: ReadonlyArray<RuntimeSubagent>): WorkflowRailTone {
  if (members.every((member) => member.status === "pending")) return "queued";
  if (members.some((member) => isActiveSubagentStatus(member.status) || member.status === "idle")) {
    return "working";
  }
  if (members.some((member) => member.status === "failed")) return "failed";
  return members.every((member) => member.status === "completed") ? "completed" : "stopped";
}

export function workflowRail(
  group: SubagentWorkflowGroup,
  resolve: MessageResolver = m,
): ReadonlyArray<WorkflowRailItem> {
  const items = group.phases.map((phase) => ({
    key: String(phase.index),
    title: phase.title,
    members: phase.members,
  }));
  if (group.unphasedMembers.length > 0) {
    items.push({
      key: "unphased",
      title:
        items.length === 0
          ? resolve(msg("Agents"))
          : resolve(msg("Other", { $context: "group of agents outside any workflow phase" })),
      members: group.unphasedMembers,
    });
  }
  return items.map((item) => ({
    ...item,
    completedCount: item.members.filter((member) => member.status === "completed").length,
    tone: railTone(item.members),
  }));
}

export function nextWorkflowSelection(
  rail: ReadonlyArray<WorkflowRailItem>,
  selected: string | null,
  tapped?: string,
): string | null {
  const open = rail.some((item) => item.key === selected) ? selected : null;
  if (tapped !== undefined) return tapped === open ? null : tapped;
  if (open !== null) return null;
  const filled = rail.filter((item) => item.members.length > 0);
  return (
    (
      filled.find((item) => item.tone === "working") ??
      filled.find((item) => item.tone === "failed") ??
      filled.at(-1)
    )?.key ?? null
  );
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

export function workflowMemberMetadata(
  member: Pick<RuntimeSubagent, "model" | "effort" | "speed">,
  provider: Pick<ServerProvider, "driver" | "models"> | undefined,
  resolve: MessageResolver = m,
) {
  const model = member.model?.trim()
    ? resolveSubagentMetadata({ model: member.model, provider }, resolve).modelLabel
    : null;
  const slug = provider
    ? resolveSelectableModel(provider.driver, member.model, provider.models)
    : null;
  const effortChoice = provider?.models
    .find((candidate) => candidate.slug === slug)
    ?.capabilities?.optionDescriptors?.flatMap((descriptor) =>
      descriptor.type === "select" &&
      (descriptor.role === "reasoning" || REASONING_EFFORT_OPTION_IDS.includes(descriptor.id))
        ? descriptor.options
        : [],
    )
    .find((option) => option.id === member.effort);
  return {
    model,
    effort: member.effort ? (effortChoice?.label ?? capitalize(member.effort)) : null,
    speed: member.speed ? capitalize(member.speed) : null,
    fast: member.speed === "fast",
  };
}

export function workflowMemberDetail(
  member: Pick<RuntimeSubagent, "status" | "progress" | "result" | "error">,
) {
  return {
    detail: subagentCardDetail(subagentDetailPreview(member)),
    error: member.status === "failed" ? subagentCardDetail(member.error) : null,
  };
}

export function resolveSubagentStopTarget(
  subagent: Pick<
    OrchestrationV2Subagent,
    | "id"
    | "threadId"
    | "childThreadId"
    | "status"
    | "origin"
    | "driver"
    | "runId"
    | "nativeTaskRef"
    | "workflow"
  >,
) {
  if (!isActiveSubagentStatus(subagent.status)) return null;
  if (subagent.workflow !== undefined) {
    return subagent.status === "running" &&
      subagent.origin === "provider_native" &&
      subagent.driver === "claudeAgent" &&
      Boolean(subagent.nativeTaskRef?.nativeId)
      ? {
          kind: "workflow" as const,
          input: { threadId: subagent.threadId, subagentId: subagent.id },
        }
      : null;
  }
  if (subagent.origin === "app_owned" && subagent.childThreadId !== null) {
    return {
      kind: "subagent" as const,
      input: { threadId: subagent.threadId, subagentId: subagent.id },
    };
  }
  if (
    subagent.origin === "provider_native" &&
    subagent.driver === "claudeAgent" &&
    subagent.runId !== null &&
    subagent.nativeTaskRef?.strength === "strong" &&
    subagent.nativeTaskRef.nativeId !== null
  ) {
    return {
      kind: "subagent" as const,
      input: { threadId: subagent.threadId, subagentId: subagent.id },
    };
  }
  return null;
}
