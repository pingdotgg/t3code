import { RefreshIcon } from "~/components/ui/refresh-icon";
import { useAtomValue } from "@effect/atom-react";
import * as Option from "effect/Option";
import { ChevronDownIcon } from "lucide-react";
import { useState, type ReactNode } from "react";
import type {
  SourceControlDiscoveryResult,
  SourceControlProviderAuth,
  SourceControlProviderDiscoveryItem,
  VcsDriverKind,
  VcsDiscoveryItem,
} from "@t3tools/contracts";
import { useSettingsScope } from "./SettingsScopeContext";
import { ProjectDefaultsSettings } from "./ProjectDefaultsSettings";
import { useLiveRefresh } from "../../hooks/useLiveRefresh";
import { cn } from "../../lib/utils";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { sourceControlEnvironment } from "../../state/sourceControl";
import { useAtomCommand } from "../../state/use-atom-command";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "../ui/empty";
import { Collapsible, CollapsibleContent } from "../ui/collapsible";
import { Skeleton } from "../ui/skeleton";
import { Switch } from "../ui/switch";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { msg, T, useGT, useMessages, Var } from "gt-react";
import { m, type MessageResolver } from "../../i18n/messages";

import { GitIcon, JujutsuIcon, type Icon } from "../Icons";
import { IssueTrackerSettings } from "./IssueTrackerSettings";
import { SourceControlHostSettings } from "./SourceControlHostSettings";
import { SourceControlAccountSettings } from "./SourceControlAccountSettings";
import { SourceControlAppSignInSettings } from "./SourceControlAppSignInSettings";
import { SourceControlTokenSettings } from "./SourceControlTokenSettings";
import { RedactedSensitiveText } from "./RedactedSensitiveText";
import { SourceControlWritingSettingsSection } from "./SourceControlWritingSettings";
import {
  SettingsPageContainer,
  SettingsRow,
  SettingsSearchTarget,
  SettingsSection,
  useSettingsSearchTargetId,
} from "./settingsLayout";
import { useSearchableSetting, sourceControlHostSettingsSearchId } from "./settingsSearch";
import { PullRequestGlyph } from "~/components/pullRequest/pullRequestIcons";
import { sourceControlInstallHintText } from "@t3tools/client-runtime/contract-labels";
import { isSourceControlProviderOffered } from "@t3tools/client-runtime/operations/projects";
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

/** The status chip at the end of a provider row. */
function itemChip(
  item: VcsDiscoveryItem | SourceControlProviderDiscoveryItem,
  resolve: MessageResolver = m,
): {
  readonly label: string;
  readonly variant: "success" | "warning" | "secondary" | "unavailable";
} {
  if (isVcsNotReady(item)) return { label: resolve(msg("Coming soon")), variant: "warning" };
  if (item.status !== "available")
    return { label: resolve(msg("Not installed")), variant: "unavailable" };
  if (!isProviderDiscoveryItem(item))
    return {
      label: resolve(msg("Ready", { $context: "source control tool status" })),
      variant: "success",
    };
  if (item.auth.status === "authenticated")
    return { label: resolve(msg("Authenticated")), variant: "success" };
  if (item.auth.status === "unauthenticated")
    return { label: resolve(msg("Not authenticated")), variant: "secondary" };
  return {
    label: resolve(msg("Available", { $context: "source control tool status" })),
    variant: "secondary",
  };
}

function RedactedAccount(props: { readonly account: string | null }) {
  const gt = useGT();
  return (
    <RedactedSensitiveText
      value={props.account}
      ariaLabel={gt("Toggle source control account visibility")}
      revealTooltip={gt("Click to reveal account")}
      hideTooltip={gt("Click to hide account")}
    />
  );
}

function sourceControlItemIcon(
  item: VcsDiscoveryItem | SourceControlProviderDiscoveryItem,
): ReactNode {
  const host = isProviderDiscoveryItem(item) ? sourceControlClients.find(item.kind) : undefined;
  const Icon = isProviderDiscoveryItem(item)
    ? host && sourceControlIcon(host)
    : VCS_ICONS[item.kind];
  return Icon ? <Icon /> : null;
}

function itemSummary({
  item,
  auth,
  authAccount,
  version,
  resolve,
}: {
  readonly item: VcsDiscoveryItem | SourceControlProviderDiscoveryItem;
  readonly auth: SourceControlProviderAuth | null;
  readonly authAccount: string | null;
  readonly version: string | null;
  readonly resolve: MessageResolver;
}) {
  const toolVersion = version
    ? auth && item.executable
      ? `${item.executable} ${version}`
      : version
    : null;
  const installHint = sourceControlInstallHintText(item.installHint, resolve);
  if (isVcsNotReady(item)) {
    return (
      <span>
        <T>
          Support for <Var>{item.label}</Var> is coming soon.
        </T>
      </span>
    );
  }

  if (item.status !== "available") {
    return (
      <span>
        <T>
          Not available on this server: <Var>{installHint}</Var>
        </T>
      </span>
    );
  }

  if (auth) {
    if (auth.status === "authenticated") {
      const authDetail = optionLabel(auth.detail);
      return (
        <>
          {authAccount ? (
            <>
              <span>
                <T>Signed in as</T>
              </span>
              <RedactedAccount account={authAccount} />
            </>
          ) : (
            <span>
              <T>Signed in</T>
            </span>
          )}
          {authDetail ? <span className="basis-full">{authDetail}</span> : null}
          {toolVersion ? <span className="basis-full">{toolVersion}</span> : null}
        </>
      );
    }

    if (!item.executable && auth.status === "unauthenticated") {
      return (
        <span>
          <T>
            Available. <Var>{installHint}</Var>
          </T>
        </span>
      );
    }

    if (auth.status === "unauthenticated" && auth.accounts?.some((entry) => entry.authenticated)) {
      return (
        <span>
          {optionLabel(auth.detail) ?? (
            <T>
              Every <Var>{item.label}</Var> host is turned off.
            </T>
          )}
        </span>
      );
    }

    if (auth.status === "unauthenticated") {
      return (
        <span>
          <T>
            Sign in with{" "}
            <code className="rounded bg-muted px-1 py-px text-2xs">
              <Var>{item.executable}</Var>
            </code>{" "}
            on the server host to enable change request features.
          </T>
        </span>
      );
    }
    const authDetail = optionLabel(auth.detail);
    if (authDetail) {
      return (
        <span>
          <T>
            Could not verify <Var>{item.label}</Var>. <Var>{authDetail}</Var>
          </T>
        </span>
      );
    }
    return (
      <span>
        <T>
          <Var>{item.executable}</Var> found on this environment
        </T>
      </span>
    );
  }

  return <span>{toolVersion ?? <T>Available</T>}</span>;
}

function DiscoveryItemRow({
  item,
  offered,
  children,
}: {
  readonly item: VcsDiscoveryItem | SourceControlProviderDiscoveryItem;
  /** A provider's switch chooses whether the project pickers offer it; a VCS switch only reports. */
  readonly offered?: {
    readonly checked: boolean;
    readonly disabled: boolean;
    readonly onChange: (checked: boolean) => void;
  };
  readonly children?: ReactNode;
}) {
  const messages = useMessages();
  const gt = useGT();
  const version = optionLabel(item.version);
  const auth = isProviderDiscoveryItem(item) ? item.auth : null;
  const authAccount = auth ? optionLabel(auth.account) : null;
  const chip = itemChip(item, messages);
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
    <div className={cn(isVcsNotReady(item) && "opacity-80")}>
      <SettingsRow
        leading={sourceControlItemIcon(item)}
        title={
          <span className="flex min-w-0 flex-wrap items-center gap-2">
            <span className="truncate">{item.label}</span>
            {version ? <code className="text-meta text-dim-foreground">{version}</code> : null}
            {chip.variant === "warning" ? (
              <Badge variant="warning">{chip.label}</Badge>
            ) : chip.variant === "secondary" &&
              isProviderDiscoveryItem(item) &&
              item.auth.status === "unauthenticated" ? (
              <Badge variant="secondary">{chip.label}</Badge>
            ) : null}
          </span>
        }
        description={
          <span className="flex min-w-0 flex-wrap items-center gap-x-1">
            {itemSummary({ item, auth, authAccount, version: null, resolve: messages })}
          </span>
        }
        trailing={
          hasDetails ? (
            <Button
              size="icon-xs"
              variant="ghost-muted"
              onClick={() => setIsExpanded((open) => !open)}
              aria-expanded={isExpanded}
              aria-label={gt("Toggle {label} details", { label: item.label })}
            >
              <ChevronDownIcon
                className={cn("size-3.5 transition-transform", isExpanded && "rotate-180")}
              />
            </Button>
          ) : null
        }
        control={
          offered ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Switch
                    checked={offered.checked}
                    disabled={offered.disabled}
                    onCheckedChange={offered.onChange}
                    aria-label={gt("Offer {label} when adding or publishing a project", {
                      label: item.label,
                    })}
                  />
                }
              />
              <TooltipPopup side="top">
                <T>Offer when adding or publishing a project</T>
              </TooltipPopup>
            </Tooltip>
          ) : undefined
        }
      />
      {hasDetails ? (
        <Collapsible open={isExpanded} onOpenChange={setIsExpanded}>
          <CollapsibleContent>
            <div className="px-3 pb-3 sm:px-4">{children}</div>
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
        <div key={row} className="flex items-center gap-3 px-4 py-3">
          <Skeleton className="size-8" />
          <div className="min-w-0 flex-1 space-y-2">
            <Skeleton shape="pill" className="h-4 w-28" />
            <Skeleton shape="pill" className="h-3 w-full max-w-xs" />
          </div>
          <Skeleton shape="pill" className="h-5 w-20" />
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
  const searchableSetting = useSearchableSetting();
  const gt = useGT();
  const hasError = error !== null;

  return (
    <SettingsSection id={searchableSetting("source-control").id} title={gt("Server environment")}>
      <Empty size="compact">
        <EmptyMedia variant="icon">
          <PullRequestGlyph.pullRequest />
        </EmptyMedia>
        <EmptyHeader>
          <EmptyTitle>
            {hasError ? gt("Could not scan the server environment") : gt("Nothing detected yet")}
          </EmptyTitle>
          <EmptyDescription>
            {hasError
              ? error
              : gt(
                  "Install Git on the server, add optional hosting integrations or credentials your workspace needs, then rescan.",
                )}
          </EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <Button size="sm" variant="secondary" onClick={onScan} disabled={isPending}>
            <RefreshIcon size="sm" refreshing={isPending} />
            <T>Scan</T>
          </Button>
        </EmptyContent>
      </Empty>
    </SettingsSection>
  );
}

export function SourceControlSettingsPanel() {
  const searchableSetting = useSearchableSetting();
  const gt = useGT();
  const { scope, environment, connectedEnvironments } = useSettingsScope();

  const environmentId =
    environment?.connection.phase === "connected" ? environment.environmentId : null;
  const aggregate = scope.environmentIds.length !== 1 && connectedEnvironments.length > 1;
  const environmentContext =
    aggregate && environment ? (
      <span className="text-meta text-muted-foreground">{environment.label}</span>
    ) : null;
  const discovery = useEnvironmentQuery(
    environmentId === null
      ? null
      : sourceControlEnvironment.discovery({
          environmentId,
          input: {},
        }),
    useMessages(),
  );
  const result = discovery.data ?? EMPTY_DISCOVERY_RESULT;
  const hasVersionControlSystems = result.versionControlSystems.length > 0;
  const hasDiscoveryItems = hasVersionControlSystems || result.sourceControlProviders.length > 0;
  const isInitialScanPending = discovery.isPending && discovery.data === null;
  const handleScan = () => {
    discovery.refresh();
  };
  // A CLI login on the server host changes nothing the client reads, so returning to the window
  // asks again. Discovery runs every hosting CLI, too costly for a timer nobody asked for.
  useLiveRefresh(
    () => {
      if (!discovery.isPending) discovery.refresh();
    },
    {
      enabled: environmentId !== null,
      key: `source-control-discovery:${environmentId}`,
      intervalMs: null,
    },
  );
  const offeredProviders = environment?.serverConfig?.settings.offeredSourceControlProviders;
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, {
    label: "save source control providers",
  });
  const canUpdateSettings = useAtomValue(
    serverEnvironment.updateSettings.permissionAtom(environmentId),
  );
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
              <div className="flex items-center gap-3 text-caption text-muted-foreground">
                <span aria-hidden className="h-px flex-1 bg-border" />
                <T>Or use your own credentials</T>
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
            // Hangs 6px past the header row so the glyph's ink ends on the card edge.
            className="-me-1.5"
            size="icon-xs"
            variant="ghost-muted"
            onClick={handleScan}
            disabled={discovery.isPending}
            aria-label={gt("Rescan Git and hosting integrations")}
          >
            <RefreshIcon refreshing={discovery.isPending} />
          </Button>
        }
      />
      <TooltipPopup side="top">
        <T>Rescan Git and hosting integrations</T>
      </TooltipPopup>
    </Tooltip>
  );

  const providersTitle = gt("Source Control Providers");
  return (
    <SettingsPageContainer className="max-w-[688px]">
      <ProjectDefaultsSettings category="source-control" />
      {environmentId === null ? (
        <SettingsSection
          id={searchableSetting("source-control").id}
          title={gt("Source Control Providers")}
        >
          <p className="px-4 py-3 text-sm text-muted-foreground">
            <T>
              Connect an environment to inspect its version control tools and hosting integrations.
            </T>
          </p>
        </SettingsSection>
      ) : isInitialScanPending ? (
        <SourceControlSectionSkeleton title={providersTitle} headerAction={scanButton} />
      ) : hasDiscoveryItems ? (
        <>
          {hasVersionControlSystems ? (
            <SettingsSection
              id={searchableSetting("source-control").id}
              title={gt("Version Control")}
              titleAction={environmentContext}
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
              title={gt("Source Control Providers")}
              titleAction={hasVersionControlSystems ? null : environmentContext}
              headerAction={hasVersionControlSystems ? null : scanButton}
            >
              {result.sourceControlProviders.map((item) => (
                <DiscoveryItemRow
                  key={`provider:${item.kind}`}
                  item={item}
                  offered={{
                    checked: isSourceControlProviderOffered(offeredProviders, item.kind),
                    disabled: !canUpdateSettings,
                    onChange: (checked) =>
                      void updateSettings({
                        environmentId,
                        input: {
                          patch: { offeredSourceControlProviders: { [item.kind]: checked } },
                        },
                      }),
                  }}
                >
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
      {environmentId === null ? null : (
        <IssueTrackerSettings key={environmentId} environmentId={environmentId} />
      )}

      <SourceControlWritingSettingsSection />
    </SettingsPageContainer>
  );
}
