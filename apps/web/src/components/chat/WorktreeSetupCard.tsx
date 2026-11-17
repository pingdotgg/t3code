import { toServerClock } from "@t3tools/client-runtime/clock";
import type {
  BoatCloudStartStep,
  BoatCloudStepProgress,
  EnvironmentId,
  WorktreeSetupSnapshot,
  WorktreeSetupStage,
} from "@t3tools/contracts";
import { formatDuration } from "@t3tools/shared/orchestrationTiming";
import {
  BrainIcon,
  CloudIcon,
  FolderGit2Icon,
  GitBranchIcon,
  PackageIcon,
  PlugIcon,
  ServerIcon,
  TerminalIcon,
  XIcon,
} from "lucide-react";
import { useState, type KeyboardEvent, type ReactNode } from "react";

import { InlineButton } from "~/components/ui/button";
import { useNowSecond } from "~/hooks/useNowSecond";
import { cn } from "~/lib/utils";
import { observeVisibleAnimation } from "~/lib/visibleAnimation";
import { ActivityShimmerOverlay } from "./TimelineRowParts";
import { failedToolIconClassName } from "./TimelineToolActivityIcon";
import { formatWorkingTimer } from "./TimelineWorkGroupRows.logic";
import { WORK_LOG_OUTPUT_CLASS_NAME, WorkLogDetails, WorkLogRow } from "./WorkLog";

function elapsed(startedAt: string | null, endMs: number): string | null {
  if (!startedAt) return null;
  const ms = endMs - Date.parse(startedAt);
  return Number.isFinite(ms) ? formatDuration(Math.max(0, ms)) : null;
}

/**
 * Mounted only while a stage runs, so finished rows never subscribe to the tick.
 * It counts on the host's clock, like the working line.
 */
function LiveElapsed({
  startedAt,
  environmentId,
}: {
  startedAt: string;
  environmentId: EnvironmentId | undefined;
}) {
  const now = useNowSecond();
  const hostNow = environmentId ? toServerClock(environmentId, now) : now;
  return <>{formatWorkingTimer(startedAt, new Date(hostNow).toISOString())}</>;
}

function Elapsed({
  startedAt,
  endedAt,
  environmentId,
}: {
  startedAt: string | null;
  endedAt: string | null;
  environmentId: EnvironmentId | undefined;
}) {
  if (!startedAt) return null;
  const text = endedAt ? (
    elapsed(startedAt, Date.parse(endedAt))
  ) : (
    <LiveElapsed startedAt={startedAt} environmentId={environmentId} />
  );
  return <span className="shrink-0 text-meta text-dim-foreground tabular-nums">{text}</span>;
}

const STAGE_ICONS = {
  fetch: GitBranchIcon,
  checkout: GitBranchIcon,
  submodules: PackageIcon,
  "setup-script": TerminalIcon,
  agent: BrainIcon,
} satisfies Record<WorktreeSetupStage["id"], typeof GitBranchIcon>;

/** A stage that started and then was cancelled. */
const stopped = (stage: WorktreeSetupStage, snapshot: WorktreeSetupSnapshot) =>
  snapshot.phase === "cancelled" &&
  stage.status === "skipped" &&
  stage.startedAt !== null &&
  stage.endedAt === snapshot.endedAt;

function stageLabel(stage: WorktreeSetupStage, snapshot: WorktreeSetupSnapshot): string {
  if (stopped(stage, snapshot)) {
    const running = stageLabel({ ...stage, status: "running" }, snapshot);
    return `Stopped ${running.charAt(0).toLowerCase()}${running.slice(1)}`;
  }
  const tense = stage.status === "running" ? 0 : stage.status === "failed" ? 2 : 1;
  const script = snapshot.setupScript?.name ?? "setup script";
  switch (stage.id) {
    case "fetch":
      return `${["Fetching", "Fetched", "Couldn't fetch"][tense]} ${snapshot.baseRef ?? "base branch"}`;
    case "checkout":
      return `${["Checking out", "Checked out", "Couldn't check out"][tense]} ${snapshot.branch ?? "files"}`;
    case "submodules":
      return `${["Initializing", "Initialized", "Couldn't initialize"][tense]} submodules`;
    case "setup-script":
      return `${["Running", "Ran", "Failed"][tense]} ${script}`;
    case "agent":
      return "Starting agent";
  }
}

/** What opening a finished row shows, as a command row shows its command and output. */
function stageBody(stage: WorktreeSetupStage, snapshot: WorktreeSetupSnapshot): string | null {
  const blocks =
    stage.id === "setup-script"
      ? [snapshot.setupScript?.command, stage.tail.join("\n"), stage.detail]
      : [stage.detail, stage.status === "failed" ? snapshot.error : null];
  const text = blocks
    .map((block) => block?.trim())
    .filter(Boolean)
    .join("\n\n");
  return text.length > 0 ? text : null;
}

const iconClassName = "block size-3.5 shrink-0 stroke-2";

function RowIcon({ icon: Icon, tone }: { icon: typeof GitBranchIcon; tone: string }) {
  return (
    <span className={cn("flex size-3.5 items-center justify-center", tone)}>
      <Icon aria-hidden className={iconClassName} />
    </span>
  );
}

/** A running stage, drawn like a running tool call: shimmering, with no disclosure. */
function LiveStageRow({
  icon,
  label,
  trailing,
}: {
  icon: typeof GitBranchIcon;
  label: string;
  trailing?: ReactNode;
}) {
  const row = (highlighted: boolean) => (
    <WorkLogRow
      icon={<RowIcon icon={icon} tone={highlighted ? "text-foreground" : "text-dim-foreground"} />}
      label={
        <span className={cn("block truncate", highlighted && "text-foreground")}>{label}</span>
      }
      trailing={
        highlighted ? (
          <span className="invisible flex items-center gap-1.5">{trailing}</span>
        ) : (
          trailing
        )
      }
    />
  );
  return (
    <div
      ref={observeVisibleAnimation}
      className="relative min-h-6 w-full min-w-0 overflow-hidden rounded-md"
    >
      {row(false)}
      <ActivityShimmerOverlay>{row(true)}</ActivityShimmerOverlay>
    </div>
  );
}

/** A finished row, drawn like a finished tool call: opens to its output when it has any. */
function SettledRow({
  icon,
  label,
  failed = false,
  warning = false,
  trailing,
  body,
  children,
  ...dataProps
}: {
  icon: typeof GitBranchIcon;
  label: string;
  failed?: boolean;
  warning?: boolean;
  trailing?: ReactNode;
  body?: string | null;
  children?: ReactNode;
  "data-worktree-setup-stage"?: string;
  "data-worktree-setup-status"?: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const details =
    children ?? (body ? <pre className={WORK_LOG_OUTPUT_CLASS_NAME}>{body}</pre> : null);
  const toggle = () => setExpanded((open) => !open);
  const toggleProps = details
    ? {
        role: "button" as const,
        tabIndex: 0 as const,
        "aria-label": failed ? `${label}, setup step failed` : label,
        "aria-expanded": expanded,
        onClick: toggle,
        onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => {
          if (
            event.target === event.currentTarget &&
            (event.key === "Enter" || event.key === " ")
          ) {
            event.preventDefault();
            toggle();
          }
        },
      }
    : {};
  return (
    <WorkLogRow
      {...dataProps}
      {...toggleProps}
      icon={
        <RowIcon
          icon={icon}
          tone={
            failed
              ? failedToolIconClassName
              : warning
                ? "text-warning-foreground"
                : "text-dim-foreground"
          }
        />
      }
      label={
        <div className="min-w-0 flex-1 overflow-hidden">
          <p className="flex min-w-0 w-full items-baseline gap-1.25 text-body">
            <span className="min-w-0 flex-1 truncate text-secondary-label">{label}</span>
          </p>
        </div>
      }
      trailing={
        <>
          {trailing}
          {failed ? (
            <XIcon aria-hidden className={cn("size-3 shrink-0", failedToolIconClassName)} />
          ) : null}
          {details ? <span aria-hidden className="size-3 shrink-0" /> : null}
        </>
      }
    >
      {expanded && details ? <WorkLogDetails kind="panel">{details}</WorkLogDetails> : null}
    </WorkLogRow>
  );
}

function StageRow({
  environmentId,
  stage,
  snapshot,
  onOpenTerminal,
}: {
  environmentId: EnvironmentId | undefined;
  stage: WorktreeSetupStage;
  snapshot: WorktreeSetupSnapshot;
  onOpenTerminal: (() => void) | null;
}) {
  const icon = STAGE_ICONS[stage.id];
  const label = stageLabel(stage, snapshot);
  const terminal =
    stage.id === "setup-script" && onOpenTerminal ? (
      <InlineButton
        tone="ghost"
        onClick={(event) => {
          event.stopPropagation();
          onOpenTerminal();
        }}
        onKeyDown={(event) => event.stopPropagation()}
      >
        Open terminal
      </InlineButton>
    ) : null;
  if (stage.status === "running" && snapshot.phase === "running") {
    return (
      <div data-worktree-setup-stage={stage.id} data-worktree-setup-status={stage.status}>
        <LiveStageRow
          icon={icon}
          label={label}
          trailing={
            <>
              {stage.percent !== null ? (
                <span className="shrink-0 text-meta text-dim-foreground tabular-nums">
                  {stage.percent}%
                </span>
              ) : null}
              {terminal}
              <Elapsed startedAt={stage.startedAt} endedAt={null} environmentId={environmentId} />
            </>
          }
        />
      </div>
    );
  }
  return (
    <SettledRow
      data-worktree-setup-stage={stage.id}
      data-worktree-setup-status={stage.status}
      icon={icon}
      label={label}
      failed={stage.status === "failed"}
      warning={stage.status === "warning"}
      body={stageBody(stage, snapshot)}
      trailing={
        <>
          {terminal}
          <Elapsed
            startedAt={stage.startedAt}
            endedAt={stage.endedAt ?? snapshot.endedAt}
            environmentId={environmentId}
          />
        </>
      }
    />
  );
}

const shownStage = (stage: WorktreeSetupStage, snapshot: WorktreeSetupSnapshot) =>
  stage.id !== "agent" &&
  stage.status !== "pending" &&
  (stage.status !== "skipped" || stopped(stage, snapshot));

/**
 * Worktree setup as work rows, the way tool calls sit under "Working for". Stages appear as
 * they start; a setup that finished cleanly folds to one row that opens again on click.
 */
export function WorktreeSetupRows({
  environmentId,
  snapshot,
  startingLabel = null,
  onOpenTerminal,
}: {
  /** The thread's environment, whose clock live timers count on. */
  environmentId?: EnvironmentId | undefined;
  snapshot: WorktreeSetupSnapshot;
  /** The provider still launching after setup, shown as the turn's live row. */
  startingLabel?: string | null;
  onOpenTerminal: (() => void) | null;
}) {
  const stages = snapshot.stages.filter((stage) => shownStage(stage, snapshot));
  const clean = snapshot.phase === "done" && !stages.some((stage) => stage.status === "failed");
  const agent = snapshot.stages.find((stage) => stage.id === "agent");
  const starting =
    snapshot.phase === "running" || snapshot.phase === "done"
      ? (startingLabel ?? (agent?.status === "running" ? "Starting agent" : null))
      : null;
  const stageRows = stages.map((stage) => (
    <StageRow
      key={stage.id}
      environmentId={environmentId}
      stage={stage}
      snapshot={snapshot}
      onOpenTerminal={onOpenTerminal}
    />
  ));
  return (
    <section
      aria-label="Worktree setup"
      data-worktree-setup-phase={snapshot.phase}
      className="flex min-w-0 flex-col gap-1"
    >
      {clean ? (
        <SettledRow
          data-worktree-setup-stage="summary"
          icon={FolderGit2Icon}
          label={snapshot.branch ? `Set up worktree ${snapshot.branch}` : "Set up worktree"}
          trailing={
            <Elapsed
              startedAt={snapshot.startedAt}
              endedAt={snapshot.endedAt}
              environmentId={environmentId}
            />
          }
        >
          {stageRows.length > 0 ? (
            <div className="flex min-w-0 flex-col gap-1">{stageRows}</div>
          ) : null}
        </SettledRow>
      ) : (
        stageRows
      )}
      {starting ? <LiveStageRow icon={BrainIcon} label={starting} /> : null}
    </section>
  );
}

/** A Boat cloud start as the thread shows it while its first message waits. */
export interface BoatCloudStartRowsState {
  readonly steps: ReadonlyArray<BoatCloudStepProgress>;
  /** `owner/repo`, for the checkout step. */
  readonly repository: string | null;
  /** A stopped VM turning back on rather than a new start. */
  readonly waking?: boolean;
}

const BOAT_CLOUD_STEP_ICONS = {
  machine: CloudIcon,
  server: ServerIcon,
  repository: GitBranchIcon,
  connect: PlugIcon,
  project: FolderGit2Icon,
  thread: BrainIcon,
} satisfies Record<BoatCloudStartStep, typeof GitBranchIcon>;

/** Running, done and failed labels per step. */
const BOAT_CLOUD_STEP_LABELS = {
  machine: ["Starting a VM", "Started a VM", "Couldn't start a VM"],
  server: [
    "Starting T3 Code on the VM",
    "Started T3 Code on the VM",
    "Couldn't start T3 Code on the VM",
  ],
  repository: ["Checking out", "Checked out", "Couldn't check out"],
  connect: ["Connecting to the VM", "Connected to the VM", "Couldn't connect to the VM"],
  project: ["Opening the project", "Opened the project", "Couldn't open the project"],
  thread: ["Starting agent", "Started agent", "Couldn't start agent"],
} satisfies Record<BoatCloudStartStep, readonly [string, string, string]>;

const WAKING_MACHINE_LABELS = ["Waking the VM", "Woke the VM", "Couldn't wake the VM"] as const;

function boatCloudStepLabel(
  entry: BoatCloudStepProgress,
  repository: string | null,
  waking: boolean,
): string {
  const [running, done, failed] =
    waking && entry.step === "machine" ? WAKING_MACHINE_LABELS : BOAT_CLOUD_STEP_LABELS[entry.step];
  const label = entry.state === "failed" ? failed : entry.state === "done" ? done : running;
  return entry.step === "repository" ? `${label} ${repository ?? "the repository"}` : label;
}

/** The Boat cloud steps still left when the first message was sent, as setup rows that appear as they start. */
export function BoatCloudStartRows({ steps, repository, waking = false }: BoatCloudStartRowsState) {
  return (
    <section aria-label="Boat cloud start" className="flex min-w-0 flex-col gap-1">
      {steps.map((entry) => {
        const icon = BOAT_CLOUD_STEP_ICONS[entry.step];
        const label = boatCloudStepLabel(entry, repository, waking);
        return entry.state === "active" ? (
          <div key={entry.step} data-boat-cloud-step={entry.step}>
            <LiveStageRow icon={icon} label={label} />
          </div>
        ) : (
          <SettledRow
            key={entry.step}
            icon={icon}
            label={label}
            failed={entry.state === "failed"}
            body={entry.step === "repository" ? null : entry.detail}
          />
        );
      })}
    </section>
  );
}
