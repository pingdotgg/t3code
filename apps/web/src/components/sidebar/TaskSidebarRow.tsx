import { scopeTaskRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { memo } from "react";
import { useUiStateStore } from "../../uiStateStore";
import { ProjectFavicon } from "../ProjectFavicon";
import type { SidebarSection } from "../Sidebar.logic";
import { TaskCard, type TaskRowProps } from "./TaskCard";
import { TaskSlimRow } from "./TaskSlimRow";

/** Keep sortable geometry updates outside task content's subscription boundary. */
export const TaskSidebarRow = memo(function TaskSidebarRow({
  task,
  project,
  section,
  expanded,
  liveCount,
  snoozedCount,
  settledCount,
  ...presentation
}: Pick<
  TaskRowProps,
  "task" | "expanded" | "status" | "settleBlocked" | "timeLabel" | "selected"
> & {
  project: EnvironmentProject | undefined;
  section: SidebarSection;
  liveCount: number;
  snoozedCount: number;
  settledCount: number;
}) {
  const setExpanded = useUiStateStore((state) => state.setTaskExpanded);
  const rowProps = {
    ...presentation,
    task,
    expanded,
    counts: { live: liveCount, snoozed: snoozedCount, settled: settledCount },
    onToggle: () => setExpanded(scopeTaskRef(task.environmentId, task.id), !expanded),
    primaryProjectName: project?.title ?? "Project",
    primaryProjectIcon: project ? (
      <ProjectFavicon project={project} className="size-3.5" />
    ) : undefined,
  };
  return section === "settled" || section === "snoozed" ? (
    <TaskSlimRow {...rowProps} snoozed={section === "snoozed"} />
  ) : (
    <TaskCard {...rowProps} />
  );
});
