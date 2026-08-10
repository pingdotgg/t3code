import {
  ChevronDownIcon,
  GitPullRequestIcon,
  InfoIcon,
  PlusIcon,
  RefreshCwIcon,
  Trash2Icon,
} from "lucide-react";
import * as Duration from "effect/Duration";
import * as Option from "effect/Option";
import { useState, type ReactNode } from "react";
import type {
  BackgroundActivitySettings,
  GitHubAccountSelection,
  GitHubAuthAccount,
  SourceControlProviderKind,
  SourceControlDiscoveryResult,
  SourceControlProviderAuth,
  SourceControlProviderDiscoveryItem,
  VcsDriverKind,
  VcsDiscoveryItem,
} from "@t3tools/contracts";
import {
  getBackgroundActivityBaseProfile,
  getBackgroundActivityPresetSettings,
  resolveServerBackgroundActivitySettings,
} from "@t3tools/shared/backgroundActivitySettings";

import { usePrimarySettings, useUpdatePrimarySettings } from "../../hooks/useSettings";
import { cn } from "../../lib/utils";
import { usePrimaryEnvironment } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { sourceControlEnvironment } from "../../state/sourceControl";
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
import { Input } from "../ui/input";
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
import { SettingResetButton, SettingsPageContainer, SettingsSection } from "./settingsLayout";
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

function githubAccountKey(account: GitHubAccountSelection): string {
  return `${account.host}\n${account.login}\n${account.tokenSource}`;
}

function githubAccountLabel(account: GitHubAccountSelection): string {
  return `${account.login} · ${account.host} · ${account.tokenSource}`;
}

function githubAccountSelection(account: GitHubAuthAccount): GitHubAccountSelection {
  return {
    host: account.host,
    login: account.login,
    tokenSource: account.tokenSource,
  };
}

function hasMultipleGitHubAccountsOnHost(accounts: ReadonlyArray<GitHubAuthAccount>): boolean {
  return accounts.some(
    (account, index) =>
      accounts.findIndex(
        (candidate) => candidate.host.toLowerCase() === account.host.toLowerCase(),
      ) !== index,
  );
}

function GitHubAccountSelect({
  accounts,
  value,
  label,
  onChange,
}: {
  readonly accounts: ReadonlyArray<GitHubAuthAccount>;
  readonly value: GitHubAccountSelection;
  readonly label: string;
  readonly onChange: (account: GitHubAccountSelection) => void;
}) {
  const selections = accounts.map(githubAccountSelection);
  const selected =
    selections.find((account) => githubAccountKey(account) === githubAccountKey(value)) ?? value;
  return (
    <Select
      value={githubAccountKey(selected)}
      onValueChange={(key) => {
        const account = selections.find((entry) => githubAccountKey(entry) === key);
        if (account) onChange(account);
      }}
    >
      <SelectTrigger size="sm" className="w-full sm:w-64" aria-label={label}>
        <SelectValue>{githubAccountLabel(selected)}</SelectValue>
      </SelectTrigger>
      <SelectPopup align="end" alignItemWithTrigger={false}>
        {selections.map((account) => (
          <SelectItem
            key={githubAccountKey(account)}
            hideIndicator
            value={githubAccountKey(account)}
          >
            {githubAccountLabel(account)}
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}

function GitHubAccountSettings({
  accounts,
}: {
  readonly accounts: ReadonlyArray<GitHubAuthAccount>;
}) {
  const settings = usePrimarySettings();
  const updateSettings = useUpdatePrimarySettings();
  const [owner, setOwner] = useState("");
  const uniqueAccounts = [
    ...new Map(accounts.map((account) => [githubAccountKey(account), account])).values(),
  ];
  const accountsByHost = new Map<string, GitHubAuthAccount[]>();
  for (const account of uniqueAccounts) {
    const host = account.host.toLowerCase();
    const held = accountsByHost.get(host);
    if (held === undefined) accountsByHost.set(host, [account]);
    else held.push(account);
  }
  const selectableHosts = [...accountsByHost.entries()].filter(
    ([, hostAccounts]) => hostAccounts.length > 1,
  );
  const selectableHostKeys = new Set(selectableHosts.map(([host]) => host));
  const hiddenDefaultHosts = Object.keys(settings.githubDefaultAccounts).filter(
    (host) => !selectableHostKeys.has(host.toLowerCase()),
  );
  const selectableAccounts = selectableHosts.flatMap(([, hostAccounts]) => hostAccounts);
  const initialAccount =
    selectableAccounts.find((account) => account.active) ?? selectableAccounts[0];
  const [accountKey, setAccountKey] = useState(
    initialAccount === undefined ? "" : githubAccountKey(initialAccount),
  );
  const hasSavedRouting =
    Object.keys(settings.githubDefaultAccounts).length > 0 ||
    Object.keys(settings.githubAccountOverrides).length > 0;

  if (selectableAccounts.length === 0) {
    if (!hasSavedRouting) return null;
    return (
      <div className="flex flex-col gap-3 border-t border-border/60 pt-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <div className="text-xs font-medium text-foreground">Saved account routing</div>
          <div className="text-xs text-muted-foreground">
            Multiple signed-in accounts are no longer available. Clear saved routing to use the
            active GitHub account.
          </div>
        </div>
        <Button
          size="sm"
          variant="outline"
          onClick={() => updateSettings({ githubDefaultAccounts: {}, githubAccountOverrides: {} })}
        >
          Clear saved routing
        </Button>
      </div>
    );
  }
  const normalizedOwner = owner.trim().replace(/^\/+|\/+$/g, "");
  const overrideAccount =
    selectableAccounts.find((entry) => githubAccountKey(entry) === accountKey) ??
    selectableAccounts[0]!;
  const canAddOverride = /^[A-Za-z0-9_.-]+$/.test(normalizedOwner);

  const addOverride = () => {
    if (!canAddOverride) return;
    updateSettings({
      githubAccountOverrides: {
        ...settings.githubAccountOverrides,
        [`${overrideAccount.host.toLowerCase()}/${normalizedOwner.toLowerCase()}`]:
          githubAccountSelection(overrideAccount),
      },
    });
    setOwner("");
  };

  return (
    <div className="grid gap-4 border-t border-border/60 pt-4">
      {selectableHosts.map(([host, hostAccounts]) => {
        const active = hostAccounts.find((account) => account.active) ?? hostAccounts[0]!;
        const selected = settings.githubDefaultAccounts[host] ?? githubAccountSelection(active);
        return (
          <div
            key={host}
            className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between"
          >
            <div>
              <div className="text-xs font-medium text-foreground">Default account</div>
              <div className="text-xs text-muted-foreground">{host}</div>
            </div>
            <GitHubAccountSelect
              accounts={hostAccounts}
              value={selected}
              label={`Default GitHub account for ${host}`}
              onChange={(account) =>
                updateSettings({
                  githubDefaultAccounts: {
                    ...settings.githubDefaultAccounts,
                    [host]: account,
                  },
                })
              }
            />
          </div>
        );
      })}

      <div className="grid gap-2">
        <div>
          <div className="text-xs font-medium text-foreground">Organization or user overrides</div>
          <div className="text-xs text-muted-foreground">
            Use a different signed-in account for repositories owned by this organization or user.
          </div>
        </div>
        {Object.entries(settings.githubAccountOverrides).map(([ownerKey, account]) => {
          const hostAccounts = accountsByHost.get(account.host.toLowerCase()) ?? [];
          return (
            <div key={ownerKey} className="flex flex-col gap-2 sm:flex-row sm:items-center">
              <code className="min-w-0 flex-1 truncate text-xs">{ownerKey}</code>
              <GitHubAccountSelect
                accounts={hostAccounts}
                value={account}
                label={`GitHub account for ${ownerKey}`}
                onChange={(nextAccount) =>
                  updateSettings({
                    githubAccountOverrides: {
                      ...settings.githubAccountOverrides,
                      [ownerKey]: nextAccount,
                    },
                  })
                }
              />
              <Button
                size="icon-xs"
                variant="ghost"
                aria-label={`Remove GitHub account override for ${ownerKey}`}
                onClick={() => {
                  const next = { ...settings.githubAccountOverrides };
                  delete next[ownerKey];
                  updateSettings({ githubAccountOverrides: next });
                }}
              >
                <Trash2Icon className="size-3.5" />
              </Button>
            </div>
          );
        })}
        <form
          className="flex flex-col gap-2 sm:flex-row sm:items-center"
          onSubmit={(event) => {
            event.preventDefault();
            addOverride();
          }}
        >
          <Input
            size="sm"
            value={owner}
            onValueChange={setOwner}
            placeholder="Organization or user"
            aria-label="GitHub organization or user"
            className="flex-1"
          />
          <GitHubAccountSelect
            accounts={selectableAccounts}
            value={githubAccountSelection(overrideAccount)}
            label="GitHub account for new override"
            onChange={(account) => setAccountKey(githubAccountKey(account))}
          />
          <Button size="sm" type="submit" disabled={!canAddOverride}>
            <PlusIcon className="size-3.5" />
            Add
          </Button>
        </form>
        {hiddenDefaultHosts.length > 0 ? (
          <div className="flex flex-col gap-2 rounded-lg border border-border/60 p-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <div className="text-xs font-medium text-foreground">Unavailable saved defaults</div>
              <div className="text-xs text-muted-foreground">
                Saved defaults for {hiddenDefaultHosts.join(", ")} are no longer selectable.
              </div>
            </div>
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                const next = { ...settings.githubDefaultAccounts };
                for (const host of hiddenDefaultHosts) delete next[host];
                updateSettings({ githubDefaultAccounts: next });
              }}
            >
              Clear unavailable defaults
            </Button>
          </div>
        ) : null}
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

export function SourceControlSettingsPanel() {
  const environmentId = usePrimaryEnvironment()?.environmentId ?? null;
  const settings = usePrimarySettings();
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
                <DiscoveryItemRow key={`provider:${item.kind}`} item={item}>
                  {item.kind === "github" &&
                  (hasMultipleGitHubAccountsOnHost(item.auth.githubAccounts ?? []) ||
                    Object.keys(settings.githubDefaultAccounts).length > 0 ||
                    Object.keys(settings.githubAccountOverrides).length > 0) ? (
                    <GitHubAccountSettings accounts={item.auth.githubAccounts ?? []} />
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

      {environmentId !== null ? <SourceControlWritingSettingsSection /> : null}
    </SettingsPageContainer>
  );
}
