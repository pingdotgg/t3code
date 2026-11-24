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

export interface ThreadTodoListEntry {
  readonly id: string;
  readonly steps: TodoListPlan["steps"];
}

/**
 * True when `next` takes over `previous` instead of adding to it: the earlier list never started
 * (a plan written in one turn and run in the next), or most of its steps reappear in the new one
 * (the agent rewrote or extended the same plan).
 */
function continuesList(previous: ThreadTodoListEntry, next: ThreadTodoListEntry): boolean {
  if (previous.steps.every((step) => step.status === "pending")) return true;
  const nextTexts = new Set(next.steps.map((step) => step.text.trim().toLowerCase()));
  const kept = previous.steps.filter((step) => nextTexts.has(step.text.trim().toLowerCase()));
  return kept.length * 2 >= previous.steps.length;
}

/**
 * Every task list of the thread in run order, one per run, newest last. The newest comes from
 * {@link selectLatestTodoList}; earlier runs use the last todo item each published (a closed run's
 * item holds its final steps). A list that continues the one before it replaces it. Earlier runs
 * whose items are not loaded yet are left out until thread history pages them in.
 */
export function selectThreadTodoLists(
  projection: Pick<ThreadStructure, "plans" | "runs" | "turnItems"> | null,
): ReadonlyArray<ThreadTodoListEntry> {
  if (projection === null) return [];
  const latest = selectLatestTodoList(projection);
  const ordinalByRun = new Map<string, number>();
  for (const run of projection.runs) ordinalByRun.set(run.id, run.ordinal);
  const superseded = new Set<string>();
  for (const plan of projection.plans) {
    if (plan.status === "superseded") superseded.add(String(plan.id));
  }
  const latestOrdinal = latest?.runId == null ? undefined : ordinalByRun.get(String(latest.runId));

  // The last todo item of each earlier run.
  const byRun = new Map<number, { itemOrdinal: number; entry: ThreadTodoListEntry }>();
  for (const item of projection.turnItems) {
    if (item.type !== "todo_list" || item.runId === null) continue;
    if (superseded.has(String(item.planId))) continue;
    const runOrdinal = ordinalByRun.get(String(item.runId));
    if (runOrdinal === undefined) continue;
    if (latestOrdinal !== undefined && runOrdinal >= latestOrdinal) continue;
    const current = byRun.get(runOrdinal);
    if (current !== undefined && current.itemOrdinal > item.ordinal) continue;
    byRun.set(runOrdinal, {
      itemOrdinal: item.ordinal,
      entry: { id: String(item.planId), steps: item.steps },
    });
  }

  const ordered = [...byRun.entries()]
    .sort(([left], [right]) => left - right)
    .map(([, value]) => value.entry);
  if (latest !== null) ordered.push({ id: String(latest.id), steps: latest.steps });

  const lists: ThreadTodoListEntry[] = [];
  for (const entry of ordered) {
    if (entry.steps.length === 0) continue;
    const previous = lists.at(-1);
    if (previous !== undefined && continuesList(previous, entry)) lists.pop();
    lists.push(entry);
  }
  return lists;
}
