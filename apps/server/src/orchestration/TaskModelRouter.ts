import type {
  DelegateTaskInput,
  ModelSelection,
  TaskRoutingRule,
  TaskRoutingSettings,
} from "@t3tools/contracts";

/**
 * Context the router needs beyond the task itself: the lead thread's model (the
 * ultimate fallback), the configured routing rules, and an optional predicate
 * that reports whether a provider instance is currently usable.
 */
export interface TaskModelRouterContext {
  readonly parentModelSelection: ModelSelection;
  readonly routing?: TaskRoutingSettings | undefined;
  /** Returns false for instances that are disabled/uninstalled so we skip them. */
  readonly isInstanceEnabled?: ((instanceId: string) => boolean) | undefined;
}

const ruleMatches = (when: TaskRoutingRule["when"], task: DelegateTaskInput): boolean => {
  if (when.modelHint !== undefined && when.modelHint !== task.modelHint) {
    return false;
  }
  if (when.labelMatches !== undefined) {
    const label = task.label?.toLowerCase() ?? "";
    if (!label.includes(when.labelMatches.toLowerCase())) {
      return false;
    }
  }
  return true;
};

/**
 * Resolve which model a delegated sub-task should run on, using this priority
 * chain (mirrors the app's existing default-resolution order):
 *
 *   1. Explicit `task.modelSelection` (manual override).
 *   2. First matching routing rule's `use`.
 *   3. `routing.default`.
 *   4. The lead thread's model selection.
 *
 * Candidates whose instance is reported disabled are skipped; if every
 * candidate is disabled we still return the parent's selection so the sub-task
 * can run rather than fail to start.
 */
export const resolveTaskModelSelection = (
  task: DelegateTaskInput,
  context: TaskModelRouterContext,
): ModelSelection => {
  const candidates: Array<ModelSelection> = [];

  if (task.modelSelection !== undefined) {
    candidates.push(task.modelSelection);
  }

  const matchedRule = context.routing?.rules.find((rule) => ruleMatches(rule.when, task));
  if (matchedRule !== undefined) {
    candidates.push(matchedRule.use);
  }

  if (context.routing?.default !== undefined) {
    candidates.push(context.routing.default);
  }

  candidates.push(context.parentModelSelection);

  const isEnabled = context.isInstanceEnabled ?? (() => true);
  const usable = candidates.find((candidate) => isEnabled(candidate.instanceId));
  return usable ?? context.parentModelSelection;
};
