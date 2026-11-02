import type { ScopedThreadRef } from "@t3tools/contracts";
import {
  CheckIcon,
  CircleAlertIcon,
  CircleCheckIcon,
  CircleDotIcon,
  CircleIcon,
  CircleXIcon,
  ClockIcon,
  XIcon,
} from "lucide-react";
import { useState, type ReactNode } from "react";

import { useTheme } from "~/hooks/useTheme";
import { cn } from "~/lib/utils";
import { useQuietThreadVisibleTurnItems } from "~/state/entities";
import { RelativeTime } from "../RelativeTime";
import { CollapsibleSectionHeader } from "../ui/collapsible-section-header";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../ui/empty";
import { ScrollArea } from "../ui/scroll-area";
import {
  deriveActivitySummary,
  isActivityItem,
  type ActivityFolder,
  type ActivityPlan,
  type ActivitySummary,
} from "./activityPanel.logic";
import { PierreEntryIcon } from "./PierreEntryIcon";

const VISIBLE_DONE_STEPS = 8;
const ROW_CLASS = "flex items-start gap-2 rounded-md px-2 py-1 text-left text-sm";

function plural(count: number, noun: string) {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function Section(props: {
  title: string;
  count: ReactNode;
  defaultExpanded?: boolean;
  children: ReactNode;
}) {
  const [expanded, setExpanded] = useState(props.defaultExpanded ?? true);
  return (
    <section>
      <CollapsibleSectionHeader
        variant="panel"
        expanded={expanded}
        onClick={() => setExpanded(!expanded)}
        accessory={
          <span className="shrink-0 text-2xs font-normal tabular-nums">{props.count}</span>
        }
      >
        {props.title}
      </CollapsibleSectionHeader>
      {expanded ? <div className="px-1 pb-2">{props.children}</div> : null}
    </section>
  );
}

/** The one answer the panel exists for: where is the agent, and does it need me? */
function StatusBanner(props: { summary: ActivitySummary }) {
  const { summary } = props;
  const { phase, plan, touchedTotals, failedCount } = summary;

  let Icon = CircleCheckIcon;
  let iconClass = "text-success";
  let title = "Finished";
  const details: string[] = [];
  if (phase === "waiting") {
    Icon = ClockIcon;
    iconClass = "text-warning";
    title = summary.now ?? "Waiting for you";
    details.push("Paused until you respond");
  } else if (phase === "running") {
    Icon = CircleDotIcon;
    iconClass = "text-primary";
    title = summary.now ?? "Working";
    if (plan)
      details.push(
        `Step ${Math.min(plan.completed + 1, plan.steps.length)} of ${plan.steps.length}`,
      );
  } else if (summary.outcome === "failed") {
    Icon = CircleXIcon;
    iconClass = "text-destructive-foreground";
    title = "Finished with errors";
    details.push(`${plural(failedCount, "step")} failed`);
    if (plan) details.push(`${plan.completed} of ${plural(plan.steps.length, "step")}`);
    if (touchedTotals.files > 0) details.push(`${plural(touchedTotals.files, "file")} changed`);
  } else {
    if (summary.outcome === "incomplete" && plan) {
      Icon = CircleAlertIcon;
      iconClass = "text-warning";
      title = "Stopped with steps left";
      details.push(`${plan.completed} of ${plural(plan.steps.length, "step")} done`);
    } else if (plan) {
      details.push(`${plan.completed} of ${plural(plan.steps.length, "step")}`);
    }
    if (touchedTotals.files > 0) details.push(`${plural(touchedTotals.files, "file")} changed`);
  }

  return (
    <div
      role="status"
      data-phase={phase}
      className={cn(
        "flex items-start gap-2.5 border-b px-3 py-3",
        phase === "waiting" && "bg-warning/8",
      )}
    >
      <Icon aria-hidden className={cn("mt-0.5 size-4 shrink-0", iconClass)} />
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="line-clamp-2 break-words text-sm font-medium">{title}</span>
        <span className="text-xs text-muted-foreground">
          {details.join(" · ")}
          {summary.lastActivityAt ? (
            <>
              {details.length > 0 ? " · " : null}
              Updated <RelativeTime timestamp={summary.lastActivityAt} />
            </>
          ) : null}
        </span>
      </div>
    </div>
  );
}

function PlanSection(props: { plan: ActivityPlan }) {
  const { steps, completed } = props.plan;
  const complete = steps.length > 0 && completed === steps.length;
  return (
    <Section
      title="Plan"
      count={`${completed} of ${steps.length}`}
      // A finished plan is already summarised by the banner; keep its steps one click away.
      defaultExpanded={!complete}
    >
      <div
        role="progressbar"
        aria-label="Plan progress"
        aria-valuemin={0}
        aria-valuemax={steps.length}
        aria-valuenow={completed}
        aria-valuetext={`${completed} of ${plural(steps.length, "step")}`}
        className="mx-2 mb-1.5 h-1 overflow-hidden rounded-full bg-border"
      >
        <div
          className={cn("h-full rounded-full", complete ? "bg-success" : "bg-primary")}
          style={{ width: `${steps.length === 0 ? 0 : (completed / steps.length) * 100}%` }}
        />
      </div>
      <ol>
        {steps.map((step) => (
          <li
            key={step.id}
            className={cn(
              ROW_CLASS,
              step.status === "running" ? "font-medium" : "text-muted-foreground",
            )}
          >
            {step.status === "completed" ? (
              <CheckIcon aria-label="Done" className="mt-0.5 size-3.5 shrink-0" />
            ) : step.status === "running" ? (
              <CircleDotIcon
                aria-label="In progress"
                className="mt-0.5 size-3.5 shrink-0 text-primary"
              />
            ) : (
              <CircleIcon aria-label="Not started" className="mt-0.5 size-3.5 shrink-0" />
            )}
            <span className="min-w-0 break-words">{step.text}</span>
          </li>
        ))}
      </ol>
    </Section>
  );
}

function DoneSection(props: { summary: ActivitySummary }) {
  const [showAll, setShowAll] = useState(false);
  const { done } = props.summary;
  if (done.length === 0) return null;
  const hidden = showAll ? 0 : Math.max(0, done.length - VISIBLE_DONE_STEPS);
  return (
    <Section
      title="Done this turn"
      count={String(done.length)}
      // With a plan the same progress is already above; the log is for looking things up.
      defaultExpanded={props.summary.plan === null}
    >
      <ol>
        {hidden > 0 ? (
          <li>
            <button
              type="button"
              onClick={() => setShowAll(true)}
              className={cn(
                ROW_CLASS,
                "w-full cursor-pointer text-2xs text-muted-foreground hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70",
              )}
            >
              Show {hidden} earlier {hidden === 1 ? "step" : "steps"}
            </button>
          </li>
        ) : null}
        {done.slice(hidden).map((step) => (
          <li
            key={step.id}
            className={cn(ROW_CLASS, step.failed ? "text-destructive-foreground" : undefined)}
          >
            {step.failed ? (
              <XIcon aria-label="Failed" className="mt-0.5 size-3.5 shrink-0" />
            ) : (
              <CheckIcon
                aria-label="Done"
                className="mt-0.5 size-3.5 shrink-0 text-muted-foreground"
              />
            )}
            <span className="min-w-0 break-words">{step.label}</span>
          </li>
        ))}
      </ol>
    </Section>
  );
}

function TouchedSection(props: {
  summary: ActivitySummary;
  onOpenFile: (relativePath: string) => void;
}) {
  const { resolvedTheme } = useTheme();
  const { touched, touchedTotals } = props.summary;
  if (touched.length === 0) return null;
  return (
    <Section
      title="Files touched"
      count={
        <>
          {touchedTotals.files}
          {touchedTotals.additions === null && touchedTotals.deletions === null ? null : (
            <>
              {" "}
              <span className="text-success">+{touchedTotals.additions ?? 0}</span>{" "}
              <span className="text-destructive-foreground">-{touchedTotals.deletions ?? 0}</span>
            </>
          )}
        </>
      }
    >
      {touched.map((folder: ActivityFolder) => (
        <div key={folder.folder} role="group" aria-label={folder.folder} className="pb-1">
          <div className="truncate px-2 pt-1 text-2xs text-muted-foreground">{folder.folder}</div>
          {folder.files.map((file) => (
            <button
              key={file.path}
              type="button"
              disabled={!file.openable}
              onClick={() => props.onOpenFile(file.path)}
              className={cn(
                ROW_CLASS,
                "w-full items-center focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70 enabled:cursor-pointer enabled:hover:bg-accent",
              )}
            >
              <PierreEntryIcon
                pathValue={file.path}
                kind="file"
                theme={resolvedTheme}
                className="size-3.5 shrink-0"
              />
              <span className="min-w-0 flex-1 truncate">
                {file.path.slice(file.path.lastIndexOf("/") + 1)}
              </span>
              {!file.openable ? (
                <span className="shrink-0 text-2xs text-muted-foreground">Outside workspace</span>
              ) : file.additions === null && file.deletions === null ? null : (
                <span className="shrink-0 text-xs tabular-nums">
                  <span className="text-success">+{file.additions ?? 0}</span>{" "}
                  <span className="text-destructive-foreground">-{file.deletions ?? 0}</span>
                </span>
              )}
            </button>
          ))}
        </div>
      ))}
    </Section>
  );
}

/** What the agent is doing and has done this turn, built from items every provider produces. */
export function ActivityPanel(props: {
  threadRef: ScopedThreadRef;
  workspaceRoot: string | undefined;
  onOpenFile: (relativePath: string) => void;
}) {
  const visibleItems = useQuietThreadVisibleTurnItems(props.threadRef);
  const summary = deriveActivitySummary(
    visibleItems.map((visible) => visible.item).filter(isActivityItem),
    props.workspaceRoot ?? null,
  );

  const isEmpty =
    summary.now === null &&
    summary.done.length === 0 &&
    summary.touched.length === 0 &&
    summary.plan === null;
  if (isEmpty) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyTitle>Nothing to show yet</EmptyTitle>
          <EmptyDescription>
            Progress appears here while the agent works: what it is doing, what it finished, and
            which files it changed.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  return (
    <ScrollArea>
      <StatusBanner summary={summary} />
      {summary.plan ? <PlanSection plan={summary.plan} /> : null}
      <TouchedSection summary={summary} onOpenFile={props.onOpenFile} />
      <DoneSection summary={summary} />
    </ScrollArea>
  );
}
