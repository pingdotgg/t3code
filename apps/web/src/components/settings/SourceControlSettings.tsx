import {
  ArrowUpRightIcon,
  ChevronDownIcon,
  GitBranchIcon,
  GitPullRequestIcon,
  RefreshCwIcon,
} from "lucide-react";
import { Link } from "@tanstack/react-router";
import * as Duration from "effect/Duration";
import * as Option from "effect/Option";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useAtomValue } from "@effect/atom-react";
import type {
  BackgroundActivitySettings,
  EnvironmentId,
  SourceControlProviderKind,
  SourceControlDiscoveryResult,
  SourceControlProviderAuth,
  SourceControlProviderDiscoveryItem,
  VcsDriverKind,
  VcsDiscoveryItem,
  WorktreeInfo,
  WorktreePruneBlocker,
} from "@t3tools/contracts";
import {
  getBackgroundActivityBaseProfile,
  getBackgroundActivityPresetSettings,
  resolveServerBackgroundActivitySettings,
} from "@t3tools/shared/backgroundActivitySettings";
import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts/settings";

import { formatRelativeTimeLabel } from "../../timestampFormat";
import { useAtomCommand } from "../../state/use-atom-command";

import {
  useEnvironmentSettings,
  usePrimarySettings,
  useUpdateEnvironmentSettings,
  useUpdatePrimarySettings,
} from "../../hooks/useSettings";
import { cn } from "../../lib/utils";
import {
  useEnvironments,
  usePrimaryEnvironment,
  usePrimaryEnvironmentId,
} from "../../state/environments";
import { environmentServerConfigsAtom } from "../../state/server";
import { useEnvironmentQuery } from "../../state/query";
import { sourceControlEnvironment } from "../../state/sourceControl";
import { worktreeEnvironment } from "../../state/worktrees";
import { Alert, AlertDescription, AlertTitle } from "../ui/alert";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Collapsible, CollapsibleContent } from "../ui/collapsible";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "../ui/empty";
import { Skeleton } from "../ui/skeleton";
import {
  NumberField,
  NumberFieldDecrement,
  NumberFieldGroup,
  NumberFieldIncrement,
  NumberFieldInput,
} from "../ui/number-field";
import { Switch } from "../ui/switch";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

import {
  AzureDevOpsIcon,
  BitbucketIcon,
  GitHubIcon,
  GitIcon,
  GitLabIcon,
  JujutsuIcon,
  type Icon,
} from "../Icons";
import { ProjectFavicon } from "../ProjectFavicon";
import { RedactedSensitiveText } from "./RedactedSensitiveText";
import { SourceControlWritingSettingsSection } from "./SourceControlWritingSettings";
import {
  PolicyTooltip,
  SettingResetButton,
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
  useRelativeTimeTick,
} from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

const EMPTY_DISCOVERY_RESULT: SourceControlDiscoveryResult = {
  versionControlSystems: [],
  sourceControlProviders: [],
};

const SOURCE_CONTROL_PROVIDER_ICONS: Partial<Record<SourceControlProviderKind, Icon>> = {
  github: GitHubIcon,
  gitlab: GitLabIcon,
  "azure-devops": AzureDevOpsIcon,
  bitbucket: BitbucketIcon,
};

const VCS_ICONS: Partial<Record<VcsDriverKind, Icon>> = {
  git: GitIcon,
  jj: JujutsuIcon,
};

const SOURCE_CONTROL_SKELETON_ROWS = ["primary", "secondary"] as const;
const GIT_FETCH_INTERVAL_STEP_SECONDS = 5;
type BackgroundActivityOverridePatch = Partial<{
  [K in keyof BackgroundActivitySettings["overrides"]]:
    | BackgroundActivitySettings["overrides"][K]
    | undefined;
}>;

function durationToSeconds(duration: Duration.Duration): number {
  return Math.round(Duration.toMillis(duration) / 1_000);
}

function normalizeFetchIntervalSeconds(value: number | null): number {
  if (value === null || !Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.round(value));
}

function backgroundActivityOverrideSettings(
  current: BackgroundActivitySettings,
  overrides: BackgroundActivityOverridePatch,
) {
  const nextOverrides: BackgroundActivityOverridePatch = {
    ...current.overrides,
    ...overrides,
  };
  for (const [key, value] of Object.entries(nextOverrides)) {
    if (value === undefined) {
      delete nextOverrides[key as keyof typeof nextOverrides];
    }
  }
  return {
    backgroundActivity: {
      schemaVersion: 1 as const,
      profile: "custom" as const,
      baseProfile: getBackgroundActivityBaseProfile(current),
      overrides: nextOverrides as BackgroundActivitySettings["overrides"],
    },
  };
}

function optionLabel(value: Option.Option<string>): string | null {
  return Option.getOrNull(value);
}

function isProviderDiscoveryItem(
  item: VcsDiscoveryItem | SourceControlProviderDiscoveryItem,
): item is SourceControlProviderDiscoveryItem {
  return "auth" in item;
}

function isVcsNotReady(item: VcsDiscoveryItem | SourceControlProviderDiscoveryItem): boolean {
  return !isProviderDiscoveryItem(item) && !item.implemented;
}

function authPresentation(auth: SourceControlProviderAuth): {
  readonly label: string;
  readonly badge: "warning" | null;
} {
  if (auth.status === "authenticated") {
    return { label: "Authenticated", badge: null };
  }
  if (auth.status === "unauthenticated") {
    return { label: "Not authenticated", badge: "warning" };
  }
  return { label: "Status unknown", badge: null };
}

function RedactedAccount(props: { readonly account: string | null }) {
  return (
    <RedactedSensitiveText
      value={props.account}
      ariaLabel="Toggle source control account visibility"
      revealTooltip="Click to reveal account"
      hideTooltip="Click to hide account"
    />
  );
}

function itemStatusDot(item: VcsDiscoveryItem | SourceControlProviderDiscoveryItem): string {
  if (isVcsNotReady(item)) return "bg-muted-foreground/35";
  if (item.status !== "available") return "bg-warning";
  if (isProviderDiscoveryItem(item) && item.auth.status !== "authenticated") return "bg-warning";
  return "bg-success";
}

function SourceControlItemMark({
  item,
}: {
  readonly item: VcsDiscoveryItem | SourceControlProviderDiscoveryItem;
}) {
  const dotClassName = itemStatusDot(item);
  const Icon = isProviderDiscoveryItem(item)
    ? SOURCE_CONTROL_PROVIDER_ICONS[item.kind]
    : VCS_ICONS[item.kind];

  if (!Icon) {
    return <span className={cn("size-2 shrink-0 rounded-full", dotClassName)} aria-hidden />;
  }

  return (
    <span className="relative inline-flex size-5 shrink-0 items-center justify-center">
      <Icon className="size-4.5 text-foreground/80" aria-hidden />
      <span
        className={cn(
          "pointer-events-none absolute -left-0.5 -top-0.5 size-2 rounded-full ring-2 ring-background",
          dotClassName,
        )}
        aria-hidden
      />
    </span>
  );
}

function itemSummary({
  item,
  auth,
  authAccount,
}: {
  readonly item: VcsDiscoveryItem | SourceControlProviderDiscoveryItem;
  readonly auth: SourceControlProviderAuth | null;
  readonly authAccount: string | null;
}) {
  if (isVcsNotReady(item)) {
    return <span>Support for {item.label} is coming soon.</span>;
  }

  if (item.status !== "available") {
    return <span>Not available on this server: {item.installHint}</span>;
  }

  if (auth) {
    if (auth.status === "authenticated") {
      return (
        <>
          <span>Authenticated</span>
          {authAccount ? (
            <>
              <span aria-hidden>as</span>
              <RedactedAccount account={authAccount} />
            </>
          ) : null}
        </>
      );
    }

    if (!item.executable) {
      return <span>Available. {item.installHint}</span>;
    }

    if (auth.status === "unauthenticated") {
      return (
        <span>
          {item.label} is not authenticated on this server. Sign in or configure credentials using
          the <code className="rounded bg-muted px-1 py-px text-[11px]">{item.executable}</code>{" "}
          tool on the server host to enable change request features.
        </span>
      );
    }
    return (
      <span>
        Could not verify {item.label}. {item.installHint}
      </span>
    );
  }

  return <span>Available</span>;
}

function DiscoveryItemRow({
  item,
  children,
}: {
  readonly item: VcsDiscoveryItem | SourceControlProviderDiscoveryItem;
  readonly children?: ReactNode;
}) {
  const version = optionLabel(item.version);
  const enabled = isProviderDiscoveryItem(item)
    ? item.status === "available" && item.auth.status === "authenticated"
    : item.status === "available" && item.implemented;
  const auth = isProviderDiscoveryItem(item) ? item.auth : null;
  const authStatus = auth ? authPresentation(auth) : null;
  const authAccount = auth ? optionLabel(auth.account) : null;
  const [isExpanded, setIsExpanded] = useState(false);
  const hasDetails = children !== undefined;

  return (
    <div
      className={cn(
        "rounded-xl transition-colors hover:bg-muted/20",
        isVcsNotReady(item) && "opacity-80",
      )}
    >
      <div className="px-3 py-3 sm:px-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0 flex-1 space-y-1">
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <SourceControlItemMark item={item} />
              <span className="truncate text-sm font-medium tracking-[-0.005em] text-foreground">
                {item.label}
              </span>
              {version ? <code className="text-xs text-muted-foreground">{version}</code> : null}
              {isVcsNotReady(item) ? (
                <Badge variant="warning" size="sm">
                  Coming Soon
                </Badge>
              ) : null}
              {authStatus?.badge ? (
                <Badge variant={authStatus.badge} size="sm">
                  {authStatus.label}
                </Badge>
              ) : null}
            </div>
            <p className="flex min-w-0 flex-wrap items-center gap-x-1 text-[13px] leading-[1.45] text-muted-foreground/80">
              {itemSummary({ item, auth, authAccount })}
            </p>
          </div>
          <div className="flex w-full shrink-0 items-center gap-2 sm:w-auto sm:justify-end">
            {hasDetails ? (
              <Button
                size="compact"
                variant="ghost-muted"
                onClick={() => setIsExpanded((open) => !open)}
                aria-expanded={isExpanded}
                aria-label={`Toggle ${item.label} details`}
              >
                <ChevronDownIcon
                  className={cn("size-3.5 transition-transform", isExpanded && "rotate-180")}
                />
              </Button>
            ) : null}
            {!isVcsNotReady(item) ? (
              <Switch checked={enabled} disabled aria-label={`${item.label} availability`} />
            ) : null}
          </div>
        </div>
      </div>

      {hasDetails ? (
        <Collapsible open={isExpanded} onOpenChange={setIsExpanded}>
          <CollapsibleContent>
            <div className="px-3 pb-4 pt-1 sm:px-4">{children}</div>
          </CollapsibleContent>
        </Collapsible>
      ) : null}
    </div>
  );
}

function GitFetchIntervalSettings() {
  const settings = usePrimarySettings();
  const updateSettings = useUpdatePrimarySettings();
  const resolvedBackgroundActivity = resolveServerBackgroundActivitySettings(settings);
  const automaticGitFetchIntervalSeconds = durationToSeconds(
    resolvedBackgroundActivity.automaticGitFetchInterval,
  );
  const defaultAutomaticGitFetchIntervalSeconds = durationToSeconds(
    getBackgroundActivityPresetSettings(
      getBackgroundActivityBaseProfile(settings.backgroundActivity),
    ).automaticGitFetchInterval,
  );
  const canResetFetchInterval =
    automaticGitFetchIntervalSeconds !== defaultAutomaticGitFetchIntervalSeconds;

  return (
    <div className="grid gap-3">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 space-y-1">
          <div className="flex min-w-0 items-center gap-1">
            <span className="text-xs font-medium text-foreground">Fetch interval</span>
            <PolicyTooltip>
              This interval is configured for Git only. The shared Background activity policy still
              decides whether Git refreshes may run when the timer fires. Custom intervals appear as
              Advanced in General settings.
            </PolicyTooltip>
            <span
              className={cn(
                "inline-flex size-5 shrink-0 items-center justify-center transition-opacity",
                canResetFetchInterval ? "opacity-100" : "pointer-events-none opacity-0",
              )}
              aria-hidden={!canResetFetchInterval}
            >
              {canResetFetchInterval ? (
                <SettingResetButton
                  label="fetch interval"
                  onClick={() =>
                    updateSettings(
                      backgroundActivityOverrideSettings(settings.backgroundActivity, {
                        automaticGitFetchInterval: undefined,
                      }),
                    )
                  }
                />
              ) : null}
            </span>
          </div>
          <p className="max-w-2xl text-xs leading-relaxed text-muted-foreground">
            Refresh remote branch status in the background. Set this to 0 seconds if Git credentials
            or security keys should only be prompted by explicit Git actions.
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <NumberField
            value={automaticGitFetchIntervalSeconds}
            min={0}
            step={GIT_FETCH_INTERVAL_STEP_SECONDS}
            size="sm"
            className="w-32"
            onValueChange={(value) =>
              updateSettings(
                backgroundActivityOverrideSettings(settings.backgroundActivity, {
                  automaticGitFetchInterval: Duration.seconds(normalizeFetchIntervalSeconds(value)),
                }),
              )
            }
          >
            <NumberFieldGroup>
              <NumberFieldDecrement aria-label="Decrease fetch interval" />
              <NumberFieldInput aria-label="Automatic Git fetch interval in seconds" />
              <NumberFieldIncrement aria-label="Increase fetch interval" />
            </NumberFieldGroup>
          </NumberField>
          <span className="text-xs text-muted-foreground">seconds</span>
        </div>
      </div>
    </div>
  );
}

function SourceControlSectionSkeleton({
  title,
  headerAction,
}: {
  readonly title: string;
  readonly headerAction?: ReactNode;
}) {
  return (
    <SettingsSection title={title} headerAction={headerAction}>
      {SOURCE_CONTROL_SKELETON_ROWS.map((row) => (
        <div key={row} className="rounded-xl px-3 py-3 sm:px-4">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0 flex-1 space-y-2">
              <div className="flex items-center gap-2">
                <span className="relative inline-flex size-5 shrink-0 items-center justify-center">
                  <Skeleton className="size-4.5 rounded-md" />
                  <Skeleton
                    className="pointer-events-none absolute -left-0.5 -top-0.5 size-2 rounded-full ring-2 ring-background"
                    aria-hidden
                  />
                </span>
                <Skeleton className="h-4 w-28 rounded-full" />
                <Skeleton className="h-5 w-14 rounded-full" />
              </div>
              <Skeleton className="h-3 w-full max-w-xs rounded-full" />
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <Skeleton className="size-7 rounded-md" />
              <Skeleton className="h-5 w-9 rounded-full" />
            </div>
          </div>
        </div>
      ))}
    </SettingsSection>
  );
}

function EmptySourceControlDiscovery({
  error,
  isPending,
  onScan,
}: {
  readonly error: string | null;
  readonly isPending: boolean;
  readonly onScan: () => void;
}) {
  const hasError = error !== null;

  return (
    <SettingsSection id={searchableSetting("source-control").id} title="Server environment">
      <Empty className="min-h-88">
        <EmptyMedia variant="icon">
          <GitPullRequestIcon />
        </EmptyMedia>
        <EmptyHeader>
          <EmptyTitle>
            {hasError ? "Could not scan the server environment" : "Nothing detected yet"}
          </EmptyTitle>
          <EmptyDescription>
            {hasError
              ? error
              : "Install Git on the server, add optional hosting integrations or credentials your workspace needs, then rescan."}
          </EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <Button
            size="sm"
            variant="outline"
            className="h-8 gap-1.5 px-3 text-xs"
            onClick={onScan}
            disabled={isPending}
          >
            <RefreshCwIcon className={cn("size-3.5", isPending && "animate-spin")} />
            Scan
          </Button>
        </EmptyContent>
      </Empty>
    </SettingsSection>
  );
}

type WorktreeManagementViewProps = {
  readonly environmentId: EnvironmentId;
  readonly worktrees: ReadonlyArray<WorktreeInfo>;
  readonly onPrune: (worktree: WorktreeInfo) => void;
  readonly pendingPath: string | null;
  readonly inventoryError: string | null;
  readonly isPending: boolean;
  readonly pruneAfterDays: number | null;
  readonly deleteOrphanedImmediately: boolean;
  readonly canResetPruneAfterDays: boolean;
  readonly canResetDeleteOrphaned: boolean;
  readonly onPruneAfterDaysChange: (days: number | null) => void;
  readonly onDeleteOrphanedImmediatelyChange: (checked: boolean) => void;
  readonly onResetPruneAfterDays: () => void;
  readonly onResetDeleteOrphaned: () => void;
};

function WorktreeRetentionSelect({
  pruneAfterDays,
  onChange,
  className = "w-full sm:w-36",
}: {
  readonly pruneAfterDays: number | null;
  readonly onChange: (days: number | null) => void;
  readonly className?: string;
}) {
  const value = pruneAfterDays === null ? "never" : String(pruneAfterDays);
  return (
    <Select
      value={value}
      onValueChange={(nextValue) => onChange(nextValue === "never" ? null : Number(nextValue))}
    >
      <SelectTrigger className={className} aria-label="Automatic worktree cleanup">
        <SelectValue>
          {pruneAfterDays === null
            ? "Never"
            : `${pruneAfterDays} ${pruneAfterDays === 1 ? "day" : "days"}`}
        </SelectValue>
      </SelectTrigger>
      <SelectPopup align="end" alignItemWithTrigger={false}>
        <SelectItem hideIndicator value="never">
          Never
        </SelectItem>
        {[1, 7, 14, 30, 60, 90, 365].map((days) => (
          <SelectItem key={days} hideIndicator value={String(days)}>
            {days} {days === 1 ? "day" : "days"}
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}

type WorktreeRowProps = {
  readonly environmentId: EnvironmentId;
  readonly worktree: WorktreeInfo;
  readonly onPrune: (worktree: WorktreeInfo) => void;
  readonly pendingPath: string | null;
};

function worktreeBlockerDetail(worktree: WorktreeInfo, blocker: WorktreePruneBlocker): string {
  switch (blocker) {
    case "active_thread": {
      const activeThreads = worktree.threads.filter((thread) => thread.status === "active");
      return activeThreads.length > 1 ? `${activeThreads.length} active threads` : "In use";
    }
    case "dirty":
      return worktree.dirtyFileCount !== null && worktree.dirtyFileCount > 0
        ? `${worktree.dirtyFileCount} changed file${worktree.dirtyFileCount === 1 ? "" : "s"}`
        : "Local changes";
    case "unpushed":
      return worktree.aheadOfUpstreamCount !== null && worktree.aheadOfUpstreamCount > 0
        ? `${worktree.aheadOfUpstreamCount} unpushed commit${worktree.aheadOfUpstreamCount === 1 ? "" : "s"}`
        : "Unpushed commits";
    case "status_unavailable":
      return "Status unavailable";
  }
}

function WorktreeProtectionStatus({ worktree }: { readonly worktree: WorktreeInfo }) {
  if (worktree.safeToPrune) return null;

  const priority: ReadonlyArray<WorktreePruneBlocker> = [
    "status_unavailable",
    "dirty",
    "unpushed",
    "active_thread",
  ];
  const primary = priority.find((blocker) => worktree.pruneBlockers.includes(blocker));
  if (primary === undefined) return null;

  const details = worktree.pruneBlockers.map((blocker) => worktreeBlockerDetail(worktree, blocker));
  return (
    <span
      className={cn(
        "shrink-0 text-[11px] tabular-nums",
        primary === "active_thread" ? "text-muted-foreground" : "text-warning",
      )}
      title={details.join(", ")}
    >
      {worktreeBlockerDetail(worktree, primary)}
      {details.length > 1 ? ` +${details.length - 1}` : null}
    </span>
  );
}

function WorktreeSyncCounters({ worktree }: { readonly worktree: WorktreeInfo }) {
  if (worktree.upstreamGone) {
    return <span className="shrink-0">upstream gone</span>;
  }
  const ahead = worktree.aheadOfUpstreamCount;
  const behind = worktree.behindUpstreamCount;
  if ((ahead === null || ahead === 0) && (behind === null || behind === 0)) return null;
  return (
    <span className="shrink-0 tabular-nums">
      {ahead !== null && ahead > 0 ? `${ahead} ahead` : null}
      {ahead !== null && ahead > 0 && behind !== null && behind > 0 ? ", " : null}
      {behind !== null && behind > 0 ? `${behind} behind` : null}
    </span>
  );
}

function WorktreeRichMetadata({
  environmentId,
  worktree,
}: {
  readonly environmentId: EnvironmentId;
  readonly worktree: WorktreeInfo;
}) {
  const linkedThreads = worktree.threads.filter((thread) => thread.status !== "deleted");
  const firstThread =
    linkedThreads.find((thread) => thread.status === "active") ??
    linkedThreads.find((thread) => thread.status === "settled") ??
    linkedThreads[0] ??
    null;
  const firstThreadTitle = firstThread?.title || "Untitled thread";
  const otherThreadCount = firstThread === null ? 0 : linkedThreads.length - 1;
  const parts: ReadonlyArray<{ key: string; node: ReactNode }> = [
    ...(firstThread
      ? [
          {
            key: "thread",
            node:
              firstThread.status === "archived" ? (
                <span className="min-w-0 max-w-full truncate" title={firstThreadTitle}>
                  {firstThreadTitle} (archived)
                </span>
              ) : (
                <Link
                  to="/$environmentId/$threadId"
                  params={{ environmentId, threadId: firstThread.threadId }}
                  className="inline-flex min-w-0 max-w-full items-center gap-1 text-foreground/70 hover:text-foreground"
                  title={firstThreadTitle}
                >
                  <ArrowUpRightIcon className="size-3 shrink-0" aria-hidden />
                  <span className="truncate">{firstThreadTitle}</span>
                </Link>
              ),
          },
        ]
      : [
          {
            key: "threads",
            node: <span className="shrink-0">No linked threads</span>,
          },
        ]),
    ...(otherThreadCount > 0
      ? [
          {
            key: "other-threads",
            node: (
              <span className="shrink-0 tabular-nums">
                +{otherThreadCount} thread{otherThreadCount === 1 ? "" : "s"}
              </span>
            ),
          },
        ]
      : []),
    ...(worktree.lastActivityAt
      ? [
          {
            key: "activity",
            node: (
              <span className="shrink-0">
                Used {formatRelativeTimeLabel(worktree.lastActivityAt)}
              </span>
            ),
          },
        ]
      : []),
    ...(worktree.upstreamGone || worktree.aheadOfUpstreamCount || worktree.behindUpstreamCount
      ? [{ key: "sync", node: <WorktreeSyncCounters worktree={worktree} /> }]
      : []),
  ];
  return (
    <span className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[11px] text-muted-foreground">
      {parts.map((part, index) => (
        <span key={part.key} className="flex min-w-0 items-center gap-x-1.5">
          {index > 0 ? <span aria-hidden>·</span> : null}
          {part.node}
        </span>
      ))}
    </span>
  );
}

/** House inline error strip. */
function WorktreeErrorStrip({ error }: { readonly error: string | null }) {
  if (error === null) return null;
  return (
    <Alert variant="error" className="mx-3 px-3 py-2 text-xs sm:mx-4">
      <AlertTitle>Couldn't load worktrees.</AlertTitle>
      <AlertDescription>{error}</AlertDescription>
    </Alert>
  );
}

/** House pending strip: live label, no skeletons. */
function WorktreePendingStrip({
  label,
  className,
}: {
  readonly label: string;
  readonly className?: string;
}) {
  return (
    <div
      role="status"
      aria-live="polite"
      className={cn(
        "mx-3 rounded-md border border-input bg-muted/40 px-3 py-2 text-xs text-muted-foreground sm:mx-4 dark:border-transparent dark:bg-white/[0.035]",
        className,
      )}
    >
      {label}
    </div>
  );
}

/** Settings-list empty medallion (matches Scheduled Tasks). */
function WorktreeEmptyMedallion() {
  return (
    <div className="flex flex-col items-center gap-3 px-5 py-12 text-center">
      <div className="grid size-10 place-items-center rounded-full border border-border/70 bg-muted/40 text-muted-foreground">
        <GitBranchIcon className="size-4.5" />
      </div>
      <div className="space-y-1">
        <p className="text-sm font-medium text-foreground">No worktrees yet</p>
        <p className="mx-auto max-w-xs text-xs text-muted-foreground">
          Worktrees created for threads show up here.
        </p>
      </div>
    </div>
  );
}

function WorktreeRemoveButton({ worktree, onPrune, pendingPath }: WorktreeRowProps) {
  if (!worktree.safeToPrune) return null;
  return (
    <Button
      size="xs"
      variant="ghost"
      className="text-muted-foreground hover:text-destructive"
      onClick={() => onPrune(worktree)}
      disabled={pendingPath !== null}
      aria-label={`Remove worktree ${worktree.branch ?? worktree.path}`}
    >
      Remove
    </Button>
  );
}

/** Policy controls as canonical settings rows. */
function WorktreePolicyRows(props: WorktreeManagementViewProps) {
  return (
    <>
      <SettingsRow
        title="Auto-remove after"
        description="Worktrees with no activity for this long are removed. Active threads or local work block removal."
        resetAction={
          props.canResetPruneAfterDays ? (
            <SettingResetButton
              label="automatic worktree cleanup"
              onClick={props.onResetPruneAfterDays}
            />
          ) : undefined
        }
        control={
          <WorktreeRetentionSelect
            pruneAfterDays={props.pruneAfterDays}
            onChange={props.onPruneAfterDaysChange}
          />
        }
      />
      <SettingsRow
        title="Clean up with last thread"
        description="Removes a safe worktree as soon as its final linked thread is deleted."
        resetAction={
          props.canResetDeleteOrphaned ? (
            <SettingResetButton
              label="orphaned worktree cleanup"
              onClick={props.onResetDeleteOrphaned}
            />
          ) : undefined
        }
        control={
          <Switch
            checked={props.deleteOrphanedImmediately}
            onCheckedChange={(checked) => props.onDeleteOrphanedImmediatelyChange(Boolean(checked))}
            aria-label="Delete orphaned worktrees immediately"
          />
        }
      />
    </>
  );
}

function WorktreePolicySummary(props: WorktreeManagementViewProps) {
  const [open, setOpen] = useState(false);
  const retention =
    props.pruneAfterDays === null
      ? "Do not remove inactive worktrees by age."
      : `Remove safe worktrees after ${props.pruneAfterDays} ${props.pruneAfterDays === 1 ? "day" : "days"}.`;
  const orphaned = props.deleteOrphanedImmediately ? " Clean up with the last linked thread." : "";

  return (
    <>
      <SettingsRow
        title="Automatic cleanup"
        description={`${retention}${orphaned}`}
        control={
          <Button size="xs" variant="outline" onClick={() => setOpen(true)}>
            Change
          </Button>
        }
      />
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogPopup className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Automatic worktree cleanup</DialogTitle>
            <DialogDescription>
              T3 Code removes a worktree only after verifying it has no active threads, local
              changes, or unpushed commits.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel className="space-y-1 px-2 sm:px-3">
            <WorktreePolicyRows {...props} />
          </DialogPanel>
          <DialogFooter>
            <DialogClose render={<Button size="sm" />}>Done</DialogClose>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </>
  );
}

function WorktreeLedgerRow({ environmentId, worktree, onPrune, pendingPath }: WorktreeRowProps) {
  const isPending = pendingPath === worktree.path;
  return (
    <div className="px-3 py-3 transition-colors hover:bg-muted/20 sm:px-4">
      <div className="flex min-w-0 items-center gap-3">
        <GitBranchIcon className="size-3.5 shrink-0 text-muted-foreground/70" aria-hidden />
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex min-w-0 items-center gap-2">
            <span
              className="truncate text-sm font-medium tracking-[-0.005em] text-foreground"
              title={worktree.path}
            >
              {worktree.branch ?? "Detached HEAD"}
            </span>
          </div>
          <WorktreeRichMetadata environmentId={environmentId} worktree={worktree} />
        </div>
        {isPending ? null : worktree.safeToPrune ? (
          <WorktreeRemoveButton
            environmentId={environmentId}
            worktree={worktree}
            onPrune={onPrune}
            pendingPath={pendingPath}
          />
        ) : (
          <WorktreeProtectionStatus worktree={worktree} />
        )}
      </div>
      {isPending ? (
        <div className="pt-2">
          <WorktreePendingStrip label="Removing worktree..." className="mx-0 sm:mx-0" />
        </div>
      ) : null}
    </div>
  );
}

type WorktreeProjectGroup = {
  readonly projectId: WorktreeInfo["projectId"];
  readonly projectTitle: string;
  readonly projectTitles: ReadonlyArray<string>;
  readonly workspaceRoot: string;
  readonly worktrees: ReadonlyArray<WorktreeInfo>;
};

function groupWorktreesByProject(
  worktrees: ReadonlyArray<WorktreeInfo>,
): ReadonlyArray<WorktreeProjectGroup> {
  const groups = new Map<
    WorktreeInfo["projectId"],
    Omit<WorktreeProjectGroup, "worktrees"> & { worktrees: WorktreeInfo[] }
  >();
  for (const worktree of worktrees) {
    const existing = groups.get(worktree.projectId);
    if (existing) {
      existing.worktrees.push(worktree);
    } else {
      groups.set(worktree.projectId, {
        projectId: worktree.projectId,
        projectTitle: worktree.projectTitle,
        projectTitles: worktree.projects.map((project) => project.projectTitle),
        workspaceRoot: worktree.workspaceRoot,
        worktrees: [worktree],
      });
    }
  }
  return [...groups.values()].toSorted(
    (a, b) =>
      a.projectTitle.localeCompare(b.projectTitle) ||
      a.workspaceRoot.localeCompare(b.workspaceRoot),
  );
}

function WorktreeProjectLedger({
  environmentId,
  group,
  onPrune,
  pendingPath,
}: {
  readonly environmentId: EnvironmentId;
  readonly group: WorktreeProjectGroup;
  readonly onPrune: (worktree: WorktreeInfo) => void;
  readonly pendingPath: string | null;
}) {
  const ordered = [...group.worktrees].sort(
    (a, b) => Number(a.safeToPrune) - Number(b.safeToPrune),
  );
  const otherProjectCount = group.projectTitles.length - 1;
  return (
    <section aria-label={`${group.projectTitle} worktrees`}>
      <div className="flex min-w-0 items-center justify-between gap-4 border-b border-border/60 px-3 pt-4 pb-2 sm:px-4">
        <div className="flex min-w-0 items-center gap-2">
          <ProjectFavicon
            environmentId={environmentId}
            cwd={group.workspaceRoot}
            className="size-3.5 shrink-0"
          />
          <h3 className="truncate text-xs font-medium text-foreground">{group.projectTitle}</h3>
          {otherProjectCount > 0 ? (
            <span
              className="shrink-0 text-[10px] text-muted-foreground"
              title={group.projectTitles.join(", ")}
            >
              +{otherProjectCount} project{otherProjectCount === 1 ? "" : "s"}
            </span>
          ) : null}
        </div>
        <code
          className="max-w-[55%] truncate text-[10px] text-muted-foreground/60"
          title={group.workspaceRoot}
        >
          {group.workspaceRoot}
        </code>
      </div>
      <div className="mx-3 divide-y divide-border/60 sm:mx-4">
        {ordered.map((worktree) => (
          <WorktreeLedgerRow
            key={worktree.path}
            environmentId={environmentId}
            worktree={worktree}
            onPrune={onPrune}
            pendingPath={pendingPath}
          />
        ))}
      </div>
    </section>
  );
}

function WorktreeLedgerView(props: WorktreeManagementViewProps) {
  useRelativeTimeTick(30_000);
  const groups = groupWorktreesByProject(props.worktrees);
  return (
    <div className="space-y-1">
      <WorktreePolicySummary {...props} />
      <WorktreeErrorStrip error={props.inventoryError} />
      {props.isPending ? (
        <WorktreePendingStrip label="Reading worktrees..." />
      ) : groups.length === 0 ? (
        <WorktreeEmptyMedallion />
      ) : (
        <div className="space-y-2">
          {groups.map((group) => (
            <WorktreeProjectLedger
              key={group.projectId}
              environmentId={props.environmentId}
              group={group}
              onPrune={props.onPrune}
              pendingPath={props.pendingPath}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function WorktreePruneConfirmation({
  open,
  worktree,
  onOpenChange,
  onOpenChangeComplete,
  onConfirm,
}: {
  readonly open: boolean;
  readonly worktree: WorktreeInfo | null;
  readonly onOpenChange: (open: boolean) => void;
  readonly onOpenChangeComplete: (open: boolean) => void;
  readonly onConfirm: () => void;
}) {
  const branch = worktree?.branch ?? "Detached HEAD";

  return (
    <AlertDialog
      open={open}
      onOpenChange={onOpenChange}
      onOpenChangeComplete={onOpenChangeComplete}
    >
      <AlertDialogPopup>
        <AlertDialogHeader>
          <AlertDialogTitle>Remove {branch}?</AlertDialogTitle>
          <AlertDialogDescription>
            This removes the worktree checkout. The local branch and checkpoint refs will be kept.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
          <Button variant="destructive" onClick={onConfirm}>
            Remove worktree
          </Button>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
}

type WorktreeEnvironmentTarget = {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly isPrimary: boolean;
  readonly isConnected: boolean;
};

/** Worktree inventory and cleanup policy for one environment. Mounted per
    environment, so state can never leak across servers. */
function WorktreeEnvironmentGroup({
  target,
  showLabel,
  refreshToken,
  onPendingChange,
}: {
  readonly target: WorktreeEnvironmentTarget;
  readonly showLabel: boolean;
  readonly refreshToken: number;
  readonly onPendingChange: (environmentId: EnvironmentId, pending: boolean) => void;
}) {
  const environmentId = target.environmentId;
  const settings = useEnvironmentSettings(environmentId);
  const updateSettings = useUpdateEnvironmentSettings(environmentId);
  const inventory = useEnvironmentQuery(worktreeEnvironment.list({ environmentId, input: {} }));
  const inventoryChanges = useEnvironmentQuery(
    worktreeEnvironment.changes({ environmentId, input: {} }),
  );
  const pruneWorktrees = useAtomCommand(worktreeEnvironment.prune, {
    label: "prune worktrees",
  });
  const [pendingPath, setPendingPath] = useState<string | null>(null);
  const [pruneCandidate, setPruneCandidate] = useState<WorktreeInfo | null>(null);
  const [pruneDialogOpen, setPruneDialogOpen] = useState(false);
  const worktrees = inventory.data?.worktrees ?? [];
  const defaults = DEFAULT_UNIFIED_SETTINGS.worktrees;
  const observedInventoryRevision = useRef<number | null>(null);

  useEffect(() => {
    const revision = inventoryChanges.data?.revision;
    if (revision === undefined || observedInventoryRevision.current === revision) return;
    observedInventoryRevision.current = revision;
    inventory.refresh();
  }, [inventory.refresh, inventoryChanges.data?.revision]);

  useEffect(() => {
    if (refreshToken === 0) return;
    inventory.refresh();
  }, [inventory.refresh, refreshToken]);

  useEffect(() => {
    onPendingChange(environmentId, target.isConnected && inventory.isPending);
  }, [environmentId, inventory.isPending, onPendingChange, target.isConnected]);

  useEffect(
    () => () => {
      onPendingChange(environmentId, false);
    },
    [environmentId, onPendingChange],
  );

  const handlePrune = (worktree: WorktreeInfo) => {
    if (!worktree.safeToPrune || pendingPath !== null) return;
    setPruneCandidate(worktree);
    setPruneDialogOpen(true);
  };

  const handleConfirmPrune = () => {
    if (pruneCandidate === null || pendingPath !== null) return;
    const worktree = pruneCandidate;
    setPendingPath(worktree.path);
    setPruneDialogOpen(false);
    void pruneWorktrees({ environmentId, input: { paths: [worktree.path] } }).finally(() => {
      setPendingPath(null);
      inventory.refresh();
    });
  };

  const pruneAfterDays = settings.worktrees.autoPruneAfterDays;
  const deleteOrphanedImmediately = settings.worktrees.deleteOrphanedImmediately;
  const isInitialInventoryPending = inventory.isPending && inventory.data === null;
  const managementProps: WorktreeManagementViewProps = {
    environmentId,
    worktrees,
    onPrune: handlePrune,
    pendingPath,
    inventoryError: inventory.error ?? null,
    isPending: isInitialInventoryPending,
    pruneAfterDays,
    deleteOrphanedImmediately,
    canResetPruneAfterDays: pruneAfterDays !== defaults.autoPruneAfterDays,
    canResetDeleteOrphaned: deleteOrphanedImmediately !== defaults.deleteOrphanedImmediately,
    onPruneAfterDaysChange: (days) => updateSettings({ worktrees: { autoPruneAfterDays: days } }),
    onDeleteOrphanedImmediatelyChange: (checked) =>
      updateSettings({ worktrees: { deleteOrphanedImmediately: checked } }),
    onResetPruneAfterDays: () =>
      updateSettings({ worktrees: { autoPruneAfterDays: defaults.autoPruneAfterDays } }),
    onResetDeleteOrphaned: () =>
      updateSettings({
        worktrees: { deleteOrphanedImmediately: defaults.deleteOrphanedImmediately },
      }),
  };

  return (
    <div>
      {showLabel ? (
        <div className="flex items-baseline gap-2 px-3 pb-1 sm:px-4">
          <h3 className="text-sm font-medium tracking-[-0.005em] text-foreground">
            {target.label}
          </h3>
          {target.isPrimary ? (
            <span className="text-[11px] text-muted-foreground">primary</span>
          ) : null}
        </div>
      ) : null}
      <WorktreeLedgerView {...managementProps} />
      <WorktreePruneConfirmation
        open={pruneDialogOpen}
        worktree={pruneCandidate}
        onOpenChange={setPruneDialogOpen}
        onOpenChangeComplete={(open) => {
          if (!open) setPruneCandidate(null);
        }}
        onConfirm={handleConfirmPrune}
      />
    </div>
  );
}

function WorktreeManagementSection() {
  const { environments } = useEnvironments();
  const serverConfigs = useAtomValue(environmentServerConfigsAtom);
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const [refreshToken, setRefreshToken] = useState(0);
  const [pendingEnvironmentIds, setPendingEnvironmentIds] = useState<ReadonlySet<EnvironmentId>>(
    () => new Set(),
  );
  const handlePendingChange = useCallback((environmentId: EnvironmentId, pending: boolean) => {
    setPendingEnvironmentIds((current) => {
      const alreadyPending = current.has(environmentId);
      if (alreadyPending === pending) return current;
      const next = new Set(current);
      if (pending) next.add(environmentId);
      else next.delete(environmentId);
      return next;
    });
  }, []);
  const isPending = pendingEnvironmentIds.size > 0;
  const targets: WorktreeEnvironmentTarget[] = environments
    .filter(
      (environment) =>
        serverConfigs.get(environment.environmentId)?.environment.capabilities
          .worktreeManagement === true,
    )
    .map((environment) => ({
      environmentId: environment.environmentId,
      label: environment.label,
      isPrimary: environment.environmentId === primaryEnvironmentId,
      isConnected: environment.connection.phase === "connected",
    }))
    .sort((a, b) => Number(b.isPrimary) - Number(a.isPrimary) || a.label.localeCompare(b.label));

  return (
    <SettingsSection
      id={searchableSetting("worktrees").id}
      title="Worktrees"
      icon={<GitBranchIcon className="size-4 text-muted-foreground" />}
      headerAction={
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                size="icon-micro"
                variant="ghost-muted"
                onClick={() => setRefreshToken((token) => token + 1)}
                disabled={isPending}
                aria-label={
                  isPending ? "Refreshing worktree inventory" : "Refresh worktree inventory"
                }
              >
                <RefreshCwIcon className={cn("size-3", isPending && "animate-spin")} />
              </Button>
            }
          />
          <TooltipPopup side="top">
            {isPending ? "Refreshing worktree inventory" : "Refresh worktree inventory"}
          </TooltipPopup>
        </Tooltip>
      }
    >
      {targets.length === 0 ? (
        <p className="px-3 py-3 text-[13px] leading-[1.45] text-muted-foreground/80 sm:px-4">
          Worktree management needs a newer T3 Code server. Update the connected environments to
          manage their worktrees here.
        </p>
      ) : (
        <div className="space-y-6">
          {targets.map((target) => (
            <WorktreeEnvironmentGroup
              key={target.environmentId}
              target={target}
              showLabel={targets.length > 1}
              refreshToken={refreshToken}
              onPendingChange={handlePendingChange}
            />
          ))}
        </div>
      )}
    </SettingsSection>
  );
}

export function SourceControlSettingsPanel() {
  const { environments } = useEnvironments();
  const primaryEnvironment = usePrimaryEnvironment();
  const fallbackEnvironment =
    environments.find((environment) => environment.connection.phase === "connected") ??
    environments[0] ??
    null;
  const environmentId =
    primaryEnvironment?.environmentId ?? fallbackEnvironment?.environmentId ?? null;
  const isPrimaryEnvironment = environmentId === primaryEnvironment?.environmentId;
  const discovery = useEnvironmentQuery(
    environmentId === null
      ? null
      : sourceControlEnvironment.discovery({
          environmentId,
          input: {},
        }),
  );
  const result = discovery.data ?? EMPTY_DISCOVERY_RESULT;
  const hasVersionControlSystems = result.versionControlSystems.length > 0;
  const hasDiscoveryItems = hasVersionControlSystems || result.sourceControlProviders.length > 0;
  const isInitialScanPending = discovery.isPending && discovery.data === null;
  const handleScan = () => {
    discovery.refresh();
  };
  const scanButton = (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            size="icon-micro"
            variant="ghost-muted"
            onClick={handleScan}
            disabled={discovery.isPending}
            aria-label="Rescan server environment"
          >
            <RefreshCwIcon className={cn("size-3", discovery.isPending && "animate-spin")} />
          </Button>
        }
      />
      <TooltipPopup side="top">Rescan Git and hosting integrations</TooltipPopup>
    </Tooltip>
  );

  return (
    <SettingsPageContainer>
      {isInitialScanPending ? (
        <>
          <SourceControlSectionSkeleton title="Version Control" headerAction={scanButton} />
          <SourceControlSectionSkeleton title="Source Control Providers" />
        </>
      ) : hasDiscoveryItems ? (
        <>
          {hasVersionControlSystems ? (
            <SettingsSection
              id={searchableSetting("source-control").id}
              title="Version Control"
              headerAction={scanButton}
            >
              {result.versionControlSystems.map((item) => (
                <DiscoveryItemRow key={`vcs:${item.kind}`} item={item}>
                  {item.kind === "git" && isPrimaryEnvironment ? (
                    <GitFetchIntervalSettings />
                  ) : undefined}
                </DiscoveryItemRow>
              ))}
            </SettingsSection>
          ) : null}

          {result.sourceControlProviders.length > 0 ? (
            <SettingsSection
              id={hasVersionControlSystems ? undefined : searchableSetting("source-control").id}
              title="Source Control Providers"
              headerAction={hasVersionControlSystems ? null : scanButton}
            >
              {result.sourceControlProviders.map((item) => (
                <DiscoveryItemRow key={`provider:${item.kind}`} item={item} />
              ))}
            </SettingsSection>
          ) : null}
        </>
      ) : (
        <EmptySourceControlDiscovery
          error={discovery.error}
          isPending={discovery.isPending}
          onScan={handleScan}
        />
      )}

      <WorktreeManagementSection />
      {isPrimaryEnvironment ? <SourceControlWritingSettingsSection /> : null}
    </SettingsPageContainer>
  );
}
