import type {
  NavigationAction,
  ParamListBase,
  PartialState,
  NavigationState,
  Router,
  StackNavigationState,
} from "@react-navigation/native";
import { workspaceRoutesOf } from "../layout/workspace-overlay-routes";

type RootParams = ReactNavigation.RootParamList;

/** A page the workspace's detail column shows on its own: what a list row selects. */
export type WorkspaceDetail =
  | { readonly name: "Thread"; readonly params: RootParams["Thread"] }
  | { readonly name: "PullRequest"; readonly params: RootParams["PullRequest"] };

/** Android opens the reviewers sheet over the pull request in the same step. */
export type WorkspaceDetailSheet = {
  readonly name: "PullRequestReviewers";
  readonly params: RootParams["PullRequestReviewers"];
};

const SELECT_WORKSPACE_DETAIL = "SELECT_WORKSPACE_DETAIL";

export interface SelectWorkspaceDetailAction {
  readonly type: typeof SELECT_WORKSPACE_DETAIL;
  readonly payload: { readonly detail: WorkspaceDetail; readonly sheet?: WorkspaceDetailSheet };
}

/**
 * Shows `detail` as the workspace's only page, the way selecting a list row does. Drilling in
 * from a page pushes instead.
 */
export function selectWorkspaceDetail(
  detail: WorkspaceDetail,
  sheet?: WorkspaceDetailSheet,
): SelectWorkspaceDetailAction {
  return { type: SELECT_WORKSPACE_DETAIL, payload: sheet ? { detail, sheet } : { detail } };
}

const IDENTITY = {
  Thread: ["environmentId", "threadId"],
  PullRequest: ["environmentId", "projectId", "repository", "number", "host"],
} as const;

type RouteLike = { readonly name: string; readonly key?: string; readonly params?: object };

function showsDetail(route: RouteLike, detail: WorkspaceDetail) {
  if (route.name !== detail.name) return false;
  const current = route.params as Readonly<Record<string, unknown>> | undefined;
  const target = detail.params as Readonly<Record<string, unknown>> | undefined;
  return IDENTITY[detail.name].every((key) => current?.[key] === target?.[key]);
}

// UIKit pops a card by native Back before the router hears of it, so a row tapped meanwhile
// must not reuse the card on its way out.
let nativelyPoppingRoute: string | null = null;

export function setNativelyPoppingWorkspaceRoute(key: string | null) {
  nativelyPoppingRoute = key;
}

/**
 * The root stack after selecting `detail`: Home, then the detail alone. The route already showing
 * it, or else the detail column's current page of the same kind, keeps its key, so the column
 * updates in place instead of pushing.
 */
function workspaceDetailState<
  State extends { readonly index: number; readonly routes: readonly RouteLike[] },
>(state: State, detail: WorkspaceDetail, sheet?: WorkspaceDetailSheet, popping?: string | null) {
  const { workspace } = workspaceRoutesOf(state.routes.slice(0, state.index + 1));
  const leaving = workspace.findIndex((route) => route.key !== undefined && route.key === popping);
  const live = leaving < 0 ? workspace : workspace.slice(0, leaving);
  const home = live.find((route) => route.name === "Home") ?? { name: "Home" };
  const page = live.find((route) => route.name !== "Home" && route.name !== "Settings");
  const reused =
    live.findLast((route) => showsDetail(route, detail)) ??
    (page?.name === detail.name ? page : undefined);
  const routes = [
    home,
    reused ? { ...reused, params: detail.params } : { name: detail.name, params: detail.params },
    ...(sheet ? [sheet] : []),
  ];
  return { ...state, index: routes.length - 1, routes };
}

/** Root stack router overrides that handle `selectWorkspaceDetail`. */
export function workspaceDetailRouter<Action extends NavigationAction>(
  original: Router<StackNavigationState<ParamListBase>, Action>,
): Partial<Router<StackNavigationState<ParamListBase>, Action>> {
  return {
    getStateForAction(state, action, options) {
      if (action.type !== SELECT_WORKSPACE_DETAIL) {
        return original.getStateForAction(state, action, options);
      }
      const { detail, sheet } = (action as unknown as SelectWorkspaceDetailAction).payload;
      const next = workspaceDetailState(state, detail, sheet, nativelyPoppingRoute);
      const reset = { type: "RESET", payload: { ...next, stale: false } };
      return original.getStateForAction(state, reset as unknown as Action, options);
    },
  };
}

/** A link to a single thread or pull request selects it, like its list row would. */
export function workspaceDetailLinkAction(
  state: PartialState<NavigationState> | NavigationState,
): SelectWorkspaceDetailAction | undefined {
  const pages = state.routes.filter((route) => route.name !== "Home");
  const [page] = pages;
  if (pages.length !== 1 || !page || page.state) return undefined;
  if (page.name !== "Thread" && page.name !== "PullRequest") return undefined;
  return selectWorkspaceDetail({ name: page.name, params: page.params } as WorkspaceDetail);
}
