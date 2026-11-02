import { RefreshIcon } from "~/components/ui/refresh-icon";
import { ChevronDownIcon } from "lucide-react";
import * as Option from "effect/Option";
import { useState, type ReactNode } from "react";
import type {
  SourceControlDiscoveryResult,
  SourceControlProviderAuth,
  SourceControlProviderDiscoveryItem,
  VcsDriverKind,
  VcsDiscoveryItem,
} from "@t3tools/contracts";
import type { MessageKey } from "@t3tools/client-runtime/i18n";
import { useT } from "../../hooks/useI18n";
import { useSettingsScope } from "./SettingsScopeContext";
import { ProjectDefaultsSettings } from "./ProjectDefaultsSettings";
import { cn } from "../../lib/utils";
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
import { Switch } from "../ui/switch";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

import { GitIcon, JujutsuIcon, type Icon } from "../Icons";
import { SourceControlHostSettings } from "./SourceControlHostSettings";
import { SourceControlAccountSettings } from "./SourceControlAccountSettings";
import { SourceControlAppSignInSettings } from "./SourceControlAppSignInSettings";
import { SourceControlTokenSettings } from "./SourceControlTokenSettings";
import { RedactedSensitiveText } from "./RedactedSensitiveText";
import { SourceControlWritingSettingsSection } from "./SourceControlWritingSettings";
import {
  SettingsPageContainer,
  SettingsSearchTarget,
  SettingsSection,
  useSettingsSearchTargetId,
} from "./settingsLayout";
import { searchableSetting, sourceControlHostSettingsSearchId } from "./settingsSearch";
import { PullRequestGlyph } from "~/components/pullRequest/pullRequestIcons";
import { sourceControlClients } from "@t3tools/client-runtime/source-control-clients";
import { sourceControlIcon } from "~/sourceControlPresentation";

const EMPTY_DISCOVERY_RESULT: SourceControlDiscoveryResult = {
  versionControlSystems: [],
  sourceControlProviders: [],
};

const VCS_ICONS: Partial<Record<VcsDriverKind, Icon>> = {
  git: GitIcon,
  jj: JujutsuIcon,
};

const SOURCE_CONTROL_SKELETON_ROWS = ["primary", "secondary"] as const;
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

type Translate = ReturnType<typeof useT>;
/** Placeholder swapped for inline markup after translation. */
const SLOT = "\u0001";

function authPresentation(auth: SourceControlProviderAuth): {
  readonly label: MessageKey;
  readonly badge: "secondary" | null;
} {
  if (auth.status === "authenticated") {
    return { label: "settings.code.sc.authenticated", badge: null };
  }
  if (auth.status === "unauthenticated") {
    return { label: "settings.code.sc.notAuthenticated", badge: "secondary" };
  }
  return { label: "settings.code.sc.statusUnknown", badge: null };
}

function RedactedAccount(props: { readonly account: string | null }) {
  const t = useT();
  return (
    <RedactedSensitiveText
      value={props.account}
      ariaLabel={t("settings.code.sc.toggleAccount")}
      revealTooltip={t("settings.code.sc.revealAccount")}
      hideTooltip={t("settings.code.sc.hideAccount")}
    />
  );
}

function itemStatusDot(item: VcsDiscoveryItem | SourceControlProviderDiscoveryItem): string {
  if (isVcsNotReady(item)) return "bg-muted-foreground/35";
  if (isProviderDiscoveryItem(item)) {
    return item.status === "available" && item.auth.status === "authenticated"
      ? "bg-success"
      : "bg-muted-foreground/35";
  }
  if (item.status !== "available") return "bg-warning";
  return "bg-success";
}

function sourceControlItemIcon(
  item: VcsDiscoveryItem | SourceControlProviderDiscoveryItem,
): ReactNode {
  const host = isProviderDiscoveryItem(item) ? sourceControlClients.find(item.kind) : undefined;
  const Icon = isProviderDiscoveryItem(item)
    ? host && sourceControlIcon(host)
    : VCS_ICONS[item.kind];
  return Icon ? <Icon className="size-4.5 text-foreground/80" aria-hidden /> : null;
}

function SourceControlItemMark({
  item,
}: {
  readonly item: VcsDiscoveryItem | SourceControlProviderDiscoveryItem;
}) {
  const dotClassName = itemStatusDot(item);
  const icon = sourceControlItemIcon(item);

  if (!icon) {
    return <span className={cn("size-2 shrink-0 rounded-full", dotClassName)} aria-hidden />;
  }

  return (
    <span className="relative inline-flex size-5 shrink-0 items-center justify-center">
      {icon}
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
  t,
  item,
  auth,
  authAccount,
}: {
  readonly t: Translate;
  readonly item: VcsDiscoveryItem | SourceControlProviderDiscoveryItem;
  readonly auth: SourceControlProviderAuth | null;
  readonly authAccount: string | null;
}) {
  if (isVcsNotReady(item)) {
    return <span>{t("settings.code.sc.comingSoonSupport", { label: item.label })}</span>;
  }

  if (item.status !== "available") {
    return <span>{t("settings.code.sc.notAvailable", { hint: item.installHint })}</span>;
  }

  if (auth) {
    if (auth.status === "authenticated") {
      const authDetail = optionLabel(auth.detail);
      return (
        <>
          <span>{t("settings.code.sc.authenticated")}</span>
          {authAccount ? (
            <>
              <span aria-hidden>{t("settings.code.sc.asAccount")}</span>
              <RedactedAccount account={authAccount} />
            </>
          ) : null}
          {authDetail ? <span>· {authDetail}</span> : null}
        </>
      );
    }

    if (!item.executable && auth.status === "unauthenticated") {
      return <span>{t("settings.code.sc.availableHint", { hint: item.installHint })}</span>;
    }

    if (auth.status === "unauthenticated" && auth.accounts?.some((entry) => entry.authenticated)) {
      return (
        <span>
          {optionLabel(auth.detail) ?? t("settings.code.sc.allHostsOff", { label: item.label })}
        </span>
      );
    }

    if (auth.status === "unauthenticated") {
      const [before, after] = t("settings.code.sc.unauthenticatedHint", {
        label: item.label,
        tool: SLOT,
      }).split(SLOT);
      return (
        <span>
          {before}
          <code className="rounded bg-muted px-1 py-px text-2xs">{item.executable}</code>
          {after}
        </span>
      );
    }
    const authDetail = optionLabel(auth.detail);
    return (
      <span>
        {t("settings.code.sc.couldNotVerify", {
          label: item.label,
          detail: authDetail ?? item.installHint,
        })}
      </span>
    );
  }

  return <span>{t("settings.code.sc.available")}</span>;
}

function DiscoveryItemRow({
  item,
  children,
}: {
  readonly item: VcsDiscoveryItem | SourceControlProviderDiscoveryItem;
  readonly children?: ReactNode;
}) {
  const t = useT();
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
  const [seenSearchTargetId, setSeenSearchTargetId] = useState<string | null>(null);
  const targetsThisRow = searchTargetId === sourceControlHostSettingsSearchId(item.kind);
  if (targetsThisRow && !isExpanded && seenSearchTargetId !== searchTargetId) {
    setIsExpanded(true);
  }
  if (seenSearchTargetId !== searchTargetId) setSeenSearchTargetId(searchTargetId);

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
                  {t("settings.code.sc.comingSoon")}
                </Badge>
              ) : null}
              {authStatus?.badge ? (
                <Badge variant={authStatus.badge} size="sm">
                  {t(authStatus.label)}
                </Badge>
              ) : null}
            </div>
            <p className="flex min-w-0 flex-wrap items-center gap-x-1 text-xs leading-normal text-muted-foreground/80">
              {itemSummary({ t, item, auth, authAccount })}
            </p>
          </div>
          <div className="flex w-full shrink-0 items-center gap-2 sm:w-auto sm:justify-end">
            {hasDetails ? (
              <Button
                size="icon-xs"
                variant="ghost-muted"
                onClick={() => setIsExpanded((open) => !open)}
                aria-expanded={isExpanded}
                aria-label={t("settings.code.sc.toggleDetails", { label: item.label })}
              >
                <ChevronDownIcon
                  className={cn("size-3.5 transition-transform", isExpanded && "rotate-180")}
                />
              </Button>
            ) : null}
            {!isVcsNotReady(item) ? (
              <Switch
                checked={enabled}
                disabled
                aria-label={t("settings.code.sc.availability", { label: item.label })}
              />
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
  const t = useT();
  const hasError = error !== null;

  return (
    <SettingsSection
      id={searchableSetting("source-control").id}
      title={t("settings.code.sc.serverEnvironment")}
    >
      <Empty>
        <EmptyMedia variant="icon">
          <PullRequestGlyph.pullRequest />
        </EmptyMedia>
        <EmptyHeader>
          <EmptyTitle>
            {hasError ? t("settings.code.sc.scanFailed") : t("settings.code.sc.nothingDetected")}
          </EmptyTitle>
          <EmptyDescription>
            {hasError ? error : t("settings.code.sc.nothingDetectedHint")}
          </EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <Button size="sm" variant="outline" onClick={onScan} disabled={isPending}>
            <RefreshIcon size="sm" refreshing={isPending} />
            {t("settings.code.sc.scan")}
          </Button>
        </EmptyContent>
      </Empty>
    </SettingsSection>
  );
}

export function SourceControlSettingsPanel() {
  const t = useT();
  const { scope, environment, connectedEnvironments } = useSettingsScope();

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
  const hostSettingsPanel = (item: SourceControlProviderDiscoveryItem) => {
    const definition = sourceControlClients.find(item.kind);
    if (!definition?.settings || environmentId === null) return undefined;
    const { credentials } = definition;
    if (credentials) {
      return (
        <SettingsSearchTarget id={sourceControlHostSettingsSearchId(item.kind)}>
          <div className="grid gap-6">
            {credentials.appSignIn && item.appSignIn === true ? (
              <SourceControlAppSignInSettings
                key={`sign-in-${environmentId}`}
                environmentId={environmentId}
                definition={definition}
                appSignIn={credentials.appSignIn}
                account={Option.getOrNull(item.auth.account)}
                onChanged={handleScan}
              />
            ) : null}
            {credentials.appSignIn && item.appSignIn === true ? (
              <div className="flex items-center gap-3 text-2xs text-muted-foreground">
                <span aria-hidden className="h-px flex-1 bg-border" />
                {t("settings.code.sc.ownCredentials")}
                <span aria-hidden className="h-px flex-1 bg-border" />
              </div>
            ) : null}
            <SourceControlTokenSettings
              key={`token-${environmentId}`}
              environmentId={environmentId}
              definition={definition}
              credentials={credentials}
              onSaved={handleScan}
            />
            {item.status === "available" ? (
              <SourceControlAccountSettings
                key={environmentId}
                environmentId={environmentId}
                definition={definition}
                credentials={credentials}
                auth={item.auth}
                onSaved={handleScan}
              />
            ) : null}
          </div>
        </SettingsSearchTarget>
      );
    }
    return (
      <SettingsSearchTarget id={sourceControlHostSettingsSearchId(item.kind)}>
        <SourceControlHostSettings
          key={environmentId}
          environmentId={environmentId}
          definition={{ ...definition, settings: definition.settings }}
          onSaved={handleScan}
        />
      </SettingsSearchTarget>
    );
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
            aria-label={t("settings.code.sc.rescanAria")}
          >
            <RefreshIcon refreshing={discovery.isPending} />
          </Button>
        }
      />
      <TooltipPopup side="top">{t("settings.code.sc.rescanTooltip")}</TooltipPopup>
    </Tooltip>
  );

  return (
    <SettingsPageContainer>
      <ProjectDefaultsSettings category="source-control" />
      {environmentId === null ? (
        <SettingsSection
          id={searchableSetting("source-control").id}
          title={t("settings.code.sc.serverEnvironment")}
        >
          <p className="px-4 py-3 text-sm text-muted-foreground">
            {t("settings.code.sc.connectEnvironment")}
          </p>
        </SettingsSection>
      ) : isInitialScanPending ? (
        <>
          <SourceControlSectionSkeleton
            title={`${t("settings.code.sc.versionControl")}${environmentSuffix}`}
            headerAction={scanButton}
          />
          <SourceControlSectionSkeleton title={t("settings.code.sc.providers")} />
        </>
      ) : hasDiscoveryItems ? (
        <>
          {hasVersionControlSystems ? (
            <SettingsSection
              id={searchableSetting("source-control").id}
              title={`${t("settings.code.sc.versionControl")}${environmentSuffix}`}
              headerAction={scanButton}
            >
              {result.versionControlSystems.map((item) => (
                <DiscoveryItemRow key={`vcs:${item.kind}`} item={item} />
              ))}
            </SettingsSection>
          ) : null}

          {result.sourceControlProviders.length > 0 ? (
            <SettingsSection
              id={hasVersionControlSystems ? undefined : searchableSetting("source-control").id}
              title={
                hasVersionControlSystems
                  ? t("settings.code.sc.providers")
                  : `${t("settings.code.sc.providers")}${environmentSuffix}`
              }
              headerAction={hasVersionControlSystems ? null : scanButton}
            >
              {result.sourceControlProviders.map((item) => (
                <DiscoveryItemRow key={`provider:${item.kind}`} item={item}>
                  {hostSettingsPanel(item)}
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

      <SourceControlWritingSettingsSection />
    </SettingsPageContainer>
  );
}
