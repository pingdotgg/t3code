export type FirstRunDecision = "pending" | "app" | "wizard";

interface FirstRunDecisionInput {
  readonly enabled: boolean;
  readonly hydrated: boolean;
  readonly completed: boolean;
  readonly bootstrapped: boolean;
  readonly authoritative: boolean;
  readonly serverConfigAvailable: boolean;
  readonly workspaceFresh: boolean;
  readonly projectCount: number;
  readonly threadCount: number;
}

/** Cached projects may open the app, but only live workspace data may complete onboarding. */
export function resolveFirstRunDecision(input: FirstRunDecisionInput): {
  readonly decision: FirstRunDecision;
  readonly persistCompletion: boolean;
} {
  if (!input.enabled || (input.hydrated && input.completed)) {
    return { decision: "app", persistCompletion: false };
  }

  if (!input.hydrated) {
    return { decision: "pending", persistCompletion: false };
  }

  if (input.projectCount > 1 || input.threadCount > 1) {
    return {
      decision: "app",
      persistCompletion: input.authoritative && input.serverConfigAvailable,
    };
  }

  if (!input.bootstrapped || !input.authoritative || !input.serverConfigAvailable) {
    return { decision: "pending", persistCompletion: false };
  }

  return input.workspaceFresh
    ? { decision: "wizard", persistCompletion: false }
    : { decision: "app", persistCompletion: true };
}
