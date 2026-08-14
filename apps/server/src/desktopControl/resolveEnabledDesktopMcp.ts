/**
 * Compatibility re-export. Computer Use settings resolution lives in
 * `desktopMcpLaunch.ts` and always acquires `ServerSettingsService` directly
 * (fail-closed). Kept so path-based review tools that still reference this
 * filename see the current, correct API.
 */
export {
  makeResolveEnabledDesktopMcp,
  resolveEnabledDesktopMcp,
  type DesktopMcpLaunch,
} from "./desktopMcpLaunch.ts";
