import type { OrchestrationV2PlanArtifact } from "@t3tools/contracts";

import type { ThreadStructure } from "./models.ts";

export type TodoListPlan = Extract<OrchestrationV2PlanArtifact, { readonly kind: "todo_list" }>;

/**
 * The newest non-superseded todo list by run ordinal, then todo item ordinal, then plan id: the
 * server's bounded-snapshot rule, so live and reopened threads agree. Plan and item statuses are
 * ignored (an older plan can stay active); a run without a list yet keeps the previous one.
 */
export function selectLatestTodoList(
  projection: Pick<ThreadStructure, "plans" | "runs" | "turnItems"> | null,
): TodoListPlan | null {
  if (projection === null) return null;
  const ordinalByRun = new Map<string, number>();
  for (const run of projection.runs) ordinalByRun.set(run.id, run.ordinal);

  let topOrdinal = -1;
  let inTop: TodoListPlan[] = [];
  for (const plan of projection.plans) {
    if (plan.kind !== "todo_list" || plan.status === "superseded" || plan.runId === null) {
      continue;
    }
    const ordinal = ordinalByRun.get(plan.runId);
    if (ordinal === undefined || ordinal < topOrdinal) continue;
    if (ordinal > topOrdinal) {
      topOrdinal = ordinal;
      inTop = [];
    }
    inTop.push(plan);
  }

  let chosen: TodoListPlan | null = inTop.length === 1 ? inTop[0]! : null;
  if (inTop.length > 1) {
    const topRunId = inTop[0]!.runId;
    let bestItemOrdinal = -1;
    for (const item of projection.turnItems) {
      if (item.type !== "todo_list" || item.runId !== topRunId || item.ordinal <= bestItemOrdinal) {
        continue;
      }
      const plan = inTop.find((candidate) => candidate.id === item.planId);
      if (plan === undefined) continue;
      bestItemOrdinal = item.ordinal;
      chosen = plan;
    }
    if (chosen === null) {
      for (const plan of inTop) {
        if (chosen === null || String(plan.id) > String(chosen.id)) chosen = plan;
      }
    }
  }

  if (chosen === null || chosen.steps.length === 0) return null;
  return chosen;
}
