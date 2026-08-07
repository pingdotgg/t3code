import {
  ChevronDownIcon,
  GitBranchIcon,
  GitPullRequestIcon,
  InfoIcon,
  RefreshCwIcon,
  Trash2Icon,
} from "lucide-react";
import * as Duration from "effect/Duration";
import * as Option from "effect/Option";
import { useEffect, useRef, useState, type ReactNode } from "react";
import type {
  BackgroundActivitySettings,
  SourceControlProviderKind,
  SourceControlDiscoveryResult,
  SourceControlProviderAuth,
  SourceControlProviderDiscoveryItem,
  VcsDriverKind,
  VcsDiscoveryItem,
  WorktreeInfo,
} from "@t3tools/contracts";
import {
  getBackgroundActivityBaseProfile,
  getBackgroundActivityPresetSettings,
  resolveServerBackgroundActivitySettings,
} from "@t3tools/shared/backgroundActivitySettings";
import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts/settings";

import { formatRelativeTimeLabel } from "../../timestampFormat";
import { useAtomCommand } from "../../state/use-atom-command";

import { usePrimarySettings, useUpdatePrimarySettings } from "../../hooks/useSettings";
import { cn } from "../../lib/utils";
import { usePrimaryEnvironment } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { sourceControlEnvironment } from "../../state/sourceControl";
import { worktreeEnvironment } from "../../state/worktrees";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
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
import { RedactedSensitiveText } from "./RedactedSensitiveText";
import { SourceControlWritingSettingsSection } from "./SourceControlWritingSettings";
import {
  SettingResetButton,
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
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

function BackgroundPolicyTooltip({ children }: { readonly children: string }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            className="inline-flex size-5 items-center justify-center rounded-sm text-muted-foreground hover:text-foreground"
            aria-label="Background policy details"
          >
            <InfoIcon className="size-3.5" />
          </button>
        }
      />
      <TooltipPopup side="top" className="max-w-72">
        {children}
      </TooltipPopup>
    </Tooltip>
  );
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
                size="sm"
                variant="ghost"
                className="h-7 px-2 text-xs text-muted-foreground hover:text-foreground"
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
            <BackgroundPolicyTooltip>
              This interval is configured for Git only. The shared Background activity policy still
              decides whether Git refreshes may run when the timer fires. Custom intervals appear as
              Advanced in General settings.
            </BackgroundPolicyTooltip>
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

type WorktreeSurfaceProps = {
  readonly worktrees: ReadonlyArray<WorktreeInfo>;
  readonly onPrune: (worktree: WorktreeInfo) => void;
  readonly pendingPath: string | null;
};

function worktreeBlockerLabel(blocker: WorktreeInfo["pruneBlockers"][number]): string {
  switch (blocker) {
    case "active_thread":
      return "Active thread";
    case "dirty":
      return "Uncommitted changes";
    case "unpushed":
      return "Unpushed commits";
    case "status_unavailable":
      return "Status unavailable";
  }
}

function WorktreeStatus({ worktree }: { readonly worktree: WorktreeInfo }) {
  return (
    <span
      className={cn(
        "text-xs",
        worktree.safeToPrune ? "text-muted-foreground" : "text-warning-foreground",
      )}
    >
      {worktree.safeToPrune
        ? worktree.orphaned
          ? "Orphaned"
          : "Safe to prune"
        : worktree.pruneBlockers[0] === undefined
          ? "Needs attention"
          : worktreeBlockerLabel(worktree.pruneBlockers[0])}
    </span>
  );
}

function WorktreeAction({
  worktree,
  onPrune,
  pendingPath,
}: {
  readonly worktree: WorktreeInfo;
  readonly onPrune: (worktree: WorktreeInfo) => void;
  readonly pendingPath: string | null;
}) {
  if (!worktree.safeToPrune) return null;
  const isPending = pendingPath === worktree.path;
  return (
    <Button
      size="xs"
      variant="ghost"
      className="text-muted-foreground hover:text-destructive"
      onClick={() => onPrune(worktree)}
      disabled={pendingPath !== null}
      aria-label={`Prune ${worktree.branch ?? worktree.path}`}
    >
      <Trash2Icon className={cn("size-3.5", isPending && "animate-pulse")} />
      {isPending ? "Pruning" : "Prune"}
    </Button>
  );
}

function WorktreeIdentity({ worktree }: { readonly worktree: WorktreeInfo }) {
  return (
    <div className="min-w-0 space-y-1">
      <div className="flex min-w-0 items-center gap-2">
        <GitBranchIcon className="size-4 shrink-0 text-muted-foreground/70" />
        <span className="truncate text-sm font-medium text-foreground">
          {worktree.branch ?? "Detached HEAD"}
        </span>
        <WorktreeStatus worktree={worktree} />
      </div>
      <div
        className="truncate font-mono text-[11px] text-muted-foreground/75"
        title={worktree.path}
      >
        {worktree.path}
      </div>
      <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
        <span>
          {worktree.projects.length === 1
            ? worktree.projectTitle
            : `${worktree.projects.length} linked projects`}
        </span>
        <span>
          {worktree.threads.length === 0
            ? "No linked threads"
            : `${worktree.threads.length} linked thread${worktree.threads.length === 1 ? "" : "s"}`}
        </span>
        {worktree.lastActivityAt ? (
          <span>Active {formatRelativeTimeLabel(worktree.lastActivityAt)}</span>
        ) : null}
      </div>
    </div>
  );
}

function WorktreeEmptyState({ title = "No managed worktrees" }: { readonly title?: string }) {
  return (
    <Empty className="min-h-48 rounded-xl border border-dashed border-border/70 bg-muted/10">
      <EmptyMedia variant="icon">
        <GitBranchIcon />
      </EmptyMedia>
      <EmptyHeader>
        <EmptyTitle>{title}</EmptyTitle>
        <EmptyDescription>
          Worktrees created for threads will appear here. Safe cleanup keeps branches and checkpoint
          history intact.
        </EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}

function WorktreeCard({
  worktree,
  onPrune,
  pendingPath,
}: {
  readonly worktree: WorktreeInfo;
  readonly onPrune: (worktree: WorktreeInfo) => void;
  readonly pendingPath: string | null;
}) {
  return (
    <div className="flex flex-col gap-3 rounded-xl border border-border/70 bg-card/35 p-3 sm:flex-row sm:items-center sm:justify-between sm:p-4">
      <WorktreeIdentity worktree={worktree} />
      <WorktreeAction worktree={worktree} onPrune={onPrune} pendingPath={pendingPath} />
    </div>
  );
}

function WorktreeList({ worktrees, onPrune, pendingPath }: WorktreeSurfaceProps) {
  if (worktrees.length === 0) {
    return <WorktreeEmptyState title="No worktree activity yet" />;
  }
  return (
    <div className="space-y-4">
      {worktrees.map((worktree) => (
        <WorktreeCard
          key={worktree.path}
          worktree={worktree}
          onPrune={onPrune}
          pendingPath={pendingPath}
        />
      ))}
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

function WorktreeManagementSection() {
  const environmentId = usePrimaryEnvironment()?.environmentId ?? null;
  const settings = usePrimarySettings();
  const updateSettings = useUpdatePrimarySettings();
  const inventory = useEnvironmentQuery(
    environmentId === null ? null : worktreeEnvironment.list({ environmentId, input: {} }),
  );
  const inventoryChanges = useEnvironmentQuery(
    environmentId === null ? null : worktreeEnvironment.changes({ environmentId, input: {} }),
  );
  const pruneWorktrees = useAtomCommand(worktreeEnvironment.prune, {
    label: "prune worktrees",
    reportFailure: false,
  });
  const [pendingPath, setPendingPath] = useState<string | null>(null);
  const [pruneCandidate, setPruneCandidate] = useState<WorktreeInfo | null>(null);
  const [pruneDialogOpen, setPruneDialogOpen] = useState(false);
  const worktrees = inventory.data?.worktrees ?? [];
  const safeCount = worktrees.filter((worktree) => worktree.safeToPrune).length;
  const blockedCount = worktrees.length - safeCount;
  const defaults = DEFAULT_UNIFIED_SETTINGS.worktrees;
  const observedInventoryRevision = useRef<number | null>(null);

  useEffect(() => {
    const revision = inventoryChanges.data?.revision;
    if (revision === undefined || observedInventoryRevision.current === revision) return;
    observedInventoryRevision.current = revision;
    inventory.refresh();
  }, [inventory.refresh, inventoryChanges.data?.revision]);

  const handlePrune = (worktree: WorktreeInfo) => {
    if (!worktree.safeToPrune || environmentId === null || pendingPath !== null) return;
    setPruneCandidate(worktree);
    setPruneDialogOpen(true);
  };

  const handleConfirmPrune = () => {
    if (pruneCandidate === null || environmentId === null || pendingPath !== null) return;
    const worktree = pruneCandidate;
    setPendingPath(worktree.path);
    setPruneDialogOpen(false);
    void pruneWorktrees({ environmentId, input: { paths: [worktree.path] } }).finally(() => {
      setPendingPath(null);
    });
  };

  const pruneAfterDays = settings.worktrees.autoPruneAfterDays;
  const pruneValue = pruneAfterDays === null ? "never" : String(pruneAfterDays);

  return (
    <>
      <SettingsSection
        id={searchableSetting("worktrees").id}
        title="Worktrees"
        icon={<GitBranchIcon className="size-4 text-muted-foreground" />}
        headerAction={
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  size="icon-xs"
                  variant="ghost"
                  className="size-5 rounded-sm p-0 text-muted-foreground hover:text-foreground"
                  onClick={() => inventory.refresh()}
                  disabled={inventory.isPending}
                  aria-label="Refresh worktree inventory"
                >
                  <RefreshCwIcon className={cn("size-3", inventory.isPending && "animate-spin")} />
                </Button>
              }
            />
            <TooltipPopup side="top">Refresh worktree inventory</TooltipPopup>
          </Tooltip>
        }
      >
        <SettingsRow
          title="Automatic cleanup"
          description="Remove safe, inactive worktrees after this many days. Active threads, local changes, and unpushed commits are always protected."
          resetAction={
            pruneAfterDays !== defaults.autoPruneAfterDays ? (
              <SettingResetButton
                label="automatic worktree cleanup"
                onClick={() =>
                  updateSettings({ worktrees: { autoPruneAfterDays: defaults.autoPruneAfterDays } })
                }
              />
            ) : null
          }
          control={
            <Select
              value={pruneValue}
              onValueChange={(value) =>
                updateSettings({
                  worktrees: {
                    autoPruneAfterDays: value === "never" ? null : Number(value),
                  },
                })
              }
            >
              <SelectTrigger className="w-full sm:w-36" aria-label="Automatic worktree cleanup">
                <SelectValue>
                  {pruneAfterDays === null ? "Never" : `${pruneAfterDays} days`}
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
          }
        />
        <SettingsRow
          title="Delete orphaned worktrees immediately"
          description="Allow the background cleanup to remove safe worktrees with no remaining thread references, regardless of age."
          resetAction={
            settings.worktrees.deleteOrphanedImmediately !== defaults.deleteOrphanedImmediately ? (
              <SettingResetButton
                label="orphaned worktree cleanup"
                onClick={() =>
                  updateSettings({
                    worktrees: { deleteOrphanedImmediately: defaults.deleteOrphanedImmediately },
                  })
                }
              />
            ) : null
          }
          control={
            <Switch
              checked={settings.worktrees.deleteOrphanedImmediately}
              onCheckedChange={(checked) =>
                updateSettings({ worktrees: { deleteOrphanedImmediately: Boolean(checked) } })
              }
              aria-label="Delete orphaned worktrees immediately"
            />
          }
        />
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 px-3 pb-3 text-xs text-muted-foreground sm:px-4">
          <span>
            {worktrees.length} managed worktree{worktrees.length === 1 ? "" : "s"}
          </span>
          <span aria-hidden="true">·</span>
          <span>{safeCount} ready for cleanup</span>
          {blockedCount > 0 ? (
            <>
              <span aria-hidden="true">·</span>
              <span>{blockedCount} protected</span>
            </>
          ) : null}
          {inventory.error ? <span className="text-destructive">{inventory.error}</span> : null}
        </div>
        {inventory.isPending && inventory.data === null ? (
          <div className="space-y-2 px-3 pb-3 sm:px-4">
            <Skeleton className="h-16 rounded-xl" />
            <Skeleton className="h-16 rounded-xl" />
          </div>
        ) : (
          <div className="px-3 pb-3 sm:px-4">
            <WorktreeList worktrees={worktrees} onPrune={handlePrune} pendingPath={pendingPath} />
          </div>
        )}
      </SettingsSection>
      <WorktreePruneConfirmation
        open={pruneDialogOpen}
        worktree={pruneCandidate}
        onOpenChange={setPruneDialogOpen}
        onOpenChangeComplete={(open) => {
          if (!open) setPruneCandidate(null);
        }}
        onConfirm={handleConfirmPrune}
      />
    </>
  );
}

export function SourceControlSettingsPanel() {
  const environmentId = usePrimaryEnvironment()?.environmentId ?? null;
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
            size="icon-xs"
            variant="ghost"
            className="size-5 rounded-sm p-0 text-muted-foreground hover:text-foreground"
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
                  {item.kind === "git" ? <GitFetchIntervalSettings /> : undefined}
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
      {environmentId !== null ? <SourceControlWritingSettingsSection /> : null}
    </SettingsPageContainer>
  );
}
