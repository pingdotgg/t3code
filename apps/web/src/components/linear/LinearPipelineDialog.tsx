import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { nextPipelineStartAttempt } from "@t3tools/client-runtime/pipeline-start";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type {
  EnvironmentId,
  LinearIssueDetail,
  PipelineDefinition,
  ProjectId,
} from "@t3tools/contracts";
import {
  resolveLinearMapping,
  resolveLinearMoveTarget,
  type LinearIssueIncludes,
} from "@t3tools/shared/linearLaunch";
import { useNavigate } from "@tanstack/react-router";
import { WorkflowIcon } from "lucide-react";
import { useRef, useState } from "react";

import { useEnvironmentSettings } from "../../hooks/useSettings";
import { randomUUID } from "../../lib/utils";
import { useProjects } from "../../state/entities";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useOrchestrationCommand } from "../../state/use-orchestration-command";
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
import type { LinearLaunchWorkspace } from "./linearLaunchTypes";
import {
  includesFromSettings,
  pipelineInputSummary,
  pipelineInputText,
  pipelineWorkspaceStrategy,
  readLastUsedPipelineId,
  resolveInitialPipelineId,
  writeLastUsedPipelineId,
} from "./linearPipelineDialog.logic";
import { recordLinearLaunch } from "./recordLinearLaunch";
import {
  useLinearEnvironmentId,
  useLinearIssueDetail,
  useLinearTeamMetadata,
} from "./useLinearData";

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
  const pipelines = useDraftPipelines(environmentId, true);
  const projects = useProjects().filter((project) => project.environmentId === environmentId);
  const startPipelineRun = useOrchestrationCommand(serverEnvironment.startPipelineRun, {
    reportFailure: false,
  });
  const attemptRef = useRef<ReturnType<typeof nextPipelineStartAttempt> | null>(null);

  const mapping = resolveLinearMapping(issue, settings.mappings);
  const mappedProjectId =
    mapping !== null && projects.some((project) => project.id === mapping.projectRef)
      ? mapping.projectRef
      : null;
  const moveTarget =
    states === null
      ? null
      : resolveLinearMoveTarget({
          currentStateType: issue.state.type,
          teamStates: states,
          preferredStateId: settings.moveToStateId,
        });

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

  const lastUsed = readLastUsedPipelineId(storage);
  const pipelineId =
    pipelineChoice ??
    resolveInitialPipelineId({
      pipelineIds: pipelines.pipelines.map((pipeline) => pipeline.id),
      requested: initialPipelineId,
      lastUsed,
    });
  const pipeline = pipelines.pipelines.find((candidate) => candidate.id === pipelineId) ?? null;
  const projectId = projectChoice ?? mappedProjectId;
  const project = projects.find((candidate) => candidate.id === projectId) ?? null;
  const moveEnabled = (moveChoice ?? settings.moveToStateEnabled) && moveTarget !== null;
  const commentEnabled = commentChoice ?? settings.commentEnabled;

  const projectStatus = useEnvironmentQuery(
    project !== null && mapping?.baseBranch == null
      ? vcsEnvironment.status({ environmentId, input: { cwd: project.workspaceRoot } })
      : null,
  );
  const baseRef =
    projectId !== null && projectId === mappedProjectId && mapping?.baseBranch
      ? mapping.baseBranch
      : (projectStatus.data?.refName ?? null);

  const text = pipelineInputText({ detail, includes, edited });
  const summary = pipelineInputSummary({ detail, text });
  const canStart = !pending && pipeline !== null && project !== null && text.trim().length > 0;

  const updateIncludes = (key: keyof LinearIssueIncludes, checked: boolean) => {
    setIncludes((current) => ({ ...current, [key]: checked }));
    // Toggling an include regenerates the text; a hand edit would otherwise hide the change.
    setEdited(null);
  };

  const start = async () => {
    if (!canStart || pipeline === null || project === null) return;
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
      environmentId,
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
    writeLastUsedPipelineId(storage, pipeline.id);
    // The run exists; linking it is best effort and never delays or blocks the launch.
    void recordLinearLaunch({
      environmentId,
      issueId: issue.id,
      identifier: issue.identifier,
      target: {
        kind: "pipeline_run",
        targetId: run.id,
        threadId: run.parentThreadId,
        title: `${pipeline.name}: ${issue.identifier} ${issue.title}`,
      },
      writeBack: {
        ...(moveEnabled && moveTarget ? { moveToStateId: moveTarget.id } : {}),
        comment: commentEnabled,
      },
    });
    onClose();
    const parentRef = scopeThreadRef(environmentId, run.parentThreadId);
    toastManager.add(
      stackedThreadToast({
        type: "success",
        title: "Pipeline started",
        description: `${pipeline.name} on ${issue.identifier}`,
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
                onValueChange={(value) => setPipelineChoice(value as string)}
              >
                {pipelines.pipelines.map((candidate) => (
                  <PipelineChoice
                    key={candidate.id}
                    pipeline={candidate}
                    selected={candidate.id === pipelineId}
                    lastUsed={candidate.id === lastUsed}
                  />
                ))}
              </RadioGroup>
            )}
          </section>

          <section className="space-y-1.5">
            <div className="flex items-center justify-between gap-2">
              <h3 className="text-xs font-medium text-muted-foreground">
                Input{" "}
                <span className="font-normal">
                  · the pipeline&apos;s first step receives this as text
                </span>
              </h3>
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
                      disabled={row.count === 0}
                      onCheckedChange={(checked) => updateIncludes(row.key, checked === true)}
                    />
                    {row.label}
                    <span className="text-muted-foreground">{row.count}</span>
                  </label>
                ))}
                <span className="ms-auto text-muted-foreground">{summary.tokens}</span>
              </div>
            </div>
          </section>

          <div className="grid gap-3 sm:grid-cols-2">
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
              description="One comment with a link, updated as each step finishes"
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
