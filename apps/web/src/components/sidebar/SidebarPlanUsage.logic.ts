import type { ServerProvider } from "@t3tools/contracts";

import { resolveTimestampLocale } from "../../timestampFormat";

export interface SidebarPlanUsageEnvironment {
  readonly environmentId: string;
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
        key: `${environment.environmentId}:${provider.instanceId}:${window.id}`,
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

export function formatPlanUsageReset(
  resetsAt: string | null,
  systemLocale: string | null | undefined,
): string | null {
  if (!resetsAt) return null;
  const reset = new Date(resetsAt);
  if (Number.isNaN(reset.getTime())) return null;
  return new Intl.DateTimeFormat(resolveTimestampLocale(systemLocale), {
    weekday: "short",
    hour: "numeric",
    minute: "2-digit",
  }).format(reset);
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
