import { useEffect } from "react";

import { readShellThemeState } from "./shellThemeState";
import { claimShellThemeOverride } from "./shellThemeOverride";

/**
 * Publishes the page's resolved theme to the Qt shell whenever it changes
 * (theme preference, appearance, custom theme edits, shell theme.json
 * injection), so native chrome matches the page by default.
 */
export function ShellThemeBridge({ publishToShell = true }: { publishToShell?: boolean }) {
  useEffect(() => {
    const shell = window.t3Shell;
    if (!shell) return;
    claimShellThemeOverride();
    // Embedded documents consume overrides; only the primary publishes native colors.
    if (!publishToShell) return;
    const root = document.documentElement;
    let frame: number | null = null;
    let lastJson = "";
    const publish = () => {
      frame = null;
      const state = readShellThemeState(root);
      const json = JSON.stringify(state);
      if (json === lastJson) return;
      lastJson = json;
      void shell.publish("theme", state);
    };
    const schedule = () => {
      if (frame !== null) return;
      frame = window.requestAnimationFrame(publish);
    };
    const observer = new MutationObserver(schedule);
    observer.observe(root, {
      attributes: true,
      attributeFilter: ["class", "style", "data-theme-id"],
    });
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    media.addEventListener("change", schedule);
    // Fonts and custom themes load after first paint; settle a little later too.
    const settle = window.setTimeout(schedule, 1500);
    schedule();
    return () => {
      observer.disconnect();
      media.removeEventListener("change", schedule);
      window.clearTimeout(settle);
      if (frame !== null) window.cancelAnimationFrame(frame);
    };
  }, [publishToShell]);
  return null;
}
