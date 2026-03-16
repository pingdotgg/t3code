import type { ServerProviderCapabilityState } from "@t3tools/contracts";
import {
  ChevronDownIcon,
  ChevronUpIcon,
  CircleAlertIcon,
  LoaderCircleIcon,
  PauseCircleIcon,
  ShieldAlertIcon,
  SquareDashedBottomCodeIcon,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import type {
  AgentTeamsActivity,
  AgentTeamsMember,
  AgentTeamsRun,
  AgentTeamsState,
  AgentTeamsTaskSnapshot,
  AgentTeamsTaskStatus,
} from "../../session-logic";
import { cn } from "~/lib/utils";

interface AgentTeamsPanelProps {
  state: AgentTeamsState;
  enabled: boolean;
  capabilityState?: ServerProviderCapabilityState;
  capabilityMessage?: string | null;
}

const FALLBACK_TEAM_COLORS = [
  {
    accent: "text-rose-700 dark:text-rose-200",
    border: "border-rose-500/30",
    surface: "bg-rose-500/8",
    dot: "bg-rose-500",
  },
  {
    accent: "text-orange-700 dark:text-orange-200",
    border: "border-orange-500/30",
    surface: "bg-orange-500/8",
    dot: "bg-orange-500",
  },
  {
    accent: "text-emerald-700 dark:text-emerald-200",
    border: "border-emerald-500/30",
    surface: "bg-emerald-500/8",
    dot: "bg-emerald-500",
  },
  {
    accent: "text-sky-700 dark:text-sky-200",
    border: "border-sky-500/30",
    surface: "bg-sky-500/8",
    dot: "bg-sky-500",
  },
  {
    accent: "text-violet-700 dark:text-violet-200",
    border: "border-violet-500/30",
    surface: "bg-violet-500/8",
    dot: "bg-violet-500",
  },
  {
    accent: "text-fuchsia-700 dark:text-fuchsia-200",
    border: "border-fuchsia-500/30",
    surface: "bg-fuchsia-500/8",
    dot: "bg-fuchsia-500",
  },
] as const;

const COLOR_NAME_MAP: Record<string, number> = {
  red: 0,
  rose: 0,
  orange: 1,
  amber: 1,
  green: 2,
  emerald: 2,
  blue: 3,
  sky: 3,
  cyan: 3,
  violet: 4,
  purple: 4,
  indigo: 4,
  fuchsia: 5,
  pink: 5,
  magenta: 5,
};

function statusLabel(status: Exclude<AgentTeamsTaskStatus, "lead">): string {
  switch (status) {
    case "running":
      return "Running";
    case "idle":
      return "Idle";
    case "awaitingApproval":
      return "Needs approval";
    case "completed":
      return "Completed";
    case "failed":
      return "Failed";
    case "stopped":
      return "Stopped";
  }
}

function statusTone(status: Exclude<AgentTeamsTaskStatus, "lead">): string {
  switch (status) {
    case "running":
      return "border-sky-500/20 bg-sky-500/8 text-sky-700 dark:text-sky-200";
    case "idle":
      return "border-amber-500/20 bg-amber-500/8 text-amber-700 dark:text-amber-200";
    case "awaitingApproval":
      return "border-orange-500/30 bg-orange-500/10 text-orange-800 dark:text-orange-100";
    case "completed":
      return "border-emerald-500/18 bg-emerald-500/6 text-emerald-700 dark:text-emerald-200";
    case "failed":
      return "border-rose-500/25 bg-rose-500/8 text-rose-700 dark:text-rose-200";
    case "stopped":
      return "border-zinc-500/25 bg-zinc-500/8 text-zinc-700 dark:text-zinc-200";
  }
}

function StatusGlyph({ status }: { status: Exclude<AgentTeamsTaskStatus, "lead"> }) {
  if (status === "running") {
    return <LoaderCircleIcon className="size-3 animate-spin" />;
  }
  if (status === "idle") {
    return <PauseCircleIcon className="size-3" />;
  }
  if (status === "awaitingApproval") {
    return <ShieldAlertIcon className="size-3" />;
  }
  if (status === "failed" || status === "stopped") {
    return <CircleAlertIcon className="size-3" />;
  }
  return <span className="size-1.5 rounded-full bg-current" />;
}

function hashValue(value: string): number {
  let result = 0;
  for (let index = 0; index < value.length; index += 1) {
    result = (result * 31 + value.charCodeAt(index)) >>> 0;
  }
  return result;
}

function colorPresetForMember(member: AgentTeamsMember): (typeof FALLBACK_TEAM_COLORS)[number] {
  const rawColor = member.agentColor?.trim().toLowerCase();
  if (rawColor) {
    const directIndex = COLOR_NAME_MAP[rawColor];
    if (directIndex !== undefined) {
      return FALLBACK_TEAM_COLORS[directIndex]!;
    }
    for (const [name, index] of Object.entries(COLOR_NAME_MAP)) {
      if (rawColor.includes(name)) {
        return FALLBACK_TEAM_COLORS[index]!;
      }
    }
  }
  return FALLBACK_TEAM_COLORS[hashValue(member.id) % FALLBACK_TEAM_COLORS.length]!;
}

function formatTimestamp(value: string): string {
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) {
    return value;
  }
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(parsed);
}

function formatRelativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function formatRunSpan(run: AgentTeamsRun): string {
  if (!run.endedAt) {
    return `Started ${formatTimestamp(run.startedAt)}`;
  }
  return `${formatTimestamp(run.startedAt)} to ${formatTimestamp(run.endedAt)}`;
}

function panelSummary(run: AgentTeamsRun): string {
  const runningMembers = run.members.filter((member) => member.status === "running").length;
  const idleMembers = run.members.filter((member) => member.status === "idle").length;
  const parts = [`${run.members.length} agent${run.members.length === 1 ? "" : "s"}`];
  if (runningMembers > 0) parts.push(`${runningMembers} running`);
  if (idleMembers > 0) parts.push(`${idleMembers} idle`);
  return parts.join(" · ");
}

function latestToolForMember(member: AgentTeamsMember): string | undefined {
  if (member.status !== "running") return undefined;
  const sorted = [...member.activities].toSorted((a, b) =>
    b.updatedAt.localeCompare(a.updatedAt),
  );
  return sorted[0]?.lastToolName;
}

interface UnifiedFeedEntry {
  id: string;
  updatedAt: string;
  label: string;
  detail?: string;
  lastToolName?: string;
  kind: "activity" | "task";
  status?: string;
}

function buildUnifiedFeed(
  member: AgentTeamsMember,
  tasks: AgentTeamsTaskSnapshot[] | undefined,
): UnifiedFeedEntry[] {
  const entries: UnifiedFeedEntry[] = [];

  for (const activity of member.activities) {
    const entry: UnifiedFeedEntry = {
      id: activity.id,
      updatedAt: activity.updatedAt,
      label: activity.label,
      kind: "activity",
    };
    if (activity.detail) entry.detail = activity.detail;
    if (activity.lastToolName) entry.lastToolName = activity.lastToolName;
    entries.push(entry);
  }

  if (tasks) {
    for (const task of tasks) {
      if (
        task.teammateName &&
        task.teammateName.toLowerCase() !== member.label.toLowerCase() &&
        task.teammateName.toLowerCase() !== member.teammateName?.toLowerCase() &&
        task.teammateName.toLowerCase() !== member.agentName?.toLowerCase()
      ) {
        continue;
      }
      const taskEntry: UnifiedFeedEntry = {
        id: `task:${task.taskId ?? task.summary ?? task.updatedAt ?? "unknown"}`,
        updatedAt: task.updatedAt ?? member.startedAt,
        label: task.summary ?? task.taskId ?? "Task",
        kind: "task",
      };
      if (task.status) taskEntry.status = task.status;
      entries.push(taskEntry);
    }
  }

  return entries.toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function AgentTeamsPanel({
  state,
  enabled,
  capabilityState,
  capabilityMessage,
}: AgentTeamsPanelProps) {
  const [expanded, setExpanded] = useState(false);
  const [selectedMemberId, setSelectedMemberId] = useState<string | null>(null);

  const activeRun = useMemo(
    () =>
      state.runs.find((run) => run.id === state.activeRunId) ??
      state.runs.find((run) => run.activeCount > 0) ??
      null,
    [state.activeRunId, state.runs],
  );
  const subjectRun = activeRun ?? state.runs[0] ?? null;
  const archivedRuns = useMemo(
    () => (subjectRun ? state.runs.filter((run) => run.id !== subjectRun.id) : []),
    [state.runs, subjectRun],
  );
  const selectedMember = useMemo(
    () =>
      subjectRun?.members.find((member) => member.id === selectedMemberId) ??
      subjectRun?.members[0] ??
      null,
    [selectedMemberId, subjectRun],
  );
  const showWarning =
    enabled &&
    capabilityState !== undefined &&
    capabilityState !== "available" &&
    capabilityMessage;
  const selectedMemberPreset = selectedMember ? colorPresetForMember(selectedMember) : null;

  const unifiedFeed = useMemo(
    () => (selectedMember ? buildUnifiedFeed(selectedMember, subjectRun?.tasks) : []),
    [selectedMember, subjectRun?.tasks],
  );

  useEffect(() => {
    if (!subjectRun) {
      if (selectedMemberId !== null) {
        setSelectedMemberId(null);
      }
      return;
    }
    const hasCurrentSelection = subjectRun.members.some((member) => member.id === selectedMemberId);
    if (!hasCurrentSelection) {
      setSelectedMemberId(subjectRun.members[0]?.id ?? null);
    }
  }, [selectedMemberId, subjectRun]);

  if (!state.hasTeamActivity || !subjectRun) {
    return null;
  }

  return (
    <section className="relative z-10 -mt-px w-full">
      <div
        className={cn(
          "overflow-hidden border border-border bg-card transition-[border-radius]",
          expanded ? "rounded-b-[20px] rounded-t-none" : "rounded-b-[18px] rounded-t-none",
        )}
      >
        {/* Collapsed / header bar */}
        <div
          className={cn(
            "bg-card px-3 sm:px-4",
            expanded ? "border-b border-border/70 py-3" : "py-2.5",
          )}
        >
          <div className="flex items-center gap-2.5">
            <button
              type="button"
              aria-expanded={expanded}
              onClick={() => setExpanded((current) => !current)}
              className={cn(
                "flex min-w-0 flex-1 text-left",
                expanded ? "items-center gap-2.5" : "items-center gap-3 overflow-hidden",
              )}
            >
              <span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-muted/40 text-muted-foreground">
                <SquareDashedBottomCodeIcon className="size-3.5" />
              </span>
              {expanded ? (
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-2">
                    <span className="truncate text-sm font-medium text-foreground">
                      {subjectRun.label}
                    </span>
                    <span
                      className={cn(
                        "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px]",
                        statusTone(subjectRun.status),
                      )}
                    >
                      <StatusGlyph status={subjectRun.status} />
                      {statusLabel(subjectRun.status)}
                    </span>
                  </span>
                  <span className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted-foreground">
                    <span>{activeRun ? "Active team" : "Recent team"}</span>
                    <span>{panelSummary(subjectRun)}</span>
                    {subjectRun.members.slice(0, 2).map((member) => {
                      const preset = colorPresetForMember(member);
                      return (
                        <span key={member.id} className="inline-flex items-center gap-1">
                          <span className={cn("size-1.5 rounded-full", preset.dot)} />
                          <span className="truncate">{member.label}</span>
                        </span>
                      );
                    })}
                    {subjectRun.members.length > 2 ? (
                      <span>+{subjectRun.members.length - 2} more</span>
                    ) : null}
                  </span>
                </span>
              ) : (
                <span className="flex min-w-0 flex-1 items-center gap-3 overflow-hidden whitespace-nowrap">
                  <span className="min-w-0 truncate text-sm font-medium text-foreground">
                    {subjectRun.label}
                  </span>
                  <span
                    className={cn(
                      "inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-[11px]",
                      statusTone(subjectRun.status),
                    )}
                  >
                    <StatusGlyph status={subjectRun.status} />
                    {statusLabel(subjectRun.status)}
                  </span>
                  <span className="shrink-0 text-[11px] text-muted-foreground">
                    {activeRun ? "Active team" : formatRunSpan(subjectRun)}
                  </span>
                  <span className="shrink-0 text-[11px] text-muted-foreground">
                    {panelSummary(subjectRun)}
                  </span>
                  <span className="flex min-w-0 items-center gap-2 overflow-hidden text-[11px] text-muted-foreground">
                    {subjectRun.members.map((member) => {
                      const preset = colorPresetForMember(member);
                      return (
                        <span
                          key={member.id}
                          className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap"
                        >
                          <span className={cn("size-1.5 rounded-full", preset.dot)} />
                          <span>{member.label}</span>
                        </span>
                      );
                    })}
                  </span>
                </span>
              )}
            </button>

            <button
              type="button"
              aria-label={expanded ? "Collapse agent team panel" : "Expand agent team panel"}
              aria-expanded={expanded}
              onClick={() => setExpanded((current) => !current)}
              className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
            >
              {expanded ? (
                <ChevronUpIcon className="size-3.5" />
              ) : (
                <ChevronDownIcon className="size-3.5" />
              )}
            </button>
          </div>

          {expanded ? (
            <div className="mt-2 space-y-2">
              <p className="text-xs text-muted-foreground">
                {formatRunSpan(subjectRun)}
                {subjectRun.endedAt ? " · shut down" : ""}
              </p>

              {showWarning ? (
                <div className="rounded-xl border border-orange-500/25 bg-orange-500/8 px-3 py-2 text-xs text-orange-800 dark:text-orange-100/90">
                  {capabilityMessage}
                </div>
              ) : null}
            </div>
          ) : null}
        </div>

        {/* Expanded: master-detail layout */}
        {expanded ? (
          <div className="max-h-[500px] overflow-y-auto bg-muted/[0.18] px-3 py-3 sm:px-4">
            <div className="grid gap-0 lg:grid-cols-[200px_minmax(0,1fr)]">
              {/* Left: agent list */}
              <div className="flex gap-1 overflow-x-auto border-b border-border/50 pb-2 lg:max-h-[460px] lg:flex-col lg:gap-0 lg:overflow-x-visible lg:overflow-y-auto lg:border-b-0 lg:border-r lg:pb-0 lg:pr-3">
                {subjectRun.members.map((member) => {
                  const preset = colorPresetForMember(member);
                  const isSelected = selectedMember?.id === member.id;
                  const currentTool = latestToolForMember(member);
                  return (
                    <button
                      key={member.id}
                      type="button"
                      onClick={() => setSelectedMemberId(member.id)}
                      className={cn(
                        "flex shrink-0 flex-col gap-0.5 rounded-lg px-2.5 py-1.5 text-left transition-colors lg:shrink",
                        isSelected
                          ? cn("bg-background", preset.surface)
                          : "hover:bg-background/60",
                      )}
                    >
                      <div className="flex items-center gap-1.5">
                        <span className={cn("size-1.5 shrink-0 rounded-full", preset.dot)} />
                        <span
                          className={cn("truncate text-sm font-medium", preset.accent)}
                        >
                          {member.label}
                        </span>
                        <StatusGlyph status={member.status} />
                      </div>
                      <div className="flex items-center gap-1.5 pl-3 text-[11px] text-muted-foreground">
                        <span>{statusLabel(member.status)}</span>
                        {currentTool ? (
                          <>
                            <span className="text-border">·</span>
                            <span className="truncate">{currentTool}</span>
                          </>
                        ) : null}
                      </div>
                    </button>
                  );
                })}

                {archivedRuns.length > 0 ? (
                  <div className="mt-2 hidden space-y-1 border-t border-border/50 pt-2 lg:block">
                    <p className="px-2.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                      Earlier runs
                    </p>
                    {archivedRuns.map((run) => (
                      <div
                        key={run.id}
                        className="flex items-center justify-between gap-2 px-2.5 py-1"
                      >
                        <span className="truncate text-xs text-foreground">{run.label}</span>
                        <span
                          className={cn(
                            "inline-flex shrink-0 items-center gap-1 text-[11px]",
                            statusTone(run.status),
                          )}
                        >
                          <StatusGlyph status={run.status} />
                        </span>
                      </div>
                    ))}
                  </div>
                ) : null}
              </div>

              {/* Right: selected member detail + activity feed */}
              <div className="min-w-0 pt-3 lg:pl-4 lg:pt-0">
                {selectedMember && selectedMemberPreset ? (
                  <>
                    {/* Identity header */}
                    <div className="flex items-center gap-2">
                      <span
                        className={cn("text-sm font-semibold", selectedMemberPreset.accent)}
                      >
                        {selectedMember.label}
                      </span>
                      <span
                        className={cn(
                          "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px]",
                          statusTone(selectedMember.status),
                        )}
                      >
                        <StatusGlyph status={selectedMember.status} />
                        {statusLabel(selectedMember.status)}
                      </span>
                      <span className="ml-auto text-[11px] text-muted-foreground">
                        {selectedMember.agentType ? `${selectedMember.agentType} · ` : ""}
                        Started {formatRelativeTime(selectedMember.startedAt)}
                        {" · Updated "}
                        {formatRelativeTime(selectedMember.updatedAt)}
                      </span>
                    </div>

                    {/* Current detail */}
                    {selectedMember.detail ? (
                      <p className="mt-1 text-xs text-muted-foreground">
                        {selectedMember.detail}
                      </p>
                    ) : null}

                    {/* Unified activity feed */}
                    <div className="mt-3 max-h-[400px] overflow-y-auto">
                      <div className="relative pl-4">
                        <div className="absolute bottom-1 left-[5px] top-1 w-px bg-border/60" />
                        {unifiedFeed.map((entry) => (
                          <div key={entry.id} className="relative flex gap-2 pb-2">
                            <span
                              className={cn(
                                "absolute left-[-11px] top-1.5 size-1.5 rounded-full",
                                entry.kind === "task" ? "bg-violet-400" : "bg-border",
                              )}
                            />
                            <span className="w-12 shrink-0 text-[11px] tabular-nums text-muted-foreground">
                              {formatRelativeTime(entry.updatedAt)}
                            </span>
                            <div className="min-w-0 flex-1">
                              <span className="text-xs text-foreground">{entry.label}</span>
                              {entry.lastToolName ? (
                                <span className="ml-1.5 text-[11px] text-muted-foreground">
                                  [{entry.lastToolName}]
                                </span>
                              ) : null}
                              {entry.kind === "task" && entry.status ? (
                                <span className="ml-1.5 text-[11px] text-muted-foreground">
                                  ({entry.status})
                                </span>
                              ) : null}
                              {entry.detail ? (
                                <p className="truncate text-[11px] text-muted-foreground">
                                  {entry.detail}
                                </p>
                              ) : null}
                            </div>
                          </div>
                        ))}
                        {unifiedFeed.length === 0 ? (
                          <p className="pl-2 text-xs text-muted-foreground">
                            No activity recorded yet.
                          </p>
                        ) : null}
                      </div>
                    </div>
                  </>
                ) : (
                  <div className="py-4 text-sm text-muted-foreground">
                    Select a teammate to view activity.
                  </div>
                )}
              </div>
            </div>
          </div>
        ) : null}
      </div>
    </section>
  );
}
