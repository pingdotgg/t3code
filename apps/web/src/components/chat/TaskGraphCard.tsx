import {
  TaskGraphId,
  type EnvironmentId,
  type ModelSelection,
  type ProjectId,
  type TaskGraph,
  type TaskGraphNode,
  type ThreadId,
} from "@t3tools/contracts";
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
import {
  useDraftTaskGraph,
  useTaskGraphCommands,
  useTaskGraphEditorRequest,
} from "./useTaskGraphCommands";
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
  const [editorOpenLocally, setEditorOpen] = useState(false);
  // A graph just started from the composer opens straight into its editor.
  const requestedNodeKey = useTaskGraphEditorRequest((state) =>
    state.graphId === graph.id ? state.nodeKey : null,
  );
  const clearEditorRequest = useTaskGraphEditorRequest((state) => state.clear);
  const editorOpen = editorOpenLocally || requestedNodeKey !== null;
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
      <Dialog
        open={editorOpen}
        onOpenChange={(open) => {
          setEditorOpen(open);
          if (!open && requestedNodeKey !== null) clearEditorRequest();
        }}
      >
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
                initialNodeKey={requestedNodeKey ?? editorNodeKey}
              />
            </Suspense>
          ) : null}
        </DialogPopup>
      </Dialog>
    </ComposerBanner.Attachment>
  );
}

/**
 * The editor for a graph drafted on a new chat. Nothing reaches the server
 * until Run, which creates the chat's thread and the graph together; closing
 * keeps the draft for as long as the new chat stays open.
 */
export function DraftTaskGraphDialog(props: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly threadId: ThreadId;
  readonly baseRef: string | null;
  readonly modelSelection: ModelSelection | null;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onRun: (nodes: ReadonlyArray<TaskGraphNode>) => Promise<string | null>;
}) {
  const draft = useDraftTaskGraph({
    canRun: true,
    onRun: props.onRun,
    onDiscard: () => props.onOpenChange(false),
  });
  const [createdAt] = useState(() => new Date().toISOString());
  const graph: TaskGraph = {
    id: TaskGraphId.make("draft"),
    projectId: props.projectId,
    threadId: props.threadId,
    title: "New task graph",
    baseRef: props.baseRef ?? "HEAD",
    modelSelection: props.modelSelection,
    status: "draft",
    nodes: draft.nodes,
    createdAt,
    updatedAt: createdAt,
  };
  const labels = useTaskGraphLabels(props.environmentId, graph);
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogPopup className="h-[min(85vh,52rem)] max-w-6xl overflow-hidden">
        {props.open ? (
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
              commands={draft.commands}
              labels={labels}
              initialNodeKey={draft.firstNodeKey}
            />
          </Suspense>
        ) : null}
      </DialogPopup>
    </Dialog>
  );
}
