import type { WorkspaceSelections } from "../../persistence/mobile-preferences";
import {
  SETTINGS_PAGE_TARGETS,
  type SettingsPageTarget,
} from "../settings/components/settings-page-targets";
import { settingsNavigationState } from "../settings/settings-navigation";
import type { WorkspaceTab } from "./workspace-tabs-state";

type RouteLike = {
  readonly name: string;
  readonly key?: string;
  readonly params?: object | undefined;
};
type ThreadSelection = NonNullable<WorkspaceSelections["threads"]>;
type PullRequestSelection = NonNullable<WorkspaceSelections["pullRequests"]>;

/** Opened when Settings has columns and none of its pages has been opened yet. */
export const DEFAULT_SETTINGS_PAGE = "SettingsEnvironments" satisfies SettingsPageTarget;

export function workspaceTabColumns(
  platform: string,
  tab: WorkspaceTab | "settings",
  columns: boolean,
) {
  return columns && (platform === "ios" || (platform === "android" && tab === "settings"));
}

// Pages a Settings row opens, minus Project overview: it shows the project chosen in the
// Settings scope, which resets whenever Settings closes.
const REMEMBERED_SETTINGS_PAGES: ReadonlySet<string> = new Set(
  SETTINGS_PAGE_TARGETS.filter((page) => page !== "SettingsProjectOverview"),
);

export function rememberedSettingsPage(selections: WorkspaceSelections): SettingsPageTarget {
  return selections.settings && REMEMBERED_SETTINGS_PAGES.has(selections.settings)
    ? (selections.settings as SettingsPageTarget)
    : DEFAULT_SETTINGS_PAGE;
}

/** Whether a remembered chat or pull request can still be opened. */
export interface WorkspaceSelectionCheck {
  readonly thread: (selection: ThreadSelection) => boolean;
  readonly pullRequest: (selection: PullRequestSelection) => boolean;
}

function stringParam(params: object | undefined, key: string) {
  const value = (params as Record<string, unknown> | undefined)?.[key];
  return typeof value === "string" ? value : undefined;
}

function pullRequestSelection(
  params: object | undefined,
): Omit<PullRequestSelection, "key"> | undefined {
  const value = params as Record<string, unknown> | undefined;
  if (
    typeof value?.environmentId !== "string" ||
    typeof value.projectId !== "string" ||
    typeof value.repository !== "string" ||
    typeof value.number !== "number"
  ) {
    return undefined;
  }
  return {
    environmentId: value.environmentId,
    projectId: value.projectId,
    repository: value.repository,
    number: value.number,
    ...(typeof value.host === "string" ? { host: value.host } : {}),
  };
}

function samePullRequest(
  left: PullRequestSelection | undefined,
  right: Omit<PullRequestSelection, "key">,
) {
  return (
    left?.environmentId === right.environmentId &&
    left.projectId === right.projectId &&
    left.repository === right.repository &&
    left.number === right.number &&
    left.host === right.host
  );
}

/**
 * The page each tab shows in a root route chain: the newest chat, the newest pull request, and
 * the Settings page directly above the Settings route. Returns `previous` when nothing changed.
 */
export function workspaceSelectionsIn(
  routes: readonly RouteLike[],
  previous: WorkspaceSelections,
): WorkspaceSelections {
  let next = previous;
  const thread = routes.findLast((route) => route.name === "Thread");
  const environmentId = stringParam(thread?.params, "environmentId");
  const threadId = stringParam(thread?.params, "threadId");
  if (
    environmentId &&
    threadId &&
    (next.threads?.environmentId !== environmentId ||
      next.threads.threadId !== threadId ||
      next.threads.key !== thread?.key ||
      next.threadsDraft)
  ) {
    const { threadsDraft: _, ...rest } = next;
    next = { ...rest, threads: { environmentId, threadId, key: thread?.key } };
  } else if (
    thread?.key !== undefined &&
    !threadId &&
    (next.threadsDraft?.key !== thread.key || next.threadsDraft.params !== thread.params)
  ) {
    next = { ...next, threadsDraft: { key: thread.key, params: thread.params } };
  }
  const pullRequestRoute = routes.findLast((route) => route.name === "PullRequest");
  const pullRequest = pullRequestSelection(pullRequestRoute?.params);
  if (
    pullRequest &&
    (!samePullRequest(next.pullRequests, pullRequest) ||
      next.pullRequests?.key !== pullRequestRoute?.key)
  ) {
    next = { ...next, pullRequests: { ...pullRequest, key: pullRequestRoute?.key } };
  }
  const list = routes.findIndex((route) => route.name === "Settings");
  const page = list < 0 ? undefined : routes[list + 1];
  if (
    page &&
    REMEMBERED_SETTINGS_PAGES.has(page.name) &&
    (page.name !== next.settings || page.key !== next.settingsKey)
  ) {
    next = { ...next, settings: page.name, settingsKey: page.key };
  }
  return next;
}

function identityOf({ key: _key, ...identity }: PullRequestSelection) {
  return identity;
}

let routeKeys = 0;

/** New routes get their key here, so the caller knows which route it is about to show. */
function keyed<Route extends RouteLike>(route: Route): Route & { readonly key: string } {
  if (route.key !== undefined) return route as Route & { readonly key: string };
  routeKeys += 1;
  return { ...route, key: `${route.name}-workspace-${routeKeys}` };
}

function detailRoute(
  state: { readonly routes: readonly RouteLike[] },
  tab: "threads" | "pullRequests",
  selections: WorkspaceSelections,
  check: WorkspaceSelectionCheck,
): RouteLike | undefined {
  if (tab === "threads") {
    const draft = selections.threadsDraft;
    if (draft) {
      return (
        state.routes.find((route) => route.key === draft.key) ?? {
          key: draft.key,
          name: "Thread",
          params: draft.params as object | undefined,
        }
      );
    }
    const thread = selections.threads;
    if (!thread || !check.thread(thread)) return undefined;
    return (
      state.routes.find(
        (route) =>
          route.name === "Thread" &&
          stringParam(route.params, "environmentId") === thread.environmentId &&
          stringParam(route.params, "threadId") === thread.threadId,
      ) ?? {
        key: thread.key,
        name: "Thread",
        params: { environmentId: thread.environmentId, threadId: thread.threadId },
      }
    );
  }
  const pullRequest = selections.pullRequests;
  if (!pullRequest || !check.pullRequest(pullRequest)) return undefined;
  return (
    state.routes.find(
      (route) =>
        route.name === "PullRequest" &&
        samePullRequest(pullRequestSelection(route.params), pullRequest),
    ) ?? { key: pullRequest.key, name: "PullRequest", params: identityOf(pullRequest) }
  );
}

/**
 * The root stack for opening a workspace tab. With columns the detail column must show
 * something, so the tab reopens the page it last showed (Settings falls back to its default);
 * without columns the tab opens on its list. Routes already on screen keep their keys, and
 * `overlays` (open sheets) stay on top.
 */
export function workspaceTabNavigationState<
  State extends { readonly routes: readonly RouteLike[] },
>(
  state: State,
  tab: WorkspaceTab | "settings",
  selections: WorkspaceSelections,
  options: {
    readonly columns: boolean;
    readonly check: WorkspaceSelectionCheck;
    readonly overlays?: readonly RouteLike[];
  },
) {
  const overlays = options.overlays ?? [];
  if (tab === "settings") {
    const page = options.columns ? rememberedSettingsPage(selections) : undefined;
    const settings = settingsNavigationState(
      state,
      page,
      undefined,
      page === selections.settings ? selections.settingsKey : undefined,
    );
    const routes = [...settings.routes.map(keyed), ...overlays];
    return { ...settings, index: routes.length - 1, routes };
  }
  const home = state.routes.find((route) => route.name === "Home") ?? { name: "Home" };
  const detail =
    options.columns && tab !== "usage"
      ? detailRoute(state, tab, selections, options.check)
      : undefined;
  const routes = [...[home, ...(detail ? [detail] : [])].map(keyed), ...overlays];
  return { ...state, index: routes.length - 1, routes };
}
