import type { NavigationState, PartialState } from "@react-navigation/native";

import {
  dispatchRootStackReset,
  resetRootStack,
  rootStackState,
  type RootStackNavigation,
} from "../../lib/root-stack-reset";

type RootParams = ReactNavigation.RootParamList;

/** Settings routes that open as modals over whatever is on screen, not as Settings pages. */
const SETTINGS_MODAL_ROUTES = new Set(["SettingsLegal", "SettingsAuth", "SettingsWaitlist"]);

/** Root routes that make up the Settings tab: its list and the pages it opens. */
export type SettingsRouteName = Exclude<
  Extract<keyof RootParams, `Settings${string}`>,
  "SettingsLegal" | "SettingsAuth" | "SettingsWaitlist"
>;

/** A page in the Settings tab's detail column. */
export type SettingsPageName = Exclude<SettingsRouteName, "Settings">;

export function isSettingsRoute(name: string): boolean {
  return name.startsWith("Settings") && !SETTINGS_MODAL_ROUTES.has(name);
}

/**
 * Settings is open while its `Settings` route is under the topmost workspace page and that
 * page is a Settings page. A Settings page pushed without it, such as a usage account opened
 * from the Usage tab, stays a detail of the current tab.
 */
export function settingsOpenIn(workspaceRoutes: readonly { readonly name: string }[]): boolean {
  return (
    workspaceRoutes.some((route) => route.name === "Settings") &&
    isSettingsRoute(workspaceRoutes.at(-1)?.name ?? "")
  );
}

/**
 * A `settings/...` link names only its page, so put the Settings tab's route under it. A bare
 * `settings` link opens `page` beside the list when the window has columns.
 */
export function restoreSettingsLinkState(
  state: PartialState<NavigationState> | undefined,
  page: SettingsPageName | undefined,
) {
  if (!state) return state;
  const routes = [...state.routes];
  const list = routes.findIndex((route) => route.name === "Settings");
  const first = routes.findIndex((route) => isSettingsRoute(route.name));
  if (first < 0) return state;
  if (list < 0) routes.splice(first, 0, { name: "Settings" });
  const top = routes.at(-1);
  if (page && top?.name === "Settings") routes.push({ name: page });
  return routes.length === state.routes.length
    ? state
    : { ...state, index: routes.length - 1, routes };
}

type SettingsPageArgs<Name extends SettingsPageName> = undefined extends RootParams[Name]
  ? [params?: RootParams[Name]]
  : [params: RootParams[Name]];

type RouteLike = { readonly name: string; readonly key?: string; readonly params?: object };

/**
 * Settings pages sit on the root stack above Home, under a `Settings` route that keeps the
 * Settings list as the workspace's primary content. Opening a page replaces whatever was above
 * Home, so the tab always starts from its list and Back returns there. Routes already on screen
 * keep their keys, so reopening the open page doesn't rebuild it.
 */
export function settingsNavigationState<State extends { readonly routes: readonly RouteLike[] }>(
  state: State,
  page: SettingsPageName | undefined,
  params?: object,
  key?: string,
) {
  const home = state.routes.find((route) => route.name === "Home") ?? { name: "Home" };
  const list = state.routes.find((route) => route.name === "Settings") ?? { name: "Settings" };
  const current = page
    ? state.routes.find(
        (route) => route.name === page && JSON.stringify(route.params) === JSON.stringify(params),
      )
    : undefined;
  const routes = [
    home,
    list,
    ...(page ? [current ?? (key ? { key, name: page, params } : { name: page, params })] : []),
  ];
  return { ...state, index: routes.length - 1, routes };
}

/** Opens one Settings page in the Settings tab, from anywhere outside it. */
export function openSettings<Name extends SettingsPageName>(
  navigation: RootStackNavigation,
  page: Name,
  ...[params]: SettingsPageArgs<Name>
) {
  resetRootStack(navigation, (state) => settingsNavigationState(state, page, params));
}

/**
 * Closes a Settings page that finished its job. The first page beside the list is replaced with
 * `fallback` when the window has columns, since going back would leave the detail column empty.
 */
export function leaveSettingsPage(
  navigation: RootStackNavigation & { readonly goBack: () => void },
  columns: boolean,
  fallback: SettingsPageName,
) {
  const state = rootStackState(navigation);
  const below = state?.routes[state.index - 1];
  if (state && columns && below?.name === "Settings") {
    dispatchRootStackReset(navigation, state, settingsNavigationState(state, fallback));
  } else {
    navigation.goBack();
  }
}
