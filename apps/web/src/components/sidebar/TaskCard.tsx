import { useAtomValue } from "@effect/atom-react";
import { environmentShell } from "../../state/shell";
import { scopeTaskRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentTask } from "@t3tools/client-runtime/state/tasks";
import type { TaskMemberStatus } from "@t3tools/client-runtime/state/task-grouping";
import {
  ArrowUpRightIcon,
  ChevronRightIcon,
  CheckIcon,
  FolderIcon,
  LayersIcon,
  MoreHorizontalIcon,
  PinIcon,
  PlusIcon,
} from "lucide-react";
import { memo, type KeyboardEvent, type ReactNode } from "react";
import { useTaskActions } from "../../hooks/useTaskActions";
import { useTaskActionMenu } from "../../hooks/useTaskActionMenu";
import { cn } from "../../lib/utils";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

export interface TaskRowProps {
  task: EnvironmentTask;
  expanded: boolean;
  onToggle: () => void;
  counts: { live: number; snoozed: number; settled: number };
  status: TaskMemberStatus;
  settleBlocked: boolean;
  primaryProjectName: string;
  primaryProjectIcon?: ReactNode;
  timeLabel: string;
  selected?: boolean;
  className?: string;
}

const STATUS_LABELS: Record<TaskMemberStatus, string> = {
  approval: "Needs approval",
  input: "Needs input",
  working: "Working",
  error: "Error",
  background: "Background work",
  monitoring: "Monitoring",
  idle: "Idle",
};

export function TaskStatus({ status }: { status: TaskMemberStatus }) {
  return (
    <span className="inline-flex min-w-0 items-center gap-1" aria-label={STATUS_LABELS[status]}>
      <span
        aria-hidden="true"
        className={cn(
          "size-1.5 shrink-0 rounded-full",
          status === "approval" || status === "input"
            ? "bg-amber-500"
            : status === "error"
              ? "bg-destructive"
              : status === "working" || status === "background"
                ? "bg-emerald-500"
                : "bg-muted-foreground/50",
        )}
      />
      <span className="truncate">{STATUS_LABELS[status]}</span>
    </span>
  );
}

/** The containing row is keyboard operable without hijacking its nested buttons. */
export function toggleTaskRow(event: KeyboardEvent<HTMLDivElement>, onToggle: () => void) {
  if (event.target !== event.currentTarget || (event.key !== "Enter" && event.key !== " ")) return;
  event.preventDefault();
  event.stopPropagation();
  onToggle();
}

export function TaskRowAction({
  label,
  onClick,
  children,
  disabled = false,
}: {
  label: string;
  onClick: (element: HTMLButtonElement) => void;
  children: ReactNode;
  disabled?: boolean;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label={label}
            aria-disabled={disabled || undefined}
            onPointerDown={(event) => event.stopPropagation()}
            onKeyDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation();
              if (!disabled) onClick(event.currentTarget);
            }}
            className="inline-flex size-5 shrink-0 cursor-pointer items-center justify-center rounded-sm text-muted-foreground hover:bg-sidebar-control-surface hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring aria-disabled:cursor-default aria-disabled:opacity-40"
          />
        }
      >
        {children}
      </TooltipTrigger>
      <TooltipPopup>{label}</TooltipPopup>
    </Tooltip>
  );
}

/** Header only: member rows remain in the sidebar's flattened drag inventory. */
export const TaskCard = memo(function TaskCard({
  task,
  expanded,
  onToggle,
  counts,
  status,
  settleBlocked,
  primaryProjectName,
  primaryProjectIcon,
  timeLabel,
  selected = false,
  className,
}: TaskRowProps) {
  const ref = scopeTaskRef(task.environmentId, task.id);
  const actions = useTaskActions();
  const { openMenu } = useTaskActionMenu(ref);
  const shellStatus = useAtomValue(environmentShell.statusAtom(task.environmentId));
  return (
    <div
      role="button"
      tabIndex={0}
      aria-expanded={expanded}
      aria-label={`${task.name}, ${counts.live} live, ${counts.snoozed} snoozed, ${counts.settled} settled`}
      aria-current={selected ? "page" : undefined}
      onClick={onToggle}
      onKeyDown={(event) => toggleTaskRow(event, onToggle)}
      onContextMenu={(event) => {
        event.preventDefault();
        event.stopPropagation();
        openMenu({ x: event.clientX, y: event.clientY });
      }}
      className={cn(
        "group/task relative h-[4.875rem] w-full cursor-pointer overflow-hidden rounded-md px-[var(--sidebar-row-content-inset)] py-[var(--sidebar-content-inset)] text-left text-sidebar-foreground outline-none select-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring",
        selected ? "bg-sidebar-row-active" : "hover:bg-sidebar-row-hover",
        className,
      )}
    >
      <div className="flex h-5 min-w-0 items-center gap-1.5">
        <ChevronRightIcon
          className={cn("size-3.5 shrink-0 text-muted-foreground", expanded && "rotate-90")}
        />
        <span
          className="flex size-3.5 shrink-0 items-center justify-center text-muted-foreground"
          aria-hidden="true"
        >
          {primaryProjectIcon ?? <FolderIcon className="size-3.5" />}
        </span>
        <span
          className="min-w-0 flex-1 truncate text-xs font-medium text-secondary-label"
          aria-label={primaryProjectName}
        >
          {primaryProjectName}
        </span>
        {task.pinnedAt ? (
          <PinIcon className="size-3 shrink-0 text-muted-foreground" aria-label="Pinned" />
        ) : null}
        <TaskRowAction label="New thread in task" onClick={() => void actions.newThreadInTask(ref)}>
          <PlusIcon className="size-3.5" />
        </TaskRowAction>
        <TaskRowAction
          label="Settle task"
          disabled={settleBlocked || shellStatus !== "live" || task.archivedAt !== null}
          onClick={() => void actions.settleTask(ref)}
        >
          <CheckIcon className="size-3.5" />
        </TaskRowAction>
        <TaskRowAction label="Open task" onClick={() => void actions.openTask(ref)}>
          <ArrowUpRightIcon className="size-3.5" />
        </TaskRowAction>
        <TaskRowAction
          label="Task actions"
          onClick={(element) => {
            const rect = element.getBoundingClientRect();
            openMenu({ x: rect.left, y: rect.bottom });
          }}
        >
          <MoreHorizontalIcon className="size-3.5" />
        </TaskRowAction>
      </div>
      <div className="mt-1 flex min-w-0 items-center gap-1.5">
        <LayersIcon className="size-3.5 shrink-0 text-primary/80" />
        <span
          className={cn(
            "min-w-0 flex-1 truncate text-sm",
            selected ? "font-medium" : "font-normal",
          )}
          aria-label={task.name}
        >
          {task.name}
        </span>
        <span
          className="shrink-0 text-[11px] tabular-nums text-secondary-label"
          aria-label={task.updatedAt}
        >
          {timeLabel}
        </span>
      </div>
      <div className="mt-0.5 flex min-w-0 items-center justify-between gap-1.5 text-[11px] text-secondary-label">
        <span
          className="truncate tabular-nums"
          aria-label={`${counts.live} live · ${counts.snoozed} snoozed · ${counts.settled} settled`}
        >
          {counts.live} live · {counts.snoozed} snoozed · {counts.settled} settled
        </span>
        {status !== "idle" ? <TaskStatus status={status} /> : null}
      </div>
    </div>
  );
});
