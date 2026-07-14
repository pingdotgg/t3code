import { useAtomValue } from "@effect/atom-react";
import {
  DownloadIcon,
  KeyRoundIcon,
  LoaderIcon,
  PackageOpenIcon,
  PuzzleIcon,
  RefreshCwIcon,
  ShieldCheckIcon,
  SparklesIcon,
  Trash2Icon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  type ExtensionCatalogItem,
  type ExtensionInstallScope,
  type ExtensionInstallTarget,
  type ProviderInstanceEnvironmentVariable,
  type ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";

import * as Cause from "effect/Cause";

import { cn } from "../../lib/utils";
import { usePrimarySettings, useUpdatePrimarySettings } from "../../hooks/useSettings";
import { usePrimaryEnvironment } from "../../state/environments";
import { primaryServerProvidersAtom, serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { useEnvironmentQuery } from "../../state/query";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";
import { ProviderEnvironmentSection } from "./ProviderInstanceCard";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";
import { getDriverOption } from "./providerDriverMeta";

const SCOPE_OPTIONS: ReadonlyArray<{ value: ExtensionInstallScope; label: string }> = [
  { value: "global", label: "Global" },
  { value: "provider", label: "Per provider" },
];

function targetKey(target: ExtensionInstallTarget): string {
  return target.scope === "global" ? "global" : `provider:${target.providerInstanceId ?? ""}`;
}

function commandErrorMessage(cause: Cause.Cause<unknown>, fallback: string): string {
  const error = Cause.squash(cause);
  return error instanceof Error && error.message.trim().length > 0 ? error.message : fallback;
}

function itemMatchesSearch(item: ExtensionCatalogItem, query: string): boolean {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return true;
  return [item.name, item.displayName, item.description, item.sourceUrl, item.sourceSubpath]
    .filter((value): value is string => Boolean(value))
    .some((value) => value.toLowerCase().includes(normalized));
}

function ExtensionTargetBadges({ targets }: { targets: ReadonlyArray<ExtensionInstallTarget> }) {
  if (targets.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-1">
      {targets.map((target) => (
        <Badge key={targetKey(target)} variant="success" size="sm">
          {target.scope === "global" ? "Global" : target.providerInstanceId}
        </Badge>
      ))}
    </div>
  );
}

function MarketplaceItemCard(props: {
  readonly item: ExtensionCatalogItem;
  readonly selectedScope: ExtensionInstallScope;
  readonly selectedProviderInstanceId: ProviderInstanceId | null;
  readonly isBusy: boolean;
  readonly onInstall: (item: ExtensionCatalogItem) => void;
  readonly onUninstall: (item: ExtensionCatalogItem, target: ExtensionInstallTarget) => void;
}) {
  const displayName = props.item.displayName ?? props.item.name;
  const selectedTarget: ExtensionInstallTarget | null =
    props.selectedScope === "provider"
      ? props.selectedProviderInstanceId
        ? { scope: "provider", providerInstanceId: props.selectedProviderInstanceId }
        : null
      : { scope: "global" };
  const installedForSelectedTarget = selectedTarget
    ? props.item.installedTargets.some((target) => targetEquals(target, selectedTarget))
    : false;

  return (
    <div className="border-t border-border/60 px-4 py-4 first:border-t-0 sm:px-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 flex-1 space-y-2">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <span className="inline-flex size-7 items-center justify-center rounded-lg border border-border/70 bg-muted/35 text-muted-foreground">
              {props.item.type === "skill" ? (
                <SparklesIcon className="size-3.5" />
              ) : (
                <PuzzleIcon className="size-3.5" />
              )}
            </span>
            <div className="min-w-0">
              <h3 className="truncate text-[13px] font-semibold tracking-[-0.01em] text-foreground">
                {displayName}
              </h3>
              <p className="truncate text-[11px] text-muted-foreground/70">
                {props.item.sourceSubpath ?? props.item.sourceUrl}
              </p>
            </div>
            <Badge variant="outline" size="sm">
              {props.item.type}
            </Badge>
          </div>
          {props.item.description ? (
            <p className="max-w-2xl text-xs leading-5 text-muted-foreground/85">
              {props.item.description}
            </p>
          ) : null}
          <ExtensionTargetBadges targets={props.item.installedTargets} />
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {installedForSelectedTarget && selectedTarget ? (
            <Button
              size="sm"
              variant="outline"
              className="h-7 gap-1.5 px-2 text-xs"
              disabled={props.isBusy}
              onClick={() => props.onUninstall(props.item, selectedTarget)}
            >
              <Trash2Icon className="size-3" />
              Remove
            </Button>
          ) : (
            <Button
              size="sm"
              className="h-7 gap-1.5 px-2 text-xs"
              disabled={props.isBusy || selectedTarget === null}
              onClick={() => props.onInstall(props.item)}
            >
              {props.isBusy ? (
                <LoaderIcon className="size-3 animate-spin" />
              ) : (
                <DownloadIcon className="size-3" />
              )}
              Install
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

function targetEquals(left: ExtensionInstallTarget, right: ExtensionInstallTarget): boolean {
  return left.scope === right.scope && left.providerInstanceId === right.providerInstanceId;
}

function ProviderSelectLabel(props: {
  readonly instanceId: ProviderInstanceId;
  readonly providers: ReadonlyArray<ServerProvider>;
}) {
  const provider = props.providers.find((candidate) => candidate.instanceId === props.instanceId);
  const driverOption = provider ? getDriverOption(provider.driver) : undefined;
  return (
    <span className="inline-flex min-w-0 items-center gap-2">
      {provider ? (
        <ProviderInstanceIcon
          driverKind={provider.driver}
          displayName={provider.displayName ?? driverOption?.label ?? String(provider.instanceId)}
          accentColor={provider.accentColor}
          className="size-4"
          iconClassName="size-3.5"
        />
      ) : null}
      <span className="truncate">
        {provider?.displayName ?? driverOption?.label ?? String(props.instanceId)}
      </span>
    </span>
  );
}

function MarketplaceDiscoverySection() {
  const primaryEnvironment = usePrimaryEnvironment();
  const environmentId = primaryEnvironment?.environmentId ?? null;
  const providers = useAtomValue(primaryServerProvidersAtom);
  const [query, setQuery] = useState("");
  const [selectedScope, setSelectedScope] = useState<ExtensionInstallScope>("global");
  const [selectedProviderInstanceId, setSelectedProviderInstanceId] =
    useState<ProviderInstanceId | null>(() => providers[0]?.instanceId ?? null);
  const [busyItemIds, setBusyItemIds] = useState<ReadonlySet<string>>(() => new Set());
  const discovery = useEnvironmentQuery(
    environmentId === null
      ? null
      : serverEnvironment.extensionsDiscover({ environmentId, input: {} }),
  );
  const installExtension = useAtomCommand(serverEnvironment.extensionsInstall, {
    reportFailure: false,
  });
  const uninstallExtension = useAtomCommand(serverEnvironment.extensionsUninstall, {
    reportFailure: false,
  });
  const filteredItems = useMemo(
    () => (discovery.data?.items ?? []).filter((item) => itemMatchesSearch(item, query)),
    [discovery.data?.items, query],
  );
  const markItemBusy = useCallback((itemId: string, busy: boolean) => {
    setBusyItemIds((current) => {
      const next = new Set(current);
      if (busy) {
        next.add(itemId);
      } else {
        next.delete(itemId);
      }
      return next;
    });
  }, []);

  useEffect(() => {
    if (selectedProviderInstanceId !== null || providers.length === 0) return;
    setSelectedProviderInstanceId(providers[0]!.instanceId);
  }, [providers, selectedProviderInstanceId]);

  const runInstall = useCallback(
    async (item: ExtensionCatalogItem) => {
      if (environmentId === null) return;
      if (selectedScope === "provider" && selectedProviderInstanceId === null) return;
      markItemBusy(item.id, true);
      const result = await installExtension({
        environmentId,
        input: {
          marketplaceId: item.marketplaceId,
          itemId: item.id,
          scope: selectedScope,
          ...(selectedScope === "provider" && selectedProviderInstanceId
            ? { providerInstanceId: selectedProviderInstanceId }
            : {}),
        },
      });
      markItemBusy(item.id, false);
      if (result._tag === "Success") {
        discovery.refresh();
        toastManager.add({
          type: "success",
          title: "Extension installed",
          description: `${item.displayName ?? item.name} is available for ${selectedScope}.`,
        });
        return;
      }
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not install extension",
          description: commandErrorMessage(
            result.cause,
            "Review the marketplace source and provider compatibility, then try again.",
          ),
        }),
      );
    },
    [
      discovery,
      environmentId,
      installExtension,
      markItemBusy,
      selectedProviderInstanceId,
      selectedScope,
    ],
  );

  const runUninstall = useCallback(
    async (item: ExtensionCatalogItem, target: ExtensionInstallTarget) => {
      if (environmentId === null) return;
      markItemBusy(item.id, true);
      const result = await uninstallExtension({
        environmentId,
        input: {
          itemId: item.id,
          scope: target.scope,
          ...(target.scope === "provider" && target.providerInstanceId
            ? { providerInstanceId: target.providerInstanceId }
            : {}),
        },
      });
      markItemBusy(item.id, false);
      if (result._tag === "Success") {
        discovery.refresh();
        toastManager.add({
          type: "success",
          title: "Extension removed",
          description: `${item.displayName ?? item.name} was removed from ${target.scope}.`,
        });
        return;
      }
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not remove extension",
          description: commandErrorMessage(
            result.cause,
            "The extension registry could not be updated.",
          ),
        }),
      );
    },
    [discovery, environmentId, markItemBusy, uninstallExtension],
  );

  return (
    <SettingsSection
      title="Discover"
      headerAction={
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                size="icon-xs"
                variant="ghost"
                className="size-5 rounded-sm p-0 text-muted-foreground hover:text-foreground"
                disabled={discovery.isPending}
                onClick={discovery.refresh}
                aria-label="Refresh extension marketplaces"
              >
                <RefreshCwIcon className={cn("size-3", discovery.isPending && "animate-spin")} />
              </Button>
            }
          />
          <TooltipPopup side="top">Refresh marketplaces</TooltipPopup>
        </Tooltip>
      }
    >
      <div className="border-b border-border/60 px-4 py-3 sm:px-5">
        <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_9rem_minmax(10rem,14rem)]">
          <Input
            nativeInput
            type="search"
            value={query}
            onChange={(event) => setQuery(event.currentTarget.value)}
            placeholder="Search skills and plugins"
            className="rounded-lg"
          />
          <Select
            value={selectedScope}
            onValueChange={(value) => {
              if (value === "global" || value === "provider") {
                setSelectedScope(value);
              }
            }}
          >
            <SelectTrigger size="sm" aria-label="Install scope">
              <SelectValue />
            </SelectTrigger>
            <SelectPopup>
              {SCOPE_OPTIONS.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
          <Select
            value={selectedProviderInstanceId ?? ""}
            onValueChange={(value) => setSelectedProviderInstanceId(value as ProviderInstanceId)}
            disabled={selectedScope !== "provider" || providers.length === 0}
          >
            <SelectTrigger size="sm" aria-label="Provider install target">
              <SelectValue placeholder="Select provider" />
            </SelectTrigger>
            <SelectPopup>
              {providers.map((provider) => (
                <SelectItem key={provider.instanceId} value={provider.instanceId}>
                  <ProviderSelectLabel instanceId={provider.instanceId} providers={providers} />
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        </div>
      </div>

      {discovery.error ? (
        <SettingsRow
          title="Could not load marketplaces"
          description={discovery.error}
          control={
            <Button size="sm" variant="outline" onClick={discovery.refresh}>
              Retry
            </Button>
          }
        />
      ) : discovery.isPending && filteredItems.length === 0 ? (
        <SettingsRow
          title={
            <span className="inline-flex items-center gap-2">
              <LoaderIcon className="size-3.5 animate-spin text-muted-foreground" /> Loading
              marketplaces
            </span>
          }
          description="Discovering configured skill and plugin sources."
        />
      ) : filteredItems.length === 0 ? (
        <SettingsRow
          title="No extensions found"
          description="Try a different search or add another marketplace source in settings.json."
        />
      ) : (
        filteredItems.map((item) => (
          <MarketplaceItemCard
            key={item.id}
            item={item}
            selectedScope={selectedScope}
            selectedProviderInstanceId={selectedProviderInstanceId}
            isBusy={busyItemIds.has(item.id)}
            onInstall={runInstall}
            onUninstall={runUninstall}
          />
        ))
      )}
    </SettingsSection>
  );
}

function MarketplaceSourcesSection() {
  const settings = usePrimarySettings((value) => value.extensions);
  return (
    <SettingsSection title="Marketplaces">
      {settings.marketplaces.map((marketplace) => (
        <SettingsRow
          key={marketplace.id}
          title={
            <span className="inline-flex items-center gap-2">
              {marketplace.name}
              {marketplace.trusted ? (
                <Badge variant="success" size="sm">
                  <ShieldCheckIcon className="size-3" /> Trusted
                </Badge>
              ) : null}
            </span>
          }
          description={marketplace.sourceUrl}
          status={`${marketplace.kind} · ${marketplace.enabled ? "Enabled" : "Disabled"}`}
        />
      ))}
    </SettingsSection>
  );
}

function GlobalEnvironmentSection() {
  const globalEnvironment = usePrimarySettings((settings) => settings.globalEnvironment);
  const updateSettings = useUpdatePrimarySettings();
  const updateGlobalEnvironment = useCallback(
    (environment: ReadonlyArray<ProviderInstanceEnvironmentVariable>) => {
      updateSettings({ globalEnvironment: [...environment] });
    },
    [updateSettings],
  );
  return (
    <SettingsSection title="Global .env keys" icon={<KeyRoundIcon className="size-3.5" />}>
      <div className="px-4 py-3 sm:px-5">
        <ProviderEnvironmentSection
          title="Global environment variables"
          environment={globalEnvironment}
          onChange={updateGlobalEnvironment}
          emptyDescription="Add keys inherited by every provider instance. Provider-specific keys with the same name override these values."
          footer="Sensitive global values are stored in SergeCode's server secret store and redacted after saving."
        />
      </div>
    </SettingsSection>
  );
}

export function ExtensionsSettingsPanel() {
  return (
    <SettingsPageContainer className="max-w-5xl">
      <SettingsSection title="Overview" icon={<PackageOpenIcon className="size-3.5" />}>
        <SettingsRow
          title="Native extensions and keys"
          description="Discover Vercel skills and manage global or provider-scoped installs from one place."
          status="Provider-scoped native installs currently target Codex-compatible home layouts; other providers can still receive .env keys."
        />
      </SettingsSection>
      <MarketplaceDiscoverySection />
      <GlobalEnvironmentSection />
      <MarketplaceSourcesSection />
    </SettingsPageContainer>
  );
}
