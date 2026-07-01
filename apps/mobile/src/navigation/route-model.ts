import type { NavigationState, PartialState, Route } from "@react-navigation/native";

export type RouteParams = Record<string, string | string[] | undefined>;

export type AppRouteName =
  | "Home"
  | "Settings"
  | "SettingsEnvironments"
  | "SettingsEnvironmentNew"
  | "SettingsArchive"
  | "SettingsAuth"
  | "SettingsWaitlist"
  | "Connections"
  | "ConnectionsNew"
  | "NewTask"
  | "AddProject"
  | "AddProjectRepository"
  | "AddProjectDestination"
  | "AddProjectLocal"
  | "NewTaskDraft"
  | "Thread"
  | "ThreadTerminal"
  | "ThreadReview"
  | "ThreadReviewComment"
  | "ThreadFiles"
  | "ThreadFile"
  | "GitOverview"
  | "GitCommit"
  | "GitBranches"
  | "GitConfirm"
  | "DebugRnsGlass"
  | "NotFound";

export type AppStackParamList = {
  Home: undefined;
  Settings: undefined;
  SettingsEnvironments: undefined;
  SettingsEnvironmentNew: RouteParams | undefined;
  SettingsArchive: undefined;
  SettingsAuth: undefined;
  SettingsWaitlist: undefined;
  Connections: undefined;
  ConnectionsNew: RouteParams | undefined;
  NewTask: undefined;
  AddProject: RouteParams | undefined;
  AddProjectRepository: RouteParams | undefined;
  AddProjectDestination: RouteParams | undefined;
  AddProjectLocal: RouteParams | undefined;
  NewTaskDraft: RouteParams | undefined;
  Thread: RouteParams;
  ThreadTerminal: RouteParams;
  ThreadReview: RouteParams;
  ThreadReviewComment: RouteParams;
  ThreadFiles: RouteParams;
  ThreadFile: RouteParams;
  GitOverview: RouteParams;
  GitCommit: RouteParams;
  GitBranches: RouteParams;
  GitConfirm: RouteParams;
  DebugRnsGlass: undefined;
  NotFound: RouteParams | undefined;
};

export type AppNavigationInput = string | AppNavigationTarget;

export type AppNavigationTarget = {
  readonly name: AppRouteName;
  readonly params?: RouteParams;
};

export type AppFocusedRoute = Pick<Route<string>, "name" | "params">;

function normalizeParamValue(value: unknown): string | string[] | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (Array.isArray(value)) {
    return value.map((item) => String(item));
  }
  return String(value);
}

export function normalizeRouteParams(
  params: Record<string, unknown> | undefined,
): RouteParams | undefined {
  if (!params) {
    return undefined;
  }

  const normalized: RouteParams = {};
  for (const [key, value] of Object.entries(params)) {
    const normalizedValue = normalizeParamValue(value);
    if (normalizedValue !== undefined) {
      normalized[key] = normalizedValue;
    }
  }
  return normalized;
}

function withParams(name: AppRouteName, params?: Record<string, unknown>): AppNavigationTarget {
  return { name, params: normalizeRouteParams(params) };
}

function splitPathAndQuery(path: string): {
  readonly pathname: string;
  readonly query: RouteParams | undefined;
} {
  const queryStart = path.indexOf("?");
  if (queryStart === -1) {
    return { pathname: path, query: undefined };
  }

  const pathname = path.slice(0, queryStart);
  const query = new URLSearchParams(path.slice(queryStart + 1));
  const params: RouteParams = {};
  for (const [key, value] of query.entries()) {
    const existing = params[key];
    if (Array.isArray(existing)) {
      existing.push(value);
    } else if (existing !== undefined) {
      params[key] = [existing, value];
    } else {
      params[key] = value;
    }
  }
  return { pathname, query: Object.keys(params).length > 0 ? params : undefined };
}

function pathSegments(pathname: string): string[] {
  return pathname
    .replace(/^\/+|\/+$/g, "")
    .split("/")
    .filter(Boolean)
    .map((segment) => decodeURIComponent(segment));
}

function mergeParams(
  base: Record<string, unknown> | undefined,
  extra: Record<string, unknown> | undefined,
): RouteParams | undefined {
  return normalizeRouteParams({ ...base, ...extra });
}

export function resolveNavigationTarget(input: AppNavigationInput): AppNavigationTarget {
  if (typeof input !== "string") {
    return withParams(input.name, input.params);
  }

  const { pathname, query } = splitPathAndQuery(input);
  const target = resolveNavigationPath(pathname);
  return { name: target.name, params: mergeParams(target.params, query) };
}

export function resolveNavigationPath(pathname: string): AppNavigationTarget {
  const segments = pathSegments(pathname);

  if (segments.length === 0) return { name: "Home" };
  if (segments[0] === "debug" && segments[1] === "rns-glass") return { name: "DebugRnsGlass" };

  if (segments[0] === "settings") {
    switch (segments[1]) {
      case undefined:
        return { name: "Settings" };
      case "environments":
        return { name: "SettingsEnvironments" };
      case "environment-new":
        return { name: "SettingsEnvironmentNew" };
      case "archive":
        return { name: "SettingsArchive" };
      case "auth":
        return { name: "SettingsAuth" };
      case "waitlist":
        return { name: "SettingsWaitlist" };
      default:
        return withParams("NotFound", { pathname });
    }
  }

  if (segments[0] === "connections") {
    return segments[1] === "new" ? { name: "ConnectionsNew" } : { name: "Connections" };
  }

  if (segments[0] === "new") {
    if (segments[1] === "add-project") {
      switch (segments[2]) {
        case undefined:
          return { name: "AddProject" };
        case "repository":
          return { name: "AddProjectRepository" };
        case "destination":
          return { name: "AddProjectDestination" };
        case "local":
          return { name: "AddProjectLocal" };
        default:
          return withParams("NotFound", { pathname });
      }
    }
    return segments[1] === "draft" ? { name: "NewTaskDraft" } : { name: "NewTask" };
  }

  if (segments[0] === "threads" && segments[1] && segments[2]) {
    const baseParams = { environmentId: segments[1], threadId: segments[2] };
    switch (segments[3]) {
      case undefined:
        return withParams("Thread", baseParams);
      case "terminal":
        return withParams("ThreadTerminal", baseParams);
      case "review":
        return withParams("ThreadReview", baseParams);
      case "review-comment":
        return withParams("ThreadReviewComment", baseParams);
      case "git":
        if (segments[4] === "commit") return withParams("GitCommit", baseParams);
        if (segments[4] === "branches") return withParams("GitBranches", baseParams);
        if (segments[4] === "review") return withParams("ThreadReview", baseParams);
        return withParams("GitOverview", baseParams);
      case "git-confirm":
        return withParams("GitConfirm", baseParams);
      case "files":
        if (segments.length > 4) {
          return withParams("ThreadFile", { ...baseParams, path: segments.slice(4) });
        }
        return withParams("ThreadFiles", baseParams);
      default:
        return withParams("NotFound", { pathname });
    }
  }

  return withParams("NotFound", { pathname });
}

export function buildPathFromRoute(route: AppFocusedRoute): string {
  const params = (route.params ?? {}) as RouteParams;
  const environmentId = firstParam(params.environmentId);
  const threadId = firstParam(params.threadId);
  const path = params.path;
  const pathSegmentsValue = Array.isArray(path) ? path : path ? [path] : [];
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (key === "environmentId" || key === "threadId" || key === "path") continue;
    if (Array.isArray(value)) {
      for (const item of value) query.append(key, item);
    } else if (value !== undefined) {
      query.set(key, value);
    }
  }
  const querySuffix = query.size > 0 ? `?${query.toString()}` : "";

  switch (route.name as AppRouteName) {
    case "Home":
      return "/";
    case "Settings":
      return "/settings";
    case "SettingsEnvironments":
      return "/settings/environments";
    case "SettingsEnvironmentNew":
      return `/settings/environment-new${querySuffix}`;
    case "SettingsArchive":
      return "/settings/archive";
    case "SettingsAuth":
      return "/settings/auth";
    case "SettingsWaitlist":
      return "/settings/waitlist";
    case "Connections":
      return "/connections";
    case "ConnectionsNew":
      return `/connections/new${querySuffix}`;
    case "NewTask":
      return "/new";
    case "AddProject":
      return "/new/add-project";
    case "AddProjectRepository":
      return `/new/add-project/repository${querySuffix}`;
    case "AddProjectDestination":
      return `/new/add-project/destination${querySuffix}`;
    case "AddProjectLocal":
      return `/new/add-project/local${querySuffix}`;
    case "NewTaskDraft":
      return `/new/draft${querySuffix}`;
    case "Thread":
      return `/threads/${encodeURIComponent(environmentId ?? "")}/${encodeURIComponent(threadId ?? "")}`;
    case "ThreadTerminal":
      return `/threads/${encodeURIComponent(environmentId ?? "")}/${encodeURIComponent(threadId ?? "")}/terminal${querySuffix}`;
    case "ThreadReview":
      return `/threads/${encodeURIComponent(environmentId ?? "")}/${encodeURIComponent(threadId ?? "")}/review`;
    case "ThreadReviewComment":
      return `/threads/${encodeURIComponent(environmentId ?? "")}/${encodeURIComponent(threadId ?? "")}/review-comment${querySuffix}`;
    case "ThreadFiles":
      return `/threads/${encodeURIComponent(environmentId ?? "")}/${encodeURIComponent(threadId ?? "")}/files${querySuffix}`;
    case "ThreadFile":
      return `/threads/${encodeURIComponent(environmentId ?? "")}/${encodeURIComponent(threadId ?? "")}/files/${pathSegmentsValue.map(encodeURIComponent).join("/")}${querySuffix}`;
    case "GitOverview":
      return `/threads/${encodeURIComponent(environmentId ?? "")}/${encodeURIComponent(threadId ?? "")}/git${querySuffix}`;
    case "GitCommit":
      return `/threads/${encodeURIComponent(environmentId ?? "")}/${encodeURIComponent(threadId ?? "")}/git/commit${querySuffix}`;
    case "GitBranches":
      return `/threads/${encodeURIComponent(environmentId ?? "")}/${encodeURIComponent(threadId ?? "")}/git/branches${querySuffix}`;
    case "GitConfirm":
      return `/threads/${encodeURIComponent(environmentId ?? "")}/${encodeURIComponent(threadId ?? "")}/git-confirm${querySuffix}`;
    case "DebugRnsGlass":
      return "/debug/rns-glass";
    case "NotFound":
      return firstParam(params.pathname) ?? "/not-found";
  }
}

export function buildPathFromState(
  state: NavigationState | PartialState<NavigationState> | undefined,
): string {
  const route = getFocusedRoute(state);
  return route ? buildPathFromRoute(route) : "/";
}

export function getFocusedRoute(
  state: NavigationState | PartialState<NavigationState> | undefined,
): AppFocusedRoute | undefined {
  if (!state || state.routes.length === 0) {
    return undefined;
  }

  const index = state.index ?? 0;
  const route = state.routes[index];
  if (!route) {
    return undefined;
  }

  return getFocusedRoute(route.state as PartialState<NavigationState> | undefined) ?? route;
}

export function firstParam(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
