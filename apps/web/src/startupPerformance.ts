const markedStartupMilestones = new Set<string>();

/**
 * Records startup timing without coupling it to tracing, which is configured
 * only after authentication.
 */
export function markStartupMilestone(name: string): void {
  if (markedStartupMilestones.has(name) || typeof performance === "undefined") {
    return;
  }
  markedStartupMilestones.add(name);
  performance.mark(name);
}
