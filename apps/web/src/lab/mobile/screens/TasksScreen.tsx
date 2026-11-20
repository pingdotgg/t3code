import { GlassButton } from "../components/GlassHeader";
import { Icon } from "../components/Icon";
import { InsightStrip } from "../components/InsightStrip";
import { WithStatusDot } from "../components/StatusDot";
import { WorkspaceBar } from "../components/WorkspaceBar";
import { TASKS, type TaskCardData } from "../data/fixtures";
import type { InsightVariant } from "../urlState";
import "./TasksScreen.css";

const PROJECT_COLORS = [
  "#6366f1",
  "#0ea5e9",
  "#10b981",
  "#f59e0b",
  "#ec4899",
  "#8b5cf6",
  "#14b8a6",
  "#ef4444",
];

/** The project badge; the status dot sits on its corner, ringed with the screen colour. */
function ProjectTile(props: { readonly name: string }) {
  const hash = [...props.name].reduce((sum, char) => sum + char.charCodeAt(0), 0);
  return (
    <span className="m-tile" style={{ background: PROJECT_COLORS[hash % PROJECT_COLORS.length] }}>
      {(props.name[0] ?? "?").toUpperCase()}
    </span>
  );
}

function TaskCard(props: { readonly task: TaskCardData }) {
  const { task } = props;
  return (
    <div className="m-task">
      <div className="m-task-head">
        <WithStatusDot state={task.dot} ring="var(--color-screen)">
          <ProjectTile name={task.project} />
        </WithStatusDot>
        <span className="m-task-title" data-recede={task.dot === "working"}>
          {task.title}
        </span>
      </div>
      <div className="m-task-meta">
        <span className="m-task-detail">
          {task.project.toLowerCase()} · <span className="m-tnum">#{task.id}</span> ·{" "}
          {task.subtasks} · <span className="m-tnum">{task.time}</span> · {task.node}
          {task.pr ? (
            <>
              {" · "}
              <span className="m-task-pr m-tnum" data-state={task.pr.state}>
                <Icon name={task.pr.state === "merged" ? "merge" : "pull-request"} size={12} />#
                {task.pr.number}
              </span>
            </>
          ) : null}
        </span>
      </div>
    </div>
  );
}

/** The Tasks tab: a title bar with the lane filter, the insight strip, then task cards. */
export function TasksScreen(props: { readonly chart: boolean; readonly insights: InsightVariant }) {
  return (
    <div className="m-tasks">
      <div className="m-tasks-scroll m-scroll">
        <div className="m-tasks-bar">
          <div className="m-tasks-title">
            <div className="m-tasks-title-text">Tasks</div>
            <div className="m-tasks-subtitle">In progress · {TASKS.length}</div>
          </div>
          <div className="m-tasks-filter">
            <GlassButton icon="filter" label="Lanes" size={20} />
          </div>
        </div>
        <InsightStrip
          key={String(props.chart)}
          variant={props.insights}
          initiallyOpen={props.chart}
        />
        <div className="m-task-list">
          {TASKS.map((task) => (
            <TaskCard key={task.id} task={task} />
          ))}
        </div>
      </div>
      <WorkspaceBar active="tasks" />
    </div>
  );
}
