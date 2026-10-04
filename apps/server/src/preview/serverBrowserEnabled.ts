import type { RuntimeMode } from "../config.ts";

/**
 * Standalone servers host `runtime: "server"` preview tabs. A desktop-managed
 * server leaves the browser to its Electron app. `T3CODE_SERVER_BROWSER=0|1`
 * overrides either.
 */
export const isServerBrowserEnabled = (mode: RuntimeMode): boolean => {
  const override = process.env.T3CODE_SERVER_BROWSER;
  if (override === "0") return false;
  if (override === "1") return true;
  return mode === "web";
};
