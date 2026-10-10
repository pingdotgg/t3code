import type { EnvironmentId, TaskGraph, ThreadId } from "@t3tools/contracts";
import { ChevronDownIcon, Maximize2Icon, PlayIcon, SquareIcon, WorkflowIcon } from "lucide-react";
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
import { TaskGraphDiagram } from "./TaskGraphDiagram";
import {
  isTaskGraphFinished,
  TASK_GRAPH_STATUS_LABEL,
  taskGraphProgressLabel,
  taskGraphPullRequestLinks,
  taskGraphResourcesLabel,
} from "./taskGraphView";
import { useTaskGraphCommands } from "./useTaskGraphCommands";
import { useTaskGraphLabels } from "./useTaskGraphLabels";

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
 * The task graphs a thread proposed, docked above its composer, each drawn as
 * a left-to-right diagram. Any graph collapses to a summary line, and finished
 * ones can be dismissed. Fed by the live subscription, so status needs no refresh.
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
  // Expanded by default, finished or not: a graph that ran on its own should still show its shape.
  const [expanded, setExpanded] = useState(true);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editorNodeKey, setEditorNodeKey] = useState<string | null>(null);
  const openEditor = (nodeKey: string | null) => {
    setEditorNodeKey(nodeKey);
    setEditorOpen(true);
  };
  const commands = useTaskGraphCommands(props.environmentId, graph);
  const labels = useTaskGraphLabels(props.environmentId, graph);
  const listId = useId();
  const pullRequests = taskGraphPullRequestLinks(graph.nodes);

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
            <ComposerBanner.Separator />
            <span className="min-w-0 truncate text-muted-foreground">
              {taskGraphResourcesLabel(graph, labels.modelLabel)}
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
                    onClick={() => openEditor(null)}
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
        <ComposerBanner.Scroll id={listId} className={cn("max-h-72", !expanded && "hidden")}>
          {expanded ? (
            <TaskGraphDiagram
              environmentId={props.environmentId}
              nodes={graph.nodes}
              labels={labels}
              onOpenPullRequest={openExternal}
              onEditNode={(key) => {
                void loadTaskGraphEditor();
                openEditor(key);
              }}
            />
          ) : null}
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
                labels={labels}
                initialNodeKey={editorNodeKey}
              />
            </Suspense>
          ) : null}
        </DialogPopup>
      </Dialog>
    </ComposerBanner.Attachment>
  );
}
