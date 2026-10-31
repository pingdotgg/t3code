import type { LinearScope, LinearSearch } from "@t3tools/client-runtime/linear/search";

/** Deep-link paths of the Linear screens; Stack.tsx registers them as the routes' linking. */
export const LINEAR_LINK_PATHS = {
  LinearWorkspace: "linear/:environmentId",
  LinearTeam: "linear/:environmentId/team/:teamId",
  LinearProject: "linear/:environmentId/team/:teamId/project/:projectId",
  LinearMilestone: "linear/:environmentId/team/:teamId/project/:projectId/milestone/:milestoneId",
  LinearIssue: "linear/:environmentId/issue/:issueId",
} as const;

export type LinearRouteParams = {
  readonly LinearWorkspace: { readonly environmentId: string };
  readonly LinearTeam: { readonly environmentId: string; readonly teamId: string };
  readonly LinearProject: {
    readonly environmentId: string;
    readonly teamId: string;
    readonly projectId: string;
  };
  readonly LinearMilestone: {
    readonly environmentId: string;
    readonly teamId: string;
    readonly projectId: string;
    readonly milestoneId: string;
  };
  readonly LinearIssue: { readonly environmentId: string; readonly issueId: string };
};

type LinearDrillRoute =
  | { readonly name: "LinearTeam"; readonly params: LinearRouteParams["LinearTeam"] }
  | { readonly name: "LinearProject"; readonly params: LinearRouteParams["LinearProject"] }
  | { readonly name: "LinearMilestone"; readonly params: LinearRouteParams["LinearMilestone"] };

/** The stack route that shows `scope`; null for the workspace level, which is the tab itself. */
export function linearDrillRoute(
  environmentId: string,
  scope: LinearScope,
): LinearDrillRoute | null {
  if (scope.team === undefined) return null;
  if (scope.project === undefined) {
    return { name: "LinearTeam", params: { environmentId, teamId: scope.team } };
  }
  if (scope.milestone === undefined) {
    return {
      name: "LinearProject",
      params: { environmentId, teamId: scope.team, projectId: scope.project },
    };
  }
  return {
    name: "LinearMilestone",
    params: {
      environmentId,
      teamId: scope.team,
      projectId: scope.project,
      milestoneId: scope.milestone,
    },
  };
}

type ScopeParams = Partial<
  Record<"teamId" | "projectId" | "milestoneId", string | ReadonlyArray<string> | undefined>
>;

function first(value: string | ReadonlyArray<string> | undefined): string | undefined {
  const text = typeof value === "string" ? value : value?.[0];
  return text === undefined || text === "" ? undefined : text;
}

/** The drill-down position a route's params name; a level without its parent is not reachable. */
export function linearScopeFromParams(params: ScopeParams): LinearScope {
  const team = first(params.teamId);
  const project = team === undefined ? undefined : first(params.projectId);
  const milestone = project === undefined ? undefined : first(params.milestoneId);
  return {
    ...(team === undefined ? {} : { team }),
    ...(project === undefined ? {} : { project }),
    ...(milestone === undefined ? {} : { milestone }),
  };
}

/** A route's scope merged under the session's filters, ready for the shared search helpers. */
export function linearSearchFor(scope: LinearScope, filters: LinearSearch): LinearSearch {
  return {
    ...filters,
    ...(scope.team === undefined ? {} : { team: scope.team }),
    ...(scope.project === undefined ? {} : { project: scope.project }),
    ...(scope.milestone === undefined ? {} : { milestone: scope.milestone }),
  };
}

/** Only the filter half of a search; the scope comes from the route. */
export function linearFiltersOf(search: LinearSearch): LinearSearch {
  const {
    team: _team,
    project: _project,
    milestone: _milestone,
    issue: _issue,
    ...filters
  } = search;
  return filters;
}
