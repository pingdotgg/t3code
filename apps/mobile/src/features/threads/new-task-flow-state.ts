import type { EnvironmentConnectionPhase } from "@t3tools/client-runtime/connection";
import type { EnvironmentShellStatus } from "@t3tools/client-runtime/state/shell";
import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import { scopedProjectKey } from "../../lib/scopedEntities";
import { appAtomRegistry } from "../../state/atom-registry";
import { isNewTaskDraftKey } from "../../state/new-task-draft-key";
import {
  draftRouteIdentity,
  isDraftThreadRoute,
  type NewTaskDraftRouteParams,
} from "./thread-route-state";

/** The flow a provider serves while no draft route is on the stack. */
export const INACTIVE_FLOW_KEY = "inactive";

/** The flow key for a draft Thread route: its key plus the draft it opened. */
export function newTaskFlowKey(route: {
  readonly key: string;
  readonly params?: object;
}): string | undefined {
  const draft = (route.params as { draft?: NewTaskDraftRouteParams } | undefined)?.draft;
  return draft ? `${route.key}:${draftRouteIdentity(draft)}` : undefined;
}

export interface NewTaskFlowState {
  readonly environmentId: EnvironmentId | null;
  readonly projectKey: string | null;
  readonly draftKey: string | null;
  readonly submitting: boolean;
  readonly expandedProvider: string | null;
}

export const INITIAL_NEW_TASK_FLOW_STATE: NewTaskFlowState = {
  environmentId: null,
  projectKey: null,
  draftKey: null,
  submitting: false,
  expandedProvider: null,
};

// Every draft route on the stack keeps its flow, not just the one the provider
// currently serves: a draft Thread pushed above draft A must not drop A's
// selection. Entries live exactly as long as their route (see prune below).
const flowStatesAtom = Atom.make<Readonly<Record<string, NewTaskFlowState>>>({}).pipe(
  Atom.keepAlive,
  Atom.withLabel("mobile:new-task-flows"),
);

export const newTaskFlowStateAtom = Atom.family((flowKey: string) =>
  Atom.make((get) => get(flowStatesAtom)[flowKey] ?? INITIAL_NEW_TASK_FLOW_STATE).pipe(
    Atom.withLabel("mobile:new-task-flow"),
  ),
);

export function readNewTaskFlowState(flowKey: string): NewTaskFlowState {
  return appAtomRegistry.get(flowStatesAtom)[flowKey] ?? INITIAL_NEW_TASK_FLOW_STATE;
}

export function updateNewTaskFlowState(flowKey: string, patch: Partial<NewTaskFlowState>): void {
  const flows = appAtomRegistry.get(flowStatesAtom);
  appAtomRegistry.set(flowStatesAtom, {
    ...flows,
    [flowKey]: { ...(flows[flowKey] ?? INITIAL_NEW_TASK_FLOW_STATE), ...patch },
  });
}

/**
 * What a draft route's `draftId` means for a flow that has not bound a draft
 * yet. Drafts hydrate from disk and projects arrive with the shell snapshot,
 * so on a cold launch or deep link the answer can be "pending" for a while.
 */
export type RouteDraftResolution =
  | { readonly kind: "none" }
  | { readonly kind: "pending" }
  | { readonly kind: "missing" }
  | { readonly kind: "open"; readonly flow: NewTaskFlowState };

export function resolveRouteDraft(input: {
  readonly flow: NewTaskFlowState;
  readonly routeDraftId: string | undefined;
  readonly draftsLoaded: boolean;
  readonly stamp:
    | { readonly environmentId: EnvironmentId; readonly projectId: ProjectId }
    | undefined;
  readonly projects: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly id: ProjectId;
  }>;
  /** See `stampedEnvironmentProjectsLoading`. */
  readonly stampedEnvironmentLoading: boolean;
}): RouteDraftResolution {
  const { routeDraftId, stamp } = input;
  if (routeDraftId === undefined || input.flow.draftKey !== null) return { kind: "none" };
  if (!input.draftsLoaded) return { kind: "pending" };
  if (!isNewTaskDraftKey(routeDraftId) || stamp === undefined) return { kind: "missing" };
  // The stamped project must be loaded: the composer falls back to the
  // environment's first project otherwise, and the draft would be sent
  // somewhere the user never chose.
  const loaded = input.projects.some(
    (project) => project.environmentId === stamp.environmentId && project.id === stamp.projectId,
  );
  if (!loaded) return input.stampedEnvironmentLoading ? { kind: "pending" } : { kind: "missing" };
  return {
    kind: "open",
    flow: {
      ...input.flow,
      environmentId: stamp.environmentId,
      projectKey: scopedProjectKey(stamp.environmentId, stamp.projectId),
      draftKey: routeDraftId,
    },
  };
}

/**
 * Whether the stamped environment may still deliver its project list. An
 * unknown, offline, or failed environment is settled, so a project it lacks
 * sends the route back to the picker. Mirrors `threadRouteIsHydrating`.
 */
export function stampedEnvironmentProjectsLoading(input: {
  readonly connectionsReady: boolean;
  readonly connectionState: EnvironmentConnectionPhase | null;
  readonly shellCacheRead: boolean;
  readonly shellStatus: EnvironmentShellStatus;
  readonly shellHasError: boolean;
}): boolean {
  if (input.shellHasError) return false;
  if (!input.connectionsReady) return true;
  if (input.connectionState === null) return false;
  if (!input.shellCacheRead) return true;
  // Only a first attempt is worth waiting out; a reconnecting environment's
  // retries leave its shell synchronizing.
  if (input.connectionState === "connecting") return true;
  if (input.connectionState !== "connected") return false;
  return input.shellStatus === "synchronizing" || input.shellStatus === "empty";
}

interface NavigationRoutes {
  readonly routes: ReadonlyArray<{
    readonly key: string;
    readonly name: string;
    readonly params?: object;
  }>;
}

/** Flow keys of the draft routes on the stack. */
export function liveNewTaskFlowKeys(state: NavigationRoutes): ReadonlySet<string> {
  return new Set(
    state.routes.flatMap((route) => {
      const flowKey = isDraftThreadRoute(route) ? newTaskFlowKey(route) : undefined;
      return flowKey === undefined ? [] : [flowKey];
    }),
  );
}

/**
 * Drops the flow of every draft route that left the stack: popped (discarded)
 * or promoted to a live thread, whose params no longer carry the draft.
 */
export function pruneNewTaskFlowStates(state: NavigationRoutes): void {
  const flows = appAtomRegistry.get(flowStatesAtom);
  const live = liveNewTaskFlowKeys(state);
  const kept = Object.entries(flows).filter(([flowKey]) => live.has(flowKey));
  if (kept.length === Object.keys(flows).length) return;
  appAtomRegistry.set(flowStatesAtom, Object.fromEntries(kept));
}
