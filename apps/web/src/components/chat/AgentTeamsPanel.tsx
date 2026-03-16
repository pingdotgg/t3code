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
  AgentTeamsMember,
  AgentTeamsRun,
  AgentTeamsState,
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
    const direct = FALLBACK_TEAM_COLORS.find((preset) => preset.accent.includes(rawColor));
    if (direct) {
      return direct;
    }
    if (rawColor.includes("purple") || rawColor.includes("violet")) {
      return FALLBACK_TEAM_COLORS[4];
    }
    if (rawColor.includes("pink") || rawColor.includes("fuchsia")) {
      return FALLBACK_TEAM_COLORS[5];
    }
    if (rawColor.includes("blue") || rawColor.includes("sky")) {
      return FALLBACK_TEAM_COLORS[3];
    }
    if (rawColor.includes("green") || rawColor.includes("emerald")) {
      return FALLBACK_TEAM_COLORS[2];
    }
    if (rawColor.includes("orange") || rawColor.includes("amber")) {
      return FALLBACK_TEAM_COLORS[1];
    }
    if (rawColor.includes("red") || rawColor.includes("rose")) {
      return FALLBACK_TEAM_COLORS[0];
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

function formatRunSpan(run: AgentTeamsRun): string {
  if (!run.endedAt) {
    return `Started ${formatTimestamp(run.startedAt)}`;
  }
  return `${formatTimestamp(run.startedAt)} to ${formatTimestamp(run.endedAt)}`;
}

function panelSummary(run: AgentTeamsRun): string {
  const idleMembers = run.members.filter((member) => member.status === "idle").length;
  const activeMembers = run.members.filter(
    (member) =>
      member.status === "running" ||
      member.status === "idle" ||
      member.status === "awaitingApproval",
  ).length;
  return `${run.members.length} agent${run.members.length === 1 ? "" : "s"} • ${activeMembers} active${idleMembers > 0 ? ` • ${idleMembers} idle` : ""}`;
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
            <div className="mt-3 space-y-3">
              <p className="text-xs text-muted-foreground">
                {formatRunSpan(subjectRun)}
                {subjectRun.endedAt ? " • shut down" : ""}
              </p>

              {showWarning ? (
                <div className="rounded-xl border border-orange-500/25 bg-orange-500/8 px-3 py-2 text-xs text-orange-800 dark:text-orange-100/90">
                  {capabilityMessage}
                </div>
              ) : null}

              <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
                {subjectRun.members.map((member) => {
                  const preset = colorPresetForMember(member);
                  const isSelected = selectedMember?.id === member.id;
                  return (
                    <button
                      key={member.id}
                      type="button"
                      onClick={() => {
                        setSelectedMemberId(member.id);
                        setExpanded(true);
                      }}
                      className={cn(
                        "flex min-w-0 flex-col gap-2 rounded-xl border px-3 py-2 text-left transition-colors",
                        preset.border,
                        isSelected
                          ? cn("bg-background", preset.surface)
                          : "bg-background/70 hover:bg-background",
                      )}
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="flex items-center gap-2">
                            <span className={cn("size-2 rounded-full", preset.dot)} />
                            <span className={cn("truncate text-sm font-medium", preset.accent)}>
                              {member.label}
                            </span>
                          </div>
                          <p className="mt-1 truncate text-[11px] text-muted-foreground">
                            {member.agentType ?? member.teamName ?? "Teammate"}
                          </p>
                        </div>
                        <span
                          className={cn(
                            "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px]",
                            statusTone(member.status),
                          )}
                        >
                          <StatusGlyph status={member.status} />
                          {statusLabel(member.status)}
                        </span>
                      </div>
                      <p className="line-clamp-2 text-xs text-muted-foreground">
                        {member.detail ?? "Claude has not published a detailed update yet."}
                      </p>
                    </button>
                  );
                })}
              </div>
            </div>
          ) : null}
        </div>

        {expanded ? (
          <div className="bg-muted/[0.18] px-3 py-3 sm:px-4">
            {selectedMember ? (
              <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_220px]">
                <div className="min-w-0 rounded-xl border border-border bg-card/70 p-3">
                  <div className="flex flex-col gap-4">
                    <div className="space-y-2">
                      <div className="flex flex-wrap items-center gap-2">
                        <p
                          className={cn(
                            "text-base font-semibold",
                            selectedMemberPreset ? selectedMemberPreset.accent : undefined,
                          )}
                        >
                          {selectedMember.label}
                        </p>
                        <span
                          className={cn(
                            "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px]",
                            statusTone(selectedMember.status),
                          )}
                        >
                          <StatusGlyph status={selectedMember.status} />
                          {statusLabel(selectedMember.status)}
                        </span>
                      </div>
                      <p className="text-xs text-muted-foreground">
                        {selectedMember.agentType ? `${selectedMember.agentType} • ` : ""}
                        {selectedMember.teamName ?? subjectRun.label}
                      </p>
                      <p className="text-sm text-foreground">
                        {selectedMember.detail ??
                          "Claude has not published a detailed update for this teammate yet."}
                      </p>
                    </div>

                    <div className="grid gap-2 text-xs text-muted-foreground sm:grid-cols-2">
                      <div className="rounded-lg border border-border bg-background/80 px-3 py-2">
                        <span className="block text-[11px]">Started</span>
                        <span className="text-foreground">
                          {formatTimestamp(selectedMember.startedAt)}
                        </span>
                      </div>
                      <div className="rounded-lg border border-border bg-background/80 px-3 py-2">
                        <span className="block text-[11px]">Last update</span>
                        <span className="text-foreground">
                          {formatTimestamp(selectedMember.updatedAt)}
                        </span>
                      </div>
                    </div>

                    <div className="space-y-2">
                      <p className="text-sm font-medium text-foreground">Activity</p>
                      <div className="max-h-80 space-y-2 overflow-y-auto pr-1">
                        {selectedMember.activities
                          .toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt))
                          .map((activity) => (
                            <div
                              key={activity.id}
                              className="rounded-lg border border-border bg-background/75 px-3 py-2"
                            >
                              <div className="flex flex-wrap items-center justify-between gap-2">
                                <p className="text-sm text-foreground">{activity.label}</p>
                                <span className="text-[11px] text-muted-foreground">
                                  {formatTimestamp(activity.updatedAt)}
                                </span>
                              </div>
                              <p className="mt-1 text-xs text-muted-foreground">
                                {activity.detail ?? "No extra detail from Claude for this step."}
                              </p>
                            </div>
                          ))}
                      </div>
                    </div>

                    {subjectRun.tasks && subjectRun.tasks.length > 0 ? (
                      <div className="space-y-2">
                        <p className="text-sm font-medium text-foreground">Claude task history</p>
                        <div className="space-y-2">
                          {subjectRun.tasks.map((task) => (
                            <div
                              key={`${
                                selectedMember.id
                              }:task:${task.taskId ?? task.summary ?? task.updatedAt ?? task.teammateName ?? "task"}`}
                              className="rounded-lg border border-border bg-background/75 px-3 py-2"
                            >
                              <div className="flex flex-wrap items-center justify-between gap-2">
                                <p className="text-sm text-foreground">
                                  {task.summary ?? task.taskId ?? "Task"}
                                </p>
                                {task.status ? (
                                  <span className="text-[11px] text-muted-foreground">
                                    {task.status}
                                  </span>
                                ) : null}
                              </div>
                              <p className="mt-1 text-xs text-muted-foreground">
                                {[
                                  task.teammateName,
                                  task.updatedAt ? formatTimestamp(task.updatedAt) : null,
                                ]
                                  .filter(Boolean)
                                  .join(" • ")}
                              </p>
                            </div>
                          ))}
                        </div>
                      </div>
                    ) : null}
                  </div>
                </div>

                <aside className="space-y-2 rounded-xl border border-border bg-card/60 p-3">
                  <p className="text-sm font-medium text-foreground">Team snapshot</p>
                  <div className="space-y-2">
                    {subjectRun.members.map((member) => {
                      const preset = colorPresetForMember(member);
                      return (
                        <button
                          key={member.id}
                          type="button"
                          onClick={() => setSelectedMemberId(member.id)}
                          className={cn(
                            "flex w-full items-center justify-between gap-2 rounded-xl border px-3 py-2 text-left transition-colors",
                            preset.border,
                            selectedMember.id === member.id
                              ? cn("bg-background", preset.surface)
                              : "bg-background/70 hover:bg-background",
                          )}
                        >
                          <span className="flex min-w-0 items-center gap-2">
                            <span className={cn("size-2 rounded-full", preset.dot)} />
                            <span className={cn("truncate text-sm font-medium", preset.accent)}>
                              {member.label}
                            </span>
                          </span>
                          <span
                            className={cn(
                              "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px]",
                              statusTone(member.status),
                            )}
                          >
                            <StatusGlyph status={member.status} />
                            {statusLabel(member.status)}
                          </span>
                        </button>
                      );
                    })}
                  </div>

                  {archivedRuns.length > 0 ? (
                    <div className="space-y-2 border-t border-border/70 pt-3">
                      <p className="text-sm font-medium text-foreground">Earlier runs</p>
                      <div className="space-y-2">
                        {archivedRuns.map((run) => (
                          <div
                            key={run.id}
                            className="rounded-xl border border-border bg-background/70 px-3 py-2"
                          >
                            <div className="flex items-center justify-between gap-2">
                              <p className="truncate text-sm text-foreground">{run.label}</p>
                              <span
                                className={cn(
                                  "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px]",
                                  statusTone(run.status),
                                )}
                              >
                                <StatusGlyph status={run.status} />
                                {statusLabel(run.status)}
                              </span>
                            </div>
                            <p className="mt-1 text-[11px] text-muted-foreground">
                              {formatRunSpan(run)}
                            </p>
                          </div>
                        ))}
                      </div>
                    </div>
                  ) : null}
                </aside>
              </div>
            ) : (
              <div className="rounded-lg border border-dashed border-border bg-background/70 px-3 py-4 text-sm text-muted-foreground">
                Select a teammate to inspect their current work.
              </div>
            )}
          </div>
        ) : null}
      </div>
    </section>
  );
}
