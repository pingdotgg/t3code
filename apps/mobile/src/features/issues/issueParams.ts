import type { NavigationState } from "@react-navigation/native";
import {
  EnvironmentId,
  IssueTrackerKind,
  ProjectId,
  type IssueDetail,
  type IssueListEntry,
  type IssueRef,
} from "@t3tools/contracts";

/** Route params that name one issue. Plain strings, so a link can carry them. */
export type IssueParams = {
  readonly environmentId: string;
  readonly projectId: string;
  readonly tracker: string;
  readonly host?: string;
  readonly scope: string;
  readonly issueKey: string;
  /** The list row the issue was opened from, shown until its detail arrives. */
  readonly initialSummary?: IssueListEntry;
};

export function issueTarget(params: IssueParams) {
  const input: IssueRef = {
    projectId: ProjectId.make(params.projectId),
    tracker: IssueTrackerKind.make(params.tracker),
    ...(params.host ? { host: params.host } : {}),
    scope: params.scope,
    key: params.issueKey,
  };
  return { environmentId: EnvironmentId.make(params.environmentId), input };
}

/** Where the server placed the issue: a ClickUp link names no list until the task is read. */
export function placedIssueTarget(
  target: ReturnType<typeof issueTarget>,
  detail: Pick<IssueDetail, "projectId" | "scope"> | null | undefined,
) {
  return detail == null
    ? target
    : { ...target, input: { ...target.input, projectId: detail.projectId, scope: detail.scope } };
}

/** The params without the list row, for the screens an issue opens. */
export function issueIdentity({ initialSummary: _, ...identity }: IssueParams) {
  return identity;
}

/** The identity the Issues tab remembers and the list marks as selected. */
export function issueParamsKey(
  params: Pick<IssueParams, "environmentId" | "projectId" | "host" | "scope" | "issueKey">,
) {
  return [
    params.environmentId,
    params.projectId,
    (params.host ?? "").toLowerCase(),
    params.scope.toLowerCase(),
    params.issueKey,
  ].join("\u0000");
}

/** The selected issue's key from a route's params, when they name one. */
export function selectedIssueKeyOf(params: object | undefined) {
  const value = params as Partial<Record<keyof IssueParams, unknown>> | undefined;
  return typeof value?.environmentId === "string" &&
    typeof value.projectId === "string" &&
    typeof value.scope === "string" &&
    typeof value.issueKey === "string"
    ? issueParamsKey({
        environmentId: value.environmentId,
        projectId: value.projectId,
        scope: value.scope,
        issueKey: value.issueKey,
        ...(typeof value.host === "string" ? { host: value.host } : {}),
      })
    : null;
}

/** The issue the detail pane shows, for marking its row in the Android sidebar. */
export function selectedIssueKey(state: Pick<NavigationState, "routes" | "index">) {
  for (let index = state.index; index >= 0; index--) {
    const route = state.routes[index];
    if (!route) continue;
    if (route.name === "Home" || !route.name.startsWith("Issue")) return null;
    const key = selectedIssueKeyOf(route.params);
    if (key !== null || route.name === "Issue") return key;
  }
  return null;
}
