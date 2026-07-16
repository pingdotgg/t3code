import {
  AlertTriangleIcon,
  BoxIcon,
  DatabaseIcon,
  DownloadIcon,
  PlugIcon,
  RefreshCwIcon,
  RotateCcwIcon,
  ShieldCheckIcon,
  Trash2Icon,
} from "lucide-react";
import { useAtomValue } from "@effect/atom-react";
import type {
  MarketplaceEntry,
  MarketplaceVersion,
  PluginCatalogInput,
  PluginCatalogResult,
  PluginCheckUpdatesResult,
  PluginId,
  PluginInfo,
  PluginInstallBeginInput,
  PluginInstallConfirmInput,
  PluginInstallConfirmResult,
  PluginInstallStaged,
  PluginSetEnabledInput,
  PluginSource,
  PluginSourcesAddInput,
  PluginSourcesAddResult,
  PluginSourcesListResult,
  PluginSourcesRemoveInput,
  PluginUninstallInput,
  PluginUpdateInfo,
  PluginUpgradeBeginInput,
  PluginUpgradeConfirmInput,
} from "@t3tools/contracts";
import type { AtomCommandResult } from "@t3tools/client-runtime/state/runtime";
import { AsyncResult } from "effect/unstable/reactivity";
import { type FormEvent, useCallback, useEffect, useMemo, useState } from "react";

import {
  abortPluginInstallCommand,
  addPluginSourceCommand,
  beginPluginInstallCommand,
  beginPluginUpgradeCommand,
  checkPluginUpdatesCommand,
  confirmPluginInstallCommand,
  confirmPluginUpgradeCommand,
  getPluginCatalogCommand,
  listPluginSourcesCommand,
  pluginListAtom,
  removePluginSourceCommand,
  setPluginEnabledCommand,
  uninstallPluginCommand,
} from "~/state/plugins";
import { pluginUiRegistryAtom } from "~/plugins/PluginUiHost";
import { useAtomCommand } from "~/state/use-atom-command";
import { Alert, AlertDescription, AlertTitle } from "../../ui/alert";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../../ui/alert-dialog";
import { Badge } from "../../ui/badge";
import { Button } from "../../ui/button";
import { Checkbox } from "../../ui/checkbox";
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../../ui/dialog";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../../ui/empty";
import { Input } from "../../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../../ui/select";
import { Spinner } from "../../ui/spinner";
import { Switch } from "../../ui/switch";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "../settingsLayout";
import {
  ALL_PLUGIN_SOURCES_VALUE,
  abortPluginInstallConsentFlow,
  addPluginSourceFlow,
  beginPluginInstallConsentFlow,
  commandFailureMessage,
  confirmPluginInstallConsentFlow,
  effectiveInstallSourceId,
  latestMarketplaceVersion,
  pluginRequiresRelaunch,
  pluginStateBadgeVariant,
  pluginStateLabel,
  removePluginSourceFlow,
} from "./PluginsSettings.logic";

type InstallIntent = "install" | "upgrade";

interface StagedPluginAction {
  readonly intent: InstallIntent;
  readonly staged: PluginInstallStaged;
  readonly entryName: string;
}

interface UninstallTarget {
  readonly plugin: PluginInfo;
  readonly removeData: boolean;
}

interface PluginSettingsCommands {
  readonly listSources: (
    input: void,
  ) => Promise<AtomCommandResult<PluginSourcesListResult, unknown>>;
  readonly addSource: (
    input: PluginSourcesAddInput,
  ) => Promise<AtomCommandResult<PluginSourcesAddResult, unknown>>;
  readonly removeSource: (
    input: PluginSourcesRemoveInput,
  ) => Promise<AtomCommandResult<{}, unknown>>;
  readonly catalog: (
    input: PluginCatalogInput | void,
  ) => Promise<AtomCommandResult<PluginCatalogResult, unknown>>;
  readonly beginInstall: (
    input: PluginInstallBeginInput,
  ) => Promise<AtomCommandResult<PluginInstallStaged, unknown>>;
  readonly confirmInstall: (
    input: PluginInstallConfirmInput,
  ) => Promise<AtomCommandResult<PluginInstallConfirmResult, unknown>>;
  readonly abortInstall: (
    input: PluginInstallConfirmInput,
  ) => Promise<AtomCommandResult<{}, unknown>>;
  readonly setEnabled: (input: PluginSetEnabledInput) => Promise<AtomCommandResult<{}, unknown>>;
  readonly uninstall: (input: PluginUninstallInput) => Promise<AtomCommandResult<{}, unknown>>;
  readonly beginUpgrade: (
    input: PluginUpgradeBeginInput,
  ) => Promise<AtomCommandResult<PluginInstallStaged, unknown>>;
  readonly confirmUpgrade: (
    input: PluginUpgradeConfirmInput,
  ) => Promise<AtomCommandResult<PluginInstallConfirmResult, unknown>>;
  readonly checkUpdates: (
    input: void,
  ) => Promise<AtomCommandResult<PluginCheckUpdatesResult, unknown>>;
}

function usePluginSettingsCommands(): PluginSettingsCommands {
  const listSources = useAtomCommand(listPluginSourcesCommand, { reportFailure: false });
  const addSource = useAtomCommand(addPluginSourceCommand, { reportFailure: false });
  const removeSource = useAtomCommand(removePluginSourceCommand, { reportFailure: false });
  const catalog = useAtomCommand(getPluginCatalogCommand, { reportFailure: false });
  const beginInstall = useAtomCommand(beginPluginInstallCommand, { reportFailure: false });
  const confirmInstall = useAtomCommand(confirmPluginInstallCommand, { reportFailure: false });
  const abortInstall = useAtomCommand(abortPluginInstallCommand, { reportFailure: false });
  const setEnabled = useAtomCommand(setPluginEnabledCommand, { reportFailure: false });
  const uninstall = useAtomCommand(uninstallPluginCommand, { reportFailure: false });
  const beginUpgrade = useAtomCommand(beginPluginUpgradeCommand, { reportFailure: false });
  const confirmUpgrade = useAtomCommand(confirmPluginUpgradeCommand, { reportFailure: false });
  const checkUpdates = useAtomCommand(checkPluginUpdatesCommand, { reportFailure: false });

  return useMemo<PluginSettingsCommands>(
    () => ({
      listSources,
      addSource,
      removeSource,
      catalog,
      beginInstall,
      confirmInstall,
      abortInstall,
      setEnabled,
      uninstall,
      beginUpgrade,
      confirmUpgrade,
      checkUpdates,
    }),
    [
      abortInstall,
      addSource,
      beginInstall,
      beginUpgrade,
      catalog,
      checkUpdates,
      confirmInstall,
      confirmUpgrade,
      listSources,
      removeSource,
      setEnabled,
      uninstall,
    ],
  );
}

function updateMapFromResult(result: PluginCheckUpdatesResult): Map<PluginId, PluginUpdateInfo> {
  return new Map(result.updates.map((update) => [update.pluginId, update]));
}

function capabilityLabel(capability: string): string {
  switch (capability) {
    case "agents":
      return "Agents";
    case "vcs":
      return "VCS";
    case "terminals":
      return "Terminals";
    case "database":
      return "Database";
    case "projections.read":
      return "Projections read";
    case "environments.read":
      return "Environments read";
    case "secrets":
      return "Secrets";
    case "http":
      return "HTTP";
    case "sourceControl":
      return "Source control";
    case "textGeneration":
      return "Text generation";
    default:
      return capability;
  }
}

function CapabilityBadges({ capabilities }: { readonly capabilities: ReadonlyArray<string> }) {
  if (capabilities.length === 0) {
    return <span className="text-xs text-muted-foreground">No declared capabilities</span>;
  }

  return (
    <div className="flex flex-wrap gap-1.5">
      {capabilities.map((capability) => (
        <Badge key={capability} size="sm" variant="outline">
          {capabilityLabel(capability)}
        </Badge>
      ))}
    </div>
  );
}

function SectionError({ message }: { readonly message: string | null }) {
  if (!message) return null;
  return (
    <Alert className="mb-3" variant="error">
      <AlertTriangleIcon />
      <AlertTitle>Plugin operation failed</AlertTitle>
      <AlertDescription>{message}</AlertDescription>
    </Alert>
  );
}

function RelaunchBanner({ state }: { readonly state: PluginInfo["state"] }) {
  return (
    <Alert className="mt-3" variant="warning">
      <RotateCcwIcon />
      <AlertTitle>Relaunch to apply</AlertTitle>
      <AlertDescription>
        This plugin is {pluginStateLabel(state).toLowerCase()}; restart the app to finish applying
        the change.
      </AlertDescription>
    </Alert>
  );
}

function InstalledPluginRow({
  plugin,
  update,
  busy,
  onToggleEnabled,
  onCheckUpdates,
  onBeginUpgrade,
  onRequestUninstall,
}: {
  readonly plugin: PluginInfo;
  readonly update: PluginUpdateInfo | undefined;
  readonly busy: boolean;
  readonly onToggleEnabled: (plugin: PluginInfo, enabled: boolean) => void;
  readonly onCheckUpdates: () => void;
  readonly onBeginUpgrade: (plugin: PluginInfo, version: string) => void;
  readonly onRequestUninstall: (plugin: PluginInfo) => void;
}) {
  // Client-side web load/register failure for this plugin. The server can report a
  // plugin "active" (its server-side activation succeeded) while its web bundle 404s
  // or its register() throws in the browser — leaving none of its UI present with no
  // visible reason. Surface that here so "active but no UI" is explained, not silent.
  const webFailure = useAtomValue(pluginUiRegistryAtom).failures[plugin.id];
  const checked = plugin.state === "active" || plugin.state === "pending-upgrade";
  // "failed" is toggleable ON: the server's setEnabled(true) resets state and
  // crashCount, which is the whole point of the repair flow (fix settings on the
  // still-reachable page, then re-enable to retry activation). Without this the
  // failed plugin's toggle is dead and the fix can never be applied.
  const canToggle =
    plugin.state === "active" || plugin.state === "disabled" || plugin.state === "failed";
  const stateBadge = (
    <Badge size="sm" variant={pluginStateBadgeVariant(plugin.state)}>
      {pluginStateLabel(plugin.state)}
    </Badge>
  );

  return (
    <SettingsRow
      title={
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate">{plugin.name}</span>
          {stateBadge}
        </span>
      }
      description={`${plugin.id} · ${plugin.version}`}
      status={<CapabilityBadges capabilities={plugin.capabilities} />}
      control={
        <div className="flex flex-wrap items-center justify-end gap-2">
          <Switch
            aria-label={`${checked ? "Disable" : "Enable"} ${plugin.name}`}
            checked={checked}
            disabled={!canToggle || busy}
            onCheckedChange={(enabled) => onToggleEnabled(plugin, enabled)}
          />
          <Button size="xs" variant="outline" disabled={busy} onClick={onCheckUpdates}>
            <RefreshCwIcon />
            Check
          </Button>
          {update ? (
            <Button
              size="xs"
              variant="outline"
              disabled={busy}
              onClick={() => onBeginUpgrade(plugin, update.latestVersion)}
            >
              <DownloadIcon />
              Upgrade {update.latestVersion}
            </Button>
          ) : null}
          <Button
            size="icon-xs"
            variant="destructive-outline"
            aria-label={`Uninstall ${plugin.name}`}
            disabled={busy}
            onClick={() => onRequestUninstall(plugin)}
          >
            <Trash2Icon />
          </Button>
        </div>
      }
    >
      {plugin.lastError ? (
        <Alert className="mt-3" variant="error">
          <AlertTriangleIcon />
          <AlertTitle>Activation failed</AlertTitle>
          <AlertDescription>{plugin.lastError}</AlertDescription>
        </Alert>
      ) : null}
      {webFailure !== undefined ? (
        <Alert className="mt-3" variant="error">
          <AlertTriangleIcon />
          <AlertTitle>Web UI failed to load</AlertTitle>
          <AlertDescription>{webFailure}</AlertDescription>
        </Alert>
      ) : null}
      {pluginRequiresRelaunch(plugin) ? <RelaunchBanner state={plugin.state} /> : null}
    </SettingsRow>
  );
}

export function InstalledPluginsSection({
  plugins,
  updates,
  busy,
  error,
  onToggleEnabled,
  onCheckUpdates,
  onBeginUpgrade,
  onRequestUninstall,
}: {
  readonly plugins: ReadonlyArray<PluginInfo>;
  readonly updates: ReadonlyMap<PluginId, PluginUpdateInfo>;
  readonly busy: boolean;
  readonly error: string | null;
  readonly onToggleEnabled: (plugin: PluginInfo, enabled: boolean) => void;
  readonly onCheckUpdates: () => void;
  readonly onBeginUpgrade: (plugin: PluginInfo, version: string) => void;
  readonly onRequestUninstall: (plugin: PluginInfo) => void;
}) {
  return (
    <SettingsSection
      title="Installed"
      icon={<PlugIcon className="size-3.5" />}
      headerAction={
        <Button size="xs" variant="ghost" disabled={busy} onClick={onCheckUpdates}>
          <RefreshCwIcon />
          Check updates
        </Button>
      }
    >
      <div className="p-3 pb-0">
        <SectionError message={error} />
      </div>
      {plugins.length === 0 ? (
        <Empty className="min-h-44">
          <EmptyMedia variant="icon">
            <PlugIcon />
          </EmptyMedia>
          <EmptyHeader>
            <EmptyTitle>No plugins installed</EmptyTitle>
            <EmptyDescription>Installed plugins will appear here.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        plugins.map((plugin) => (
          <InstalledPluginRow
            key={plugin.id}
            plugin={plugin}
            update={updates.get(plugin.id)}
            busy={busy}
            onToggleEnabled={onToggleEnabled}
            onCheckUpdates={onCheckUpdates}
            onBeginUpgrade={onBeginUpgrade}
            onRequestUninstall={onRequestUninstall}
          />
        ))
      )}
    </SettingsSection>
  );
}

function SourcesSection({
  sources,
  selectedSourceId,
  addUrl,
  busy,
  error,
  onAddUrlChange,
  onSelectedSourceChange,
  onAddSource,
  onRemoveSource,
}: {
  readonly sources: ReadonlyArray<PluginSource>;
  readonly selectedSourceId: string;
  readonly addUrl: string;
  readonly busy: boolean;
  readonly error: string | null;
  readonly onAddUrlChange: (value: string) => void;
  readonly onSelectedSourceChange: (value: string) => void;
  readonly onAddSource: () => void;
  readonly onRemoveSource: (sourceId: string) => void;
}) {
  const submit = (event: FormEvent) => {
    event.preventDefault();
    onAddSource();
  };

  return (
    <SettingsSection title="Sources" icon={<DatabaseIcon className="size-3.5" />}>
      <div className="space-y-3 p-4 sm:p-5">
        <SectionError message={error} />
        <form className="flex flex-col gap-2 sm:flex-row" onSubmit={submit}>
          <Input
            aria-label="Plugin source URL"
            nativeInput
            placeholder="https://example.com/marketplace.json"
            value={addUrl}
            onChange={(event) => onAddUrlChange(event.currentTarget.value)}
          />
          <Button type="submit" disabled={busy || addUrl.trim().length === 0}>
            {busy ? <Spinner /> : <DownloadIcon />}
            Add source
          </Button>
        </form>
        <div className="grid gap-2">
          <Select
            value={selectedSourceId}
            onValueChange={(value) => {
              if (value !== null) {
                onSelectedSourceChange(value);
              }
            }}
          >
            <SelectTrigger size="sm" aria-label="Browse source">
              <SelectValue placeholder="All sources" />
            </SelectTrigger>
            <SelectPopup>
              <SelectItem value={ALL_PLUGIN_SOURCES_VALUE}>All sources</SelectItem>
              {sources.map((source) => (
                <SelectItem key={source.id} value={source.id}>
                  {source.url}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
          {sources.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              No marketplace sources have been added for this environment.
            </p>
          ) : (
            <div className="divide-y rounded-lg border">
              {sources.map((source) => (
                <div
                  key={source.id}
                  className="flex min-w-0 flex-col gap-2 p-3 sm:flex-row sm:items-center sm:justify-between"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">{source.url}</p>
                    <p className="text-xs text-muted-foreground">{source.id}</p>
                  </div>
                  <Button
                    size="xs"
                    variant="destructive-outline"
                    disabled={busy}
                    onClick={() => onRemoveSource(source.id)}
                  >
                    <Trash2Icon />
                    Remove
                  </Button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </SettingsSection>
  );
}

function CatalogEntryRow({
  entry,
  version,
  sourceReady,
  busy,
  onInstall,
}: {
  readonly entry: MarketplaceEntry;
  readonly version: MarketplaceVersion | null;
  readonly sourceReady: boolean;
  readonly busy: boolean;
  readonly onInstall: (entry: MarketplaceEntry, version: MarketplaceVersion) => void;
}) {
  return (
    <SettingsRow
      title={
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate">{entry.name}</span>
          {version ? (
            <Badge size="sm" variant="outline">
              {version.version}
            </Badge>
          ) : null}
        </span>
      }
      description={entry.description || entry.id}
      status={
        <div className="space-y-1.5">
          {entry.author ? (
            <p>
              By{" "}
              {entry.author.url ? (
                <a href={entry.author.url} rel="noreferrer">
                  {entry.author.name}
                </a>
              ) : (
                entry.author.name
              )}
            </p>
          ) : null}
          <CapabilityBadges capabilities={entry.capabilities} />
        </div>
      }
      control={
        <Button
          size="xs"
          disabled={busy || !sourceReady || version === null}
          onClick={() => {
            if (version) onInstall(entry, version);
          }}
        >
          <ShieldCheckIcon />
          Install
        </Button>
      }
    />
  );
}

function BrowseSection({
  catalogEntries,
  catalogErrors,
  sourceReady,
  busy,
  error,
  onRefreshCatalog,
  onInstall,
}: {
  readonly catalogEntries: ReadonlyArray<MarketplaceEntry>;
  readonly catalogErrors: ReadonlyArray<string>;
  readonly sourceReady: boolean;
  readonly busy: boolean;
  readonly error: string | null;
  readonly onRefreshCatalog: () => void;
  readonly onInstall: (entry: MarketplaceEntry, version: MarketplaceVersion) => void;
}) {
  return (
    <SettingsSection
      title="Browse"
      icon={<BoxIcon className="size-3.5" />}
      headerAction={
        <Button size="xs" variant="ghost" disabled={busy} onClick={onRefreshCatalog}>
          <RefreshCwIcon />
          Refresh
        </Button>
      }
    >
      <div className="p-3 pb-0">
        <SectionError message={error} />
        {!sourceReady ? (
          <Alert className="mb-3" variant="info">
            <DatabaseIcon />
            <AlertTitle>Select one source to install</AlertTitle>
            <AlertDescription>
              All sources can be browsed together, but installing requires a concrete source.
            </AlertDescription>
          </Alert>
        ) : null}
        {catalogErrors.map((message) => (
          <Alert key={message} className="mb-3" variant="warning">
            <AlertTriangleIcon />
            <AlertTitle>Source could not be loaded</AlertTitle>
            <AlertDescription>{message}</AlertDescription>
          </Alert>
        ))}
      </div>
      {catalogEntries.length === 0 ? (
        <Empty className="min-h-44">
          <EmptyMedia variant="icon">
            <BoxIcon />
          </EmptyMedia>
          <EmptyHeader>
            <EmptyTitle>No catalog entries</EmptyTitle>
            <EmptyDescription>Add a source or refresh the selected source.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        catalogEntries.map((entry) => (
          <CatalogEntryRow
            key={entry.id}
            entry={entry}
            version={latestMarketplaceVersion(entry.versions)}
            sourceReady={sourceReady}
            busy={busy}
            onInstall={onInstall}
          />
        ))
      )}
    </SettingsSection>
  );
}

function ConsentDialog({
  stagedAction,
  busy,
  error,
  onConfirm,
  onCancel,
}: {
  readonly stagedAction: StagedPluginAction | null;
  readonly busy: boolean;
  readonly error: string | null;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
}) {
  const capabilityDescriptions = stagedAction
    ? Object.entries(stagedAction.staged.capabilityDescriptions)
    : [];
  const actionLabel = stagedAction?.intent === "upgrade" ? "Upgrade" : "Install";

  return (
    <Dialog open={stagedAction !== null} onOpenChange={(open) => !open && onCancel()}>
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>
            {actionLabel} {stagedAction?.entryName ?? "plugin"}
          </DialogTitle>
          <DialogDescription>
            Review the capabilities this plugin requests before continuing.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-3">
          <SectionError message={error} />
          {capabilityDescriptions.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              This plugin does not request host capabilities.
            </p>
          ) : (
            <div className="space-y-2">
              {capabilityDescriptions.map(([capability, description]) => (
                <div key={capability} className="rounded-lg border p-3">
                  <p className="text-sm font-medium">{capabilityLabel(capability)}</p>
                  <p className="mt-1 text-xs text-muted-foreground">{description}</p>
                </div>
              ))}
            </div>
          )}
        </DialogPanel>
        <DialogFooter>
          <DialogClose render={<Button variant="outline" disabled={busy} />}>Cancel</DialogClose>
          <Button disabled={busy} onClick={onConfirm}>
            {busy ? <Spinner /> : <ShieldCheckIcon />}
            {actionLabel}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

function UninstallDialog({
  target,
  busy,
  onRemoveDataChange,
  onConfirm,
  onCancel,
}: {
  readonly target: UninstallTarget | null;
  readonly busy: boolean;
  readonly onRemoveDataChange: (removeData: boolean) => void;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
}) {
  return (
    <AlertDialog open={target !== null} onOpenChange={(open) => !open && onCancel()}>
      <AlertDialogPopup>
        <AlertDialogHeader>
          <AlertDialogTitle>Uninstall {target?.plugin.name ?? "plugin"}?</AlertDialogTitle>
          <AlertDialogDescription>
            The plugin will be removed on the next app restart.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div className="px-6 pb-4">
          <label className="flex items-center gap-2 text-sm">
            <Checkbox
              checked={target?.removeData ?? false}
              onCheckedChange={(checked) => onRemoveDataChange(checked === true)}
            />
            Remove plugin data
          </label>
        </div>
        <AlertDialogFooter>
          <AlertDialogClose render={<Button variant="outline" disabled={busy} />}>
            Cancel
          </AlertDialogClose>
          <Button variant="destructive" disabled={busy} onClick={onConfirm}>
            {busy ? <Spinner /> : <Trash2Icon />}
            Uninstall
          </Button>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
}

export function PluginsSettingsPanel() {
  const installedPlugins = useAtomValue(pluginListAtom);
  const commands = usePluginSettingsCommands();
  const [sources, setSources] = useState<ReadonlyArray<PluginSource>>([]);
  const [selectedSourceId, setSelectedSourceId] = useState(ALL_PLUGIN_SOURCES_VALUE);
  const [addUrl, setAddUrl] = useState("");
  const [catalogEntries, setCatalogEntries] = useState<ReadonlyArray<MarketplaceEntry>>([]);
  const [catalogErrors, setCatalogErrors] = useState<ReadonlyArray<string>>([]);
  const [updates, setUpdates] = useState<ReadonlyMap<PluginId, PluginUpdateInfo>>(() => new Map());
  const [stagedAction, setStagedAction] = useState<StagedPluginAction | null>(null);
  const [uninstallTarget, setUninstallTarget] = useState<UninstallTarget | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [installedError, setInstalledError] = useState<string | null>(null);
  const [sourcesError, setSourcesError] = useState<string | null>(null);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [consentError, setConsentError] = useState<string | null>(null);

  const installSourceId = useMemo(
    () => effectiveInstallSourceId(selectedSourceId, sources),
    [selectedSourceId, sources],
  );

  const refreshSources = useCallback(async () => {
    setBusyKey("sources");
    const result = await commands.listSources(undefined);
    setBusyKey(null);
    const failure = commandFailureMessage(result, "Could not load plugin sources.");
    if (failure) {
      setSourcesError(failure);
      return;
    }
    if (AsyncResult.isSuccess(result)) {
      setSources(result.value.sources);
      setSourcesError(null);
      if (
        selectedSourceId !== ALL_PLUGIN_SOURCES_VALUE &&
        !result.value.sources.some((source) => source.id === selectedSourceId)
      ) {
        setSelectedSourceId(ALL_PLUGIN_SOURCES_VALUE);
      }
    }
  }, [commands, selectedSourceId]);

  const refreshCatalog = useCallback(async () => {
    setBusyKey("catalog");
    const result = await commands.catalog(
      selectedSourceId === ALL_PLUGIN_SOURCES_VALUE ? undefined : { sourceId: selectedSourceId },
    );
    setBusyKey(null);
    const failure = commandFailureMessage(result, "Could not load the plugin catalog.");
    if (failure) {
      setCatalogError(failure);
      return;
    }
    if (AsyncResult.isSuccess(result)) {
      setCatalogEntries(result.value.entries);
      setCatalogErrors(result.value.errors.map((error) => `${error.url}: ${error.message}`));
      setCatalogError(null);
    }
  }, [commands, selectedSourceId]);

  const checkUpdates = useCallback(async () => {
    setBusyKey("updates");
    const result = await commands.checkUpdates(undefined);
    setBusyKey(null);
    const failure = commandFailureMessage(result, "Could not check plugin updates.");
    if (failure) {
      setInstalledError(failure);
      return;
    }
    if (AsyncResult.isSuccess(result)) {
      setUpdates(updateMapFromResult(result.value));
      setInstalledError(null);
    }
  }, [commands]);

  useEffect(() => {
    void refreshSources();
  }, [refreshSources]);

  useEffect(() => {
    void refreshCatalog();
  }, [refreshCatalog]);

  const addSource = useCallback(async () => {
    const url = addUrl.trim();
    if (!url) return;
    setBusyKey("sources");
    const result = await addPluginSourceFlow(commands, url);
    setBusyKey(null);
    if (!result.ok) {
      setSourcesError(result.error);
      return;
    }
    setAddUrl("");
    setSelectedSourceId(result.value.source.id);
    setSourcesError(null);
    await refreshSources();
  }, [addUrl, commands, refreshSources]);

  const removeSource = useCallback(
    async (sourceId: string) => {
      setBusyKey("sources");
      const result = await removePluginSourceFlow(commands, sourceId);
      setBusyKey(null);
      if (!result.ok) {
        setSourcesError(result.error);
        return;
      }
      setSourcesError(null);
      await refreshSources();
      await refreshCatalog();
    },
    [commands, refreshCatalog, refreshSources],
  );

  const toggleEnabled = useCallback(
    async (plugin: PluginInfo, enabled: boolean) => {
      setBusyKey(plugin.id);
      const result = await commands.setEnabled({ pluginId: plugin.id, enabled });
      setBusyKey(null);
      const failure = commandFailureMessage(result, "Could not update plugin enabled state.");
      setInstalledError(failure);
    },
    [commands],
  );

  const beginInstall = useCallback(
    async (entry: MarketplaceEntry, version: MarketplaceVersion) => {
      if (!installSourceId) {
        setCatalogError("Choose a concrete source before installing this plugin.");
        return;
      }
      const input: PluginInstallBeginInput = {
        sourceId: installSourceId,
        pluginId: entry.id,
        version: version.version,
      };
      setBusyKey(entry.id);
      const result = await beginPluginInstallConsentFlow(commands, input);
      setBusyKey(null);
      if (!result.ok) {
        setCatalogError(result.error);
        return;
      }
      setCatalogError(null);
      setConsentError(null);
      setStagedAction({ intent: "install", staged: result.value, entryName: entry.name });
    },
    [commands, installSourceId],
  );

  const beginUpgrade = useCallback(
    async (plugin: PluginInfo, version: string) => {
      setBusyKey(plugin.id);
      const result = await commands.beginUpgrade({ pluginId: plugin.id, version });
      setBusyKey(null);
      const failure = commandFailureMessage(result, "Could not stage plugin upgrade.");
      if (failure) {
        setInstalledError(failure);
        return;
      }
      if (AsyncResult.isSuccess(result)) {
        setInstalledError(null);
        setConsentError(null);
        setStagedAction({ intent: "upgrade", staged: result.value, entryName: plugin.name });
      }
    },
    [commands],
  );

  const cancelStaged = useCallback(async () => {
    const staged = stagedAction;
    setStagedAction(null);
    setConsentError(null);
    if (!staged) return;
    if (staged.intent === "install") {
      await abortPluginInstallConsentFlow(commands, { stageToken: staged.staged.stageToken });
      return;
    }
    await commands.abortInstall({ stageToken: staged.staged.stageToken });
  }, [commands, stagedAction]);

  const confirmStaged = useCallback(async () => {
    const staged = stagedAction;
    if (!staged) return;
    setBusyKey("consent");
    if (staged.intent === "install") {
      const result = await confirmPluginInstallConsentFlow(commands, {
        stageToken: staged.staged.stageToken,
      });
      setBusyKey(null);
      if (!result.ok) {
        setConsentError(result.error);
        return;
      }
      setStagedAction(null);
      setConsentError(null);
      void checkUpdates();
      return;
    }

    const result = await commands.confirmUpgrade({ stageToken: staged.staged.stageToken });
    setBusyKey(null);
    const failure = commandFailureMessage(result, "Could not upgrade plugin.");
    if (failure) {
      setConsentError(failure);
      return;
    }
    setStagedAction(null);
    setConsentError(null);
    void checkUpdates();
  }, [checkUpdates, commands, stagedAction]);

  const confirmUninstall = useCallback(async () => {
    const target = uninstallTarget;
    if (!target) return;
    setBusyKey(target.plugin.id);
    const result = await commands.uninstall({
      pluginId: target.plugin.id,
      removeData: target.removeData,
    });
    setBusyKey(null);
    const failure = commandFailureMessage(result, "Could not uninstall plugin.");
    if (failure) {
      setInstalledError(failure);
      return;
    }
    setInstalledError(null);
    setUninstallTarget(null);
  }, [commands, uninstallTarget]);

  const isBusy = busyKey !== null;

  return (
    <SettingsPageContainer>
      <InstalledPluginsSection
        plugins={installedPlugins}
        updates={updates}
        busy={isBusy}
        error={installedError}
        onToggleEnabled={(plugin, enabled) => void toggleEnabled(plugin, enabled)}
        onCheckUpdates={() => void checkUpdates()}
        onBeginUpgrade={(plugin, version) => void beginUpgrade(plugin, version)}
        onRequestUninstall={(plugin) => setUninstallTarget({ plugin, removeData: false })}
      />

      <SourcesSection
        sources={sources}
        selectedSourceId={selectedSourceId}
        addUrl={addUrl}
        busy={isBusy}
        error={sourcesError}
        onAddUrlChange={setAddUrl}
        onSelectedSourceChange={setSelectedSourceId}
        onAddSource={() => void addSource()}
        onRemoveSource={(sourceId) => void removeSource(sourceId)}
      />

      <BrowseSection
        catalogEntries={catalogEntries}
        catalogErrors={catalogErrors}
        sourceReady={installSourceId !== null}
        busy={isBusy}
        error={catalogError}
        onRefreshCatalog={() => void refreshCatalog()}
        onInstall={(entry, version) => void beginInstall(entry, version)}
      />

      <ConsentDialog
        stagedAction={stagedAction}
        busy={busyKey === "consent"}
        error={consentError}
        onConfirm={() => void confirmStaged()}
        onCancel={() => void cancelStaged()}
      />

      <UninstallDialog
        target={uninstallTarget}
        busy={isBusy}
        onRemoveDataChange={(removeData) =>
          setUninstallTarget((current) => (current ? { ...current, removeData } : current))
        }
        onConfirm={() => void confirmUninstall()}
        onCancel={() => setUninstallTarget(null)}
      />
    </SettingsPageContainer>
  );
}
