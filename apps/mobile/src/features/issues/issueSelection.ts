import type { NavigationState } from "@react-navigation/native";
import { EnvironmentId, IssueTrackerKind, ProjectId } from "@t3tools/contracts";
import { scopedIssueKey } from "./issueList";

export type IssueParams = {
  readonly environmentId: string;
  readonly projectId: string;
  readonly tracker: string;
  readonly host: string;
  readonly scope: string;
  readonly key: string;
  readonly displayKey?: string;
  readonly originalURL?: string;
};

export function issueParamsKey(params: IssueParams) {
  return scopedIssueKey({
    environmentId: EnvironmentId.make(params.environmentId),
    projectId: ProjectId.make(params.projectId),
    tracker: IssueTrackerKind.make(params.tracker),
    host: params.host,
    scope: params.scope,
    key: params.key,
  });
}

/** Follow the displayed issue through its sheets, not an older stack entry. */
export function selectedIssueKey(state: Pick<NavigationState, "routes" | "index">) {
  for (let index = state.index; index >= 0; index--) {
    const route = state.routes[index];
    if (!route) continue;
    if (route.name === "Home" || route.name.startsWith("Thread")) return null;
    if (route.name.startsWith("PullRequest")) return null;
    if (route.name !== "Issue") continue;
    const params = route.params as Partial<Record<keyof IssueParams, unknown>> | undefined;
    try {
      return params &&
        typeof params.environmentId === "string" &&
        typeof params.projectId === "string" &&
        typeof params.tracker === "string" &&
        typeof params.host === "string" &&
        typeof params.scope === "string" &&
        typeof params.key === "string"
        ? issueParamsKey({
            environmentId: params.environmentId,
            projectId: params.projectId,
            tracker: params.tracker,
            host: params.host,
            scope: params.scope,
            key: params.key,
          })
        : null;
    } catch {
      return null;
    }
  }
  return null;
}
