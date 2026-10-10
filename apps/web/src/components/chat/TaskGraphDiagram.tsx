import type { EnvironmentId, TaskGraphNode } from "@t3tools/contracts";
import { taskGraphLayers } from "@t3tools/shared/taskGraph";
import { Link } from "@tanstack/react-router";

import { cn } from "~/lib/utils";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  pullRequestLabel,
  TASK_GRAPH_DIAGRAM,
  TASK_GRAPH_NODE_STATUS_DOT_CLASS,
  TASK_GRAPH_NODE_STATUS_LABEL,
  taskGraphDiagramLayout,
} from "./taskGraphView";

/**
 * The graph as boxes and curves, left to right, for the card above the
 * composer. Static: status changes recolour dots, nothing animates.
 */
export function TaskGraphDiagram(props: {
  readonly environmentId: EnvironmentId;
  readonly nodes: ReadonlyArray<TaskGraphNode>;
  readonly onOpenPullRequest: (url: string) => void;
}) {
  const layout = taskGraphDiagramLayout(taskGraphLayers(props.nodes));

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
          x={x + 8}
          y={y + 8}
          onOpenPullRequest={props.onOpenPullRequest}
        />
      ))}
    </div>
  );
}

function TaskGraphDiagramNode(props: {
  readonly environmentId: EnvironmentId;
  readonly node: TaskGraphNode;
  readonly x: number;
  readonly y: number;
  readonly onOpenPullRequest: (url: string) => void;
}) {
  const { node } = props;
  const pullRequestUrl = node.pullRequestResult?.url ?? null;
  const title =
    node.threadId === null ? (
      <span className="min-w-0 truncate text-foreground/85">{node.title}</span>
    ) : (
      <Link
        to="/$environmentId/$threadId"
        params={{
          environmentId: node.assignedEnvironmentId ?? props.environmentId,
          threadId: node.threadId,
        }}
        className="min-w-0 truncate text-foreground/85 hover:underline"
      >
        {node.title}
      </Link>
    );
  const box = (
    <div
      role="group"
      aria-label={`${node.title}: ${TASK_GRAPH_NODE_STATUS_LABEL[node.status]}`}
      className={cn(
        "absolute flex flex-col justify-center gap-0.5 rounded-md border bg-background px-2 text-xs",
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
      <div className="flex min-w-0 items-center gap-1.5 text-2xs text-muted-foreground">
        <span className="shrink-0">{TASK_GRAPH_NODE_STATUS_LABEL[node.status]}</span>
        {pullRequestUrl !== null ? (
          <button
            type="button"
            className="shrink-0 hover:text-foreground hover:underline"
            aria-label={`Open pull request for ${node.title}`}
            onClick={() => props.onOpenPullRequest(pullRequestUrl)}
          >
            {pullRequestLabel(pullRequestUrl)}
          </button>
        ) : node.branch !== null ? (
          <span className="min-w-0 truncate font-mono">{node.branch}</span>
        ) : null}
      </div>
    </div>
  );
  if (node.error === null) return box;
  return (
    <Tooltip>
      <TooltipTrigger render={box} />
      <TooltipPopup className="max-w-sm whitespace-pre-wrap">{node.error}</TooltipPopup>
    </Tooltip>
  );
}
