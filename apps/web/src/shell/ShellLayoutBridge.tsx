import type { ShellLayoutState } from "@t3tools/contracts/shell";
import { useMemo } from "react";

import { useSidebar } from "../components/ui/sidebar";
import { useSidebarToggleKeybinding } from "../hooks/useSidebarToggleKeybinding";
import { useShellActions } from "./useShellActions";
import { useShellPublish } from "./useShellPublish";

/**
 * Mounted inside SidebarProvider when the Qt shell hosts the app. The page
 * keeps owning the sidebar's open state (and its keybinding); this publishes
 * it as `layout` and applies `sidebar.toggle` from native chrome.
 */
export function ShellLayoutBridge() {
  const { open, toggleSidebar } = useSidebar();
  useSidebarToggleKeybinding();
  const state = useMemo((): ShellLayoutState => ({ sidebarCollapsed: !open }), [open]);
  useShellPublish("layout", state);
  useShellActions((action) => {
    if (action.type === "sidebar.toggle") toggleSidebar();
  });
  return null;
}
