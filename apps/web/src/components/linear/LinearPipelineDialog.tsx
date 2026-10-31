import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { nextPipelineStartAttempt } from "@t3tools/client-runtime/pipeline-start";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type {
  EnvironmentId,
  LinearIssueDetail,
  PipelineDefinition,
  ProjectId,
} from "@t3tools/contracts";
import type { LinearIssueIncludes } from "@t3tools/shared/linearLaunch";
import { useNavigate } from "@tanstack/react-router";
import { RefreshCwIcon, WorkflowIcon } from "lucide-react";
import { useRef, useState } from "react";

import {
  pipelineCommentDescription,
  resolveLinearWriteBackRoute,
  resolvePipelineSelection,
} from "@t3tools/client-runtime/linear/pipeline-machines";
import { useEnvironmentSettings } from "../../hooks/useSettings";
import { randomUUID } from "../../lib/utils";
import { useProjects } from "../../state/entities";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useOrchestrationCommand } from "../../state/use-orchestration-command";
import { linearEnvironment } from "../../state/linear";
import { vcsEnvironment } from "../../state/vcs";
import { buildThreadRouteParams } from "../../threadRoutes";
import ChatMarkdown from "../ChatMarkdown";
import { useDraftPipelines } from "../chat/useDraftPipelines";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import {
  Dialog,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Radio, RadioGroup } from "../ui/radio-group";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Spinner } from "../ui/spinner";
import { Switch } from "../ui/switch";
import { Textarea } from "../ui/textarea";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { LinearStateIcon } from "./linearIcons";
import { LinearProjectSelect } from "./LinearProjectSelect";
import type { LinearLaunchWorkspace } from "@t3tools/client-runtime/linear/launch-plan";
import {
  includesFromSettings,
  pipelineInputSummary,
  pipelineInputText,
  pipelineLaunchRecord,
  pipelineWorkspaceStrategy,
  readLastUsedPipelineName,
  resolvePipelineLaunch,
  writeLastUsedPipelineName,
} from "@t3tools/client-runtime/linear/pipeline-dialog";
import { recordLinearLaunch } from "./recordLinearLaunch";
import {
  useLinearEnvironmentId,
  useLinearIssueDetail,
  useLinearStatus,
  useLinearTeamMetadata,
} from "./useLinearData";
import { useLinearAutoMachine, useLinearPipelineMachines } from "./useLinearPipelineMachines";

export function LinearPipelineDialog({
  issueId,
  initialPipelineId,
  onClose,
}: {
  readonly issueId: string;
  readonly initialPipelineId: string | undefined;
  readonly onClose: () => void;
}) {
  const environmentId = useLinearEnvironmentId();
  const detailQuery = useLinearIssueDetail(issueId);
  const detail = detailQuery.data;
  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogPopup className="max-w-2xl">
        {detail === null || environmentId === null ? (
          <>
            <DialogHeader>
              <DialogTitle>Run pipeline from issue</DialogTitle>
            </DialogHeader>
            <DialogPanel>
              <p className="flex items-center gap-2 text-sm text-muted-foreground">
                {detailQuery.error === null ? <Spinner size="sm" /> : null}
                {detailQuery.error ?? "Loading the issue..."}
              </p>
            </DialogPanel>
            <DialogFooter>
              <Button type="button" variant="outline" size="sm" onClick={onClose}>
                Close
              </Button>
            </DialogFooter>
          </>
        ) : (
          <PipelineDialogBody
            environmentId={environmentId}
            detail={detail}
            initialPipelineId={initialPipelineId}
            onClose={onClose}
          />
        )}
      </DialogPopup>
    </Dialog>
  );
}

function MiniStepper({ steps }: { readonly steps: PipelineDefinition["steps"] }) {
  return (
    <ol className="mt-2 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-muted-foreground">
      {steps.map((step, index) => (
        <li key={step.id} className="flex items-center gap-1.5">
          {index > 0 ? <span aria-hidden className="h-px w-3 bg-border" /> : null}
          <span
            aria-hidden
            className="flex size-4 items-center justify-center rounded-full bg-primary/15 text-3xs font-semibold text-primary"
          >
            {index + 1}
          </span>
          <span>{step.name}</span>
        </li>
      ))}
    </ol>
  );
}

function PipelineChoice({
  pipeline,
  selected,
  lastUsed,
}: {
  readonly pipeline: PipelineDefinition;
  readonly selected: boolean;
  readonly lastUsed: boolean;
}) {
  return (
    <label
      className={`block cursor-pointer rounded-lg border px-3 py-2.5 transition-colors ${selected ? "border-primary bg-primary/5" : "border-border/70 hover:bg-accent/40"}`}
    >
      <div className="flex items-center gap-2.5">
        <Radio value={pipeline.id} />
        <span className="text-sm font-medium text-foreground">{pipeline.name}</span>
        <span className="text-xs text-muted-foreground">
          {pipeline.steps.length} {pipeline.steps.length === 1 ? "step" : "steps"}
        </span>
        {lastUsed ? (
          <span className="ms-auto rounded border border-border px-1.5 py-px text-2xs text-muted-foreground">
            Last used
          </span>
        ) : null}
      </div>
      {selected ? (
        <MiniStepper steps={pipeline.steps} />
      ) : (
        <p className="mt-1 ps-6.5 text-xs text-muted-foreground">
          {pipeline.steps.map((step) => step.name).join(" → ")}
        </p>
      )}
    </label>
  );
}

function PipelineDialogBody({
  environmentId,
  detail,
  initialPipelineId,
  onClose,
}: {
  readonly environmentId: EnvironmentId;
  readonly detail: LinearIssueDetail;
  readonly initialPipelineId: string | undefined;
  readonly onClose: () => void;
}) {
  const { issue } = detail;
  const navigate = useNavigate();
  const storage = typeof window === "undefined" ? undefined : window.localStorage;
  const settings = useEnvironmentSettings(environmentId, (all) => all.linear);
  const states = useLinearTeamMetadata(issue.team.id).data?.states ?? null;
  const allProjects = useProjects();
  const projects = allProjects.filter((project) => project.environmentId === environmentId);
  const startPipelineRun = useOrchestrationCommand(serverEnvironment.startPipelineRun, {
    reportFailure: false,
  });
  const attemptRef = useRef<ReturnType<typeof nextPipelineStartAttempt> | null>(null);

  // The pick is remembered by name: the same pipeline has a different id on every machine.
  const [pipelineChoice, setPipelineChoice] = useState<string | null>(null);
  const [tab, setTab] = useState<"preview" | "edit">("preview");
  const [edited, setEdited] = useState<string | null>(null);
  const [includes, setIncludes] = useState<LinearIssueIncludes>(() =>
    includesFromSettings(settings),
  );
  const [projectChoice, setProjectChoice] = useState<ProjectId | null>(null);
  const [workspace, setWorkspace] = useState<LinearLaunchWorkspace>(settings.defaultWorkspace);
  const [moveChoice, setMoveChoice] = useState<boolean | null>(null);
  const [commentChoice, setCommentChoice] = useState<boolean | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const lastUsed = readLastUsedPipelineName(storage);
  const launch = resolvePipelineLaunch({
    issue,
    settings,
    teamStates: states,
    projectIds: projects.map((candidate) => candidate.id),
    choices: { projectId: projectChoice, move: moveChoice, comment: commentChoice },
  });
  const { mappedProjectId, projectId, moveTarget, moveEnabled, commentEnabled } = launch;
  const primaryProject = projects.find((candidate) => candidate.id === projectId) ?? null;

  const machineState = useLinearPipelineMachines(environmentId, primaryProject);
  const { machines } = machineState;
  const primaryPipelines = useDraftPipelines(environmentId, true);
  const pipelines = useDraftPipelines(machineState.listEnvironmentId, true);
  const requestedName =
    primaryPipelines.pipelines.find((candidate) => candidate.id === initialPipelineId)?.name ??
    null;
  const { pipeline, unmatchedName } = resolvePipelineSelection({
    pipelines: pipelines.pipelines,
    chosenName: pipelineChoice,
    requestedName,
    lastUsedName: lastUsed,
  });
  const pipelineId = pipeline?.id ?? null;

  const auto = useLinearAutoMachine({
    machines,
    active: machineState.effective === "auto",
    live: machineState.live,
    pipeline,
    latch: machineState.latch,
  });
  const targetEnvironmentId =
    machineState.effective === "auto"
      ? auto.state.kind === "picked"
        ? auto.state.environmentId
        : null
      : machineState.effective;
  const machine =
    machines.find((candidate) => candidate.environmentId === targetEnvironmentId) ?? null;
  const project =
    machine === null
      ? null
      : (allProjects.find(
          (candidate) =>
            candidate.environmentId === machine.environmentId && candidate.id === machine.projectId,
        ) ?? null);
  const isPrimaryRun = machine === null || machine.environmentId === environmentId;

  const primaryLinear = useLinearStatus().data;
  const machineLinear = useEnvironmentQuery(
    machine !== null && !isPrimaryRun
      ? linearEnvironment.status({ environmentId: machine.environmentId, input: {} })
      : null,
  ).data;
  const writeBackRoute =
    machine === null
      ? null
      : resolveLinearWriteBackRoute({
          runEnvironmentId: machine.environmentId,
          runMachineName: machine.label,
          primaryEnvironmentId: environmentId,
          primaryOrganizationId: primaryLinear?.organization?.id ?? null,
          runLinear:
            machineLinear === null
              ? null
              : {
                  state: machineLinear.state,
                  organizationId: machineLinear.organization?.id ?? null,
                },
        });

  const projectStatus = useEnvironmentQuery(
    machine !== null && project !== null && launch.mappedBaseBranch === null
      ? vcsEnvironment.status({
          environmentId: machine.environmentId,
          input: { cwd: project.workspaceRoot },
        })
      : null,
  );
  const baseRef = launch.mappedBaseBranch ?? projectStatus.data?.refName ?? null;

  const text = pipelineInputText({ detail, includes, edited });
  const summary = pipelineInputSummary({ detail, text });
  const canStart =
    !pending && pipeline !== null && machine !== null && project !== null && summary.startable;

  const updateIncludes = (key: keyof LinearIssueIncludes, checked: boolean) => {
    setIncludes((current) => ({ ...current, [key]: checked }));
  };

  const start = async () => {
    if (!canStart || pipeline === null || project === null || machine === null) return;
    setPending(true);
    setError(null);
    const workspaceStrategy = pipelineWorkspaceStrategy({
      workspace,
      baseRef,
      branchName: issue.branchName,
    });
    const attempt = (attemptRef.current = nextPipelineStartAttempt(
      attemptRef.current,
      { pipelineId: pipeline.id, projectId: project.id, input: text, workspace: workspaceStrategy },
      randomUUID,
    ));
    const result = await startPipelineRun({
      environmentId: machine.environmentId,
      input: {
        commandId: attempt.commandId,
        pipelineId: pipeline.id,
        projectId: project.id,
        input: text,
        workspaceStrategy,
        creationSource: "web",
      },
    });
    setPending(false);
    if (result._tag === "Failure") {
      const failure = squashAtomCommandFailure(result);
      setError(failure instanceof Error ? failure.message : "Failed to start the pipeline.");
      return;
    }
    const run = result.value.run;
    writeLastUsedPipelineName(storage, pipeline.name);
    // The run exists; linking it is best effort and never delays or blocks the launch.
    void recordLinearLaunch(
      pipelineLaunchRecord({
        environmentId: machine.environmentId,
        issue,
        pipelineName: pipeline.name,
        run,
        writeBack: { moveTo: moveTarget, moveEnabled, commentEnabled },
        ...(writeBackRoute === null ? {} : { route: writeBackRoute }),
      }),
    );
    onClose();
    const parentRef = scopeThreadRef(machine.environmentId, run.parentThreadId);
    toastManager.add(
      stackedThreadToast({
        type: "success",
        title: "Pipeline started",
        description: `${pipeline.name} on ${issue.identifier}${isPrimaryRun ? "" : ` · ${machine.label}`}`,
      }),
    );
    void navigate({ to: "/$environmentId/$threadId", params: buildThreadRouteParams(parentRef) });
  };

  const includeRows: ReadonlyArray<{
    key: keyof LinearIssueIncludes;
    label: string;
    count: number;
  }> = [
    { key: "subIssues", label: "Sub-issues", count: summary.counts.subIssues },
    { key: "comments", label: "Comments", count: summary.counts.comments },
    { key: "linkedPrs", label: "Linked PRs", count: summary.counts.linkedPrs },
  ];

  return (
    <>
      <DialogHeader>
        <div className="flex items-center gap-2">
          <WorkflowIcon aria-hidden className="size-4 text-muted-foreground" />
          <DialogTitle>Run pipeline from issue</DialogTitle>
        </div>
        <p className="flex min-w-0 items-center gap-1.5 text-sm text-muted-foreground">
          <LinearStateIcon type={issue.state.type} color={issue.state.color} />
          <span className="font-mono text-xs">{issue.identifier}</span>
          <span className="truncate text-foreground">{issue.title}</span>
        </p>
      </DialogHeader>
      <DialogPanel>
        <div className="space-y-4">
          <section className="space-y-1.5">
            <h3 className="text-xs font-medium text-muted-foreground">Pipeline</h3>
            {pipelines.pipelines.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                {pipelines.loaded
                  ? "No pipelines yet. Create one in Settings, then come back."
                  : "Loading pipelines..."}
              </p>
            ) : (
              <RadioGroup
                value={pipelineId}
                onValueChange={(value) =>
                  setPipelineChoice(
                    pipelines.pipelines.find((candidate) => candidate.id === value)?.name ?? null,
                  )
                }
              >
                {pipelines.pipelines.map((candidate) => (
                  <PipelineChoice
                    key={candidate.id}
                    pipeline={candidate}
                    selected={candidate.id === pipelineId}
                    lastUsed={candidate.name === lastUsed}
                  />
                ))}
              </RadioGroup>
            )}
            {unmatchedName !== null && pipeline !== null ? (
              <p role="status" className="text-xs text-muted-foreground">
                &quot;{unmatchedName}&quot; isn&apos;t on this machine, so {pipeline.name} is
                selected.
              </p>
            ) : null}
          </section>

          <section className="space-y-1.5">
            <div className="flex items-center justify-between gap-2">
              <h3 className="text-xs font-medium text-muted-foreground">
                Input{" "}
                <span className="font-normal">
                  · the pipeline&apos;s first step receives this as text
                </span>
              </h3>
              <div className="flex items-center gap-2">
                {edited !== null ? (
                  <Button type="button" variant="ghost" size="xs" onClick={() => setEdited(null)}>
                    Reset edits
                  </Button>
                ) : null}
                <div
                  role="tablist"
                  aria-label="Input view"
                  className="flex rounded-md bg-muted p-0.5 text-xs"
                >
                  {(["preview", "edit"] as const).map((value) => (
                    <button
                      key={value}
                      type="button"
                      role="tab"
                      aria-selected={tab === value}
                      onClick={() => setTab(value)}
                      className={`rounded px-2 py-0.5 capitalize ${tab === value ? "bg-background text-foreground shadow-xs" : "text-muted-foreground"}`}
                    >
                      {value}
                    </button>
                  ))}
                </div>
              </div>
            </div>
            <div className="overflow-hidden rounded-lg border border-border/70">
              {tab === "preview" ? (
                <div className="max-h-64 overflow-y-auto p-3 text-sm">
                  <ChatMarkdown text={text} cwd={undefined} />
                </div>
              ) : (
                <Textarea
                  aria-label="Pipeline input"
                  value={text}
                  onChange={(event) => setEdited(event.target.value)}
                  unstyled
                />
              )}
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-border/70 px-3 py-2 text-xs">
                {includeRows.map((row) => (
                  <label key={row.key} className="flex cursor-pointer items-center gap-1.5">
                    <Checkbox
                      checked={includes[row.key]}
                      disabled={row.count === 0 || edited !== null}
                      onCheckedChange={(checked) => updateIncludes(row.key, checked === true)}
                    />
                    {row.label}
                    <span className="text-muted-foreground">{row.count}</span>
                  </label>
                ))}
                <span
                  className={`ms-auto ${summary.overLimit ? "text-destructive-foreground" : "text-muted-foreground"}`}
                >
                  {summary.sizeLabel}
                </span>
              </div>
            </div>
          </section>

          <div className="grid gap-3 sm:grid-cols-2">
            {machines.length >= 2 ? (
              <section className="min-w-0 space-y-1.5 sm:col-span-2">
                <h3 className="text-xs font-medium text-muted-foreground">Machine</h3>
                <div className="flex items-center gap-2">
                  <Select
                    value={machineState.effective as string | null}
                    onValueChange={(value) => {
                      if (value !== null) machineState.choose(value as EnvironmentId | "auto");
                    }}
                  >
                    <SelectTrigger aria-label="Machine" className="min-w-0 flex-1">
                      <SelectValue>
                        {() => {
                          if (machineState.effective !== "auto") {
                            return machine?.label ?? "Choose a machine";
                          }
                          if (auto.state.kind === "checking") return "Checking machines…";
                          if (auto.state.kind === "unavailable") {
                            return "Auto balance unavailable. Choose a machine";
                          }
                          return `Auto balance · ${machine?.label ?? ""}`;
                        }}
                      </SelectValue>
                    </SelectTrigger>
                    <SelectPopup align="start" alignItemWithTrigger={false}>
                      {machineState.autoOffered ? (
                        <SelectItem value="auto">Auto balance</SelectItem>
                      ) : null}
                      {machines.map((candidate) => (
                        <SelectItem key={candidate.environmentId} value={candidate.environmentId}>
                          {candidate.label}
                        </SelectItem>
                      ))}
                    </SelectPopup>
                  </Select>
                  {machineState.effective === "auto" && auto.state.kind !== "checking" ? (
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-xs"
                      aria-label="Check machines again"
                      onClick={() => {
                        machineState.choose("auto");
                        auto.recheck();
                      }}
                    >
                      <RefreshCwIcon aria-hidden className="size-3.5" />
                    </Button>
                  ) : null}
                </div>
              </section>
            ) : null}
            <section className="min-w-0 space-y-1.5">
              <h3 className="text-xs font-medium text-muted-foreground">Project</h3>
              <LinearProjectSelect
                projects={projects}
                value={projectId}
                onValueChange={setProjectChoice}
                fromMapping={projectId !== null && projectId === mappedProjectId}
                size="default"
                className="w-full"
              />
            </section>
            <section className="min-w-0 space-y-1.5">
              <h3 className="text-xs font-medium text-muted-foreground">Workspace</h3>
              <Select
                value={workspace}
                onValueChange={(value) => {
                  if (value === "worktree" || value === "local") setWorkspace(value);
                }}
              >
                <SelectTrigger aria-label="Workspace" className="w-full">
                  <SelectValue>
                    {() =>
                      workspace === "worktree" ? (
                        <span className="flex min-w-0 items-baseline gap-2">
                          <span>New worktree</span>
                          <span className="truncate font-mono text-xs text-muted-foreground">
                            {issue.branchName}
                          </span>
                        </span>
                      ) : (
                        "Local checkout"
                      )
                    }
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup align="start" alignItemWithTrigger={false}>
                  <SelectItem value="worktree">
                    New worktree · {issue.branchName}
                    {baseRef ? ` from ${baseRef}` : ""}
                  </SelectItem>
                  <SelectItem value="local">Local checkout</SelectItem>
                </SelectPopup>
              </Select>
            </section>
          </div>

          <section className="divide-y divide-border/60 rounded-lg border border-border/70">
            <WriteBackRow
              title={
                moveTarget
                  ? `Move ${issue.identifier} to ${moveTarget.name}`
                  : `Move ${issue.identifier} to a started state`
              }
              description={
                moveTarget
                  ? `Currently ${issue.state.name}`
                  : `Not applicable: ${issue.identifier} is ${issue.state.name}`
              }
              checked={moveEnabled}
              disabled={moveTarget === null}
              onCheckedChange={setMoveChoice}
            />
            <WriteBackRow
              title="Comment on the issue"
              description={
                writeBackRoute === null
                  ? "One comment with a link, updated as each step finishes"
                  : pipelineCommentDescription(writeBackRoute)
              }
              checked={commentEnabled}
              onCheckedChange={setCommentChoice}
            />
          </section>

          {error !== null ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
        </div>
      </DialogPanel>
      <DialogFooter className="items-center sm:justify-between">
        <p className="text-xs text-muted-foreground">
          Steps use their own models. The run takes text only.
        </p>
        <div className="flex items-center gap-2">
          <Button type="button" variant="outline" size="sm" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button type="button" size="sm" disabled={!canStart} onClick={() => void start()}>
            {pending ? <Spinner size="sm" /> : null}
            Start pipeline
          </Button>
        </div>
      </DialogFooter>
    </>
  );
}

function WriteBackRow(props: {
  readonly title: string;
  readonly description: string;
  readonly checked: boolean;
  readonly disabled?: boolean;
  readonly onCheckedChange: (checked: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-3 px-3 py-2.5">
      <div className="min-w-0">
        <div className="text-sm font-medium text-foreground">{props.title}</div>
        <div className="text-xs text-muted-foreground">{props.description}</div>
      </div>
      <Switch
        aria-label={props.title}
        checked={props.checked}
        disabled={props.disabled}
        onCheckedChange={props.onCheckedChange}
      />
    </div>
  );
}
