import type { EnvironmentId, ProjectId, ServerSettings } from "@t3tools/contracts";

export type AutoSettleSettings = Pick<
  ServerSettings,
  "sidebarAutoSettleAfterDays" | "sidebarAutoSettleOnMerge" | "sidebarAutoSettleScope"
>;

interface AutoSettleSyncTarget {
  readonly environmentId: EnvironmentId;
  readonly projectId?: ProjectId | null;
  readonly label: string;
  readonly settings: AutoSettleSettings | null;
  readonly supportsScope?: boolean;
}

/** Receives connected, capable targets. Applying these defaults must preserve other settings. */
export function planAutoSettleSettingsSync(
  reference: {
    readonly environmentId: EnvironmentId;
    readonly projectId?: ProjectId | null;
    readonly settings: AutoSettleSettings;
    readonly supportsScope?: boolean;
  },
  targets: readonly AutoSettleSyncTarget[],
) {
  const patch = {
    sidebarAutoSettleAfterDays: reference.settings.sidebarAutoSettleAfterDays,
    sidebarAutoSettleOnMerge: reference.settings.sidebarAutoSettleOnMerge,
    ...(reference.supportsScope
      ? { sidebarAutoSettleScope: reference.settings.sidebarAutoSettleScope }
      : {}),
  };
  const mismatches = targets.filter(
    (target) =>
      (target.environmentId !== reference.environmentId ||
        target.projectId !== reference.projectId) &&
      target.settings !== null &&
      (target.settings.sidebarAutoSettleAfterDays !== patch.sidebarAutoSettleAfterDays ||
        target.settings.sidebarAutoSettleOnMerge !== patch.sidebarAutoSettleOnMerge ||
        (target.supportsScope === true &&
          patch.sidebarAutoSettleScope !== undefined &&
          target.settings.sidebarAutoSettleScope !== patch.sidebarAutoSettleScope)),
  );
  return { patch, mismatches };
}
