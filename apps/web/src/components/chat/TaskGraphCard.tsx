import type { EnvironmentId, TaskGraph, TaskGraphNode, ThreadId } from "@t3tools/contracts";
import { taskGraphLayers } from "@t3tools/shared/taskGraph";
import { Link } from "@tanstack/react-router";
import {
  ChevronDownIcon,
  Maximize2Icon,
  MessageSquareTextIcon,
  PlayIcon,
  SquareIcon,
  WorkflowIcon,
} from "lucide-react";
import { lazy, Suspense, useId, useState } from "react";
import { create } from "zustand";

import { cn } from "~/lib/utils";
import { readLocalApi } from "~/localApi";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { Button } from "../ui/button";
import { PullRequestGlyph } from "../pullRequest/pullRequestIcons";
import { Dialog, DialogPopup } from "../ui/dialog";
import { Spinner } from "../ui/spinner";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ComposerBanner } from "./ComposerBanner";
import {
  isTaskGraphFinished,
  pullRequestLabel,
  TASK_GRAPH_NODE_STATUS_DOT_CLASS,
  TASK_GRAPH_NODE_STATUS_LABEL,
  TASK_GRAPH_STATUS_LABEL,
  taskGraphProgressLabel,
  taskGraphPullRequestLinks,
} from "./taskGraphView";
import { useTaskGraphCommands } from "./useTaskGraphCommands";

// The canvas, dagre and xyflow load only when someone opens the editor.
const loadTaskGraphEditor = () => import("./TaskGraphEditor");
const TaskGraphEditor = lazy(loadTaskGraphEditor);

const EMPTY_GRAPHS: ReadonlyArray<TaskGraph> = [];

/** Finished graphs hidden from the chat for the rest of this session. */
const useDismissedTaskGraphs = create<{
  readonly ids: ReadonlySet<string>;
  readonly dismiss: (id: string) => void;
}>((set) => ({
  ids: new Set(),
  dismiss: (id) => set((state) => ({ ids: new Set(state.ids).add(id) })),
}));

const openExternal = (url: string) => void readLocalApi()?.shell.openExternal(url);

/**
 * The task graphs a thread proposed, docked above its composer. Drafts and
 * running graphs start expanded; finished ones collapse to a summary line and
 * can be dismissed. Fed by the live subscription, so status needs no refresh.
 */
export function TaskGraphCards(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const graphsQuery = useEnvironmentQuery(
    serverEnvironment.taskGraphsLive({
      environmentId: props.environmentId,
      input: { threadId: props.threadId },
    }),
  );
  const dismissed = useDismissedTaskGraphs((state) => state.ids);
  const dismiss = useDismissedTaskGraphs((state) => state.dismiss);
  // A load error renders nothing: servers from before task graphs reject the
  // subscription, and every thread on them would otherwise carry an error row.
  const graphs = (graphsQuery.data?.graphs ?? EMPTY_GRAPHS).filter(
    (graph) => !(dismissed.has(graph.id) && isTaskGraphFinished(graph.status)),
  );
  return graphs.map((graph) => (
    <TaskGraphCard
      key={graph.id}
      environmentId={props.environmentId}
      graph={graph}
      onDismiss={() => dismiss(graph.id)}
    />
  ));
}

function TaskGraphCard(props: {
  readonly environmentId: EnvironmentId;
  readonly graph: TaskGraph;
  readonly onDismiss: () => void;
}) {
  const { graph } = props;
  const finished = isTaskGraphFinished(graph.status);
  const [expandedOverride, setExpanded] = useState<boolean | null>(null);
  const expanded = expandedOverride ?? !finished;
  const [editorOpen, setEditorOpen] = useState(false);
  const commands = useTaskGraphCommands(props.environmentId, graph);
  const listId = useId();
  const pullRequests = taskGraphPullRequestLinks(graph.nodes);
  const layers = expanded ? taskGraphLayers(graph.nodes) : [];

  return (
    <ComposerBanner.Attachment>
      <ComposerBanner.Root
        role="region"
        aria-label={`Task graph: ${graph.title}`}
        data-chat-composer-collapsed-controls="true"
        className="relative z-0"
      >
        <ComposerBanner.Row>
          <ComposerBanner.Icon>
            <WorkflowIcon />
          </ComposerBanner.Icon>
          <ComposerBanner.Content>
            <span className="min-w-0 truncate font-medium text-foreground/80">{graph.title}</span>
            <ComposerBanner.Separator />
            <span className="shrink-0 text-muted-foreground">
              {TASK_GRAPH_STATUS_LABEL[graph.status]} · {taskGraphProgressLabel(graph)}
            </span>
            {!expanded
              ? pullRequests.map((pullRequest) => (
                  <Button
                    key={pullRequest.key}
                    size="micro"
                    variant="ghost-muted"
                    aria-label={`Open pull request for ${pullRequest.title}`}
                    onClick={() => openExternal(pullRequest.url)}
                  >
                    <PullRequestGlyph.pullRequest />
                    {pullRequest.label}
                  </Button>
                ))
              : null}
          </ComposerBanner.Content>
          <ComposerBanner.Actions>
            {graph.status === "draft" ? (
              <Button
                size="xs"
                variant="secondary"
                disabled={!commands.canRun || commands.busy}
                onClick={() => void commands.run()}
              >
                <PlayIcon />
                Run
              </Button>
            ) : null}
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    aria-label="Open graph editor"
                    onPointerEnter={() => void loadTaskGraphEditor()}
                    onFocus={() => void loadTaskGraphEditor()}
                    onClick={() => setEditorOpen(true)}
                  />
                }
              >
                <Maximize2Icon />
              </TooltipTrigger>
              <TooltipPopup>{graph.status === "draft" ? "Edit graph" : "Open graph"}</TooltipPopup>
            </Tooltip>
            {!finished ? (
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      size="icon-xs"
                      variant="ghost"
                      aria-label={graph.status === "draft" ? "Discard draft" : "Cancel graph"}
                      disabled={!commands.canCancel || commands.busy}
                      onClick={() => void commands.cancel()}
                    />
                  }
                >
                  <SquareIcon />
                </TooltipTrigger>
                <TooltipPopup>
                  {graph.status === "draft" ? "Discard draft" : "Cancel graph"}
                </TooltipPopup>
              </Tooltip>
            ) : null}
            <Button
              size="icon-xs"
              variant="ghost"
              aria-label={expanded ? "Collapse task graph" : "Expand task graph"}
              aria-expanded={expanded}
              aria-controls={listId}
              onClick={() => setExpanded(!expanded)}
            >
              <ChevronDownIcon className={cn("size-3.5", !expanded && "rotate-180")} />
            </Button>
            {finished ? (
              <ComposerBanner.Dismiss aria-label="Hide task graph" onClick={props.onDismiss} />
            ) : null}
          </ComposerBanner.Actions>
        </ComposerBanner.Row>
        {commands.error !== null ? (
          <ComposerBanner.Body>
            <p role="alert" className="text-destructive">
              {commands.error}
            </p>
          </ComposerBanner.Body>
        ) : null}
        <ComposerBanner.Scroll id={listId} className={cn("max-h-48", !expanded && "hidden")}>
          <ComposerBanner.Children>
            {layers.map((layer, index) => (
              <div key={layer[0]?.key ?? index} role="group" aria-label={`Step ${index + 1}`}>
                {layers.length > 1 ? (
                  <ComposerBanner.Row>
                    <ComposerBanner.Content className="text-2xs text-muted-foreground">
                      Step {index + 1}
                    </ComposerBanner.Content>
                  </ComposerBanner.Row>
                ) : null}
                {layer.map((node) => (
                  <TaskGraphNodeRow
                    key={node.key}
                    environmentId={props.environmentId}
                    node={node}
                  />
                ))}
              </div>
            ))}
          </ComposerBanner.Children>
        </ComposerBanner.Scroll>
      </ComposerBanner.Root>
      <Dialog open={editorOpen} onOpenChange={setEditorOpen}>
        <DialogPopup className="h-[min(85vh,52rem)] max-w-6xl overflow-hidden">
          {editorOpen ? (
            <Suspense
              fallback={
                <div className="grid flex-1 place-items-center">
                  <Spinner />
                </div>
              }
            >
              <TaskGraphEditor
                environmentId={props.environmentId}
                graph={graph}
                commands={commands}
              />
            </Suspense>
          ) : null}
        </DialogPopup>
      </Dialog>
    </ComposerBanner.Attachment>
  );
}

function TaskGraphNodeRow(props: {
  readonly environmentId: EnvironmentId;
  readonly node: TaskGraphNode;
}) {
  const { node } = props;
  const pullRequestUrl = node.pullRequestResult?.url ?? null;
  return (
    <ComposerBanner.Row>
      <ComposerBanner.Icon>
        <ComposerBanner.Dot className={TASK_GRAPH_NODE_STATUS_DOT_CLASS[node.status]} />
      </ComposerBanner.Icon>
      <ComposerBanner.Content>
        <span className="min-w-0 truncate text-foreground/80">{node.title}</span>
        <span className="shrink-0 text-muted-foreground">
          {TASK_GRAPH_NODE_STATUS_LABEL[node.status]}
        </span>
        {node.branch !== null ? (
          <span className="min-w-0 truncate font-mono text-muted-foreground/70">{node.branch}</span>
        ) : null}
      </ComposerBanner.Content>
      <ComposerBanner.Actions>
        {node.threadId !== null ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  size="icon-xs"
                  variant="ghost-muted"
                  aria-label={`Open thread for ${node.title}`}
                  render={
                    <Link
                      to="/$environmentId/$threadId"
                      params={{
                        environmentId: node.assignedEnvironmentId ?? props.environmentId,
                        threadId: node.threadId,
                      }}
                    />
                  }
                />
              }
            >
              <MessageSquareTextIcon />
            </TooltipTrigger>
            <TooltipPopup>Open thread</TooltipPopup>
          </Tooltip>
        ) : null}
        {pullRequestUrl !== null ? (
          <Button
            size="xs"
            variant="ghost-muted"
            aria-label={`Open pull request for ${node.title}`}
            onClick={() => openExternal(pullRequestUrl)}
          >
            <PullRequestGlyph.pullRequest />
            {pullRequestLabel(pullRequestUrl)}
          </Button>
        ) : null}
      </ComposerBanner.Actions>
    </ComposerBanner.Row>
  );
}
