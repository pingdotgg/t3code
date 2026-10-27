import {
  draftRouteIdentity,
  isDraftThreadRoute,
  type NewTaskDraftRouteParams,
} from "./thread-route-state";

/** The flow key for a draft Thread route: its key plus the draft it opened. */
export function newTaskFlowKey(route: {
  readonly key: string;
  readonly params?: object;
}): string | undefined {
  const draft = (route.params as { draft?: NewTaskDraftRouteParams } | undefined)?.draft;
  return draft ? `${route.key}:${draftRouteIdentity(draft)}` : undefined;
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
