/**
 * Default Unified Agent Control Center UI: a local hub on the loopback address.
 * Point at a remote hub (e.g. one reached over Tailscale) with
 * T3CODE_UA_CONTROL_CENTER_URL.
 */
export const DEFAULT_UA_CONTROL_CENTER_URL = "http://127.0.0.1:8765/ui";

/** Desktop application-menu action id (URL is appended after `:`). */
export const OPEN_UA_CONTROL_CENTER_MENU_ACTION = "open-ua-control-center";

export function encodeUaControlCenterMenuAction(url: string): string {
  return `${OPEN_UA_CONTROL_CENTER_MENU_ACTION}:${url}`;
}

export function parseUaControlCenterMenuAction(action: string): string | null {
  const prefix = `${OPEN_UA_CONTROL_CENTER_MENU_ACTION}:`;
  if (!action.startsWith(prefix)) {
    return null;
  }
  const url = action.slice(prefix.length).trim();
  return url.length > 0 ? url : null;
}
