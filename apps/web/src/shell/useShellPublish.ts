import { useEffect, useRef } from "react";

/**
 * Publishes a view model to the Qt shell under `key`, skipping republishes
 * whose JSON is unchanged (the bridges rebuild their state on every parent
 * render, and each publish re-evaluates every QML binding on `Shell.state`).
 * Unmounting publishes `null`: leaving the route (settings, no thread) must
 * not leave stale chrome behind.
 */
export function useShellPublish(key: string, state: unknown) {
  const lastJson = useRef("");
  useEffect(() => {
    const shell = window.t3Shell;
    if (!shell) return;
    const json = JSON.stringify(state);
    if (json === lastJson.current) return;
    lastJson.current = json;
    void shell.publish(key, state);
  }, [key, state]);
  useEffect(() => {
    const shell = window.t3Shell;
    if (!shell) return;
    return () => {
      lastJson.current = "";
      void shell.publish(key, null);
    };
  }, [key]);
}
