import {
  defaultSkillEvalArms,
  type ModelSelection,
  ProjectId,
  SkillEvalRunControlInput,
  SkillEvalRunDetail,
  SkillEvalRunSummary,
  SkillEvalTask,
  SkillEvalTaskExpectation,
  SkillEvalTaskMutateInput,
  SkillModelCell,
  SkillVariantRule,
} from "@t3tools/contracts";
import { CheckIcon, FlaskConicalIcon, PlusIcon, XIcon } from "lucide-react";
import { useState } from "react";

import { Alert, AlertDescription, AlertTitle } from "../../ui/alert";
import { Badge } from "../../ui/badge";
import { Button } from "../../ui/button";
import { Checkbox } from "../../ui/checkbox";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../../ui/dialog";
import { Input } from "../../ui/input";
import { Label } from "../../ui/label";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../../ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../../ui/table";
import { Textarea } from "../../ui/textarea";
import { SkillVerdictBadge } from "./SkillVerdictBadge";
import {
  activeRunAction,
  armEvidenceSummary,
  formatCost,
  formatCount,
  formatDuration,
  formatEffect,
  formatInterval,
  formatPValue,
  formatRate,
  runJudgeCallCount,
  runTrialCount,
} from "./skillsSettings.logic";

interface ProjectOption {
  readonly id: ProjectId;
  readonly title: string;
}

function runStatusVariant(
  status: SkillEvalRunSummary["status"],
): "success" | "error" | "warning" | "outline" {
  if (status === "completed") return "success";
  if (status === "failed") return "error";
  if (status === "cancelled" || status === "interrupted") return "warning";
  return "outline";
}

function TaskDialog({
  open,
  skillName,
  projects,
  task,
  busy,
  onOpenChange,
  onMutate,
}: {
  readonly open: boolean;
  readonly skillName: string;
  readonly projects: readonly ProjectOption[];
  readonly task: SkillEvalTask | null;
  readonly busy: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onMutate: (input: SkillEvalTaskMutateInput) => void;
}) {
  const [projectId, setProjectId] = useState<ProjectId | "">(
    task?.projectId ?? projects[0]?.id ?? "",
  );
  const [promptType, setPromptType] = useState(task?.promptType ?? "direct");
  const [prompt, setPrompt] = useState(task?.prompt ?? "");
  const [rubric, setRubric] = useState(task?.rubric ?? "");
  const [expectation, setExpectation] = useState<SkillEvalTaskExpectation>(
    task?.expectation ?? "either",
  );
  const [baseRef, setBaseRef] = useState(task?.baseRef ?? "");
  const complete = projectId !== "" && promptType.trim() && prompt.trim() && rubric.trim();

  const submit = () => {
    if (!complete) return;
    if (task) {
      onMutate({
        action: "update",
        taskId: task.taskId,
        promptType: promptType.trim(),
        prompt: prompt.trim(),
        rubric: rubric.trim(),
        expectation,
        baseRef: baseRef.trim() || null,
      });
      onOpenChange(false);
      return;
    }
    onMutate({
      action: "add",
      skillName,
      projectId,
      promptType: promptType.trim(),
      prompt: prompt.trim(),
      rubric: rubric.trim(),
      expectation,
      baseRef: baseRef.trim() || null,
    });
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>{task ? "Edit evaluation task" : "Add evaluation task"}</DialogTitle>
          <DialogDescription>
            Define one independent prompt and the criteria used to compare its treatment and
            control.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="skill-eval-project">Project</Label>
              <Select
                value={projectId as string}
                disabled={task !== null}
                onValueChange={(value) => setProjectId((value ?? "") as ProjectId | "")}
              >
                <SelectTrigger id="skill-eval-project">
                  <SelectValue>
                    {projects.find((project) => project.id === projectId)?.title ??
                      "Choose project"}
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup>
                  {projects.map((project) => (
                    <SelectItem key={project.id} value={project.id}>
                      {project.title}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="skill-eval-prompt-type">Prompt type</Label>
                <Input
                  id="skill-eval-prompt-type"
                  value={promptType}
                  onChange={(event) => setPromptType(event.currentTarget.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="skill-eval-expectation">Expected activation</Label>
                <Select
                  value={expectation}
                  onValueChange={(value) =>
                    setExpectation((value ?? "either") as SkillEvalTaskExpectation)
                  }
                >
                  <SelectTrigger id="skill-eval-expectation">
                    <SelectValue>{expectation}</SelectValue>
                  </SelectTrigger>
                  <SelectPopup>
                    <SelectItem value="should-use">Should use</SelectItem>
                    <SelectItem value="should-not-use">Should not use</SelectItem>
                    <SelectItem value="either">Either</SelectItem>
                  </SelectPopup>
                </Select>
              </div>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="skill-eval-prompt">Prompt</Label>
              <Textarea
                id="skill-eval-prompt"
                value={prompt}
                onChange={(event) => setPrompt(event.currentTarget.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="skill-eval-rubric">Rubric</Label>
              <Textarea
                id="skill-eval-rubric"
                value={rubric}
                onChange={(event) => setRubric(event.currentTarget.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="skill-eval-base-ref">Base ref (optional)</Label>
              <Input
                id="skill-eval-base-ref"
                placeholder="main"
                value={baseRef}
                onChange={(event) => setBaseRef(event.currentTarget.value)}
              />
            </div>
          </div>
        </DialogPanel>
        <DialogFooter>
          <Button variant="ghost" disabled={busy} onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={busy || !complete} onClick={submit}>
            {task ? "Save task" : "Add task"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

function StartRunDialog({
  open,
  skillName,
  cell,
  rules,
  tasks,
  projects,
  candidateForProject,
  busy,
  onOpenChange,
  onControl,
}: {
  readonly open: boolean;
  readonly skillName: string;
  readonly cell: SkillModelCell;
  readonly rules: readonly SkillVariantRule[];
  readonly tasks: readonly SkillEvalTask[];
  readonly projects: readonly ProjectOption[];
  readonly candidateForProject: (projectId: ProjectId) => ModelSelection | null;
  readonly busy: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onControl: (input: SkillEvalRunControlInput) => void;
}) {
  const availableTasks = tasks.filter((task) => task.archivedAt === null);
  const initialProjectId =
    availableTasks.find((task) => candidateForProject(task.projectId) !== null)?.projectId ??
    availableTasks[0]?.projectId ??
    projects[0]?.id ??
    ("" as ProjectId | "");
  const [projectId, setProjectId] = useState<ProjectId | "">(initialProjectId);
  const projectTasks = availableTasks.filter((task) => task.projectId === projectId);
  const candidate = projectId === "" ? null : candidateForProject(projectId);
  const [selectedTaskIds, setSelectedTaskIds] = useState<ReadonlySet<string>>(
    () => new Set(projectTasks.map((task) => task.taskId)),
  );
  const [repeats, setRepeats] = useState(3);
  const [judgeSamples, setJudgeSamples] = useState(3);
  const [concurrency, setConcurrency] = useState(1);
  const selectedRule = rules.find((rule) => rule.ruleId === cell.ruleId) ?? null;
  const arms = defaultSkillEvalArms({
    effectiveMode: cell.effectiveMode,
    ruleId: cell.ruleId,
  });
  const config =
    projectId && candidate
      ? {
          skillName,
          projectId,
          candidate,
          arms,
          repeats,
          judge: null,
          judgeSamples,
          concurrency,
          taskIds: projectTasks
            .filter((task) => selectedTaskIds.has(task.taskId))
            .map((task) => task.taskId),
          variantRevisions:
            selectedRule !== null ? { [selectedRule.ruleId]: selectedRule.revision } : {},
        }
      : null;

  const selectProject = (value: string | null) => {
    const next = (value ?? "") as ProjectId | "";
    setProjectId(next);
    setSelectedTaskIds(
      new Set(availableTasks.filter((task) => task.projectId === next).map((task) => task.taskId)),
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>Start evaluation</DialogTitle>
          <DialogDescription>
            Compare the current effective skill policy with its default control using independent
            task repeats.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="space-y-5">
            <Alert variant="warning">
              <AlertTitle>Runs create real agent turns</AlertTitle>
              <AlertDescription>
                More repeats improve trial reliability but multiply agent turns. More judge samples
                improve comparison stability but multiply judge calls. The defaults use three
                repeats and three judge samples. Review both counts before starting; provider costs
                may be unavailable.
              </AlertDescription>
            </Alert>
            <div className="space-y-1.5">
              <Label htmlFor="skill-run-project">Project</Label>
              <Select value={projectId as string} onValueChange={selectProject}>
                <SelectTrigger id="skill-run-project">
                  <SelectValue>
                    {projects.find((project) => project.id === projectId)?.title ??
                      "Choose project"}
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup>
                  {projects.map((project) => (
                    <SelectItem key={project.id} value={project.id}>
                      {project.title}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            </div>
            <fieldset className="space-y-2">
              <legend className="text-sm font-medium">Tasks</legend>
              {projectTasks.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  Add an active task for this project first.
                </p>
              ) : (
                projectTasks.map((task) => (
                  <label key={task.taskId} className="flex items-start gap-3 rounded-lg border p-3">
                    <Checkbox
                      checked={selectedTaskIds.has(task.taskId)}
                      onCheckedChange={(checked) => {
                        const next = new Set(selectedTaskIds);
                        if (checked) next.add(task.taskId);
                        else next.delete(task.taskId);
                        setSelectedTaskIds(next);
                      }}
                    />
                    <span className="min-w-0 text-sm">
                      <span className="block font-medium">{task.promptType}</span>
                      <span className="block truncate text-muted-foreground">{task.prompt}</span>
                    </span>
                  </label>
                ))
              )}
            </fieldset>
            <div className="grid gap-4 sm:grid-cols-3">
              <div className="space-y-1.5">
                <Label htmlFor="skill-run-repeats">Repeats</Label>
                <Input
                  id="skill-run-repeats"
                  type="number"
                  min={1}
                  max={5}
                  value={repeats}
                  onChange={(event) => setRepeats(Number(event.currentTarget.value))}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="skill-run-judge-samples">Judge samples</Label>
                <Input
                  id="skill-run-judge-samples"
                  type="number"
                  min={1}
                  max={3}
                  value={judgeSamples}
                  onChange={(event) => setJudgeSamples(Number(event.currentTarget.value))}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="skill-run-concurrency">Concurrency</Label>
                <Input
                  id="skill-run-concurrency"
                  type="number"
                  min={1}
                  max={4}
                  value={concurrency}
                  onChange={(event) => setConcurrency(Number(event.currentTarget.value))}
                />
              </div>
            </div>
            <div className="rounded-xl border p-4 text-sm">
              <div className="font-medium">
                {candidate
                  ? `${cell.driver} · ${candidate.model}`
                  : `No enabled ${cell.driver} provider instance`}
              </div>
              {config ? (
                <p className="mt-1 text-muted-foreground">
                  {runTrialCount(config)} trial turns + {runJudgeCallCount(config)} judge calls
                </p>
              ) : null}
            </div>
          </div>
        </DialogPanel>
        <DialogFooter>
          <Button variant="ghost" disabled={busy} onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            disabled={
              busy ||
              config === null ||
              config.taskIds.length === 0 ||
              !Number.isInteger(repeats) ||
              repeats < 1 ||
              repeats > 5 ||
              !Number.isInteger(judgeSamples) ||
              judgeSamples < 1 ||
              judgeSamples > 3 ||
              !Number.isInteger(concurrency) ||
              concurrency < 1 ||
              concurrency > 4
            }
            onClick={() => {
              if (!config) return;
              onControl({ action: "start", config });
              onOpenChange(false);
            }}
          >
            Start run
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

function CompletionMetric({
  label,
  rate,
  low,
  high,
}: {
  readonly label: string;
  readonly rate: number | null;
  readonly low: number | null;
  readonly high: number | null;
}) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="text-sm font-medium">
        {formatRate(rate)} <span className="font-normal">(95% CI {formatInterval(low, high)})</span>
      </dd>
    </div>
  );
}

function RunDetail({ detail }: { readonly detail: SkillEvalRunDetail }) {
  const trialCounts = new Map<string, number>();
  for (const trial of detail.trials) {
    trialCounts.set(trial.status, (trialCounts.get(trial.status) ?? 0) + 1);
  }

  return (
    <div className="space-y-4 rounded-xl border p-4">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant={runStatusVariant(detail.status)}>{detail.status}</Badge>
        <span className="text-xs text-muted-foreground">
          {detail.config.taskIds.length} independent tasks · {detail.config.repeats} repeats
        </span>
      </div>
      <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
        {[...trialCounts].map(([status, count]) => (
          <span key={status}>
            {status}: {count}
          </span>
        ))}
      </div>
      {detail.error ? (
        <Alert variant="error">
          <AlertTitle>Run failed</AlertTitle>
          <AlertDescription>{detail.error}</AlertDescription>
        </Alert>
      ) : null}
      {detail.armResults.map((result) =>
        result.role === "control" ? (
          <article key={result.armId} className="space-y-3 rounded-xl bg-muted/35 p-4">
            <div>
              <h4 className="text-sm font-semibold">{result.label}</h4>
              <p className="text-xs text-muted-foreground">
                Baseline arm. Treatment arms are compared against it.
              </p>
            </div>
            <dl className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              <CompletionMetric
                label="Completion"
                rate={result.completion.rate}
                low={result.completion.ciLow}
                high={result.completion.ciHigh}
              />
              <div>
                <dt className="text-xs text-muted-foreground">Trigger accuracy</dt>
                <dd className="text-sm font-medium">
                  {formatRate(result.triggerAccuracy.rate)} ({result.triggerAccuracy.matched}/
                  {result.triggerAccuracy.total})
                </dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">Median tokens</dt>
                <dd className="text-sm font-medium">{formatCount(result.medianTokens)}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">Median duration</dt>
                <dd className="text-sm font-medium">{formatDuration(result.medianDurationMs)}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">Median cost</dt>
                <dd className="text-sm font-medium">{formatCost(result.medianCostUsd)}</dd>
              </div>
            </dl>
          </article>
        ) : (
          <article key={result.armId} className="space-y-3 rounded-xl bg-muted/35 p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <h4 className="text-sm font-semibold">{result.label}</h4>
                <p className="text-xs text-muted-foreground">{armEvidenceSummary(result)}</p>
                <p className="text-xs text-muted-foreground">
                  {result.nTasks} independent tasks · {result.repeats} repeats
                </p>
              </div>
              <SkillVerdictBadge verdict={result.verdict} />
            </div>
            <dl className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              <CompletionMetric
                label="Completion"
                rate={result.completion.rate}
                low={result.completion.ciLow}
                high={result.completion.ciHigh}
              />
              <CompletionMetric
                label="Control completion"
                rate={result.controlCompletion.rate}
                low={result.controlCompletion.ciLow}
                high={result.controlCompletion.ciHigh}
              />
              <div>
                <dt className="text-xs text-muted-foreground">Trigger accuracy</dt>
                <dd className="text-sm font-medium">
                  {formatRate(result.triggerAccuracy.rate)} ({result.triggerAccuracy.matched}/
                  {result.triggerAccuracy.total})
                </dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">Median tokens</dt>
                <dd className="text-sm font-medium">{formatCount(result.medianTokens)}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">Median duration</dt>
                <dd className="text-sm font-medium">{formatDuration(result.medianDurationMs)}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">Median cost</dt>
                <dd className="text-sm font-medium">{formatCost(result.medianCostUsd)}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">Paired token difference</dt>
                <dd className="text-sm font-medium">
                  {formatCount(result.pairedMedianTokenDifference)}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">Paired duration difference</dt>
                <dd className="text-sm font-medium">
                  {formatDuration(result.pairedMedianDurationMsDifference)}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">Paired cost difference</dt>
                <dd className="text-sm font-medium">
                  {formatCost(result.pairedMedianCostUsdDifference)}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">Rubric difference</dt>
                <dd className="text-sm font-medium">{formatEffect(result.rubricDifference)}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">Position consistency</dt>
                <dd className="text-sm font-medium">{formatRate(result.positionConsistency)}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">Judge model</dt>
                <dd className="text-sm font-medium">{result.judge?.model ?? "unknown"}</dd>
              </div>
            </dl>
            {result.sameFamilyAsCandidate ? (
              <p className="text-xs text-warning-foreground">
                The judge is from the same model family as the candidate, which may bias preference
                scores.
              </p>
            ) : null}
            {result.promptTypeResults.length > 0 ? (
              <div className="space-y-2">
                <div>
                  <h5 className="text-xs font-medium">Exploratory prompt-type slices</h5>
                  <p className="text-xs text-muted-foreground">
                    These estimates and intervals are exploratory and do not receive verdicts.
                  </p>
                </div>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Prompt type</TableHead>
                      <TableHead>Tasks</TableHead>
                      <TableHead>Effect, 95% CI, Holm p</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {result.promptTypeResults.map((promptType) => (
                      <TableRow key={promptType.promptType}>
                        <TableCell>{promptType.promptType}</TableCell>
                        <TableCell>{promptType.nTasks}</TableCell>
                        <TableCell>
                          {formatEffect(promptType.effect)} · 95% CI{" "}
                          {formatInterval(promptType.ciLow, promptType.ciHigh)} ·{" "}
                          {formatPValue(promptType.pAdjusted)}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            ) : null}
          </article>
        ),
      )}
    </div>
  );
}

export function SkillEvaluationPanel({
  skillName,
  cell,
  rules,
  tasks,
  runs,
  runDetail,
  runDetailPending,
  runDetailError,
  selectedRunId,
  projects,
  candidateForProject,
  canMutateTasks,
  canControlRuns,
  taskBusy,
  runBusy,
  onSelectRun,
  onRefreshRunDetail,
  onMutateTask,
  onControlRun,
}: {
  readonly skillName: string;
  readonly cell: SkillModelCell;
  readonly rules: readonly SkillVariantRule[];
  readonly tasks: readonly SkillEvalTask[];
  readonly runs: readonly SkillEvalRunSummary[];
  readonly runDetail: SkillEvalRunDetail | null;
  readonly runDetailPending: boolean;
  readonly runDetailError: string | null;
  readonly selectedRunId: string | null;
  readonly projects: readonly ProjectOption[];
  readonly candidateForProject: (projectId: ProjectId) => ModelSelection | null;
  readonly canMutateTasks: boolean;
  readonly canControlRuns: boolean;
  readonly taskBusy: boolean;
  readonly runBusy: boolean;
  readonly onSelectRun: (evalRunId: string) => void;
  readonly onRefreshRunDetail: () => void;
  readonly onMutateTask: (input: SkillEvalTaskMutateInput) => void;
  readonly onControlRun: (input: SkillEvalRunControlInput) => void;
}) {
  const [taskDialog, setTaskDialog] = useState<{ open: boolean; task: SkillEvalTask | null }>({
    open: false,
    task: null,
  });
  const [runDialogOpen, setRunDialogOpen] = useState(false);
  const permissionReason = canMutateTasks ? undefined : "Requires settings-write permission.";
  const runPermissionReason = canControlRuns
    ? undefined
    : "Requires orchestration-operate permission.";

  return (
    <section className="space-y-6" aria-labelledby="skill-evaluation-heading">
      <div>
        <h3 id="skill-evaluation-heading" className="text-sm font-semibold">
          Evaluation
        </h3>
        <p className="text-xs text-muted-foreground">
          Controlled comparisons reduce confounding. Fewer than 50 independent tasks provide
          smoke-test evidence only; 50–99 tasks require twice the minimum important effect and
          adjusted statistical evidence excluding zero; 100 or more use the standard gate. Usage
          evidence elsewhere on this page remains observational.
        </p>
      </div>

      <div className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h4 className="text-sm font-medium">Task set</h4>
          <Button
            size="xs"
            variant="outline"
            disabled={taskBusy || !canMutateTasks || projects.length === 0}
            title={permissionReason}
            onClick={() => setTaskDialog({ open: true, task: null })}
          >
            <PlusIcon />
            Add task
          </Button>
        </div>
        {!canMutateTasks ? (
          <p className="text-xs text-muted-foreground">
            Task changes are disabled because this connection lacks settings-write permission.
          </p>
        ) : null}
        {tasks.length === 0 ? (
          <p className="rounded-xl border border-dashed p-4 text-sm text-muted-foreground">
            No evaluation tasks yet.
          </p>
        ) : (
          <div className="divide-y rounded-xl border">
            {tasks.map((task) => (
              <div key={task.taskId} className="space-y-2 p-3">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-medium">{task.promptType}</span>
                      <Badge variant={task.archivedAt ? "outline" : "secondary"}>
                        {task.archivedAt ? "Archived" : task.expectation}
                      </Badge>
                    </div>
                    <p className="mt-1 line-clamp-2 text-sm text-muted-foreground">{task.prompt}</p>
                  </div>
                  <div className="flex gap-2">
                    {task.archivedAt === null ? (
                      <Button
                        size="xs"
                        variant="ghost"
                        disabled={taskBusy || !canMutateTasks}
                        title={permissionReason}
                        onClick={() => setTaskDialog({ open: true, task })}
                      >
                        Edit
                      </Button>
                    ) : null}
                    <Button
                      size="xs"
                      variant="outline"
                      disabled={taskBusy || !canMutateTasks}
                      title={permissionReason}
                      onClick={() =>
                        onMutateTask({
                          action: task.archivedAt ? "restore" : "archive",
                          taskId: task.taskId,
                        })
                      }
                    >
                      {task.archivedAt ? (
                        <>
                          <CheckIcon /> Restore
                        </>
                      ) : (
                        <>
                          <XIcon /> Archive
                        </>
                      )}
                    </Button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h4 className="text-sm font-medium">Runs</h4>
          <Button
            size="xs"
            disabled={
              runBusy ||
              !canControlRuns ||
              !tasks.some(
                (task) => task.archivedAt === null && candidateForProject(task.projectId) !== null,
              )
            }
            title={runPermissionReason}
            onClick={() => setRunDialogOpen(true)}
          >
            <FlaskConicalIcon />
            Start evaluation
          </Button>
        </div>
        {!canControlRuns ? (
          <p className="text-xs text-muted-foreground">
            Eval controls are disabled because this connection lacks orchestration-operate
            permission.
          </p>
        ) : null}
        {runs.length === 0 ? (
          <p className="rounded-xl border border-dashed p-4 text-sm text-muted-foreground">
            No evaluation runs yet.
          </p>
        ) : (
          <div className="divide-y rounded-xl border">
            {runs.map((run) => {
              const action = activeRunAction(run);
              return (
                <div key={run.evalRunId} className="flex flex-wrap items-center gap-3 p-3">
                  <button
                    type="button"
                    className="min-w-0 flex-1 text-left"
                    onClick={() => onSelectRun(run.evalRunId)}
                  >
                    <span className="flex flex-wrap items-center gap-2">
                      <Badge variant={runStatusVariant(run.status)}>{run.status}</Badge>
                      <span className="text-xs text-muted-foreground">
                        {run.config.candidate.model} · {run.config.taskIds.length} tasks ·{" "}
                        {run.config.repeats} repeats
                      </span>
                    </span>
                  </button>
                  {action ? (
                    <Button
                      size="xs"
                      variant="outline"
                      disabled={runBusy || !canControlRuns}
                      title={runPermissionReason}
                      onClick={() => onControlRun({ action, evalRunId: run.evalRunId })}
                    >
                      {action === "cancel" ? "Cancel" : "Resume"}
                    </Button>
                  ) : null}
                </div>
              );
            })}
          </div>
        )}
        {selectedRunId && runDetailError ? (
          <Alert variant="error">
            <AlertTitle>Could not load run details</AlertTitle>
            <AlertDescription>{runDetailError}</AlertDescription>
            <Button size="xs" variant="outline" onClick={onRefreshRunDetail}>
              Try again
            </Button>
          </Alert>
        ) : null}
        {selectedRunId && runDetailPending && runDetail === null ? (
          <p className="text-sm text-muted-foreground">Loading run details…</p>
        ) : null}
        {selectedRunId && runDetail ? <RunDetail detail={runDetail} /> : null}
      </div>

      {taskDialog.open ? (
        <TaskDialog
          key={taskDialog.task?.taskId ?? "new"}
          open={taskDialog.open}
          skillName={skillName}
          projects={projects}
          task={taskDialog.task}
          busy={taskBusy}
          onOpenChange={(open) => setTaskDialog((current) => ({ ...current, open }))}
          onMutate={onMutateTask}
        />
      ) : null}
      {runDialogOpen ? (
        <StartRunDialog
          key={`${cell.driver}:${cell.model}`}
          open={runDialogOpen}
          skillName={skillName}
          cell={cell}
          rules={rules}
          tasks={tasks}
          projects={projects}
          candidateForProject={candidateForProject}
          busy={runBusy}
          onOpenChange={setRunDialogOpen}
          onControl={onControlRun}
        />
      ) : null}
    </section>
  );
}
