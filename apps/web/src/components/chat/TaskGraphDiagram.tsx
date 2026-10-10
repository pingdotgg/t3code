import type { EnvironmentId, TaskGraphNode } from "@t3tools/contracts";
import { taskGraphLayers } from "@t3tools/shared/taskGraph";
import { Link } from "@tanstack/react-router";
import { CornerDownRightIcon, FolderIcon, GitBranchIcon } from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "~/lib/utils";
import { PreviewCard, PreviewCardPopup, PreviewCardTrigger } from "../ui/preview-card";
import {
  pullRequestLabel,
  TASK_GRAPH_DIAGRAM,
  TASK_GRAPH_NODE_STATUS_DOT_CLASS,
  TASK_GRAPH_NODE_STATUS_LABEL,
  taskGraphDiagramLayout,
  taskGraphWorkspaceLabel,
} from "./taskGraphView";
import type { TaskGraphLabels } from "./useTaskGraphLabels";

/**
 * The graph as boxes and curves, left to right, for the card above the
 * composer. Static: status changes recolour dots, nothing animates.
 */
export function TaskGraphDiagram(props: {
  readonly environmentId: EnvironmentId;
  readonly nodes: ReadonlyArray<TaskGraphNode>;
  readonly labels: TaskGraphLabels;
  readonly onOpenPullRequest: (url: string) => void;
  /** Opens the editor on a task; bound to double-click and Enter on its box. */
  readonly onEditNode: (key: string) => void;
}) {
  const layout = taskGraphDiagramLayout(taskGraphLayers(props.nodes));
  const titles = new Map(props.nodes.map((node) => [node.key, node.title]));
  const titleOf = (key: string) => titles.get(key) ?? key;

  return (
    <div className="relative p-2" style={{ width: layout.width + 16, height: layout.height + 16 }}>
      <svg
        aria-hidden
        className="absolute inset-2 overflow-visible"
        width={layout.width}
        height={layout.height}
      >
        {layout.edges.map((edge) => (
          <path
            key={edge.key}
            d={edge.path}
            fill="none"
            strokeWidth={1.25}
            className="stroke-muted-foreground/35"
          />
        ))}
      </svg>
      {layout.nodes.map(({ node, x, y }) => (
        <TaskGraphDiagramNode
          key={node.key}
          environmentId={props.environmentId}
          node={node}
          labels={props.labels}
          x={x + 8}
          y={y + 8}
          onOpenPullRequest={props.onOpenPullRequest}
          titleOf={titleOf}
          onEdit={() => props.onEditNode(node.key)}
        />
      ))}
    </div>
  );
}

function TaskGraphDiagramNode(props: {
  readonly environmentId: EnvironmentId;
  readonly node: TaskGraphNode;
  readonly labels: TaskGraphLabels;
  readonly x: number;
  readonly y: number;
  readonly onOpenPullRequest: (url: string) => void;
  readonly titleOf: (key: string) => string;
  readonly onEdit: () => void;
}) {
  const { node } = props;
  const pullRequestUrl = node.pullRequestResult?.url ?? null;
  const machine = props.labels.nodeMachineLabel(node);
  const title = <span className="min-w-0 truncate text-foreground/85">{node.title}</span>;
  const box = (
    <div
      role="button"
      tabIndex={0}
      aria-label={`${node.title}: ${TASK_GRAPH_NODE_STATUS_LABEL[node.status]}. Double-click to edit.`}
      onDoubleClick={props.onEdit}
      onKeyDown={(event) => {
        if (event.key === "Enter" && event.target === event.currentTarget) props.onEdit();
      }}
      className={cn(
        "absolute flex cursor-default select-none flex-col justify-center gap-0.5 rounded-md border bg-background px-2 text-xs outline-none hover:border-ring/60 focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring",
        node.status === "failed" ? "border-destructive/50" : "border-border",
        (node.status === "skipped" || node.status === "cancelled") && "opacity-60",
      )}
      style={{
        left: props.x,
        top: props.y,
        width: TASK_GRAPH_DIAGRAM.nodeWidth,
        height: TASK_GRAPH_DIAGRAM.nodeHeight,
      }}
    >
      <div className="flex min-w-0 items-center gap-1.5">
        <span
          aria-hidden
          className={cn(
            "size-1.5 shrink-0 rounded-full",
            TASK_GRAPH_NODE_STATUS_DOT_CLASS[node.status],
          )}
        />
        {title}
      </div>
      <div className="flex min-w-0 items-center gap-1 text-2xs text-muted-foreground">
        <span className="min-w-0 truncate">
          {TASK_GRAPH_NODE_STATUS_LABEL[node.status]} ·{" "}
          {machine === "Auto" ? machine : `on ${machine}`}
        </span>
        {pullRequestUrl !== null ? (
          <button
            type="button"
            className="ms-auto shrink-0 hover:text-foreground hover:underline"
            aria-label={`Open pull request for ${node.title}`}
            onClick={() => props.onOpenPullRequest(pullRequestUrl)}
          >
            {pullRequestLabel(pullRequestUrl)}
          </button>
        ) : null}
      </div>
      <div className="flex min-w-0 items-center gap-1.5 text-2xs text-muted-foreground">
        <span className="min-w-0 truncate">{props.labels.nodeModelLabel(node)}</span>
        <TaskGraphWorkspaceBadge node={node} titleOf={props.titleOf} />
      </div>
    </div>
  );
  return (
    <PreviewCard>
      <PreviewCardTrigger delay={250} render={box} />
      <PreviewCardPopup side="top" align="center" className="w-96 max-w-[calc(100vw-2rem)]">
        <TaskGraphNodeDetails
          environmentId={props.environmentId}
          node={node}
          labels={props.labels}
          titleOf={props.titleOf}
        />
      </PreviewCardPopup>
    </PreviewCard>
  );
}

/** What a hovered box expands to: the task itself, what it waits on, and how it went. */
function TaskGraphNodeDetails(props: {
  readonly environmentId: EnvironmentId;
  readonly node: TaskGraphNode;
  readonly labels: TaskGraphLabels;
  readonly titleOf: (key: string) => string;
}) {
  const { node } = props;
  const pullRequestError =
    node.pullRequestResult?.status === "failed" ? node.pullRequestResult.error : null;
  return (
    <div className="grid gap-2 p-3 text-xs">
      <div className="flex min-w-0 items-center gap-1.5">
        <span
          aria-hidden
          className={cn(
            "size-1.5 shrink-0 rounded-full",
            TASK_GRAPH_NODE_STATUS_DOT_CLASS[node.status],
          )}
        />
        <span className="min-w-0 truncate font-medium text-sm text-foreground">{node.title}</span>
        <span className="shrink-0 text-muted-foreground">
          {TASK_GRAPH_NODE_STATUS_LABEL[node.status]}
        </span>
      </div>
      <p className="max-h-48 overflow-y-auto whitespace-pre-wrap text-pretty text-foreground/85">
        {node.prompt}
      </p>
      {node.dependsOn.length > 0 ? (
        <TaskGraphNodeDetail label="After">
          {node.dependsOn.map(props.titleOf).join(", ")}
        </TaskGraphNodeDetail>
      ) : null}
      <TaskGraphNodeDetail label="Model">{props.labels.nodeModelLabel(node)}</TaskGraphNodeDetail>
      <TaskGraphNodeDetail label="Machine">
        {props.labels.nodeMachineLabel(node)}
      </TaskGraphNodeDetail>
      <TaskGraphNodeDetail label="Workspace">
        {taskGraphWorkspaceLabel(node, props.titleOf)}
      </TaskGraphNodeDetail>
      {node.branch !== null ? (
        <TaskGraphNodeDetail label="Branch">
          <span className="font-mono">{node.branch}</span>
        </TaskGraphNodeDetail>
      ) : null}
      {node.summary !== null ? (
        <TaskGraphNodeDetail label="Result">
          <span className="line-clamp-6 whitespace-pre-wrap">{node.summary}</span>
        </TaskGraphNodeDetail>
      ) : null}
      {node.error !== null ? (
        <p className="whitespace-pre-wrap text-destructive">{node.error}</p>
      ) : null}
      {pullRequestError !== null ? (
        <p className="whitespace-pre-wrap text-destructive">
          Pull request failed: {pullRequestError}
        </p>
      ) : null}
      <div className="flex items-center justify-between gap-2 text-2xs text-muted-foreground">
        <span>Double-click to edit</span>
        {node.threadId !== null ? (
          <Link
            to="/$environmentId/$threadId"
            params={{
              environmentId: node.assignedEnvironmentId ?? props.environmentId,
              threadId: node.threadId,
            }}
            className="text-foreground/85 hover:underline"
          >
            Open thread
          </Link>
        ) : null}
      </div>
    </div>
  );
}

/** The box's workspace hint: an icon, plus the dependency's name when it continues one. */
function TaskGraphWorkspaceBadge(props: {
  readonly node: TaskGraphNode;
  readonly titleOf: (key: string) => string;
}) {
  const { node } = props;
  const dependency = node.dependsOn[0];
  if (node.workspace === "dependency" && dependency !== undefined) {
    return (
      <span className="ms-auto flex min-w-0 max-w-[55%] items-center gap-0.5">
        <CornerDownRightIcon aria-hidden className="size-3 shrink-0" />
        <span className="sr-only">Continues </span>
        <span className="min-w-0 truncate">{props.titleOf(dependency)}</span>
      </span>
    );
  }
  const Icon = node.workspace === "root" ? FolderIcon : GitBranchIcon;
  return (
    <Icon
      aria-label={taskGraphWorkspaceLabel(node, props.titleOf)}
      className="ms-auto size-3 shrink-0"
    />
  );
}

function TaskGraphNodeDetail(props: { readonly label: string; readonly children: ReactNode }) {
  return (
    <div className="grid grid-cols-[4.5rem_minmax(0,1fr)] gap-2">
      <span className="text-muted-foreground">{props.label}</span>
      <span className="min-w-0 text-foreground/85">{props.children}</span>
    </div>
  );
}
