import { scopeTaskRef } from "@t3tools/client-runtime/environment";
import {
  AlarmClockIcon,
  ArrowUpRightIcon,
  ChevronRightIcon,
  LayersIcon,
  MoreHorizontalIcon,
  Undo2Icon,
} from "lucide-react";
import { memo } from "react";
import { useTaskActions } from "../../hooks/useTaskActions";
import { useTaskActionMenu } from "../../hooks/useTaskActionMenu";
import { cn } from "../../lib/utils";
import { TaskRowAction, toggleTaskRow, type TaskRowProps } from "./TaskCard";

export const TaskSlimRow = memo(function TaskSlimRow({
  task,
  expanded,
  onToggle,
  counts,
  primaryProjectName,
  timeLabel,
  selected = false,
  className,
  snoozed,
}: TaskRowProps & { snoozed: boolean }) {
  const ref = scopeTaskRef(task.environmentId, task.id);
  const actions = useTaskActions();
  const { openMenu } = useTaskActionMenu(ref);
  const countLabel = `${counts.live} live · ${counts.snoozed} snoozed · ${counts.settled} settled`;
  return (
    <div
      role="button"
      tabIndex={0}
      aria-expanded={expanded}
      aria-current={selected ? "page" : undefined}
      aria-label={`${task.name}, ${primaryProjectName}, ${countLabel}`}
      onClick={onToggle}
      onKeyDown={(event) => toggleTaskRow(event, onToggle)}
      onContextMenu={(event) => {
        event.preventDefault();
        event.stopPropagation();
        openMenu({ x: event.clientX, y: event.clientY });
      }}
      className={cn(
        "group/task flex h-9 w-full cursor-pointer items-center gap-1.5 rounded-md px-[var(--sidebar-row-content-inset)] text-left outline-none select-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring",
        selected ? "bg-sidebar-row-active" : "hover:bg-sidebar-row-hover",
        className,
      )}
    >
      <ChevronRightIcon
        className={cn("size-3.5 shrink-0 text-muted-foreground", expanded && "rotate-90")}
      />
      <LayersIcon className="size-3.5 shrink-0 text-primary/60" />
      <span
        className={cn(
          "min-w-0 flex-1 truncate text-sm text-secondary-label",
          selected ? "font-medium" : "font-normal",
        )}
        aria-label={`${task.name} — ${primaryProjectName}`}
      >
        {task.name}
      </span>
      <span className="text-[11px] tabular-nums text-secondary-label" aria-label={countLabel}>
        {counts.live + counts.snoozed + counts.settled}
      </span>
      <span
        className="shrink-0 text-[11px] tabular-nums text-secondary-label"
        aria-label={snoozed ? (task.snoozedUntil ?? undefined) : (task.settledAt ?? task.updatedAt)}
      >
        {timeLabel}
      </span>
      <TaskRowAction label="Open task" onClick={() => void actions.openTask(ref)}>
        <ArrowUpRightIcon className="size-3.5" />
      </TaskRowAction>
      <TaskRowAction
        label={snoozed ? "Wake task" : "Un-settle task"}
        onClick={() => {
          if (snoozed) void actions.unsnoozeTask(ref);
          else void actions.unsettleTask(ref);
        }}
      >
        {snoozed ? <AlarmClockIcon className="size-3.5" /> : <Undo2Icon className="size-3.5" />}
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
  );
});
