import type { EnvironmentId, ProjectId, ServerSettings } from "@t3tools/contracts";

export type AutoSettleSettings = Pick<
  ServerSettings,
  | "sidebarAutoSettleAfterDays"
  | "autoSettleFinishedChildrenAfterHours"
  | "autoArchiveSettledAfterDays"
  | "threadHistoryTrimAfterDays"
>;

interface AutoSettleSyncTarget {
  readonly environmentId: EnvironmentId;
  readonly projectId?: ProjectId | null;
  readonly label: string;
  readonly settings: AutoSettleSettings | null;
}

export function planAutoSettleSettingsSync(
  reference: {
    readonly environmentId: EnvironmentId;
    readonly projectId?: ProjectId | null;
    readonly settings: AutoSettleSettings;
  },
  targets: readonly AutoSettleSyncTarget[],
  // Child auto-settle, auto-archive and trimming are environment-wide and unknown to older servers,
  // so callers include them only outside project scope and when every target supports them.
  {
    includeFinishedChildren = false,
    includeAutoArchive = false,
    includeHistoryTrim = false,
  }: {
    readonly includeFinishedChildren?: boolean;
    readonly includeAutoArchive?: boolean;
    readonly includeHistoryTrim?: boolean;
  } = {},
) {
  const patch: Partial<AutoSettleSettings> = {
    sidebarAutoSettleAfterDays: reference.settings.sidebarAutoSettleAfterDays,
    ...(includeFinishedChildren
      ? {
          autoSettleFinishedChildrenAfterHours:
            reference.settings.autoSettleFinishedChildrenAfterHours,
        }
      : {}),
    ...(includeAutoArchive
      ? { autoArchiveSettledAfterDays: reference.settings.autoArchiveSettledAfterDays }
      : {}),
    ...(includeHistoryTrim
      ? { threadHistoryTrimAfterDays: reference.settings.threadHistoryTrimAfterDays }
      : {}),
  };
  const mismatches = targets.filter(
    (target) =>
      (target.environmentId !== reference.environmentId ||
        target.projectId !== reference.projectId) &&
      target.settings !== null &&
      (target.settings.sidebarAutoSettleAfterDays !== patch.sidebarAutoSettleAfterDays ||
        (includeFinishedChildren &&
          target.settings.autoSettleFinishedChildrenAfterHours !==
            patch.autoSettleFinishedChildrenAfterHours) ||
        (includeAutoArchive &&
          target.settings.autoArchiveSettledAfterDays !== patch.autoArchiveSettledAfterDays) ||
        (includeHistoryTrim &&
          target.settings.threadHistoryTrimAfterDays !== patch.threadHistoryTrimAfterDays)),
  );
  return { patch, mismatches };
}
