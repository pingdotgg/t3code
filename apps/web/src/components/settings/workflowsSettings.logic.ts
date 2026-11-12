import type { WorkflowQuestion, WorkflowRun } from "@t3tools/contracts";

export interface WorkflowQuestionView {
  readonly title: string;
  readonly choices: ReadonlyArray<string>;
  readonly body: string | null;
}

function field(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)[key]
    : undefined;
}

/**
 * What a question shows. `request` is whatever the workflow handed `ask`, so a part that is
 * missing or of another shape is left out instead of failing the whole list.
 */
export function readWorkflowQuestion(question: WorkflowQuestion): WorkflowQuestionView {
  const title = field(question.request, "title");
  const choices = field(question.request, "choices");
  const body = field(field(question.request, "data"), "body");
  return {
    title: typeof title === "string" && title.trim() !== "" ? title : question.name,
    choices: Array.isArray(choices)
      ? choices.filter((choice): choice is string => typeof choice === "string")
      : [],
    body: typeof body === "string" && body.trim() !== "" ? body : null,
  };
}

export interface NestedWorkflowRun {
  readonly run: WorkflowRun;
  /** How many listed runs sit between this one and a run nothing listed invoked. */
  readonly depth: number;
}

/**
 * Puts each invoked run under the run that invoked it, keeping the given order among siblings.
 * A run whose parent is not in the list stays at the top level.
 */
export function nestWorkflowRuns(
  runs: ReadonlyArray<WorkflowRun>,
): ReadonlyArray<NestedWorkflowRun> {
  const listed = new Set(runs.map((run) => run.runId));
  const children = new Map<string, WorkflowRun[]>();
  const roots: WorkflowRun[] = [];
  for (const run of runs) {
    if (run.parentRunId === null || !listed.has(run.parentRunId)) {
      roots.push(run);
      continue;
    }
    const siblings = children.get(run.parentRunId);
    if (siblings) siblings.push(run);
    else children.set(run.parentRunId, [run]);
  }
  const nested: NestedWorkflowRun[] = [];
  const place = (run: WorkflowRun, depth: number) => {
    nested.push({ run, depth });
    for (const child of children.get(run.runId) ?? []) place(child, depth + 1);
  };
  for (const root of roots) place(root, 0);
  return nested;
}

/** The line under a run's name: what it waits on, why it paused, or how it ended. */
export function workflowRunDetail(run: Pick<WorkflowRun, "status" | "detail">): string | null {
  if (run.detail === null || run.detail.trim() === "") return null;
  return run.status === "waiting" ? `Waiting on ${run.detail}` : run.detail;
}

export function workflowRunStatusVariant(status: WorkflowRun["status"]) {
  switch (status) {
    case "running":
      return "info";
    case "waiting":
      return "warning";
    case "paused":
      return "error";
    case "completed":
      return "success";
    case "stopped":
      return "outline";
    case "cancelled":
      return "secondary";
  }
}
