import { normalizeProjectPathForComparison } from "@t3tools/shared/path";

export type FirstRunDecision = "pending" | "app" | "wizard";

interface FirstRunWorkspaceInput {
  readonly primaryEnvironmentId: string | null;
  readonly serverCwd: string | null;
  readonly projects: ReadonlyArray<{
    readonly id: string;
    readonly environmentId: string;
    readonly workspaceRoot: string;
  }>;
  readonly threads: ReadonlyArray<{
    readonly projectId: string;
    readonly environmentId: string;
    readonly latestTurn: unknown;
    readonly latestUserMessageAt: string | null;
    readonly session: unknown;
  }>;
}

interface FirstRunDecisionInput {
  readonly enabled: boolean;
  readonly hydrated: boolean;
  readonly completed: boolean;
  readonly bootstrapped: boolean;
  readonly authoritative: boolean;
  readonly workspaceAuthoritative: boolean;
  readonly serverConfigAvailable: boolean;
  readonly workspaceFresh: boolean;
  readonly projectCount: number;
  readonly threadCount: number;
}

interface HostedFirstRunDecisionInput {
  readonly hydrated: boolean;
  readonly completed: boolean;
  readonly catalogReady: boolean;
  readonly environmentCount: number;
}

/** Only an untouched cwd-bootstrap project and its unused thread count as a fresh workspace. */
export function isFreshFirstRunWorkspace(input: FirstRunWorkspaceInput): boolean {
  if (input.projects.length > 1 || input.threads.length > 1) {
    return false;
  }

  const bootstrapProject = input.projects[0];
  if (bootstrapProject !== undefined) {
    if (
      input.serverCwd === null ||
      bootstrapProject.environmentId !== input.primaryEnvironmentId ||
      normalizeProjectPathForComparison(bootstrapProject.workspaceRoot) !==
        normalizeProjectPathForComparison(input.serverCwd)
    ) {
      return false;
    }
  }

  const bootstrapThread = input.threads[0];
  if (bootstrapThread === undefined) {
    return true;
  }

  return (
    bootstrapProject !== undefined &&
    bootstrapThread.environmentId === input.primaryEnvironmentId &&
    bootstrapThread.projectId === bootstrapProject.id &&
    bootstrapThread.latestTurn === null &&
    bootstrapThread.latestUserMessageAt === null &&
    bootstrapThread.session === null
  );
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
      persistCompletion:
        input.bootstrapped &&
        input.authoritative &&
        input.workspaceAuthoritative &&
        input.serverConfigAvailable,
    };
  }

  if (!input.bootstrapped || !input.authoritative || !input.serverConfigAvailable) {
    return { decision: "pending", persistCompletion: false };
  }

  return input.workspaceFresh
    ? { decision: "wizard", persistCompletion: false }
    : { decision: "app", persistCompletion: input.workspaceAuthoritative };
}

/** Hosted onboarding depends on saved environments because there is no primary server. */
export function resolveHostedFirstRunDecision(input: HostedFirstRunDecisionInput): {
  readonly decision: FirstRunDecision;
  readonly persistCompletion: boolean;
} {
  if (!input.hydrated) {
    return { decision: "pending", persistCompletion: false };
  }

  if (input.completed) {
    return { decision: "app", persistCompletion: false };
  }

  if (!input.catalogReady) {
    return { decision: "pending", persistCompletion: false };
  }

  return input.environmentCount === 0
    ? { decision: "wizard", persistCompletion: false }
    : { decision: "app", persistCompletion: true };
}
