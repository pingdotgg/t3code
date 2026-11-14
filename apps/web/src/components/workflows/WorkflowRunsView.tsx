import { type EnvironmentId } from "@t3tools/contracts";
import { WorkflowIcon } from "lucide-react";
import { useState, type ReactNode } from "react";

import { cn } from "../../lib/utils";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { Button } from "../ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../ui/empty";
import { ScrollArea } from "../ui/scroll-area";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import {
  RelativeLabel,
  WORKFLOW_TONE_CLASS,
  WorkflowChip,
  WorkflowRunFeed,
  WorkflowStateWord,
  type WorkflowThreadTarget,
} from "./WorkflowRunFeed";
import {
  allWorkflowRunNodes,
  defaultWorkflowListTab,
  defaultWorkflowRunId,
  groupWorkflowRuns,
  workflowRunLists,
  workflowRunNow,
  workflowTriggerLine,
  type WorkflowListTab,
  type WorkflowRunNode,
} from "./workflows.logic";

const WORKFLOWS_GUIDE_URL = "https://github.com/pingdotgg/t3code/blob/main/docs/user/workflows.md";
const EVERY_WORKFLOW = "";
const TABS: ReadonlyArray<{ readonly value: WorkflowListTab; readonly label: string }> = [
  { value: "needs-you", label: "Needs you" },
  { value: "running", label: "Running" },
  { value: "all", label: "All" },
];
const NOTHING: Record<WorkflowListTab, string> = {
  "needs-you": "Nothing waits on you.",
  running: "Nothing is running.",
  all: "No runs yet.",
};

export function WorkflowsEmpty({
  title,
  description,
}: {
  readonly title: string;
  readonly description: ReactNode;
}) {
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center p-6">
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <WorkflowIcon />
          </EmptyMedia>
          <EmptyTitle>{title}</EmptyTitle>
          <EmptyDescription>{description}</EmptyDescription>
        </EmptyHeader>
      </Empty>
    </div>
  );
}

/** One environment's runs: the list to pick from, and the picked run told as a feed. */
export function WorkflowRunsView({
  environmentId,
  selectedRunId,
  openThreadId,
  onSelect,
  onOpenThread,
  onOpenDefinitions,
}: {
  readonly environmentId: EnvironmentId;
  readonly selectedRunId: string | null;
  /** The agent thread shown beside the run. With one open, the list makes room below `xl`. */
  readonly openThreadId: string | null;
  readonly onSelect: (runId: string | null) => void;
  readonly onOpenThread: (thread: WorkflowThreadTarget) => void;
  readonly onOpenDefinitions: () => void;
}) {
  const live = useEnvironmentQuery(serverEnvironment.workflowsLive({ environmentId, input: {} }));
  const [pickedTab, setPickedTab] = useState<WorkflowListTab | null>(null);
  const [workflow, setWorkflow] = useState(EVERY_WORKFLOW);
  const snapshot = live.data;
  if (live.error) {
    return <WorkflowsEmpty title="Could not load workflow runs" description={live.error} />;
  }
  if (!snapshot) {
    return (
      <p className="p-6 text-sm text-muted-foreground" role="status">
        Loading workflow runs…
      </p>
    );
  }
  if (snapshot.runs.length === 0 && snapshot.workflows.length === 0) {
    return (
      <WorkflowsEmpty
        title="No workflow runs yet"
        description={
          <>
            A workflow ties agents, code, schedules and questions to you into one run that survives
            restarts. Start the server with <code className="font-mono">T3CODE_WORKFLOWS</code> set
            to a definitions file.{" "}
            <a
              href={WORKFLOWS_GUIDE_URL}
              target="_blank"
              rel="noreferrer"
              className="underline underline-offset-2 hover:text-foreground"
            >
              Read the guide
            </a>
          </>
        }
      />
    );
  }
  const groups = groupWorkflowRuns(snapshot.workflows, snapshot.runs, snapshot.questions);
  const lists = workflowRunLists(groups);
  const all = allWorkflowRunNodes(groups);
  const section = groups.workflows.find((candidate) => candidate.name === workflow) ?? null;
  const shownRunId =
    all.find((node) => node.run.runId === selectedRunId)?.run.runId ?? defaultWorkflowRunId(groups);
  const shown = all.find((node) => node.run.runId === shownRunId) ?? null;
  // A run that another invoked is not in the list itself; the one it is part of stands for it.
  const listedFor = (node: WorkflowRunNode | null): string | null => {
    if (node === null) return null;
    const parent = all.find((candidate) => candidate.run.runId === node.run.parentRunId);
    return parent === undefined ? node.run.runId : listedFor(parent);
  };
  const currentRunId = listedFor(shown);
  // A run opened by its link is shown in a list that has it, so the list never points at nothing.
  const opening = defaultWorkflowListTab(groups);
  const holds = (candidate: WorkflowListTab) =>
    lists[candidate].some((node) => node.run.runId === currentRunId);
  const tab =
    pickedTab ??
    (selectedRunId === null || holds(opening) ? opening : holds("running") ? "running" : "all");
  const listed = lists[tab].filter(
    (node) => section === null || node.run.workflow === section.name,
  );
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      {snapshot.definition?.problem == null ? null : (
        <div
          role="alert"
          className="flex shrink-0 items-center gap-3 border-b bg-destructive/4 px-4 py-2 text-xs"
        >
          <span className="min-w-0 flex-1 text-muted-foreground">
            <span className="font-medium text-destructive-foreground">
              The definitions file does not load.
            </span>{" "}
            The last version that did keeps running.
          </span>
          <Button size="xs" variant="outline" onClick={onOpenDefinitions}>
            Open the file
          </Button>
        </div>
      )}
      <div className="flex min-h-0 min-w-0 flex-1">
        {/* Below md there is room for one of the two: the list, or the run picked from it. */}
        <div
          className={cn(
            "min-h-0 w-full shrink-0 flex-col md:w-72 md:border-e",
            selectedRunId === null ? "flex" : "hidden",
            openThreadId === null ? "md:flex" : "xl:flex",
          )}
        >
          <div className="space-y-2 p-2 pb-1">
            <ToggleGroup
              aria-label="Which runs"
              className="w-full *:flex-1"
              value={[tab]}
              onValueChange={(next) => {
                const value = TABS.find((candidate) => candidate.value === next[0]);
                if (value !== undefined) setPickedTab(value.value);
              }}
            >
              {TABS.map(({ value, label }) => (
                <Toggle key={value} value={value}>
                  {label}
                  {value === "all" || lists[value].length === 0 ? null : (
                    <span
                      className={cn(
                        "tabular-nums",
                        value === "needs-you"
                          ? cn("font-semibold", WORKFLOW_TONE_CLASS.input)
                          : "text-muted-foreground",
                      )}
                    >
                      {lists[value].length}
                    </span>
                  )}
                </Toggle>
              ))}
            </ToggleGroup>
            {groups.workflows.length > 1 ? (
              <Select
                value={workflow}
                onValueChange={(value) => setWorkflow(value ?? EVERY_WORKFLOW)}
              >
                <SelectTrigger size="sm" aria-label="Workflow">
                  <SelectValue>
                    {section === null ? `All ${groups.workflows.length} workflows` : section.name}
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup>
                  <SelectItem value={EVERY_WORKFLOW}>All workflows</SelectItem>
                  {groups.workflows.map((candidate) => (
                    <SelectItem key={candidate.name} value={candidate.name}>
                      <span className="flex items-center gap-2">
                        <WorkflowChip name={candidate.name} />
                        {candidate.name}
                      </span>
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            ) : null}
            {section === null ? null : (
              <p className="px-1 text-xs text-muted-foreground">{workflowTriggerLine(section)}</p>
            )}
          </div>
          <ScrollArea className="min-h-0 flex-1">
            <nav aria-label="Workflow runs" className="p-2 pt-1">
              {listed.length === 0 ? (
                <p className="px-2 py-6 text-center text-xs text-muted-foreground">
                  {section?.neverRan ? "Has not run yet." : NOTHING[tab]}
                </p>
              ) : (
                <ul className="space-y-0.5">
                  {listed.map((node) => (
                    <WorkflowRunListItem
                      key={node.run.runId}
                      node={node}
                      current={node.run.runId === currentRunId}
                      onSelect={onSelect}
                    />
                  ))}
                </ul>
              )}
            </nav>
          </ScrollArea>
        </div>
        <ScrollArea
          className={cn(
            "@container/feed min-h-0 min-w-0 flex-1",
            selectedRunId === null ? "hidden md:block" : "block",
          )}
        >
          {shown === null ? null : (
            <WorkflowRunFeed
              key={shown.run.runId}
              environmentId={environmentId}
              node={shown}
              parent={all.find((node) => node.run.runId === shown.run.parentRunId)?.run ?? null}
              openThreadId={openThreadId}
              onSelect={onSelect}
              onOpenThread={onOpenThread}
            />
          )}
        </ScrollArea>
      </div>
    </div>
  );
}

/** A run in the thread list's own shape: which workflow, its state in a word, and what it is at. */
function WorkflowRunListItem({
  node,
  current,
  onSelect,
}: {
  readonly node: WorkflowRunNode;
  readonly current: boolean;
  readonly onSelect: (runId: string | null) => void;
}) {
  const { run } = node;
  return (
    <li>
      <button
        type="button"
        aria-current={current ? "true" : undefined}
        className={cn(
          "flex w-full cursor-pointer flex-col gap-0.5 rounded-lg px-2 py-1.5 text-left focus-visible:ring-2 focus-visible:ring-ring/70 focus-visible:outline-none focus-visible:ring-inset",
          current ? "bg-accent" : "hover:bg-accent/50",
        )}
        onClick={() => onSelect(run.runId)}
      >
        <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
          <WorkflowChip name={run.workflow} />
          <span className="min-w-0 flex-1 truncate">{run.workflow}</span>
          <WorkflowStateWord node={node} />
        </span>
        <span className="truncate text-sm text-foreground">{run.title}</span>
        <span className="flex min-w-0 gap-1.5 text-xs text-muted-foreground">
          <span className="min-w-0 flex-1 truncate">{workflowRunNow(node)}</span>
          <span className="shrink-0">
            <RelativeLabel value={run.updatedAt} />
          </span>
        </span>
      </button>
    </li>
  );
}
