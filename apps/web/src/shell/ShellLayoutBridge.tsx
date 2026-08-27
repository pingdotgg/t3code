import { ShellAction, type ShellLayoutState } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { useEffect, useRef } from "react";

import { useSidebar } from "../components/ui/sidebar";
import { useSidebarToggleKeybinding } from "../hooks/useSidebarToggleKeybinding";

const isShellAction = Schema.is(ShellAction);

/**
 * Mounted inside SidebarProvider when the Qt shell hosts the app. The page
 * keeps owning the sidebar's open state (and its keybinding); this publishes
 * it as `layout` and applies `sidebar.toggle` from native chrome.
 */
export function ShellLayoutBridge() {
  const shell = window.t3Shell;
  const { open, toggleSidebar } = useSidebar();
  useSidebarToggleKeybinding();

  useEffect(() => {
    if (!shell) return;
    const state: ShellLayoutState = { sidebarCollapsed: !open };
    void shell.publish("layout", state);
  }, [open, shell]);

  // The shell subscribes once; the handler reads the latest toggle through a
  // ref (its identity changes with the open state).
  const toggleRef = useRef(toggleSidebar);
  toggleRef.current = toggleSidebar;
  useEffect(() => {
    if (!shell) return;
    let disposed = false;
    let unsubscribe: (() => void) | null = null;
    void shell
      .onAction((type, payload) => {
        const candidate = {
          ...(typeof payload === "object" && payload !== null ? payload : {}),
          type,
        };
        if (!isShellAction(candidate) || candidate.type !== "sidebar.toggle") return;
        toggleRef.current();
      })
      .then((dispose) => {
        if (disposed) dispose();
        else unsubscribe = dispose;
      });
    return () => {
      disposed = true;
      unsubscribe?.();
      void shell.publish("layout", null);
    };
  }, [shell]);

  return null;
}
