import type { OrchestrationThreadGoal } from "@t3tools/contracts";

export function goalStatusLabel(status: OrchestrationThreadGoal["status"]): string {
  switch (status) {
    case "active":
      return "Active";
    case "paused":
      return "Paused";
    case "budgetLimited":
      return "Budget limited";
    case "complete":
      return "Complete";
  }
}

export function goalStatusToastTitle(goal: OrchestrationThreadGoal): string {
  return `Goal ${goalStatusLabel(goal.status).toLowerCase()}`;
}

export function formatGoalDuration(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m`;
  return `${seconds}s`;
}

export function formatGoalTokens(goal: OrchestrationThreadGoal): string {
  const used = goal.tokensUsed.toLocaleString();
  return goal.tokenBudget === null ? used : `${used} / ${goal.tokenBudget.toLocaleString()}`;
}

export function formatGoalStatusToastDescription(goal: OrchestrationThreadGoal): string {
  return `${goal.objective} · ${formatGoalDuration(goal.timeUsedSeconds)} · ${formatGoalTokens(goal)} tokens`;
}
