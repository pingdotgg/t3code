import { normalizeProjectPathForComparison } from "@t3tools/shared/path";

export type FirstRunDecision = "pending" | "app" | "wizard";

export interface FirstRunGateState {
  readonly decision: FirstRunDecision;
  readonly stalled: boolean;
}

type FirstRunGateEvent =
  | { readonly type: "evidence"; readonly decision: FirstRunDecision }
  | { readonly type: "timeout" };

interface FirstRunWorkspaceInput {
  readonly primaryEnvironmentId: string | null;
  readonly serverCwd: string | null;
  readonly bootstrapProjectId?: string | undefined;
  readonly bootstrapThreadId?: string | undefined;
  readonly bootstrapProjectCreated?: boolean | undefined;
  readonly bootstrapThreadCreated?: boolean | undefined;
  readonly projects: ReadonlyArray<{
    readonly id: string;
    readonly environmentId: string;
    readonly workspaceRoot: string;
  }>;
  readonly threads: ReadonlyArray<{
    readonly id: string;
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
  readonly workspaceProvenanceAuthoritative: boolean;
  readonly catalogReady: boolean;
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

export function isFirstRunWorkspaceProvenanceAuthoritative(input: {
  readonly welcomeReceived: boolean;
  readonly bootstrapStatus: "pending" | "complete" | null;
}): boolean {
  // An empty catalog is not final while cwd auto-bootstrap is pending. Older
  // servers omit bootstrapStatus, so a received welcome with null stays valid.
  return input.welcomeReceived && input.bootstrapStatus !== "pending";
}

/** Keeps the authenticated app unmounted until workspace evidence settles. */
export function transitionFirstRunGateState(
  state: FirstRunGateState,
  event: FirstRunGateEvent,
): FirstRunGateState {
  if (event.type === "timeout") {
    return state.decision === "pending" && !state.stalled ? { ...state, stalled: true } : state;
  }

  if (
    state.decision === "wizard" ||
    event.decision === "pending" ||
    (state.decision === "app" && event.decision !== "wizard")
  ) {
    return state;
  }

  return { decision: event.decision, stalled: false };
}

/** Only a project and thread created by this startup count as a fresh nonempty workspace. */
export function isFreshFirstRunWorkspace(input: FirstRunWorkspaceInput): boolean {
  if (input.projects.length > 1 || input.threads.length > 1) {
    return false;
  }

  const bootstrapProject = input.projects[0];
  if (bootstrapProject !== undefined) {
    if (
      input.bootstrapProjectCreated !== true ||
      input.bootstrapProjectId !== bootstrapProject.id ||
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
    input.bootstrapThreadCreated === true &&
    input.bootstrapThreadId === bootstrapThread.id &&
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
        input.catalogReady &&
        input.serverConfigAvailable,
    };
  }

  if (
    !input.bootstrapped ||
    !input.authoritative ||
    !input.workspaceProvenanceAuthoritative ||
    !input.catalogReady ||
    !input.serverConfigAvailable
  ) {
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
