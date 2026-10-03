import { RefreshIcon } from "~/components/ui/refresh-icon";
import { ChevronDownIcon, GitBranchIcon, RefreshCwIcon } from "lucide-react";
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
} from "@t3tools/contracts";
import {
  getBackgroundActivityBaseProfile,
  getBackgroundActivityPresetSettings,
  resolveServerBackgroundActivitySettings,
} from "@t3tools/shared/backgroundActivitySettings";

import { useScopedSettings, useUpdateScopedSettings } from "./useScopedSettings";
import { useSettingsScope } from "./SettingsScopeContext";
import { ProjectDefaultsSettings } from "./ProjectDefaultsSettings";
import { cn } from "../../lib/utils";
import { useAtomCommand } from "../../state/use-atom-command";
import { useEnvironments, usePrimaryEnvironmentId } from "../../state/environments";
import { useProject } from "../../state/entities";
import { environmentServerConfigsAtom } from "../../state/server";
import { useEnvironmentQuery } from "../../state/query";
import { sourceControlEnvironment } from "../../state/sourceControl";
import { worktreeEnvironment } from "../../state/worktrees";
import {
  confirmWorktreeRemoval,
  formatWorktreeAge,
  groupWorktreesByProject,
  NO_CONFIRMED_WORKTREE_REMOVALS,
  primaryLinkedThread,
  visibleWorktrees,
  worktreeBranchLabel,
  worktreeGroupSummary,
  worktreeIgnoredNote,
  worktreeInventoryRefreshKey,
  worktreeRemovalConfirmation,
  worktreeRemovalOutcome,
  worktreeStateLabel,
  type WorktreeProjectGroup,
} from "@t3tools/client-runtime/state/worktrees";
import { toastManager } from "../ui/toast";
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
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

import {
  AzureDevOpsIcon,
  BitbucketIcon,
  GitHubIcon,
  GitIcon,
  GitLabIcon,
  ForgejoIcon,
  JujutsuIcon,
  type Icon,
} from "../Icons";
import { ProjectFavicon } from "../ProjectFavicon";
import { BitbucketCredentialsSettings } from "./BitbucketCredentialsSettings";
import { RedactedSensitiveText } from "./RedactedSensitiveText";
import { SourceControlWritingSettingsSection } from "./SourceControlWritingSettings";
import {
  PolicyTooltip,
  SettingResetButton,
  SettingsPageContainer,
  SettingsSearchTarget,
  SettingsSection,
  useRelativeTimeTick,
  useSettingsSearchTargetId,
} from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { PullRequestGlyph } from "~/components/pullRequest/pullRequestIcons";

const EMPTY_DISCOVERY_RESULT: SourceControlDiscoveryResult = {
  versionControlSystems: [],
  sourceControlProviders: [],
};

const SOURCE_CONTROL_PROVIDER_ICONS: Partial<Record<SourceControlProviderKind, Icon>> = {
  github: GitHubIcon,
  gitlab: GitLabIcon,
  forgejo: ForgejoIcon,
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

    // API integrations have no CLI to sign in with; an unverified saved credential falls
    // through to the "could not verify" detail instead of repeating the setup hint.
    if (!item.executable && auth.status === "unauthenticated") {
      return <span>Available. {item.installHint}</span>;
    }

    if (auth.status === "unauthenticated") {
      return (
        <span>
          {item.label} is not authenticated on this server. Sign in or configure credentials using
          the <code className="rounded bg-muted px-1 py-px text-2xs">{item.executable}</code> tool
          on the server host to enable change request features.
        </span>
      );
    }
    const authDetail = optionLabel(auth.detail);
    return (
      <span>
        Could not verify {item.label}. {authDetail ?? item.installHint}
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
  const searchTargetId = useSettingsSearchTargetId();

  useEffect(() => {
    if (
      (item.kind === "git" && searchTargetId === searchableSetting("git-fetch-interval").id) ||
      (item.kind === "bitbucket" &&
        searchTargetId === searchableSetting("bitbucket-credentials").id)
    ) {
      setIsExpanded(true);
    }
  }, [item.kind, searchTargetId]);

  return (
    <div
      className={cn(
        "first:rounded-t-xl last:rounded-b-xl transition-colors hover:bg-muted/20",
        isVcsNotReady(item) && "opacity-80",
      )}
    >
      <div className="px-3 py-3 sm:px-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0 flex-1 space-y-1">
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <SourceControlItemMark item={item} />
              <span className="truncate text-sm font-medium text-foreground">{item.label}</span>
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
            <p className="flex min-w-0 flex-wrap items-center gap-x-1 text-xs leading-normal text-muted-foreground/80">
              {itemSummary({ item, auth, authAccount })}
            </p>
          </div>
          <div className="flex w-full shrink-0 items-center gap-2 sm:w-auto sm:justify-end">
            {hasDetails ? (
              <Button
                size="icon-xs"
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
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
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
  const setting = searchableSetting("git-fetch-interval");

  return (
    <SettingsSearchTarget id={setting.id} className="grid gap-3">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 space-y-1">
          <div className="flex min-w-0 items-center gap-1">
            <span className="text-xs font-medium text-foreground">{setting.title}</span>
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
            Refresh remote branches in the background. Set to 0 to avoid automatic Git prompts.
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
    </SettingsSearchTarget>
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
        <div key={row} className="first:rounded-t-xl last:rounded-b-xl px-3 py-3 sm:px-4">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0 flex-1 space-y-2">
              <div className="flex items-center gap-2">
                <span className="relative inline-flex size-5 shrink-0 items-center justify-center">
                  <Skeleton className="size-4.5" />
                  <Skeleton
                    shape="pill"
                    className="pointer-events-none absolute -left-0.5 -top-0.5 size-2"
                    aria-hidden
                  />
                </span>
                <Skeleton shape="pill" className="h-4 w-28" />
                <Skeleton shape="pill" className="h-5 w-14" />
              </div>
              <Skeleton shape="pill" className="h-3 w-full max-w-xs" />
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <Skeleton className="size-7" />
              <Skeleton shape="pill" className="h-5 w-9" />
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
      <Empty>
        <EmptyMedia variant="icon">
          <PullRequestGlyph.pullRequest />
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
          <Button size="sm" variant="outline" onClick={onScan} disabled={isPending}>
            <RefreshIcon size="sm" refreshing={isPending} />
            Scan
          </Button>
        </EmptyContent>
      </Empty>
    </SettingsSection>
  );
}

type WorktreeRowProps = {
  readonly environmentId: EnvironmentId;
  readonly worktree: WorktreeInfo;
  readonly nowMs: number;
  readonly onPrune: (worktree: WorktreeInfo) => void;
  readonly pendingPath: string | null;
};

function WorktreeThreadCell({
  environmentId,
  worktree,
}: Pick<WorktreeRowProps, "environmentId" | "worktree">) {
  const { thread, otherCount } = primaryLinkedThread(worktree);
  if (thread === null) {
    return <span className="truncate text-muted-foreground/60">No linked threads</span>;
  }
  const title = thread.title || "Untitled thread";
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      {thread.status === "archived" ? (
        <span className="truncate">Archived: {title}</span>
      ) : (
        <Link
          to="/$environmentId/$threadId"
          params={{ environmentId, threadId: thread.threadId }}
          className="truncate hover:text-foreground"
        >
          {title}
        </Link>
      )}
      {otherCount > 0 ? (
        <span className="shrink-0 tabular-nums text-muted-foreground/60">+{otherCount}</span>
      ) : null}
    </span>
  );
}

/** Right-edge cell with one fixed edge: the Remove action, what keeps the worktree, or Removing. */
function WorktreeStateCell({
  worktree,
  onPrune,
  pendingPath,
}: Pick<WorktreeRowProps, "worktree" | "onPrune" | "pendingPath">) {
  if (pendingPath === worktree.path) {
    return (
      <span role="status" className="text-muted-foreground">
        Removing
      </span>
    );
  }
  const state = worktreeStateLabel(worktree);
  if (state === null) {
    const ignoredNote = worktreeIgnoredNote(worktree);
    return (
      <>
        {ignoredNote ? <span className="text-muted-foreground/60">{ignoredNote}</span> : null}
        <Button
          size="xs"
          variant="ghost-destructive"
          onClick={() => onPrune(worktree)}
          disabled={pendingPath !== null}
          aria-label={`Remove worktree ${worktreeBranchLabel(worktree)}`}
        >
          Remove
        </Button>
      </>
    );
  }
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            className={cn(
              "truncate",
              state.tone === "warning" ? "text-warning" : "text-muted-foreground",
            )}
          >
            {state.text}
          </span>
        }
      />
      <TooltipPopup side="top">{state.detail}</TooltipPopup>
    </Tooltip>
  );
}

/** Branch, thread, age and state on fixed tracks, so every row lines up down the list. */
function WorktreeRow({ environmentId, worktree, nowMs, onPrune, pendingPath }: WorktreeRowProps) {
  const removing = pendingPath === worktree.path;
  return (
    <div
      className={cn(
        "grid min-h-8 grid-cols-[minmax(0,1fr)_2.5rem_minmax(6rem,auto)] items-center gap-x-3 text-xs sm:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)_2.5rem_minmax(8.5rem,auto)]",
        removing && "opacity-60",
      )}
    >
      <span className="flex min-w-0 items-baseline gap-1.5">
        <Tooltip>
          <TooltipTrigger
            render={
              <span className={cn("truncate", worktree.branch === null && "text-muted-foreground")}>
                {worktree.branch ?? "Detached HEAD"}
              </span>
            }
          />
          <TooltipPopup side="top">
            <code className="text-2xs">{worktree.path}</code>
          </TooltipPopup>
        </Tooltip>
        {worktree.branch === null && worktree.headShortSha !== null ? (
          <code className="shrink-0 text-2xs text-muted-foreground/60">
            {worktree.headShortSha}
          </code>
        ) : null}
      </span>
      <span className="hidden min-w-0 text-muted-foreground sm:block">
        <WorktreeThreadCell environmentId={environmentId} worktree={worktree} />
      </span>
      <span className="text-right text-2xs tabular-nums text-muted-foreground/60">
        {worktree.lastActivityAt ? formatWorktreeAge(worktree.lastActivityAt, nowMs) : null}
      </span>
      <span className="flex min-w-0 items-center justify-end gap-2 text-2xs tabular-nums">
        <WorktreeStateCell worktree={worktree} onPrune={onPrune} pendingPath={pendingPath} />
      </span>
    </div>
  );
}

/** Project heading with its counts; the workspace path lives in the title tooltip. */
function WorktreeGroupHeading({
  environmentId,
  group,
}: {
  readonly environmentId: EnvironmentId;
  readonly group: WorktreeProjectGroup;
}) {
  const otherProjectCount = group.projectTitles.length - 1;
  const project = useProject({ environmentId, projectId: group.projectId });
  return (
    <div className="flex min-w-0 items-center gap-2 px-3 pt-3 pb-1 sm:px-4">
      {project ? <ProjectFavicon project={project} className="size-3.5 shrink-0" /> : null}
      <Tooltip>
        <TooltipTrigger
          render={
            <h3 className="truncate text-xs font-medium text-foreground">{group.projectTitle}</h3>
          }
        />
        <TooltipPopup side="top">
          <code className="text-2xs">{group.workspaceRoot}</code>
        </TooltipPopup>
      </Tooltip>
      {otherProjectCount > 0 ? (
        <span className="shrink-0 text-2xs text-muted-foreground/60">
          +{otherProjectCount} project{otherProjectCount === 1 ? "" : "s"}
        </span>
      ) : null}
      <span className="ml-auto shrink-0 text-2xs tabular-nums text-muted-foreground/60">
        {worktreeGroupSummary(group)}
      </span>
    </div>
  );
}

function WorktreeList(props: {
  readonly environmentId: EnvironmentId;
  readonly worktrees: ReadonlyArray<WorktreeInfo>;
  readonly onPrune: (worktree: WorktreeInfo) => void;
  readonly pendingPath: string | null;
}) {
  const nowMs = useRelativeTimeTick(30_000);
  return groupWorktreesByProject(props.worktrees).map((group) => (
    <section key={group.projectId} aria-label={`${group.projectTitle} worktrees`}>
      <WorktreeGroupHeading environmentId={props.environmentId} group={group} />
      <div className="mx-3 divide-y divide-border/40 sm:mx-4">
        {group.worktrees.map((worktree) => (
          <WorktreeRow
            key={worktree.path}
            environmentId={props.environmentId}
            worktree={worktree}
            nowMs={nowMs}
            onPrune={props.onPrune}
            pendingPath={props.pendingPath}
          />
        ))}
      </div>
    </section>
  ));
}

/** Names what stays and, when removal deletes ignored files, which ones. */
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
  const confirmation = worktree === null ? null : worktreeRemovalConfirmation(worktree);
  return (
    <AlertDialog
      open={open}
      onOpenChange={onOpenChange}
      onOpenChangeComplete={onOpenChangeComplete}
    >
      <AlertDialogPopup>
        <AlertDialogHeader>
          <AlertDialogTitle>{confirmation?.title}</AlertDialogTitle>
          <AlertDialogDescription>{confirmation?.message}</AlertDialogDescription>
        </AlertDialogHeader>
        {confirmation?.allowIgnoredFiles ? (
          <ul className="max-h-40 space-y-0.5 overflow-y-auto px-6 pb-4 text-xs text-muted-foreground">
            {confirmation.ignoredFiles.map((file) => (
              <li key={file} className="truncate">
                <code>{file}</code>
              </li>
            ))}
            {confirmation.ignoredMoreCount > 0 ? (
              <li>and {confirmation.ignoredMoreCount} more</li>
            ) : null}
          </ul>
        ) : null}
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
};

/** Worktree inventory for one environment. Mounted per environment, so state
    can never leak across servers. */
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
  const inventory = useEnvironmentQuery(worktreeEnvironment.list({ environmentId, input: {} }));
  const { refresh: refreshInventory, isPending: inventoryPending } = inventory;
  const listedRevision = inventory.data?.revision;
  const streamRevision = useEnvironmentQuery(
    worktreeEnvironment.changes({ environmentId, input: {} }),
  ).data?.revision;
  const pruneWorktrees = useAtomCommand(worktreeEnvironment.prune, {
    label: "prune worktrees",
  });
  const [pendingPath, setPendingPath] = useState<string | null>(null);
  const [pruneCandidate, setPruneCandidate] = useState<WorktreeInfo | null>(null);
  const [pruneDialogOpen, setPruneDialogOpen] = useState(false);
  // Hides a confirmed removal right away, before the inventory is read again.
  const [removals, setRemovals] = useState(NO_CONFIRMED_WORKTREE_REMOVALS);
  const worktrees = visibleWorktrees(inventory.data, removals);
  const lastRefreshKey = useRef<string | null>(null);

  useEffect(() => {
    const refreshKey = worktreeInventoryRefreshKey({
      listedRevision,
      streamRevision,
      isPending: inventoryPending,
      lastRefreshKey: lastRefreshKey.current,
    });
    if (refreshKey === null) return;
    lastRefreshKey.current = refreshKey;
    refreshInventory();
  }, [refreshInventory, inventoryPending, listedRevision, streamRevision]);

  useEffect(() => {
    if (refreshToken === 0) return;
    refreshInventory();
  }, [refreshInventory, refreshToken]);

  useEffect(() => {
    onPendingChange(environmentId, inventoryPending);
  }, [environmentId, inventoryPending, onPendingChange]);

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
    // Opt in to deleting ignored files only when this dialog listed them.
    const { allowIgnoredFiles } = worktreeRemovalConfirmation(worktree);
    setPendingPath(worktree.path);
    setPruneDialogOpen(false);
    void pruneWorktrees({
      environmentId,
      input: {
        projectId: worktree.projectId,
        paths: [worktree.path],
        ...(allowIgnoredFiles ? { allowIgnoredFiles } : {}),
      },
    })
      .then((result) => {
        if (result._tag !== "Success") return;
        const outcome = worktreeRemovalOutcome(result.value);
        if (outcome.removed) {
          setRemovals((current) => confirmWorktreeRemoval(current, listedRevision, worktree.path));
          return;
        }
        // The row stays; the read below gives it its new reason.
        toastManager.add({
          type: "warning",
          title: `Kept ${worktreeBranchLabel(worktree)}`,
          description: outcome.message,
        });
      })
      .finally(() => {
        setPendingPath(null);
        refreshInventory();
      });
  };

  return (
    <div>
      {showLabel ? (
        <div className="flex items-baseline gap-2 px-3 pb-1 sm:px-4">
          <h3 className="text-sm font-medium text-foreground">{target.label}</h3>
          {target.isPrimary ? (
            <span className="text-2xs text-muted-foreground">primary</span>
          ) : null}
        </div>
      ) : null}
      {/* Rows from the last read stay up while a refresh runs or fails. */}
      {inventory.error !== null ? (
        <p className="flex items-center gap-2 px-3 py-2 text-xs text-muted-foreground sm:px-4">
          Couldn't read worktrees.
          <Button size="xs" variant="link" onClick={refreshInventory}>
            Retry
          </Button>
        </p>
      ) : null}
      {inventory.data === null ? (
        inventory.error === null ? (
          <p role="status" className="px-3 py-2 text-xs text-muted-foreground sm:px-4">
            Reading worktrees
          </p>
        ) : null
      ) : worktrees.length === 0 ? (
        <p className="px-3 py-2 text-xs text-muted-foreground sm:px-4">No worktrees</p>
      ) : (
        <WorktreeList
          environmentId={environmentId}
          worktrees={worktrees}
          onPrune={handlePrune}
          pendingPath={pendingPath}
        />
      )}
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

/**
 * Every connected environment's managed worktrees. An environment whose
 * server predates worktree management is left out rather than shown broken.
 * Cleanup rules stay in Storage settings; this only links there.
 */
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
        environment.connection.phase === "connected" &&
        serverConfigs.get(environment.environmentId)?.environment.capabilities
          .worktreeManagement === true,
    )
    .map((environment) => ({
      environmentId: environment.environmentId,
      label: environment.label,
      isPrimary: environment.environmentId === primaryEnvironmentId,
    }))
    .sort((a, b) => Number(b.isPrimary) - Number(a.isPrimary) || a.label.localeCompare(b.label));

  return (
    <SettingsSection
      id={searchableSetting("worktrees").id}
      title="Worktrees"
      icon={<GitBranchIcon className="size-4 text-muted-foreground" />}
      headerAction={
        <div className="flex items-center gap-2">
          <Link
            to="/settings/storage"
            className="text-xs text-muted-foreground hover:text-foreground"
          >
            Cleanup rules
          </Link>
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  size="icon-micro"
                  variant="ghost-muted"
                  onClick={() => setRefreshToken((token) => token + 1)}
                  disabled={isPending}
                  aria-busy={isPending}
                  aria-label="Refresh worktrees"
                >
                  <RefreshCwIcon className="size-3" />
                </Button>
              }
            />
            <TooltipPopup side="top">Refresh worktrees</TooltipPopup>
          </Tooltip>
        </div>
      }
    >
      {targets.length === 0 ? (
        <p className="px-3 py-2 text-xs text-muted-foreground sm:px-4">
          Connect an up-to-date server to manage its worktrees.
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
  const { scope, environment, connectedEnvironments } = useSettingsScope();
  // Discovery scans one machine's tools, so it shows the representative
  // environment (named in the section title when several are selected);
  // the settings rows above it fan out like everywhere else.
  const environmentId =
    environment?.connection.phase === "connected" ? environment.environmentId : null;
  const aggregate = scope.environmentIds.length !== 1 && connectedEnvironments.length > 1;
  const environmentSuffix = aggregate && environment ? ` · ${environment.label}` : "";
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
            variant="ghost-muted"
            onClick={handleScan}
            disabled={discovery.isPending}
            aria-label="Rescan server environment"
          >
            <RefreshIcon refreshing={discovery.isPending} />
          </Button>
        }
      />
      <TooltipPopup side="top">Rescan Git and hosting integrations</TooltipPopup>
    </Tooltip>
  );

  return (
    <SettingsPageContainer>
      <ProjectDefaultsSettings category="source-control" />
      {environmentId === null ? (
        <SettingsSection id={searchableSetting("source-control").id} title="Server environment">
          <p className="px-4 py-3 text-sm text-muted-foreground">
            Connect an environment to inspect its version control tools and hosting integrations.
          </p>
        </SettingsSection>
      ) : isInitialScanPending ? (
        <>
          <SourceControlSectionSkeleton
            title={`Version Control${environmentSuffix}`}
            headerAction={scanButton}
          />
          <SourceControlSectionSkeleton title="Source Control Providers" />
        </>
      ) : hasDiscoveryItems ? (
        <>
          {hasVersionControlSystems ? (
            <SettingsSection
              id={searchableSetting("source-control").id}
              title={`Version Control${environmentSuffix}`}
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
              title={
                hasVersionControlSystems
                  ? "Source Control Providers"
                  : `Source Control Providers${environmentSuffix}`
              }
              headerAction={hasVersionControlSystems ? null : scanButton}
            >
              {result.sourceControlProviders.map((item) => (
                <DiscoveryItemRow key={`provider:${item.kind}`} item={item}>
                  {item.kind === "bitbucket" ? (
                    <SettingsSearchTarget id={searchableSetting("bitbucket-credentials").id}>
                      <BitbucketCredentialsSettings
                        // Drafts belong to one environment; switching must not carry them over.
                        key={environmentId}
                        environmentId={environmentId}
                        onSaved={handleScan}
                      />
                    </SettingsSearchTarget>
                  ) : undefined}
                </DiscoveryItemRow>
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
      <SourceControlWritingSettingsSection />
    </SettingsPageContainer>
  );
}
