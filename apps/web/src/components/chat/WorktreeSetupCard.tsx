import { toServerClock } from "@t3tools/client-runtime/clock";
import type { EnvironmentId, WorktreeSetupSnapshot, WorktreeSetupStage } from "@t3tools/contracts";
import { formatDuration } from "@t3tools/shared/orchestrationTimingCopy";
import { msg, T, useGT, useMessages } from "gt-react";
import {
  BrainIcon,
  FolderGit2Icon,
  GitBranchIcon,
  PackageIcon,
  TerminalIcon,
  XIcon,
} from "lucide-react";
import { useState, type KeyboardEvent, type ReactNode } from "react";

import { InlineButton } from "~/components/ui/button";
import { useNowSecond } from "~/hooks/useNowSecond";
import type { MessageResolver } from "~/i18n/messages";
import { cn } from "~/lib/utils";
import { observeVisibleAnimation } from "~/lib/visibleAnimation";
import { ActivityShimmerOverlay } from "./TimelineRowParts";
import { failedToolIconClassName } from "./TimelineToolActivityIcon";
import { formatWorkingTimer } from "./TimelineWorkGroupRows.logic";
import { WORK_LOG_OUTPUT_CLASS_NAME, WorkLogDetails, WorkLogRow } from "./WorkLog";

function elapsed(startedAt: string | null, endMs: number, resolve: MessageResolver): string | null {
  if (!startedAt) return null;
  const ms = endMs - Date.parse(startedAt);
  return Number.isFinite(ms) ? formatDuration(Math.max(0, ms), resolve) : null;
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
  const m = useMessages();
  if (!startedAt) return null;
  const text = endedAt ? (
    elapsed(startedAt, Date.parse(endedAt), m)
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

function stageLabel(
  stage: WorktreeSetupStage,
  snapshot: WorktreeSetupSnapshot,
  resolve: MessageResolver,
): string {
  const tense = stopped(stage, snapshot)
    ? "stopped"
    : stage.status === "running"
      ? "running"
      : stage.status === "failed"
        ? "failed"
        : "done";
  const baseRef = snapshot.baseRef;
  const branch = snapshot.branch;
  const script = snapshot.setupScript?.name;
  switch (stage.id) {
    case "fetch":
      return baseRef
        ? resolve(
            msg(
              "{tense, select, running {Fetching {ref}} failed {Couldn't fetch {ref}} stopped {Stopped fetching {ref}} other {Fetched {ref}}}",
              { tense, ref: baseRef },
            ),
          )
        : resolve(
            msg(
              "{tense, select, running {Fetching base branch} failed {Couldn't fetch base branch} stopped {Stopped fetching base branch} other {Fetched base branch}}",
              { tense },
            ),
          );
    case "checkout":
      return branch
        ? resolve(
            msg(
              "{tense, select, running {Checking out {branch}} failed {Couldn't check out {branch}} stopped {Stopped checking out {branch}} other {Checked out {branch}}}",
              { tense, branch },
            ),
          )
        : resolve(
            msg(
              "{tense, select, running {Checking out files} failed {Couldn't check out files} stopped {Stopped checking out files} other {Checked out files}}",
              { tense },
            ),
          );
    case "submodules":
      return resolve(
        msg(
          "{tense, select, running {Initializing submodules} failed {Couldn't initialize submodules} stopped {Stopped initializing submodules} other {Initialized submodules}}",
          { tense },
        ),
      );
    case "setup-script":
      return script
        ? resolve(
            msg(
              "{tense, select, running {Running {script}} failed {Failed {script}} stopped {Stopped running {script}} other {Ran {script}}}",
              { tense, script },
            ),
          )
        : resolve(
            msg(
              "{tense, select, running {Running setup script} failed {Failed setup script} stopped {Stopped running setup script} other {Ran setup script}}",
              { tense },
            ),
          );
    case "agent":
      return tense === "stopped"
        ? resolve(msg("Stopped starting agent"))
        : resolve(msg("Starting agent"));
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
  const gt = useGT();
  const [expanded, setExpanded] = useState(false);
  const details =
    children ?? (body ? <pre className={WORK_LOG_OUTPUT_CLASS_NAME}>{body}</pre> : null);
  const toggle = () => setExpanded((open) => !open);
  const toggleProps = details
    ? {
        role: "button" as const,
        tabIndex: 0 as const,
        "aria-label": failed ? gt("{label}, setup step failed", { label }) : label,
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
  const m = useMessages();
  const icon = STAGE_ICONS[stage.id];
  const label = stageLabel(stage, snapshot, m);
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
        <T>Open terminal</T>
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
  const gt = useGT();
  const stages = snapshot.stages.filter((stage) => shownStage(stage, snapshot));
  const clean = snapshot.phase === "done" && !stages.some((stage) => stage.status === "failed");
  const agent = snapshot.stages.find((stage) => stage.id === "agent");
  const starting =
    snapshot.phase === "running" || snapshot.phase === "done"
      ? (startingLabel ?? (agent?.status === "running" ? gt("Starting agent") : null))
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
      aria-label={gt("Worktree setup")}
      data-worktree-setup-phase={snapshot.phase}
      className="flex min-w-0 flex-col gap-1"
    >
      {clean ? (
        <SettledRow
          data-worktree-setup-stage="summary"
          icon={FolderGit2Icon}
          label={
            snapshot.branch
              ? gt("Set up worktree {branch}", { branch: snapshot.branch })
              : gt("Set up worktree")
          }
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
