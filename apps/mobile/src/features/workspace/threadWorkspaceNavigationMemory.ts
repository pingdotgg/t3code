import { useEffect } from "react";
import { useNavigation, type NavigationState } from "@react-navigation/native";
import {
  readThreadWorkspaceLocation,
  rememberThreadWorkspaceLocation,
  type ThreadWorkspaceLocation,
} from "./workspacePaneMemory";

const locationNames = new Set([
  "Thread",
  "ThreadReview",
  "ThreadReviewFile",
  "ThreadFiles",
  "ThreadFile",
]);

/** Only the focused destination writes memory; a hidden chat cannot overwrite its diff. */
export function rememberFocusedThreadWorkspace(
  state: Pick<NavigationState, "index" | "routes"> | undefined,
) {
  if (!state) return;
  const route = state.routes[state.index];
  if (!route || !locationNames.has(route.name)) return;
  const params = route.params as Readonly<Record<string, unknown>> | undefined;
  if (typeof params?.environmentId !== "string" || typeof params.threadId !== "string") return;
  const stringParam = (key: string) => (typeof params[key] === "string" ? params[key] : undefined);
  const scope = params.reviewWorkingTreeScope;
  const path = params.path;
  rememberThreadWorkspaceLocation({
    name: route.name as ThreadWorkspaceLocation["name"],
    params: {
      environmentId: params.environmentId,
      threadId: params.threadId,
      ...(typeof params.reviewSectionId === "string"
        ? { reviewSectionId: params.reviewSectionId }
        : {}),
      ...(typeof params.reviewFilePath === "string"
        ? { reviewFilePath: params.reviewFilePath }
        : {}),
      ...(scope === "staged" || scope === "unstaged" ? { reviewWorkingTreeScope: scope } : {}),
      ...(Array.isArray(path) && path.every((part) => typeof part === "string") ? { path } : {}),
      ...(stringParam("line") ? { line: String(params.line) } : {}),
      ...(stringParam("cwd") ? { cwd: String(params.cwd) } : {}),
      ...(stringParam("projectName") ? { projectName: String(params.projectName) } : {}),
    },
  });
}

export function useRememberThreadWorkspaceLocation() {
  const navigation = useNavigation();
  useEffect(() => {
    // Route state also observes explicit Back: returning to chat remembers chat.
    const remember = () => rememberFocusedThreadWorkspace(navigation.getState());
    remember();
    return navigation.addListener("state", remember);
  }, [navigation]);
}

/** Restore an inspector above its own chat/tree, keeping ordinary Back navigation intact. */
export function rememberedThreadWorkspaceNavigationState(
  state: NavigationState | undefined,
  params: { readonly environmentId: string; readonly threadId: string },
  peer = false,
) {
  if (!state) return null;
  const location = readThreadWorkspaceLocation(params.environmentId, params.threadId);
  if (!location || location.name === "Thread") return null;
  const firstThread = state.routes.findIndex((route) => locationNames.has(route.name));
  const home = state.routes.find((route) => route.name === "Home");
  const prefix = peer
    ? home
      ? [home]
      : [{ name: "Home" }]
    : firstThread >= 0
      ? state.routes.slice(0, firstThread)
      : state.routes.slice(0, state.index + 1);
  const rememberedParams = { ...location.params, ...params };
  const tree =
    location.name === "ThreadReviewFile"
      ? [{ name: "ThreadReview", params }]
      : location.name === "ThreadFile"
        ? [{ name: "ThreadFiles", params }]
        : [];
  const routes = [
    ...prefix,
    { name: "Thread", params },
    ...tree,
    { name: location.name, params: rememberedParams },
  ];
  return { ...state, index: routes.length - 1, routes };
}

/** Selecting the current sidebar thread should leave its nested viewer alone. */
export function isFocusedThreadWorkspace(
  state: Pick<NavigationState, "index" | "routes"> | undefined,
  params: { readonly environmentId: string; readonly threadId: string },
) {
  if (!state) return false;
  const route = state.routes[state.index];
  const current = route?.params as Readonly<Record<string, unknown>> | undefined;
  return Boolean(
    route &&
    locationNames.has(route.name) &&
    current?.environmentId === params.environmentId &&
    current.threadId === params.threadId,
  );
}
