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
import { useEffect, useState, type ReactNode } from "react";

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
  merged: {
    label: "Merged",
    icon: PullRequestGlyph.merged,
    color: "text-violet-400",
    bar: "bg-violet-400",
    detail:
      "Remove worktrees whose current commit was merged through a pull request, including squash merges.",
  },
  unchanged: {
    label: "No unique commits",
    icon: GitBranchIcon,
    color: "text-sky-400",
    bar: "bg-sky-400",
    detail: "Remove worktrees with no commits beyond the default branch.",
  },
  inactive: {
    label: "Settled threads",
    icon: Clock3Icon,
    color: "text-amber-400",
    bar: "bg-amber-400",
    detail:
      "Remove worktrees for settled threads after this many days without activity. Branches and thread history are kept.",
  },
  kept: {
    label: "Other worktrees",
    icon: ShieldCheckIcon,
    color: "text-muted-foreground",
    bar: "bg-muted-foreground",
    detail:
      "Active or shared worktrees, worktrees with local changes, and those outside the cleanup rules.",
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
  if (totals.folders > 0 && totals.measured === 0 && totals.bytes === 0) return "—";
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
  const scanning = data?.scanning === true;
  const loading = isPending || scanning;
  const [progressDisplay, setProgressDisplay] = useState({ loading, visible: loading });
  if (progressDisplay.loading !== loading) {
    setProgressDisplay({ loading, visible: loading || progressDisplay.visible });
  }
  useEffect(() => {
    if (loading) return;
    // Let the storage segments finish their 300ms transition before hiding progress.
    const timeout = window.setTimeout(
      () => setProgressDisplay({ loading: false, visible: false }),
      500,
    );
    return () => window.clearTimeout(timeout);
  }, [loading]);
  const showProgress = loading || (progressDisplay.visible && data !== null && failed.length === 0);
  const progress = scanning ? data.progress : undefined;
  const scanPercent = !loading
    ? 100
    : progress && progress.total > 0
      ? Math.min(99, Math.floor((progress.completed / progress.total) * 100))
      : undefined;
  const chartCategories =
    data?.categories.toSorted(
      (left, right) =>
        Number(right.kind === "kept") - Number(left.kind === "kept") ||
        Number(right.kind === "unchecked") - Number(left.kind === "unchecked"),
    ) ?? [];
  const partialScan =
    scanning || partial || (!!data && (data.unchecked > 0 || data.unavailable > 0));
  const incomplete =
    data &&
    (data.unchecked > 0 || data.unavailable > 0 || data.total.measured < data.total.folders);

  return (
    <div
      className="overflow-hidden rounded-lg border border-border/60"
      aria-busy={isPending || scanning}
    >
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
                <p className="whitespace-nowrap text-lg font-semibold tabular-nums tracking-tight">
                  {space(data?.total, partialScan)}
                </p>
              )}
              <p className="text-xs tabular-nums text-muted-foreground">
                {showProgress
                  ? scanPercent === undefined
                    ? "Preparing scan…"
                    : `${scanPercent}% scanned`
                  : "used by worktrees"}
              </p>
            </div>
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    disabled={!canRefresh || isPending || scanning}
                    onClick={refresh}
                    aria-label="Refresh storage usage"
                  >
                    <RefreshCwIcon
                      className={`size-3.5 ${loading ? "animate-spin motion-reduce:animate-none" : ""}`}
                    />
                  </Button>
                }
              />
              <TooltipPopup>
                {data
                  ? `Checked ${new Date(data.checkedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}. Measurements cached for five minutes.`
                  : "Refresh storage usage"}
              </TooltipPopup>
            </Tooltip>
          </div>
        </div>
        <div className="relative">
          {initialLoading ? (
            <Skeleton className="h-6 w-full" />
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
                    className={`${scanning && category.kind === "unchecked" ? CATEGORIES.kept.bar : CATEGORIES[category.kind].bar} h-full shrink-0 transition-[width] duration-300 ease-in-out motion-reduce:transition-none`}
                    style={{ width: `${(category.bytes / data.total.bytes) * 100}%` }}
                  />
                ))}
            </div>
          )}
          {showProgress && (
            <div
              role="progressbar"
              aria-label="Storage scan progress"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={scanPercent}
              className="absolute inset-x-0 top-full mt-1 h-1 overflow-hidden rounded-full bg-muted"
            >
              <div
                className="h-full rounded-full bg-primary transition-[width] duration-300 ease-in-out motion-reduce:transition-none"
                style={{ width: `${scanPercent ?? 0}%` }}
              />
            </div>
          )}
        </div>
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
              .filter(
                (category) => category.folders > 0 && (!scanning || category.kind !== "unchecked"),
              )
              .map((category) => (
                <div key={category.kind} className="flex shrink-0 items-start gap-2">
                  <span
                    className={`mt-0.5 size-2.5 shrink-0 rounded-xs ${CATEGORIES[category.kind].bar}`}
                    aria-hidden="true"
                  />
                  <div className="min-w-0">
                    <dt className="whitespace-nowrap text-xs">{CATEGORIES[category.kind].label}</dt>
                    <dd className="mt-0.5 whitespace-nowrap text-xs tabular-nums text-muted-foreground">
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
      <div>
        {controls && (
          <div className="@container/storage-headings px-3 sm:px-4">
            <div className="hidden items-center gap-8 border-b border-border/60 py-2 text-2xs font-semibold uppercase tracking-wider text-muted-foreground/70 @min-[32rem]/storage-headings:flex">
              <span className="min-w-0 flex-1">Category</span>
              <div className="flex shrink-0 gap-4 text-right">
                <span className="w-28">Space used</span>
                <span className="w-44">Automatic cleanup</span>
              </div>
            </div>
          </div>
        )}
        {(Object.keys(CATEGORIES) as StorageCleanupCategory[]).map((kind) => {
          const category = data?.categories.find((entry) => entry.kind === kind);
          if (kind === "unchecked" && (scanning || !category?.folders)) return null;
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
                  <div className="w-28 shrink-0 whitespace-nowrap text-right text-sm tabular-nums">
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
      {!isPending && !scanning && incomplete && (
        <p className="px-4 pb-3 text-xs text-muted-foreground">
          Partial scan. Some storage could not be measured or classified.
        </p>
      )}
    </div>
  );
}
