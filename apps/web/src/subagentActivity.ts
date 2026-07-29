import type { WorkLogEntry, WorkLogToolLifecycleStatus } from "./session-logic";

export type SubagentProgressStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "interrupted"
  | "stopped"
  | "unknown";

export interface SubagentProgressItem {
  id: string;
  label?: string;
  status: SubagentProgressStatus;
  message?: string;
}

export interface SubagentActivityView {
  key: string;
  title: string;
  operation?: string;
  role?: string;
  prompt?: string;
  model?: string;
  reasoningEffort?: string;
  status: SubagentProgressStatus;
  startedAt: string;
  endedAt?: string;
  result?: string;
  providerThreadIds: ReadonlyArray<string>;
  agents: ReadonlyArray<SubagentProgressItem>;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function asString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function asFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function isoFromTimestamp(value: unknown): string | undefined {
  const timestamp = asFiniteNumber(value);
  if (timestamp === undefined) return undefined;
  const milliseconds = timestamp < 10_000_000_000 ? timestamp * 1_000 : timestamp;
  const date = new Date(milliseconds);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function lifecycleStatus(status: WorkLogToolLifecycleStatus | undefined): SubagentProgressStatus {
  switch (status) {
    case "inProgress":
      return "running";
    case "completed":
      return "completed";
    case "failed":
    case "declined":
      return "failed";
    case "stopped":
      return "stopped";
    default:
      return "unknown";
  }
}

function normalizeStatus(value: unknown): SubagentProgressStatus {
  const status = asString(value)?.toLowerCase();
  switch (status) {
    case "pending":
    case "pendinginit":
      return "pending";
    case "inprogress":
    case "running":
      return "running";
    case "completed":
    case "success":
      return "completed";
    case "failed":
    case "error":
    case "errored":
    case "notfound":
      return "failed";
    case "interrupted":
      return "interrupted";
    case "stopped":
    case "shutdown":
      return "stopped";
    default:
      return "unknown";
  }
}

function preferStatus(...values: ReadonlyArray<SubagentProgressStatus>): SubagentProgressStatus {
  return values.find((value) => value !== "unknown") ?? "unknown";
}

function firstPromptLine(prompt: string | undefined): string | undefined {
  return prompt
    ?.split(/\r?\n/u)
    .find((line) => line.trim().length > 0)
    ?.trim();
}

function isGenericSubagentTitle(value: string | undefined): boolean {
  if (!value) return true;
  const normalized = value.toLowerCase();
  return (
    normalized === "subagent" ||
    normalized === "subagent task" ||
    normalized === "tool" ||
    normalized === "tool call" ||
    normalized === "task"
  );
}

function collectCodexAgents(item: Record<string, unknown>): {
  agents: SubagentProgressItem[];
  providerThreadIds: string[];
} {
  const agentsState = asRecord(item.agentsStates);
  const receiverThreadIds = Array.isArray(item.receiverThreadIds)
    ? item.receiverThreadIds.flatMap((value) => (asString(value) ? [asString(value)!] : []))
    : [];
  const activityThreadId = asString(item.agentThreadId);
  const agentIds = new Set<string>([
    ...receiverThreadIds,
    ...(agentsState ? Object.keys(agentsState) : []),
    ...(activityThreadId ? [activityThreadId] : []),
  ]);
  const agents = [...agentIds].map((id) => {
    const state = asRecord(agentsState?.[id]);
    const message = asString(state?.message);
    const label = id === activityThreadId ? asString(item.agentPath) : undefined;
    const activityKind = asString(item.kind)?.toLowerCase();
    const activityStatus =
      activityKind === "started" || activityKind === "interacted"
        ? "running"
        : activityKind === "interrupted"
          ? "interrupted"
          : "unknown";
    return {
      id,
      ...(label ? { label } : {}),
      status: preferStatus(normalizeStatus(state?.status), activityStatus),
      ...(message ? { message } : {}),
    } satisfies SubagentProgressItem;
  });
  return { agents, providerThreadIds: [...agentIds] };
}

function openCodeAgent(
  data: Record<string, unknown>,
  state: Record<string, unknown>,
  role: string | undefined,
): SubagentProgressItem | null {
  const metadata = asRecord(state.metadata);
  const id = asString(metadata?.sessionId) ?? asString(data.toolCallId);
  if (!id) return null;
  const message = asString(state.output) ?? asString(state.error);
  return {
    id,
    ...(role ? { label: role } : {}),
    status: normalizeStatus(state.status),
    ...(message ? { message } : {}),
  };
}

export function subagentEntryKey(entry: Pick<WorkLogEntry, "id" | "toolCallId">): string {
  return entry.toolCallId ?? entry.id;
}

export function deriveSubagentActivity(entry: WorkLogEntry): SubagentActivityView | null {
  if (entry.itemType !== "collab_agent_tool_call") return null;

  const data = asRecord(entry.toolData) ?? {};
  const item = asRecord(data.item);
  const state = asRecord(data.state);
  const input = asRecord(state?.input);

  const prompt = asString(item?.prompt) ?? asString(input?.prompt) ?? asString(input?.description);
  const role =
    asString(input?.subagent_type) ??
    asString(input?.subagentType) ??
    asString(item?.agentPath) ??
    asString(item?.agentRole);
  const operation = asString(item?.tool) ?? asString(data.tool);
  const stateTitle = asString(state?.title) ?? asString(input?.description);
  const entryTitle = asString(entry.toolTitle);
  const title =
    stateTitle ??
    (!isGenericSubagentTitle(entryTitle) ? entryTitle : undefined) ??
    role ??
    firstPromptLine(prompt) ??
    "Subagent";

  const codex = item ? collectCodexAgents(item) : { agents: [], providerThreadIds: [] };
  const openCode = state ? openCodeAgent(data, state, role) : null;
  const activityStatus = preferStatus(
    normalizeStatus(item?.status),
    normalizeStatus(state?.status),
    lifecycleStatus(entry.toolLifecycleStatus),
  );
  const result =
    asString(state?.output) ??
    asString(state?.error) ??
    (entry.detail && entry.detail.trim() !== title.trim() ? entry.detail.trim() : undefined);
  const stateTime = asRecord(state?.time);
  const providerThreadIds = [...codex.providerThreadIds];
  if (openCode && !providerThreadIds.includes(openCode.id)) {
    providerThreadIds.push(openCode.id);
  }

  return {
    key: subagentEntryKey(entry),
    title,
    ...(operation ? { operation } : {}),
    ...(role ? { role } : {}),
    ...(prompt ? { prompt } : {}),
    ...(asString(item?.model) ? { model: asString(item?.model)! } : {}),
    ...(asString(item?.reasoningEffort)
      ? { reasoningEffort: asString(item?.reasoningEffort)! }
      : {}),
    status: activityStatus,
    startedAt: isoFromTimestamp(stateTime?.start) ?? entry.createdAt,
    ...(isoFromTimestamp(stateTime?.end) ? { endedAt: isoFromTimestamp(stateTime?.end)! } : {}),
    ...(result ? { result } : {}),
    providerThreadIds,
    agents: openCode ? [openCode] : codex.agents,
  };
}

function providerThreadIdForEntry(entry: WorkLogEntry): string | undefined {
  const data = asRecord(entry.toolData);
  return asString(data?.threadId);
}

export function deriveSubagentChildEntries(
  activity: SubagentActivityView,
  entries: ReadonlyArray<WorkLogEntry>,
): WorkLogEntry[] {
  if (activity.providerThreadIds.length === 0) return [];
  const providerThreadIds = new Set(activity.providerThreadIds);
  return entries.filter(
    (entry) =>
      entry.itemType !== "collab_agent_tool_call" &&
      providerThreadIds.has(providerThreadIdForEntry(entry) ?? ""),
  );
}
