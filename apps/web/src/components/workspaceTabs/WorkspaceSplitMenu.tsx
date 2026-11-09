import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import { Columns2Icon, Rows2Icon, XIcon } from "lucide-react";

import { useThreadRouteTarget } from "../../hooks/useThreadRouteTarget";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { Toggle } from "../ui/toggle";
import { neighborTabKey, parseWorkspaceTab, useWorkspaceTabsStore } from "./workspaceTabsStore";

/** The split view control beside the panel toggles: opens the nearest thread tab beside or under this one. */
export function WorkspaceSplitMenu() {
  const routeTarget = useThreadRouteTarget();
  const keys = useWorkspaceTabsStore((state) => state.keys);
  const splitKey = useWorkspaceTabsStore((state) => state.split?.key ?? null);
  const openSplit = useWorkspaceTabsStore((state) => state.openSplit);
  const closeSplit = useWorkspaceTabsStore((state) => state.closeSplit);
  const routedKey = routeTarget?.kind === "server" ? scopedThreadKey(routeTarget.threadRef) : null;
  const splitShown = splitKey !== null && splitKey !== routedKey;
  // Only threads can take the split pane; offer the routed thread's nearest thread tab.
  const threadKeys = keys.filter((key) => parseWorkspaceTab(key)?.kind === "thread");
  const candidate =
    (routedKey && threadKeys.includes(routedKey)
      ? neighborTabKey(threadKeys, routedKey)
      : threadKeys.at(-1)) ?? null;
  if (!splitShown && candidate === null) return null;

  return (
    <Menu>
      <MenuTrigger
        render={
          <Toggle
            className="shrink-0 [-webkit-app-region:no-drag]"
            pressed={splitShown}
            aria-label="Split view"
            variant="ghost"
            size="sm"
          />
        }
      >
        <Columns2Icon className="size-4" />
      </MenuTrigger>
      <MenuPopup align="end" sideOffset={6}>
        {splitShown ? (
          <MenuItem onClick={closeSplit}>
            <XIcon />
            Close split
          </MenuItem>
        ) : candidate ? (
          <>
            <MenuItem onClick={() => openSplit(candidate, "right")}>
              <Columns2Icon />
              Split right
            </MenuItem>
            <MenuItem onClick={() => openSplit(candidate, "down")}>
              <Rows2Icon />
              Split down
            </MenuItem>
          </>
        ) : null}
      </MenuPopup>
    </Menu>
  );
}
