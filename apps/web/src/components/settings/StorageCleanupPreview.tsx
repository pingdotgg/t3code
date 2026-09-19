import type { StorageCleanupCategory, StorageUsageTotals } from "@t3tools/contracts";
import {
  Clock3Icon,
  GitBranchIcon,
  HardDriveIcon,
  RefreshCwIcon,
  ShieldCheckIcon,
  Trash2Icon,
  CircleHelpIcon,
} from "lucide-react";
import type { ReactNode } from "react";

import { PullRequestGlyph } from "../pullRequest/pullRequestIcons";
import { Button } from "../ui/button";
import { Skeleton } from "../ui/skeleton";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { useSettingsScope } from "./SettingsScopeContext";
import { useStorageUsage } from "./useStorageUsage";
import { SettingsRow } from "./settingsLayout";

const CATEGORIES = {
  deleted: {
    label: "Deleted threads",
    icon: Trash2Icon,
    color: "text-rose-400",
    bar: "bg-rose-400",
    detail:
      "Remove unused worktrees when active or archived threads are deleted. Worktrees with local changes are kept.",
  },
  inactive: {
    label: "Inactive",
    icon: Clock3Icon,
    color: "text-amber-400",
    bar: "bg-amber-400",
    detail:
      "Remove worktrees after their threads have been inactive for this many days. Branches and thread history are kept.",
  },
  merged: {
    label: "Merged",
    icon: PullRequestGlyph.merged,
    color: "text-violet-400",
    bar: "bg-violet-400",
    detail:
      "Remove worktrees whose pull request is merged and whose commits are included in the default branch.",
  },
  unchanged: {
    label: "No unique commits",
    icon: GitBranchIcon,
    color: "text-sky-400",
    bar: "bg-sky-400",
    detail: "Remove worktrees with no commits beyond the default branch.",
  },
  kept: {
    label: "Other worktrees",
    icon: ShieldCheckIcon,
    color: "text-muted-foreground",
    bar: "bg-muted-foreground",
    detail:
      "Active or shared worktrees, worktrees with local changes or protected files, and those outside the cleanup rules.",
  },
  unchecked: {
    label: "Not classified",
    icon: CircleHelpIcon,
    color: "text-muted-foreground",
    bar: "bg-muted-foreground/20",
    detail: "These worktrees could not be classified.",
  },
} as const;

type CleanupControls = Partial<Record<StorageCleanupCategory, ReactNode>>;

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), 4);
  return `${(bytes / 1024 ** index).toLocaleString(undefined, { maximumFractionDigits: 1 })} ${["B", "KB", "MB", "GB", "TB"][index]}`;
}

function space(totals: StorageUsageTotals | undefined, partial = false) {
  if (!totals) return "—";
  if (totals.folders > 0 && totals.measured === 0) return "—";
  return `${partial || totals.measured < totals.folders ? "≥ " : ""}${formatBytes(totals.bytes)}`;
}

export function StorageCleanupPreviewPanel({
  inactiveAfterDays,
  controls,
  mixedRules,
}: {
  inactiveAfterDays?: number | null | undefined;
  controls?: CleanupControls | undefined;
  mixedRules?: Partial<Record<StorageCleanupCategory, boolean>> | undefined;
}) {
  const { scope, environments } = useSettingsScope();
  const {
    data,
    isPending,
    recalculatingInactive,
    partial,
    offline,
    unsupported,
    failed,
    canRefresh,
    refresh,
  } = useStorageUsage(inactiveAfterDays);
  const initialLoading = isPending && data === null;
  const chartCategories =
    data?.categories.toSorted(
      (left, right) => Number(right.kind === "kept") - Number(left.kind === "kept"),
    ) ?? [];
  const partialScan = partial || (!!data && (data.unchecked > 0 || data.unavailable > 0));
  const incomplete =
    data &&
    (data.unchecked > 0 || data.unavailable > 0 || data.total.measured < data.total.folders);

  return (
    <div className="overflow-hidden rounded-lg border border-border/60" aria-busy={isPending}>
      <div className="space-y-4 border-b border-border/50 px-4 py-4">
        <div className="flex items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-3">
            <div className="flex size-10 shrink-0 items-center justify-center rounded-lg border border-border/60 bg-muted/40">
              <HardDriveIcon className="size-5 text-muted-foreground" aria-hidden="true" />
            </div>
            <div className="min-w-0">
              <p className="text-sm font-medium">Worktree storage</p>
              {initialLoading ? (
                <Skeleton className="mt-1 h-3 w-28" />
              ) : (
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {data
                    ? `${data.projectCount.toLocaleString()} ${environments.length > 1 ? "project checkout" : "project"}${data.projectCount === 1 ? "" : "s"}`
                    : "Storage unavailable"}
                  {environments.length > 1 && ` · ${environments.length} machines`}
                </p>
              )}
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <div className="text-right" aria-live="polite">
              {initialLoading ? (
                <Skeleton className="ml-auto h-7 w-24" />
              ) : (
                <p className="text-lg font-semibold tabular-nums tracking-tight">
                  {space(data?.total, partialScan)}
                </p>
              )}
              <p className="text-xs text-muted-foreground">used by worktrees</p>
            </div>
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    disabled={!canRefresh || isPending}
                    onClick={refresh}
                    aria-label="Refresh storage usage"
                  >
                    <RefreshCwIcon className="size-3.5" />
                  </Button>
                }
              />
              <TooltipPopup>
                {data
                  ? `Checked ${new Date(data.checkedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}. Cached for one minute.`
                  : "Refresh storage usage"}
              </TooltipPopup>
            </Tooltip>
          </div>
        </div>
        {isPending ? (
          <Skeleton className="h-6 w-full rounded-md" />
        ) : (
          <div
            className="flex h-6 overflow-hidden rounded-md bg-muted ring-1 ring-inset ring-border/60"
            aria-hidden="true"
          >
            {data &&
              data.total.bytes > 0 &&
              chartCategories.map((category) => (
                <div
                  key={category.kind}
                  className={`${CATEGORIES[category.kind].bar} h-full shrink-0`}
                  style={{ width: `${(category.bytes / data.total.bytes) * 100}%` }}
                />
              ))}
          </div>
        )}
        {!data && isPending && (
          <div className="flex gap-5 overflow-hidden" aria-hidden="true">
            {Object.keys(CATEGORIES)
              .filter((kind) => kind !== "unchecked")
              .map((kind) => (
                <div key={kind} className="shrink-0 space-y-1">
                  <Skeleton className="h-4 w-28" />
                  <Skeleton className="h-3 w-16" />
                </div>
              ))}
          </div>
        )}
        {data && (
          <dl
            className="flex gap-5 overflow-x-auto pb-1"
            tabIndex={0}
            aria-label="Storage categories"
          >
            {chartCategories
              .filter((category) => category.folders > 0)
              .map((category) => (
                <div key={category.kind} className="flex shrink-0 items-start gap-2">
                  <span
                    className={`mt-0.5 size-2.5 shrink-0 rounded-xs ${CATEGORIES[category.kind].bar}`}
                    aria-hidden="true"
                  />
                  <div className="min-w-0">
                    <dt className="whitespace-nowrap text-xs">{CATEGORIES[category.kind].label}</dt>
                    <dd className="mt-0.5 text-xs tabular-nums text-muted-foreground">
                      {initialLoading || (recalculatingInactive && category.kind === "inactive") ? (
                        <Skeleton className="h-4 w-16" />
                      ) : (
                        space(category)
                      )}
                    </dd>
                  </div>
                </div>
              ))}
          </dl>
        )}
      </div>
      {environments.length > 1 && (
        <p className="px-4 pb-3 text-xs text-muted-foreground">
          Usage and rules follow {scope.label}. Changes apply to connected machines.
        </p>
      )}
      <div className="pb-3">
        {controls && (
          <div className="mb-1 hidden justify-between px-4 text-[11px] text-muted-foreground sm:flex">
            <span>Space by category</span>
            <span>Automatic cleanup</span>
          </div>
        )}
        {(Object.keys(CATEGORIES) as StorageCleanupCategory[]).map((kind) => {
          const category = data?.categories.find((entry) => entry.kind === kind);
          if (kind === "unchecked" && !category?.folders) return null;
          const { icon: Icon, label, color, detail } = CATEGORIES[kind];
          return (
            <SettingsRow
              key={kind}
              title={
                <span className="flex items-center gap-2.5">
                  <Icon className={`size-4 shrink-0 ${color}`} aria-hidden="true" />
                  {label}
                </span>
              }
              description={detail}
              status={mixedRules?.[kind] ? "Mixed across selected machines" : undefined}
              serverScoped={
                !!controls?.[kind] && scope.kind !== "project" && scope.kind !== "checkout"
              }
              control={
                <div className="flex w-full items-center justify-between gap-4 @min-[32rem]/settings-row:w-auto">
                  <div className="w-20 text-right text-sm tabular-nums">
                    {initialLoading || (recalculatingInactive && kind === "inactive") ? (
                      <Skeleton className="ml-auto h-5 w-16" />
                    ) : (
                      space(category)
                    )}
                  </div>
                  {controls && (
                    <div className="flex shrink-0 justify-end @min-[32rem]/settings-row:w-44">
                      {controls[kind]}
                    </div>
                  )}
                </div>
              }
            />
          );
        })}
      </div>
      {(offline.length > 0 || unsupported.length > 0 || failed.length > 0) && (
        <div className="px-4 pb-3 text-xs text-muted-foreground" role="status">
          {offline.length > 0 && <p>Offline: {offline.join(", ")}. Usage excluded.</p>}
          {unsupported.length > 0 && <p>Update for storage usage: {unsupported.join(", ")}.</p>}
          {failed.length > 0 && <p>Usage unavailable: {failed.join(", ")}. Try refreshing.</p>}
        </div>
      )}
      {!isPending && incomplete && (
        <p className="px-4 pb-3 text-xs text-muted-foreground">
          Partial scan. Some storage could not be measured or classified.
        </p>
      )}
    </div>
  );
}
