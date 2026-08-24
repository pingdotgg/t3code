import type { ServerProvider } from "@t3tools/contracts";

export interface SidebarPlanUsageEnvironment {
  readonly label: string;
  readonly serverConfig: {
    readonly providers: ReadonlyArray<ServerProvider>;
  } | null;
}

export interface SidebarPlanUsageEntry {
  readonly key: string;
  readonly environmentLabel: string;
  readonly providerLabel: string;
  readonly windowLabel: string;
  readonly usedPercent: number;
  readonly resetsAt: string | null;
  readonly checkedAt: string;
}

export type SidebarPlanUsageTone = "muted" | "warning" | "danger";

export function collectSidebarPlanUsage(
  environments: ReadonlyArray<SidebarPlanUsageEnvironment>,
): SidebarPlanUsageEntry[] {
  return environments.flatMap((environment) =>
    (environment.serverConfig?.providers ?? []).flatMap((provider) => {
      const planUsage = provider.planUsage;
      if (!planUsage) return [];
      return planUsage.windows.map((window) => ({
        key: `${environment.label}:${provider.instanceId}:${window.id}`,
        environmentLabel: environment.label,
        providerLabel: provider.displayName ?? provider.driver,
        windowLabel: window.label,
        usedPercent: window.usedPercent,
        resetsAt: window.resetsAt,
        checkedAt: planUsage.checkedAt,
      }));
    }),
  );
}

export function highestPlanUsagePercent(
  entries: ReadonlyArray<SidebarPlanUsageEntry>,
): number | null {
  if (entries.length === 0) return null;
  return entries.reduce((highest, entry) => Math.max(highest, entry.usedPercent), 0);
}

export function sidebarPlanUsageTone(usedPercent: number): SidebarPlanUsageTone {
  if (usedPercent >= 90) return "danger";
  if (usedPercent >= 70) return "warning";
  return "muted";
}
