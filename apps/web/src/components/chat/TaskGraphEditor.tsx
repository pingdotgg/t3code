import "@xyflow/react/dist/base.css";
import "./TaskGraphEditor.css";

import type {
  EnvironmentId,
  ModelSelection,
  TaskGraph,
  TaskGraphNode,
  TaskGraphNodeWorkspace,
} from "@t3tools/contracts";
import {
  isActiveTaskGraphNodeStatus,
  isUnstartedTaskGraphNode,
  isTerminalTaskGraphNodeStatus,
  taskGraphNodeOpensPullRequest,
} from "@t3tools/shared/taskGraph";
import {
  localSnoozeDate,
  localSnoozeTime,
  resolveCustomSnooze,
} from "@t3tools/client-runtime/state/thread-settled";
import { Link } from "@tanstack/react-router";
import {
  Background,
  Handle,
  Position,
  ReactFlow,
  useReactFlow,
  type Connection,
  type NodeProps,
} from "@xyflow/react";
import {
  CalendarIcon,
  MessageSquareTextIcon,
  PlayIcon,
  PlusIcon,
  RotateCcwIcon,
  ScissorsIcon,
  SquareIcon,
  Trash2Icon,
  UnlinkIcon,
} from "lucide-react";
import { useEffect, useId, useMemo, useState } from "react";

import { cn } from "~/lib/utils";
import { readLocalApi } from "~/localApi";
import { usePrimarySettings } from "../../hooks/useSettings";
import { getCustomModelOptionsByInstance } from "../../modelSelection";
import { NO_PROVIDER_MODEL_SELECTION } from "../../providerInstances";
import { formatUpcomingTimestamp, weekStartsOn } from "../../timestampFormat";
import { Button } from "../ui/button";
import { Calendar } from "../ui/calendar";
import { DialogDescription, DialogHeader, DialogTitle } from "../ui/dialog";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { ScrollArea } from "../ui/scroll-area";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Textarea } from "../ui/textarea";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { PullRequestGlyph } from "../pullRequest/pullRequestIcons";
import { ProviderModelPicker } from "./ProviderModelPicker";
import {
  layoutTaskGraph,
  taskGraphCanvasEdgeId,
  taskGraphCanvasElements,
  taskGraphLayoutSignature,
  type TaskGraphCanvasNode,
  type TaskGraphCanvasPoint,
} from "./taskGraphCanvasLayout";
import {
  isTaskGraphFinished,
  pullRequestLabel,
  TASK_GRAPH_NODE_STATUS_DOT_CLASS,
  TASK_GRAPH_NODE_STATUS_LABEL,
  TASK_GRAPH_STATUS_LABEL,
  taskGraphNodeKeyFromTitle,
  taskGraphNodeWaitDetail,
  taskGraphProgressLabel,
} from "./taskGraphView";
import type { TaskGraphCommands } from "./useTaskGraphCommands";
import { TASK_GRAPH_PEER_STATUS_HINT, type TaskGraphLabels } from "./useTaskGraphLabels";

type Selection =
  | { readonly kind: "none" }
  | { readonly kind: "node"; readonly key: string }
  | { readonly kind: "edge"; readonly dependency: string; readonly dependent: string }
  | { readonly kind: "new" };

const NO_SELECTION: Selection = { kind: "none" };

// One editor is open at a time; keeping its last layout lets status updates
// from a running graph skip dagre until nodes or dependencies change.
let cachedLayout: {
  readonly signature: string;
  readonly positions: ReadonlyMap<string, TaskGraphCanvasPoint>;
} | null = null;

function graphLayout(nodes: ReadonlyArray<TaskGraphNode>) {
  const signature = taskGraphLayoutSignature(nodes);
  if (cachedLayout?.signature !== signature) {
    cachedLayout = { signature, positions: layoutTaskGraph(nodes) };
  }
  return cachedLayout;
}

const openExternal = (url: string) => void readLocalApi()?.shell.openExternal(url);

function TaskCanvasNode({ data, selected }: NodeProps<TaskGraphCanvasNode>) {
  const { node, opensPullRequest } = data;
  return (
    <div
      className={cn(
        "flex size-full min-w-0 flex-col justify-center gap-1 rounded-lg border bg-card px-3 text-card-foreground",
        selected ? "border-ring ring-1 ring-ring" : "border-border",
      )}
    >
      <Handle
        type="target"
        position={Position.Left}
        isConnectable={isUnstartedTaskGraphNode(node)}
        className="size-2.5 rounded-full border border-background"
      />
      <span className="flex min-w-0 items-center gap-1.5">
        <span
          aria-hidden
          className={cn(
            "size-1.5 shrink-0 rounded-full",
            TASK_GRAPH_NODE_STATUS_DOT_CLASS[node.status],
          )}
        />
        <span className="min-w-0 truncate text-sm font-medium">{node.title}</span>
      </span>
      <span className="flex min-w-0 items-center gap-1.5 text-2xs text-muted-foreground">
        <span className="min-w-0 truncate font-mono">{node.key}</span>
        <span className="shrink-0">{TASK_GRAPH_NODE_STATUS_LABEL[node.status]}</span>
        {opensPullRequest ? (
          <PullRequestGlyph.pullRequest
            aria-label="Opens a pull request"
            className="size-3 shrink-0"
          />
        ) : null}
      </span>
      <Handle
        type="source"
        position={Position.Right}
        className="size-2.5 rounded-full border border-background"
      />
    </div>
  );
}

const NODE_TYPES = { task: TaskCanvasNode };

/** Fits the view on mount; keyed by layout so it refits on structure changes, not status updates. */
function FitViewOnMount() {
  const { fitView } = useReactFlow();
  useEffect(() => {
    void fitView({ maxZoom: 1 });
  }, [fitView]);
  return null;
}

/**
 * Canvas editor for one task graph, loaded only when the card opens it. The
 * subscription's graph is the only copy: every change is sent as an edit and
 * the canvas redraws from what the server reports back.
 */
export default function TaskGraphEditor(props: {
  readonly environmentId: EnvironmentId;
  readonly graph: TaskGraph;
  readonly commands: TaskGraphCommands;
  readonly labels: TaskGraphLabels;
  /** Task to select on open, such as the box double-clicked in the chat diagram. */
  readonly initialNodeKey?: string | null;
}) {
  const { graph, commands } = props;
  const [selectionState, setSelection] = useState<Selection>(() =>
    props.initialNodeKey == null ? NO_SELECTION : { kind: "node", key: props.initialNodeKey },
  );
  const layout = graphLayout(graph.nodes);
  const selection = resolveSelection(selectionState, graph);
  const { nodes, edges } = taskGraphCanvasElements(graph.nodes, layout.positions, {
    nodeKey: selection.kind === "node" ? selection.key : null,
    edgeId:
      selection.kind === "edge"
        ? taskGraphCanvasEdgeId(selection.dependency, selection.dependent)
        : null,
  });
  const canEdit = commands.canEdit && !commands.busy;
  const finished = isTaskGraphFinished(graph.status);

  const unstartedNode = (key: string) =>
    graph.nodes.find((node) => node.key === key && isUnstartedTaskGraphNode(node));

  const connect = (connection: Connection) => {
    const dependent = unstartedNode(connection.target);
    if (dependent === undefined || dependent.dependsOn.includes(connection.source)) return;
    void commands.edit([
      {
        type: "update_node",
        key: dependent.key,
        dependsOn: [...dependent.dependsOn, connection.source],
      },
    ]);
  };

  return (
    <>
      <DialogHeader>
        <div className="flex flex-wrap items-center gap-3 pe-6">
          <div className="min-w-0 flex-1 space-y-1">
            <DialogTitle>{graph.title}</DialogTitle>
            <DialogDescription>
              {TASK_GRAPH_STATUS_LABEL[graph.status]} · {taskGraphProgressLabel(graph)} · from{" "}
              <span className="font-mono">{graph.baseRef}</span>
            </DialogDescription>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={!canEdit}
              onClick={() => setSelection({ kind: "new" })}
            >
              <PlusIcon />
              Add task
            </Button>
            {!finished ? (
              <Button
                size="sm"
                variant="destructive-outline"
                disabled={!commands.canCancel || commands.busy}
                onClick={() => void commands.cancel()}
              >
                <SquareIcon />
                {graph.status === "draft" ? "Discard draft" : "Cancel graph"}
              </Button>
            ) : null}
            {graph.status === "draft" ? (
              <Button
                size="sm"
                disabled={!commands.canRun || commands.busy}
                onClick={() => void commands.run()}
              >
                <PlayIcon />
                Run
              </Button>
            ) : null}
          </div>
        </div>
        {commands.error !== null ? (
          <p role="alert" className="text-sm text-destructive">
            {commands.error}
          </p>
        ) : null}
      </DialogHeader>
      <div className="flex min-h-0 flex-1 border-t max-sm:flex-col">
        <div className="min-h-64 min-w-0 flex-1">
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={NODE_TYPES}
            nodesDraggable={false}
            nodesConnectable={canEdit}
            edgesFocusable
            deleteKeyCode={null}
            fitView
            fitViewOptions={{ maxZoom: 1 }}
            minZoom={0.2}
            isValidConnection={(connection) =>
              connection.source !== connection.target &&
              unstartedNode(connection.target) !== undefined
            }
            onConnect={connect}
            onNodeClick={(_event, node) => setSelection({ kind: "node", key: node.id })}
            onEdgeClick={(_event, edge) =>
              setSelection({ kind: "edge", dependency: edge.source, dependent: edge.target })
            }
            onPaneClick={() => setSelection(NO_SELECTION)}
            data-task-graph-canvas
          >
            <Background gap={16} size={1} />
            <FitViewOnMount key={layout.signature} />
          </ReactFlow>
        </div>
        <div className="flex w-80 shrink-0 border-s max-sm:max-h-[45%] max-sm:w-full max-sm:border-s-0 max-sm:border-t">
          <ScrollArea radius="none">
            <div className="space-y-4 p-4">
              <SelectionPanel
                environmentId={props.environmentId}
                graph={graph}
                commands={commands}
                labels={props.labels}
                selection={selection}
                onSelect={setSelection}
              />
            </div>
          </ScrollArea>
        </div>
      </div>
    </>
  );
}

/** Drops a selection the server has since removed, such as a deleted node. */
function resolveSelection(selection: Selection, graph: TaskGraph): Selection {
  if (selection.kind === "node") {
    return graph.nodes.some((node) => node.key === selection.key) ? selection : NO_SELECTION;
  }
  if (selection.kind === "edge") {
    const dependent = graph.nodes.find((node) => node.key === selection.dependent);
    return dependent?.dependsOn.includes(selection.dependency) ? selection : NO_SELECTION;
  }
  return selection;
}

function SelectionPanel(props: {
  readonly environmentId: EnvironmentId;
  readonly graph: TaskGraph;
  readonly commands: TaskGraphCommands;
  readonly labels: TaskGraphLabels;
  readonly selection: Selection;
  readonly onSelect: (selection: Selection) => void;
}) {
  const { graph, commands, selection } = props;
  const canEdit = commands.canEdit && !commands.busy;

  if (selection.kind === "new") {
    return (
      <TaskNodeForm
        key="new"
        heading="New task"
        initial={{
          title: "",
          prompt: "",
          pullRequest: null,
          modelSelection: null,
          environmentId: null,
          workspace: "worktree",
          startAt: null,
        }}
        placement={{ graph, labels: props.labels, dependency: null }}
        opensByDefault
        disabled={!canEdit}
        submitLabel="Add task"
        keyFor={(title) =>
          taskGraphNodeKeyFromTitle(
            title,
            graph.nodes.map((node) => node.key),
          )
        }
        onCancel={() => props.onSelect(NO_SELECTION)}
        onSubmit={async (values) => {
          const key = taskGraphNodeKeyFromTitle(
            values.title,
            graph.nodes.map((node) => node.key),
          );
          const accepted = await commands.edit([
            {
              type: "add_node",
              node: {
                key,
                title: values.title,
                prompt: values.prompt,
                dependsOn: [],
                ...(values.pullRequest === null ? {} : { pullRequest: values.pullRequest }),
                ...(values.modelSelection === null
                  ? {}
                  : { modelSelection: values.modelSelection }),
                ...(values.environmentId === null ? {} : { environmentId: values.environmentId }),
                ...(values.workspace === "worktree" ? {} : { workspace: values.workspace }),
                ...(values.startAt === null ? {} : { startAt: values.startAt }),
              },
            },
          ]);
          if (accepted) props.onSelect({ kind: "node", key });
        }}
      />
    );
  }

  if (selection.kind === "edge") {
    const dependent = graph.nodes.find((node) => node.key === selection.dependent);
    const dependency = graph.nodes.find((node) => node.key === selection.dependency);
    if (dependent === undefined || dependency === undefined) return null;
    return (
      <div className="space-y-3">
        <h3 className="text-sm font-medium">Dependency</h3>
        <p className="text-sm text-muted-foreground">
          <span className="text-foreground">{dependent.title}</span> starts after{" "}
          <span className="text-foreground">{dependency.title}</span> succeeds.
        </p>
        {isUnstartedTaskGraphNode(dependent) ? (
          <Button
            size="sm"
            variant="destructive-outline"
            disabled={!canEdit}
            onClick={() =>
              void commands.edit([
                {
                  type: "update_node",
                  key: dependent.key,
                  dependsOn: dependent.dependsOn.filter((key) => key !== dependency.key),
                },
              ])
            }
          >
            <UnlinkIcon />
            Remove dependency
          </Button>
        ) : (
          <p className="text-xs text-muted-foreground">
            {dependent.title} has started, so its dependencies are fixed.
          </p>
        )}
      </div>
    );
  }

  if (selection.kind === "node") {
    const node = graph.nodes.find((candidate) => candidate.key === selection.key);
    if (node === undefined) return null;
    return (
      <NodePanel
        key={node.key}
        environmentId={props.environmentId}
        graph={graph}
        node={node}
        commands={commands}
        labels={props.labels}
      />
    );
  }

  return (
    <div className="space-y-2 text-sm text-muted-foreground">
      <h3 className="font-medium text-foreground">Graph</h3>
      <p>
        Each task runs as its own thread, in its own worktree unless set otherwise. Drag from the
        right edge of a task to the left edge of another to make the second wait for the first.
      </p>
      <p>Tasks that nothing depends on open a pull request unless you turn it off.</p>
      <p>Select a task or dependency to change it.</p>
    </div>
  );
}

function NodePanel(props: {
  readonly environmentId: EnvironmentId;
  readonly graph: TaskGraph;
  readonly node: TaskGraphNode;
  readonly commands: TaskGraphCommands;
  readonly labels: TaskGraphLabels;
}) {
  const { graph, node, commands } = props;
  const placement: TaskNodePlacementContext = {
    graph,
    labels: props.labels,
    dependency: graph.nodes.find((candidate) => candidate.key === node.dependsOn[0]) ?? null,
  };
  const canEdit = commands.canEdit && !commands.busy;
  const opensByDefault = taskGraphNodeOpensPullRequest(graph.nodes, {
    ...node,
    pullRequest: null,
  });
  const canCancelBranch =
    isActiveTaskGraphNodeStatus(node.status) ||
    node.status === "waiting" ||
    (node.status === "pending" && graph.status !== "draft");
  const canRetry = isTerminalTaskGraphNodeStatus(node.status) && node.status !== "succeeded";
  const timestampFormat = usePrimarySettings((settings) => settings.timestampFormat);
  const wait = taskGraphNodeWaitDetail(node, (iso) =>
    formatUpcomingTimestamp(iso, timestampFormat),
  );

  const actions = (
    <div className="flex flex-wrap gap-2">
      {canCancelBranch ? (
        <Button
          size="sm"
          variant="destructive-outline"
          disabled={!canEdit}
          onClick={() => void commands.edit([{ type: "cancel_branch", key: node.key }])}
        >
          <ScissorsIcon />
          Cancel branch
        </Button>
      ) : null}
      {canRetry ? (
        <Button
          size="sm"
          variant="outline"
          disabled={!canEdit}
          onClick={() => void commands.edit([{ type: "retry_node", key: node.key }])}
        >
          <RotateCcwIcon />
          Retry
        </Button>
      ) : null}
    </div>
  );

  if (isUnstartedTaskGraphNode(node)) {
    return (
      <div className="space-y-4">
        {wait !== null ? <p className="text-xs text-muted-foreground">{wait}</p> : null}
        <TaskNodeForm
          heading={`Task ${node.key}`}
          initial={{
            title: node.title,
            prompt: node.prompt,
            pullRequest: node.pullRequest,
            modelSelection: node.modelSelection,
            environmentId: node.environmentId,
            workspace: node.workspace,
            startAt: node.startAt,
          }}
          placement={placement}
          opensByDefault={opensByDefault}
          disabled={!canEdit}
          submitLabel="Save"
          onSubmit={async (values) => {
            await commands.edit([
              {
                type: "update_node",
                key: node.key,
                ...(values.title === node.title ? {} : { title: values.title }),
                ...(values.prompt === node.prompt ? {} : { prompt: values.prompt }),
                ...(values.pullRequest === node.pullRequest
                  ? {}
                  : { pullRequest: values.pullRequest }),
                ...(sameModel(values.modelSelection, node.modelSelection)
                  ? {}
                  : { modelSelection: values.modelSelection }),
                ...(values.environmentId === node.environmentId
                  ? {}
                  : { environmentId: values.environmentId }),
                ...(values.workspace === node.workspace ? {} : { workspace: values.workspace }),
                ...(values.startAt === node.startAt ? {} : { startAt: values.startAt }),
              },
            ]);
          }}
        />
        <div className="flex flex-wrap gap-2 border-t pt-4">
          <Button
            size="sm"
            variant="destructive-outline"
            disabled={!canEdit}
            onClick={() => void commands.edit([{ type: "remove_node", key: node.key }])}
          >
            <Trash2Icon />
            Delete task
          </Button>
          {actions}
        </div>
      </div>
    );
  }

  const pullRequest = node.pullRequestResult;
  const pullRequestUrl = pullRequest?.url ?? null;
  return (
    <div className="space-y-3 text-sm">
      <div className="space-y-1">
        <h3 className="font-medium">{node.title}</h3>
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <span
            aria-hidden
            className={cn(
              "size-1.5 shrink-0 rounded-full",
              TASK_GRAPH_NODE_STATUS_DOT_CLASS[node.status],
            )}
          />
          {TASK_GRAPH_NODE_STATUS_LABEL[node.status]}
          <span className="min-w-0 truncate font-mono">{node.key}</span>
        </p>
      </div>
      {wait !== null ? <p className="text-xs text-muted-foreground">{wait}</p> : null}
      {node.error !== null ? <p className="text-destructive">{node.error}</p> : null}
      {node.branch !== null ? (
        <p className="truncate font-mono text-xs text-muted-foreground">{node.branch}</p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        {node.threadId !== null ? (
          <Button
            size="sm"
            variant="outline"
            render={
              <Link
                to="/$environmentId/$threadId"
                params={{
                  environmentId: node.assignedEnvironmentId ?? props.environmentId,
                  threadId: node.threadId,
                }}
              />
            }
          >
            <MessageSquareTextIcon />
            Open thread
          </Button>
        ) : null}
        {pullRequestUrl !== null ? (
          <Button size="sm" variant="outline" onClick={() => openExternal(pullRequestUrl)}>
            <PullRequestGlyph.pullRequest />
            {pullRequestLabel(pullRequestUrl)}
          </Button>
        ) : null}
      </div>
      {pullRequest?.status === "failed" && pullRequest.error !== null ? (
        <p className="text-xs text-destructive">Pull request failed: {pullRequest.error}</p>
      ) : null}
      {actions}
      <TaskNodePlacementFields context={placement} values={node} disabled />
      <div className="space-y-1">
        <h4 className="text-xs font-medium text-muted-foreground">Prompt</h4>
        <p className="whitespace-pre-wrap wrap-anywhere text-xs">{node.prompt}</p>
      </div>
      {node.summary !== null ? (
        <div className="space-y-1">
          <h4 className="text-xs font-medium text-muted-foreground">Result</h4>
          <p className="whitespace-pre-wrap wrap-anywhere text-xs">{node.summary}</p>
        </div>
      ) : null}
    </div>
  );
}

interface TaskNodeValues {
  readonly title: string;
  readonly prompt: string;
  /** Null follows the default: a pull request only when nothing depends on the task. */
  readonly pullRequest: boolean | null;
  /** Null runs with the graph's model. */
  readonly modelSelection: ModelSelection | null;
  /** Null balances across machines when the task starts. */
  readonly environmentId: EnvironmentId | null;
  readonly workspace: TaskGraphNodeWorkspace;
  /** Earliest start as an ISO time; null starts as soon as its dependencies succeed. */
  readonly startAt: string | null;
}

type TaskNodePlacement = Pick<TaskNodeValues, "modelSelection" | "environmentId" | "workspace">;

/** What the placement fields resolve names against; `dependency` is the task's first dependency. */
interface TaskNodePlacementContext {
  readonly graph: TaskGraph;
  readonly labels: TaskGraphLabels;
  readonly dependency: TaskGraphNode | null;
}

const sameModel = (left: ModelSelection | null, right: ModelSelection | null) =>
  left === right ||
  (left !== null &&
    right !== null &&
    left.instanceId === right.instanceId &&
    left.model === right.model);

const PULL_REQUEST_CHOICES = ["auto", "on", "off"] as const;
type PullRequestChoice = (typeof PULL_REQUEST_CHOICES)[number];

const toChoice = (value: boolean | null): PullRequestChoice =>
  value === null ? "auto" : value ? "on" : "off";
const fromChoice = (choice: PullRequestChoice): boolean | null =>
  choice === "auto" ? null : choice === "on";

/** Form text stays local until submitted; everything else comes from the server. */
function TaskNodeForm(props: {
  readonly heading: string;
  readonly initial: TaskNodeValues;
  readonly placement: TaskNodePlacementContext;
  readonly opensByDefault: boolean;
  readonly disabled: boolean;
  readonly submitLabel: string;
  readonly keyFor?: (title: string) => string;
  readonly onSubmit: (values: TaskNodeValues) => Promise<void>;
  readonly onCancel?: () => void;
}) {
  const id = useId();
  const [title, setTitle] = useState(props.initial.title);
  const [prompt, setPrompt] = useState(props.initial.prompt);
  const [pullRequest, setPullRequest] = useState(props.initial.pullRequest);
  const [placement, setPlacement] = useState<TaskNodePlacement>(props.initial);
  const [start, setStart] = useState(() => initialStartChoice(props.initial.startAt));
  const startAt = resolveStartAt(start, props.initial.startAt);
  const values: TaskNodeValues = {
    title: title.trim(),
    prompt: prompt.trim(),
    pullRequest,
    modelSelection: placement.modelSelection,
    environmentId: placement.environmentId,
    workspace: placement.workspace,
    startAt,
  };
  const dirty =
    values.title !== props.initial.title ||
    values.prompt !== props.initial.prompt ||
    values.pullRequest !== props.initial.pullRequest ||
    !sameModel(values.modelSelection, props.initial.modelSelection) ||
    values.environmentId !== props.initial.environmentId ||
    values.workspace !== props.initial.workspace ||
    values.startAt !== props.initial.startAt;
  const startAtInvalid = start.scheduled && startAt === null;
  const valid =
    values.title.length > 0 &&
    values.title.length <= 120 &&
    values.prompt.length > 0 &&
    !startAtInvalid;

  return (
    <form
      className="space-y-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (dirty && valid && !props.disabled) void props.onSubmit(values);
      }}
    >
      <h3 className="text-sm font-medium">{props.heading}</h3>
      <div className="space-y-1.5">
        <Label htmlFor={`${id}-title`}>Title</Label>
        <Input
          id={`${id}-title`}
          size="sm"
          value={title}
          maxLength={120}
          disabled={props.disabled}
          onChange={(event) => setTitle(event.target.value)}
        />
        {props.keyFor && values.title.length > 0 ? (
          <p className="text-xs text-muted-foreground">
            Key <span className="font-mono">{props.keyFor(values.title)}</span>
          </p>
        ) : null}
      </div>
      <div className="space-y-1.5">
        <Label htmlFor={`${id}-prompt`}>Prompt</Label>
        <Textarea
          id={`${id}-prompt`}
          size="sm"
          value={prompt}
          disabled={props.disabled}
          onChange={(event) => setPrompt(event.target.value)}
        />
      </div>
      <TaskNodePlacementFields
        context={props.placement}
        values={placement}
        disabled={props.disabled}
        onChange={(next) => setPlacement((current) => ({ ...current, ...next }))}
      />
      <div className="space-y-1.5">
        <Label id={`${id}-pr`}>Pull request</Label>
        <ToggleGroup
          aria-labelledby={`${id}-pr`}
          className="w-full *:flex-1"
          value={[toChoice(pullRequest)]}
          disabled={props.disabled}
          onValueChange={(next) => {
            const choice = PULL_REQUEST_CHOICES.find((candidate) => candidate === next[0]);
            if (choice !== undefined) setPullRequest(fromChoice(choice));
          }}
        >
          <Toggle value="auto">Auto</Toggle>
          <Toggle value="on">Open</Toggle>
          <Toggle value="off">Skip</Toggle>
        </ToggleGroup>
        {pullRequest === null ? (
          <p className="text-xs text-muted-foreground">
            {props.opensByDefault
              ? "Opens a pull request, since no task depends on this one."
              : "No pull request, since another task builds on this one."}
          </p>
        ) : null}
      </div>
      <TaskNodeStartAtField
        value={start}
        invalid={startAtInvalid}
        disabled={props.disabled}
        onChange={setStart}
      />
      <div className="flex justify-end gap-2">
        {props.onCancel ? (
          <Button type="button" size="sm" variant="ghost" onClick={props.onCancel}>
            Cancel
          </Button>
        ) : null}
        <Button type="submit" size="sm" disabled={props.disabled || !dirty || !valid}>
          {props.submitLabel}
        </Button>
      </div>
    </form>
  );
}

/** The start-at field's local date and time; kept while unscheduled so toggling back restores it. */
interface StartChoice {
  readonly scheduled: boolean;
  readonly date: Date;
  /** Local "HH:mm". */
  readonly time: string;
}

function initialStartChoice(startAt: string | null): StartChoice {
  const at = startAt === null ? new Date(Date.now() + 3_600_000) : new Date(startAt);
  return { scheduled: startAt !== null, date: at, time: localSnoozeTime(at) };
}

/**
 * The chosen start as an ISO time, or null when it starts once ready or the
 * choice is not a future time. An untouched existing start keeps its exact
 * value, even once it has passed, so saving other fields does not reject it.
 */
function resolveStartAt(choice: StartChoice, initial: string | null): string | null {
  if (!choice.scheduled) return null;
  const date = localSnoozeDate(choice.date);
  if (initial !== null) {
    const was = new Date(initial);
    if (date === localSnoozeDate(was) && choice.time === localSnoozeTime(was)) return initial;
  }
  return resolveCustomSnooze({ mode: "date", date, time: choice.time }, new Date());
}

/** When a task may start: as soon as its dependencies succeed, or no earlier than a local time. */
function TaskNodeStartAtField(props: {
  readonly value: StartChoice;
  readonly invalid: boolean;
  readonly disabled: boolean;
  readonly onChange: (next: StartChoice) => void;
}) {
  const id = useId();
  const [calendarOpen, setCalendarOpen] = useState(false);
  const { value } = props;
  return (
    <div className="space-y-1.5">
      <Label id={`${id}-start`}>Start at</Label>
      <ToggleGroup
        aria-labelledby={`${id}-start`}
        className="w-full *:flex-1"
        value={[value.scheduled ? "at" : "ready"]}
        disabled={props.disabled}
        onValueChange={(next) => {
          if (next[0] === "ready" || next[0] === "at") {
            props.onChange({ ...value, scheduled: next[0] === "at" });
          }
        }}
      >
        <Toggle value="ready">As soon as ready</Toggle>
        <Toggle value="at">At a time</Toggle>
      </ToggleGroup>
      {value.scheduled ? (
        <div className="grid grid-cols-2 gap-2">
          <Popover open={calendarOpen} onOpenChange={setCalendarOpen}>
            <PopoverTrigger
              disabled={props.disabled}
              render={
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  aria-label="Start date"
                  className="w-full justify-between"
                />
              }
            >
              {value.date.toLocaleDateString(undefined, {
                month: "short",
                day: "numeric",
                year: "numeric",
              })}
              <CalendarIcon />
            </PopoverTrigger>
            <PopoverPopup align="start" aria-label="Choose start date">
              <Calendar
                mode="single"
                required
                selected={value.date}
                defaultMonth={value.date}
                {...(weekStartsOn === undefined ? {} : { weekStartsOn })}
                disabled={{ before: new Date(new Date().setHours(0, 0, 0, 0)) }}
                onSelect={(selected) => {
                  props.onChange({ ...value, date: selected });
                  setCalendarOpen(false);
                }}
              />
            </PopoverPopup>
          </Popover>
          <Input
            nativeInput
            type="time"
            size="sm"
            aria-label="Start time"
            required
            value={value.time}
            disabled={props.disabled}
            onChange={(event) => props.onChange({ ...value, time: event.target.value })}
          />
        </div>
      ) : null}
      {props.invalid ? (
        <p className="text-xs text-destructive">Choose a date and time in the future.</p>
      ) : null}
    </div>
  );
}

const AUTO_MACHINE = "auto";

const WORKSPACE_CHOICES: ReadonlyArray<TaskGraphNodeWorkspace> = ["worktree", "dependency", "root"];

/**
 * Model, machine and workspace for one task. Editable while the task is
 * pending; afterwards the same fields show, disabled, what it was set to.
 */
function TaskNodePlacementFields(props: {
  readonly context: TaskNodePlacementContext;
  readonly values: TaskNodePlacement;
  readonly disabled: boolean;
  readonly onChange?: (next: Partial<TaskNodePlacement>) => void;
}) {
  const id = useId();
  const { graph, labels, dependency } = props.context;
  const { modelSelection, environmentId, workspace } = props.values;
  const change = (next: Partial<TaskNodePlacement>) => {
    if (!props.disabled) props.onChange?.(next);
  };

  // Null on old graphs, made before graphs recorded their thread's model.
  const graphModel = graph.modelSelection;
  const defaultLabel =
    graphModel === null ? "Thread default" : `Graph default (${labels.modelLabel(graphModel)})`;
  const shownModel = modelSelection ?? graphModel;
  const activeInstanceId =
    shownModel?.instanceId ??
    labels.instanceEntries[0]?.instanceId ??
    NO_PROVIDER_MODEL_SELECTION.instanceId;
  const activeModel = shownModel?.model ?? "";
  const modelOptionsByInstance = useMemo(
    () =>
      getCustomModelOptionsByInstance(
        labels.settings,
        labels.providers,
        activeInstanceId,
        activeModel,
      ),
    [labels.settings, labels.providers, activeInstanceId, activeModel],
  );

  const follows = workspace === "dependency" && dependency !== null;
  const machineLabel = follows
    ? `Follows ${dependency.title} (${labels.nodeMachineLabel(dependency)})`
    : environmentId === null
      ? "Auto (balance load)"
      : environmentId === labels.environmentId
        ? `${labels.environmentLabel} (this machine)`
        : labels.machineLabel(environmentId);
  // A pin to a machine that is no longer paired still shows, so it can be cleared.
  const stalePin =
    environmentId !== null &&
    environmentId !== labels.environmentId &&
    !labels.peers.some((peer) => peer.environmentId === environmentId)
      ? environmentId
      : null;
  const continueLabel =
    dependency === null
      ? "Continue a dependency's worktree"
      : `Continue ${dependency.title}'s worktree`;

  return (
    <>
      <div className="space-y-1.5">
        <Label>Model</Label>
        <ProviderModelPicker
          activeInstanceId={activeInstanceId}
          model={activeModel}
          lockedProvider={null}
          instanceEntries={labels.instanceEntries}
          modelOptionsByInstance={modelOptionsByInstance}
          isComposerOwned={false}
          disabled={props.disabled}
          triggerClassName="w-full max-w-none"
          triggerAriaLabel="Model"
          {...(modelSelection === null ? { triggerLabel: defaultLabel } : {})}
          onInstanceModelChange={(instanceId, model) =>
            change({
              // Picking the same model again keeps its stored provider options.
              modelSelection:
                modelSelection !== null &&
                modelSelection.instanceId === instanceId &&
                modelSelection.model === model
                  ? modelSelection
                  : { instanceId, model },
            })
          }
        />
        {modelSelection !== null && !props.disabled ? (
          <Button
            type="button"
            size="xs"
            variant="ghost-muted"
            onClick={() => change({ modelSelection: null })}
          >
            Use {defaultLabel.charAt(0).toLowerCase() + defaultLabel.slice(1)}
          </Button>
        ) : null}
      </div>
      <div className="space-y-1.5">
        <Label htmlFor={`${id}-machine`}>Machine</Label>
        <Select
          value={follows ? AUTO_MACHINE : (environmentId ?? AUTO_MACHINE)}
          disabled={props.disabled || follows}
          onValueChange={(value) => {
            if (value === AUTO_MACHINE) change({ environmentId: null });
            else if (value === labels.environmentId)
              change({ environmentId: labels.environmentId });
            else {
              const peer = labels.peers.find((candidate) => candidate.environmentId === value);
              if (peer !== undefined) change({ environmentId: peer.environmentId });
            }
          }}
        >
          <SelectTrigger id={`${id}-machine`} size="sm">
            <SelectValue>{machineLabel}</SelectValue>
          </SelectTrigger>
          <SelectPopup>
            <SelectItem value={AUTO_MACHINE}>Auto (balance load)</SelectItem>
            <SelectItem value={labels.environmentId}>
              {labels.environmentLabel} (this machine)
            </SelectItem>
            {labels.peers.map((peer) => {
              const hint = TASK_GRAPH_PEER_STATUS_HINT[peer.status];
              return (
                <SelectItem key={peer.environmentId} value={peer.environmentId}>
                  {hint === null ? peer.label : `${peer.label} (${hint})`}
                </SelectItem>
              );
            })}
            {stalePin !== null ? (
              <SelectItem value={stalePin}>{labels.machineLabel(stalePin)}</SelectItem>
            ) : null}
          </SelectPopup>
        </Select>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor={`${id}-workspace`}>Workspace</Label>
        <Select
          value={workspace}
          disabled={props.disabled}
          onValueChange={(value) => {
            const next = WORKSPACE_CHOICES.find((choice) => choice === value);
            if (next === undefined) return;
            // A continuing task runs where its dependency's worktree is, so a pin no longer applies.
            change(
              next === "dependency"
                ? { workspace: next, environmentId: null }
                : { workspace: next },
            );
          }}
        >
          <SelectTrigger id={`${id}-workspace`} size="sm">
            <SelectValue>
              {workspace === "worktree"
                ? "New worktree"
                : workspace === "root"
                  ? "Project folder (no worktree)"
                  : continueLabel}
            </SelectValue>
          </SelectTrigger>
          <SelectPopup>
            <SelectItem value="worktree">New worktree</SelectItem>
            <SelectItem value="dependency" disabled={dependency === null}>
              {continueLabel}
            </SelectItem>
            <SelectItem value="root">Project folder (no worktree)</SelectItem>
          </SelectPopup>
        </Select>
        <p className="text-xs text-muted-foreground">
          {workspace === "root"
            ? "Read-only work: no branch, commit or pull request."
            : workspace === "worktree"
              ? "Its own new worktree and branch."
              : dependency === null
                ? "Needs a dependency whose worktree it continues."
                : `Builds on ${dependency.title}'s branch, on the machine it ran on.`}
        </p>
      </div>
    </>
  );
}
