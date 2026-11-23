import { type EnvironmentId, type WorkflowRunReference } from "@t3tools/contracts";
import { msg, T, useGT, useMessages } from "gt-react";
import { CircleAlertIcon, WorkflowIcon } from "lucide-react";
import { useState, type ReactNode } from "react";

import { cn } from "../../lib/utils";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { Alert, AlertAction, AlertDescription } from "../ui/alert";
import { Button, ContentButton, InlineButton } from "../ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../ui/empty";
import { ScrollArea } from "../ui/scroll-area";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import {
  RelativeLabel,
  WorkflowChip,
  WorkflowRunFeed,
  WorkflowStateWord,
  type WorkflowThreadTarget,
} from "./WorkflowRunFeed";
import type { WorkflowPaneTab } from "./workflowPane.logic";
import {
  allWorkflowRunNodes,
  defaultWorkflowListTab,
  defaultWorkflowRunId,
  groupWorkflowRuns,
  listedWorkflowRuns,
  workflowRunLists,
  workflowRunNow,
  workflowTriggerLine,
  type WorkflowListTab,
  type WorkflowRunNode,
  workflowRunInvolves,
} from "@t3tools/client-runtime/workflows";

const WORKFLOWS_GUIDE_URL = "https://github.com/pingdotgg/t3code/blob/main/docs/user/workflows.md";
const EVERY_WORKFLOW = "";
const TABS: ReadonlyArray<{ readonly value: WorkflowListTab; readonly label: string }> = [
  {
    value: "needs-you",
    label: msg("Needs you", { $context: "tab: workflow runs that wait on the user" }),
  },
  { value: "running", label: msg("Running", { $context: "tab: workflow runs under way" }) },
  { value: "all", label: msg("All", { $context: "tab: every workflow run" }) },
];
const NOTHING: Record<WorkflowListTab, string> = {
  "needs-you": msg("Nothing waits on you."),
  running: msg("Nothing is running."),
  all: msg("No runs yet."),
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
  paneOpen,
  shownTab,
  onSelect,
  onOpenThread,
  onOpenReference,
  onOpenDefinitions,
}: {
  readonly environmentId: EnvironmentId;
  readonly selectedRunId: string | null;
  /** Something is open beside the run, so the list makes room below `xl`. */
  readonly paneOpen: boolean;
  /** What shows beside the run, so what opened it can say so. */
  readonly shownTab: WorkflowPaneTab | null;
  readonly onSelect: (runId: string | null) => void;
  readonly onOpenThread: (runId: string, thread: WorkflowThreadTarget) => void;
  readonly onOpenReference: (runId: string, reference: WorkflowRunReference) => void;
  readonly onOpenDefinitions: () => void;
}) {
  const live = useEnvironmentQuery(serverEnvironment.workflowsLive({ environmentId, input: {} }));
  const [pickedTab, setPickedTab] = useState<WorkflowListTab | null>(null);
  const [workflow, setWorkflow] = useState(EVERY_WORKFLOW);
  const gt = useGT();
  const m = useMessages();
  const [showSkipped, setShowSkipped] = useState(false);
  const snapshot = live.data;
  if (live.error) {
    return <WorkflowsEmpty title={gt("Could not load workflow runs")} description={live.error} />;
  }
  if (!snapshot) {
    return (
      <p className="p-6 text-body text-muted-foreground" role="status">
        <T>Loading workflow runs…</T>
      </p>
    );
  }
  // A broken file is said even where nothing has run, or its workflows would just seem missing.
  const problemAlert =
    snapshot.definition?.problem == null ? null : (
      <Alert variant="error" density="strip" edge="bottom" className="shrink-0">
        <CircleAlertIcon aria-hidden />
        <AlertDescription>
          <p>
            <T>
              <span className="text-label text-destructive-foreground">
                A workflow file has a problem.
              </span>{" "}
              The last version that did keeps running.
            </T>
          </p>
        </AlertDescription>
        <AlertAction>
          <Button size="xs" variant="secondary" onClick={onOpenDefinitions}>
            <T>Open the file</T>
          </Button>
        </AlertAction>
      </Alert>
    );
  const withProblem = (empty: ReactNode) =>
    problemAlert === null ? (
      empty
    ) : (
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {problemAlert}
        {empty}
      </div>
    );
  const notHere = (
    <WorkflowsEmpty
      title={gt("This run is not here")}
      description={
        <T>
          This environment has no run with that link.{" "}
          <InlineButton tone="muted" onClick={() => onSelect(null)}>
            Back to the runs
          </InlineButton>
        </T>
      }
    />
  );
  // A link to a run says it is not here, even where nothing has run at all.
  if (snapshot.runs.length === 0 && snapshot.workflows.length === 0 && selectedRunId !== null) {
    return withProblem(notHere);
  }
  if (snapshot.runs.length === 0 && snapshot.workflows.length === 0) {
    return withProblem(
      <WorkflowsEmpty
        title={gt("No workflow runs yet")}
        description={
          <T>
            A workflow ties agents, code, schedules and questions to you into one run that survives
            restarts. Write one under{" "}
            <InlineButton tone="muted" onClick={onOpenDefinitions}>
              Definitions
            </InlineButton>
            , or ask an agent to.{" "}
            <InlineButton
              tone="muted"
              render={<a href={WORKFLOWS_GUIDE_URL} target="_blank" rel="noreferrer" />}
            >
              Read the guide
            </InlineButton>
          </T>
        }
      />,
    );
  }
  // A skipped run opened by its link is shown all the same.
  const openedSkipped = snapshot.runs.some(
    (run) => run.runId === selectedRunId && run.status === "skipped",
  );
  const visible = listedWorkflowRuns(snapshot.runs, showSkipped || openedSkipped);
  const groups = groupWorkflowRuns(snapshot.workflows, visible.runs, snapshot.questions);
  const lists = workflowRunLists(groups);
  const all = allWorkflowRunNodes(groups);
  const section = groups.workflows.find((candidate) => candidate.name === workflow) ?? null;
  // A run the address names is that run or none: another one's buttons would act on the wrong run.
  const shownRunId =
    selectedRunId === null
      ? defaultWorkflowRunId(groups)
      : (all.find((node) => node.run.runId === selectedRunId)?.run.runId ?? null);
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
    (node) => section === null || workflowRunInvolves(node, section.name),
  );
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      {problemAlert}
      <div className="@container/runs flex min-h-0 min-w-0 flex-1">
        {/* Below @2xl there is room for one of the two: the list, or the run picked from it. */}
        <div
          className={cn(
            "min-h-0 w-full shrink-0 flex-col @2xl/runs:w-72 @2xl/runs:border-e @2xl/runs:border-divider",
            selectedRunId === null ? "flex" : "hidden",
            paneOpen ? "@4xl/runs:flex" : "@2xl/runs:flex",
          )}
        >
          <div className="space-y-2 p-2 pb-1">
            <ToggleGroup
              aria-label={gt("Which runs")}
              className="w-full *:flex-1"
              value={[tab]}
              onValueChange={(next) => {
                const value = TABS.find((candidate) => candidate.value === next[0]);
                if (value !== undefined) setPickedTab(value.value);
              }}
            >
              {TABS.map(({ value, label }) => (
                <Toggle key={value} value={value}>
                  {m(label)}
                </Toggle>
              ))}
            </ToggleGroup>
            {groups.workflows.length > 1 ? (
              <Select
                value={workflow}
                onValueChange={(value) => setWorkflow(value ?? EVERY_WORKFLOW)}
              >
                <SelectTrigger
                  size="sm"
                  aria-label={gt("Workflow", { $context: "picker that filters runs by workflow" })}
                >
                  <SelectValue>
                    {section === null
                      ? gt("All {count} workflows", { count: groups.workflows.length })
                      : section.name}
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup>
                  <SelectItem value={EVERY_WORKFLOW}>
                    <T>All workflows</T>
                  </SelectItem>
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
              <p className="px-1 text-meta text-muted-foreground">
                {workflowTriggerLine(section, m)}
              </p>
            )}
          </div>
          <ScrollArea className="min-h-0 flex-1">
            <nav aria-label={gt("Workflow runs")} className="p-2 pt-1">
              {listed.length === 0 ? (
                <p className="px-2 py-6 text-center text-meta text-muted-foreground">
                  {section?.neverRan ? gt("Has not run yet.") : m(NOTHING[tab])}
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
              {tab === "all" && visible.skipped > 0 && !openedSkipped ? (
                <div className="flex justify-center pt-2">
                  <Button size="xs" variant="ghost" onClick={() => setShowSkipped(!showSkipped)}>
                    {showSkipped
                      ? gt("Hide skipped")
                      : gt("Show {count} skipped", { count: visible.skipped })}
                  </Button>
                </div>
              ) : null}
            </nav>
          </ScrollArea>
        </div>
        <ScrollArea
          className={cn(
            "@container/feed min-h-0 min-w-0 flex-1",
            selectedRunId === null ? "hidden @2xl/runs:block" : "block",
          )}
        >
          {shown === null ? (
            selectedRunId === null ? null : (
              notHere
            )
          ) : (
            <WorkflowRunFeed
              key={shown.run.runId}
              environmentId={environmentId}
              node={shown}
              parent={all.find((node) => node.run.runId === shown.run.parentRunId)?.run ?? null}
              shownTab={shownTab}
              onSelect={onSelect}
              onOpenThread={(thread) => onOpenThread(shown.run.runId, thread)}
              onOpenReference={(reference) => onOpenReference(shown.run.runId, reference)}
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
  const m = useMessages();
  return (
    <li>
      <ContentButton
        aria-current={current ? "true" : undefined}
        className="group/run block w-full cursor-pointer text-left"
        onClick={() => onSelect(run.runId)}
      >
        <span
          className={cn(
            "flex w-full flex-col gap-0.5 rounded-row px-2.5 py-2 group-focus-visible/run:ring-2 group-focus-visible/run:ring-ring/70 group-focus-visible/run:ring-inset",
            current ? "surface-selected" : "group-hover/run:surface-ghost-hover",
          )}
        >
          <span className="flex min-w-0 items-center gap-1.5 text-meta text-muted-foreground">
            <WorkflowChip name={run.workflow} />
            <span className="min-w-0 flex-1 truncate">{run.workflow}</span>
            <WorkflowStateWord node={node} />
          </span>
          <span className="truncate text-body text-foreground">{run.title}</span>
          <span className="flex min-w-0 gap-1.5 text-meta text-muted-foreground">
            <span className="min-w-0 flex-1 truncate">{workflowRunNow(node, m)}</span>
            <span className="shrink-0">
              <RelativeLabel value={run.updatedAt} />
            </span>
          </span>
        </span>
      </ContentButton>
    </li>
  );
}
