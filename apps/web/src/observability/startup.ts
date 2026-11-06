// Enable before reloading with localStorage.setItem("t3code:profile-startup", "1").
export const startupProfilingEnabled = (() => {
  try {
    return localStorage.getItem("t3code:profile-startup") === "1";
  } catch {
    return false;
  }
})();

type StartupMilestone =
  | "entry-evaluated"
  | "services-start"
  | "services-started"
  | "auth-shell-loaded"
  | "router-loaded"
  | "render-scheduled"
  | "route-rendered";

const recorded = new Set<StartupMilestone>();

export function markStartup(milestone: StartupMilestone): void {
  if (!startupProfilingEnabled || recorded.has(milestone)) return;
  recorded.add(milestone);
  performance.mark(`t3:startup:${milestone}`);
}
