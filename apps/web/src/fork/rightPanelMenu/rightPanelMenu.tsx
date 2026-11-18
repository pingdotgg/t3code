import { Link } from "@tanstack/react-router";

import { Button } from "../../components/ui/button";
import { MenuItem } from "../../components/ui/menu";
import type { SettingsPath } from "../../components/settings/settingsSearch";
import { useClientSettings } from "../../hooks/useSettings";
import { isBoardHost, useBoardHostRole } from "../whiteboard/role";
import {
  type ArrangedAction,
  arrangeSurfaceActions,
  type MenuAction,
  parseMenuLayer,
} from "./menu.logic";

const RIGHT_PANEL_SETTINGS_PATH = "/settings/right-panel" satisfies SettingsPath;

/** The "+" menu or launcher items after the machine's and this browser's menu choices. */
export function useArrangedSurfaceActions<A extends MenuAction>(
  actions: ReadonlyArray<A>,
): ReadonlyArray<ArrangedAction<A>> {
  const role = useBoardHostRole();
  const browser = useClientSettings((settings) => settings.rightPanelMenuOverrides);
  // Off a board host the menu is exactly upstream's.
  if (!isBoardHost(role)) return actions as ReadonlyArray<ArrangedAction<A>>;
  return arrangeSurfaceActions(actions, parseMenuLayer(role.menu), parseMenuLayer(browser));
}

/** Settings > Right panel exists only on a board host; its nav, search and palette entries too. */
export const useRightPanelSettingsOffered = (): boolean => isBoardHost(useBoardHostRole());

/** The settings nav with Right panel after Keybindings, on a board host only. */
export function useForkSettingsNavGroups<
  Group extends { readonly paths: ReadonlyArray<SettingsPath> },
>(groups: ReadonlyArray<Group>): ReadonlyArray<Group> {
  const offered = useRightPanelSettingsOffered();
  if (!offered) return groups;
  return groups.map((group) => ({
    ...group,
    paths: group.paths.flatMap((path) =>
      path === "/settings/keybindings" ? [path, RIGHT_PANEL_SETTINGS_PATH] : [path],
    ),
  }));
}

const ALL_HIDDEN = "All items are hidden.";
const OPEN_SETTINGS = "Settings > Right panel";

/** Shown in place of a launcher or "+" menu whose items are all hidden. */
export function AllMenuItemsHidden(props: { readonly in: "launcher" | "menu" }) {
  if (props.in === "menu") {
    return (
      <MenuItem render={<Link to={RIGHT_PANEL_SETTINGS_PATH} />}>
        {ALL_HIDDEN} {OPEN_SETTINGS}
      </MenuItem>
    );
  }
  return (
    <p className="text-center text-muted-foreground text-sm">
      {ALL_HIDDEN}{" "}
      <Button size="xs" variant="link" render={<Link to={RIGHT_PANEL_SETTINGS_PATH} />}>
        {OPEN_SETTINGS}
      </Button>
    </p>
  );
}
