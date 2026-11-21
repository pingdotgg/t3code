import { useState, type ReactNode } from "react";
import { T, useGT, Var } from "gt-react";
import { BlocksIcon, PackagePlusIcon, PuzzleIcon, RefreshCwIcon, SearchIcon } from "lucide-react";
import type {
  EnvironmentId,
  PluginManifest,
  PluginRegistryEntry,
  PluginStatus,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";

import { pluginEnvironment, usePluginSnapshot } from "../../plugins/state";
import { definePluginFeature } from "../../plugins/features";
import { usePluginClientStatuses } from "../../plugins/PluginHost";
import {
  reloadDesktopPlugins,
  setDesktopPluginEnabled,
  useDesktopPlugins,
} from "../../plugins/desktop";
import { useEnvironment, useEnvironmentHttpBaseUrl } from "../../state/environments";
import {
  approvePlugin,
  pluginTrustOrigin,
  revokePlugin,
  usePluginTrust,
} from "../../plugins/trust";
import { useAtomCommand } from "../../state/use-atom-command";
import { formatEnvironmentQueryError, useEnvironmentQuery } from "../../state/query";
import { useDebouncedValue } from "../../state/queries";
import { Button } from "../ui/button";
import { InputGroup, InputGroupAddon, InputGroupInput } from "../ui/input-group";
import { ToggleGroup, Toggle } from "../ui/toggle-group";
import {
  Dialog,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
  DialogTrigger,
} from "../ui/dialog";
import { Spinner } from "../ui/spinner";
import { ExtensionCard, ExtensionIcon, SourceLinkIcon } from "./ExtensionMarketplace";
import { Switch } from "../ui/switch";
import { useSettingsScope } from "./SettingsScopeContext";
import { SettingsPageContainer } from "./settingsLayout";
import { definePluginComponent } from "~/plugins/features";

const PluginRow = definePluginComponent(
  "component:components/settings/PluginsSettings/PluginRow",
  PluginOriginalPluginRow,
);
const ReviewedPluginRow = definePluginComponent(
  "component:components/settings/PluginsSettings/ReviewedPluginRow",
  PluginOriginalReviewedPluginRow,
);
const EnvironmentPlugins = definePluginComponent(
  "component:components/settings/PluginsSettings/EnvironmentPlugins",
  PluginOriginalEnvironmentPlugins,
);
const DesktopPlugins = definePluginComponent(
  "component:components/settings/PluginsSettings/DesktopPlugins",
  PluginOriginalDesktopPlugins,
);

const PluginSourceLink = definePluginComponent(
  "component:components/settings/PluginsSettings/PluginSourceLink",
  function PluginSourceLink({ manifest }: { manifest: PluginManifest }) {
    const gt = useGT();
    return manifest.sourceUrl ? (
      <Button
        aria-label={gt("View source for {name}", { name: manifest.name })}
        render={<a href={manifest.sourceUrl} rel="noreferrer" target="_blank" />}
        size="icon-micro"
        variant="ghost-muted"
      >
        <SourceLinkIcon url={manifest.sourceUrl} />
      </Button>
    ) : null;
  },
);

const PluginDetails = definePluginComponent(
  "component:components/settings/PluginsSettings/PluginDetails",
  function PluginDetails({
    manifest,
    children,
    needsApproval = false,
  }: {
    manifest: PluginManifest;
    children?: ReactNode;
    needsApproval?: boolean;
  }) {
    const gt = useGT();
    return (
      <Dialog>
        <DialogTrigger
          render={
            <Button
              size="xs"
              variant="ghost-muted"
              aria-label={
                needsApproval
                  ? gt("Review access for {name}", { name: manifest.name })
                  : gt("Details for {name}", { name: manifest.name })
              }
            />
          }
        >
          {needsApproval ? <T>Review access</T> : <T>Details</T>}
        </DialogTrigger>
        <DialogPopup>
          <DialogHeader>
            <DialogTitle>{manifest.name}</DialogTitle>
          </DialogHeader>
          <DialogPanel>
            {manifest.description ? (
              <p className="text-sm text-muted-foreground">{manifest.description}</p>
            ) : null}
            <p className="break-all text-xs text-muted-foreground">
              <T>
                <Var>{manifest.id}</Var> · Version <Var>{manifest.version}</Var>
              </T>
            </p>
            {manifest.sourceUrl ? (
              <Button
                size="sm"
                variant="outline"
                render={<a href={manifest.sourceUrl} rel="noreferrer" target="_blank" />}
              >
                <SourceLinkIcon url={manifest.sourceUrl} /> <T>View source</T>
              </Button>
            ) : null}
            {children}
          </DialogPanel>
        </DialogPopup>
      </Dialog>
    );
  },
);

function PluginOriginalDesktopPlugins() {
  const gt = useGT();
  const desktop = useDesktopPlugins();
  if (!desktop.available) return null;
  return (
    <section className="space-y-3" aria-label={gt("Desktop plugins")}>
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-sm font-medium">
          <T>On this desktop</T>
        </h3>
        <Button
          size="xs"
          variant="ghost"
          disabled={desktop.pending !== null}
          onClick={() => void reloadDesktopPlugins()}
        >
          <T>Refresh</T>
        </Button>
      </div>
      {desktop.error ? (
        <p role="status" className="text-sm text-destructive">
          {desktop.error}
        </p>
      ) : null}
      {!desktop.snapshot && !desktop.error ? (
        <p className="text-sm text-muted-foreground">
          <T>Loading desktop plugins...</T>
        </p>
      ) : null}
      {desktop.snapshot?.plugins.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          <T>No desktop plugins installed.</T>
        </p>
      ) : null}
      <div className="grid gap-2 sm:grid-cols-2">
        {desktop.snapshot?.plugins.map((plugin) => (
          <ExtensionCard
            key={plugin.manifest.id}
            name={plugin.manifest.name}
            description={plugin.manifest.description}
            byline={`${gt("Desktop", { $context: "plugin location" })} · ${
              plugin.error
                ? gt("Error", { $context: "plugin status" })
                : plugin.enabled
                  ? gt("Enabled", { $context: "plugin status" })
                  : gt("Disabled", { $context: "plugin status" })
            }`}
            icon={
              <ExtensionIcon
                iconUrl={plugin.manifest.iconUrl}
                fallback={<PuzzleIcon className="size-4" />}
              />
            }
          >
            <div className="mt-auto flex items-center justify-between gap-2">
              <div className="flex items-center gap-1">
                <PluginSourceLink manifest={plugin.manifest} />
                <PluginDetails manifest={plugin.manifest}>
                  <p className="text-xs text-muted-foreground">
                    <T>Runs on this computer, independently of connected environments.</T>
                  </p>
                  {plugin.error ? <p className="text-sm text-destructive">{plugin.error}</p> : null}
                </PluginDetails>
              </div>
              <div className="flex items-center gap-2">
                <Button
                  size="icon-micro"
                  variant="ghost-muted"
                  disabled={desktop.pending !== null || !plugin.enabled}
                  aria-label={gt("Reload desktop {name}", { name: plugin.manifest.name })}
                  onClick={() => void reloadDesktopPlugins(plugin.manifest.id)}
                >
                  <RefreshCwIcon className="size-3.5" />
                </Button>
                <Switch
                  checked={plugin.enabled}
                  disabled={desktop.pending !== null}
                  aria-label={gt("Enable desktop {name}", { name: plugin.manifest.name })}
                  onCheckedChange={(enabled) =>
                    void setDesktopPluginEnabled(plugin.manifest.id, enabled)
                  }
                />
              </div>
            </div>
          </ExtensionCard>
        ))}
      </div>
    </section>
  );
}

function PluginOriginalPluginRow({
  environmentId,
  plugin,
}: {
  environmentId: EnvironmentId;
  plugin: PluginStatus;
}) {
  const gt = useGT();
  const setEnabled = useAtomCommand(pluginEnvironment.setEnabled);
  const reload = useAtomCommand(pluginEnvironment.reload);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const clientStatus = usePluginClientStatuses(environmentId).get(plugin.manifest.id);
  const httpBaseUrl = useEnvironmentHttpBaseUrl(environmentId);
  const origin = pluginTrustOrigin(httpBaseUrl);
  const trust = usePluginTrust(environmentId, httpBaseUrl, plugin);
  const hasWebCode =
    plugin.source !== "builtin" && Boolean(plugin.manifest.entries?.web || plugin.clientModuleUrl);
  const updateTrust = (action: () => void) => {
    setError(null);
    try {
      action();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };
  const perform = async (action: () => Promise<{ readonly _tag: string }>) => {
    setPending(true);
    setError(null);
    await Promise.resolve()
      .then(action)
      .then((result) => {
        if (result._tag === "Failure") {
          setError(gt("The environment could not update this plugin."));
        }
      })
      .finally(() => setPending(false));
  };
  const failure = error ?? clientStatus?.error ?? plugin.error;
  const status = failure
    ? gt("Error", { $context: "plugin status" })
    : !plugin.enabled
      ? gt("Disabled", { $context: "plugin status" })
      : hasWebCode && !trust.trusted
        ? gt("Needs approval", { $context: "plugin status" })
        : clientStatus?.state === "loading"
          ? gt("Loading", { $context: "plugin status" })
          : gt("Enabled", { $context: "plugin status" });
  const sourceLabel =
    plugin.source === "builtin"
      ? gt("Built-in", { $context: "plugin source" })
      : plugin.source === "registry"
        ? gt("Reviewed", { $context: "plugin source" })
        : gt("Local", { $context: "plugin source" });
  return (
    <ExtensionCard
      name={plugin.manifest.name}
      description={plugin.manifest.description}
      byline={`${sourceLabel} · ${status}`}
      icon={
        <ExtensionIcon
          iconUrl={plugin.manifest.iconUrl}
          fallback={
            plugin.source === "builtin" ? (
              <BlocksIcon className="size-4" />
            ) : (
              <PuzzleIcon className="size-4" />
            )
          }
        />
      }
    >
      {failure ? (
        <p role="status" className="line-clamp-2 text-xs text-destructive">
          {failure}
        </p>
      ) : null}
      <div className="mt-auto flex items-center justify-between gap-2">
        <div className="flex items-center gap-1">
          <PluginSourceLink manifest={plugin.manifest} />
          <PluginDetails manifest={plugin.manifest} needsApproval={hasWebCode && !trust.trusted}>
            {failure ? <p className="break-words text-sm text-destructive">{failure}</p> : null}
            {hasWebCode ? (
              <div className="space-y-3">
                <p className="text-xs text-muted-foreground">
                  {trust.trusted ? (
                    trust.mode === "local-development" ? (
                      <T>Local development is approved on this device, including future edits.</T>
                    ) : (
                      <T>This version is approved on this device.</T>
                    )
                  ) : (
                    <T>Approval applies only to this device.</T>
                  )}
                </p>
                <p className="text-xs text-muted-foreground">
                  <T>
                    Approved web code has full client privileges: it can read conversations and
                    stored credentials, act on any connected environment, and use the desktop
                    bridge.
                  </T>
                </p>
                <details className="text-xs text-muted-foreground">
                  <summary className="cursor-pointer">
                    <T>Package details</T>
                  </summary>
                  <p className="mt-2 break-all">
                    {origin ? (
                      <T>
                        Environment: <Var>{origin}</Var>
                      </T>
                    ) : (
                      <T>Environment: Unavailable</T>
                    )}
                  </p>
                  <p className="mt-2 break-all">
                    {plugin.contentSha256 ? (
                      <T>
                        SHA-256: <Var>{plugin.contentSha256}</Var>
                      </T>
                    ) : (
                      <T>SHA-256: Waiting for a content hash</T>
                    )}
                  </p>
                </details>
                {plugin.source === "local" && plugin.localDevelopmentDirectory ? (
                  <p className="break-all text-xs text-muted-foreground">
                    <T>
                      Trusting local development allows future edits in{" "}
                      <Var>{plugin.localDevelopmentDirectory}</Var> to run automatically on this
                      device.
                    </T>
                  </p>
                ) : null}
                <div className="flex flex-wrap items-center gap-2">
                  {!trust.trusted ? (
                    <Button
                      size="xs"
                      variant="outline"
                      disabled={
                        pending || !origin || !plugin.contentSha256 || !plugin.clientModuleUrl
                      }
                      title={
                        plugin.clientModuleUrl
                          ? undefined
                          : gt("Enable this plugin before approving its compiled version.")
                      }
                      aria-label={gt("Trust this version of {name} on this device", {
                        name: plugin.manifest.name,
                      })}
                      onClick={() =>
                        updateTrust(() =>
                          approvePlugin(environmentId, httpBaseUrl, plugin, "version"),
                        )
                      }
                    >
                      <T>Trust this version</T>
                    </Button>
                  ) : null}
                  {plugin.source === "local" &&
                  plugin.localDevelopmentDirectory &&
                  trust.mode !== "local-development" ? (
                    <Button
                      size="xs"
                      variant="outline"
                      disabled={pending || !origin || !plugin.contentSha256}
                      aria-label={gt("Trust local development of {name} on this device", {
                        name: plugin.manifest.name,
                      })}
                      onClick={() =>
                        updateTrust(() =>
                          approvePlugin(environmentId, httpBaseUrl, plugin, "local-development"),
                        )
                      }
                    >
                      <T>Trust local development</T>
                    </Button>
                  ) : null}
                  {trust.approved ? (
                    <Button
                      size="xs"
                      variant="ghost"
                      aria-label={gt("Revoke trust for {name} on this device", {
                        name: plugin.manifest.name,
                      })}
                      onClick={() =>
                        updateTrust(() => revokePlugin(environmentId, httpBaseUrl, plugin))
                      }
                    >
                      <T>Revoke trust</T>
                    </Button>
                  ) : null}
                </div>
              </div>
            ) : null}
          </PluginDetails>
        </div>
        <div className="flex items-center gap-2">
          <Button
            size="icon-micro"
            variant="ghost-muted"
            disabled={pending || !plugin.enabled}
            aria-label={gt("Reload {name}", { name: plugin.manifest.name })}
            onClick={() =>
              void perform(() => reload({ environmentId, input: { id: plugin.manifest.id } }))
            }
          >
            <RefreshCwIcon className="size-3.5" />
          </Button>
          <Switch
            checked={plugin.enabled}
            disabled={pending}
            aria-label={gt("Enable {name}", { name: plugin.manifest.name })}
            onCheckedChange={(enabled) =>
              void perform(() =>
                setEnabled({ environmentId, input: { id: plugin.manifest.id, enabled } }),
              )
            }
          />
        </div>
      </div>
    </ExtensionCard>
  );
}

function PluginOriginalReviewedPluginRow({
  environmentId,
  entry,
  installed,
}: {
  environmentId: EnvironmentId;
  entry: PluginRegistryEntry;
  installed: boolean;
}) {
  const gt = useGT();
  const install = useAtomCommand(pluginEnvironment.install);
  const [pending, setPending] = useState(false);
  const [installedHere, setInstalledHere] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const present = installed || installedHere;
  return (
    <ExtensionCard
      name={entry.manifest.name}
      description={entry.manifest.description}
      byline={`${entry.publisher.name} · ${gt("Reviewed", { $context: "plugin source" })}`}
      icon={
        <ExtensionIcon
          iconUrl={entry.manifest.iconUrl}
          fallback={<PuzzleIcon className="size-4" />}
        />
      }
    >
      {error ? (
        <p role="status" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
      <div className="mt-auto flex items-center justify-between gap-2">
        <div className="flex items-center gap-1">
          <PluginSourceLink manifest={entry.manifest} />
          <PluginDetails manifest={entry.manifest}>
            <p className="text-xs text-muted-foreground">
              <T>
                Reviewed by <Var>{entry.review.reviewer}</Var> on{" "}
                <Var>{new Date(entry.review.reviewedAt).toLocaleDateString()}</Var>.
              </T>
            </p>
            {entry.review.summary ? (
              <p className="text-sm text-muted-foreground">{entry.review.summary}</p>
            ) : null}
            <p className="text-xs text-muted-foreground">
              <T>Installs disabled. Enable it when you're ready.</T>
            </p>
            <details className="text-xs text-muted-foreground">
              <summary className="cursor-pointer">
                <T>Package details</T>
              </summary>
              <p className="mt-2 break-all">
                <T>
                  SHA-256: <Var>{entry.sha256}</Var>
                </T>
              </p>
            </details>
          </PluginDetails>
        </div>
        <Button
          size="xs"
          variant="outline"
          disabled={pending || present}
          aria-label={gt("Install {name}", { name: entry.manifest.name })}
          onClick={() => {
            setPending(true);
            setError(null);
            void install({ environmentId, input: { id: entry.manifest.id } })
              .then((result) => {
                if (result._tag === "Failure") setError(formatEnvironmentQueryError(result.cause));
                else setInstalledHere(true);
              })
              .finally(() => setPending(false));
          }}
        >
          {pending ? <Spinner /> : <PackagePlusIcon className="size-3.5" />}
          {present ? <T>Installed</T> : pending ? <T>Installing...</T> : <T>Install</T>}
        </Button>
      </div>
    </ExtensionCard>
  );
}

function PluginOriginalEnvironmentPlugins({ environmentId }: { environmentId: EnvironmentId }) {
  const gt = useGT();
  const result = usePluginSnapshot(environmentId);
  const snapshot = Option.getOrNull(AsyncResult.value(result));
  const reload = useAtomCommand(pluginEnvironment.reload);
  const [query, setQuery] = useState("");
  const [view, setView] = useState("installed");
  const catalogQuery = useDebouncedValue(query.trim(), 200);
  const catalog = useEnvironmentQuery(
    pluginEnvironment.catalog({ environmentId, input: { query: catalogQuery } }),
  );
  const [refreshing, setRefreshing] = useState(false);
  const search = query.trim().toLowerCase();
  const plugins = (snapshot?.plugins ?? []).filter((plugin) =>
    [plugin.manifest.id, plugin.manifest.name, plugin.manifest.description ?? ""].some((text) =>
      text.toLowerCase().includes(search),
    ),
  );
  const local = plugins.filter((plugin) => plugin.source !== "builtin");
  const builtin = plugins.filter((plugin) => plugin.source === "builtin");
  const visible = view === "builtin" ? builtin : local;
  return (
    <section className="space-y-4" aria-label={gt("Plugins")}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-lg font-semibold">
          <T>Plugins</T>
        </h2>
        <div className="flex items-center gap-2">
          <Dialog>
            <DialogTrigger render={<Button size="xs" variant="ghost-muted" />}>
              <T>Add local plugin</T>
            </DialogTrigger>
            <DialogPopup>
              <DialogHeader>
                <DialogTitle>
                  <T>Add a local plugin</T>
                </DialogTitle>
              </DialogHeader>
              <DialogPanel>
                <p className="text-sm text-muted-foreground">
                  <T>
                    Place a plugin directory with plugin.json in this environment's userdata/plugins
                    folder, then refresh this page.
                  </T>
                </p>
                <p className="text-sm text-muted-foreground">
                  <T>
                    Enable it here and review access on each device. Local development approval lets
                    saved edits reload automatically.
                  </T>
                </p>
              </DialogPanel>
            </DialogPopup>
          </Dialog>
          <Button
            size="xs"
            variant="outline"
            disabled={refreshing}
            onClick={() => {
              setRefreshing(true);
              catalog.refresh();
              void reload({ environmentId, input: {} }).finally(() => setRefreshing(false));
            }}
          >
            {refreshing ? <Spinner /> : <RefreshCwIcon className="size-3.5" />} <T>Refresh</T>
          </Button>
        </div>
      </div>
      <InputGroup>
        <InputGroupAddon>
          <SearchIcon className="size-4" />
        </InputGroupAddon>
        <InputGroupInput
          aria-label={gt("Search plugins")}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={gt("Search plugins...")}
        />
      </InputGroup>
      <ToggleGroup
        value={[view]}
        onValueChange={(values) => {
          if (values[0]) setView(values[0]);
        }}
        aria-label={gt("Plugin library")}
      >
        <Toggle value="installed">
          <T>Installed</T>
        </Toggle>
        <Toggle value="browse">
          <T>Browse</T>
        </Toggle>
        <Toggle value="builtin">
          <T>Built-in</T>
        </Toggle>
      </ToggleGroup>
      {view === "browse" ? (
        <>
          <p className="text-xs text-muted-foreground">
            <T>Reviewed plugins for this environment. Install, then enable when you're ready.</T>
          </p>
          {catalog.error ? (
            <p role="status" className="text-sm text-destructive">
              {catalog.error}
            </p>
          ) : null}
          {catalog.isPending && !catalog.data ? (
            <p className="text-sm text-muted-foreground">
              <T>Loading plugins...</T>
            </p>
          ) : null}
          {catalog.data?.entries.length === 0 ? (
            <div className="rounded-xl border border-dashed p-8 text-center text-sm text-muted-foreground">
              {catalogQuery ? (
                <T>No matching plugins. Try another search.</T>
              ) : (
                <T>No reviewed plugins available yet.</T>
              )}
            </div>
          ) : null}
          <div className="grid gap-2 sm:grid-cols-2">
            {catalog.data?.entries.map((entry) => (
              <ReviewedPluginRow
                key={entry.manifest.id}
                environmentId={environmentId}
                entry={entry}
                installed={
                  snapshot?.plugins.some((plugin) => plugin.manifest.id === entry.manifest.id) ??
                  false
                }
              />
            ))}
          </div>
        </>
      ) : (
        <>
          {result._tag === "Failure" ? (
            <p role="status" className="text-sm text-destructive">
              <T>Connect to an environment with plugin support.</T>
            </p>
          ) : null}
          {!snapshot && result._tag !== "Failure" ? (
            <p className="text-sm text-muted-foreground">
              <T>Loading plugins...</T>
            </p>
          ) : null}
          {snapshot && visible.length === 0 ? (
            <div className="rounded-xl border border-dashed p-8 text-center text-sm text-muted-foreground">
              {query ? (
                <T>No matching plugins. Try another search.</T>
              ) : (
                <T>No plugins installed yet.</T>
              )}
            </div>
          ) : null}
          <div className="grid gap-2 sm:grid-cols-2">
            {visible.map((plugin) => (
              <PluginRow key={plugin.manifest.id} environmentId={environmentId} plugin={plugin} />
            ))}
          </div>
        </>
      )}
    </section>
  );
}

export function BuiltinPluginsSettingsPanel() {
  const { scope } = useSettingsScope();
  const environmentId = scope.environmentIds[0];
  const environment = useEnvironment(environmentId ?? null);
  return (
    <SettingsPageContainer>
      {environmentId && environment?.serverConfig?.environment.capabilities.plugins === true ? (
        <EnvironmentPlugins key={environmentId} environmentId={environmentId} />
      ) : (
        <p className="text-sm text-muted-foreground">
          {environmentId ? (
            <T>Connect or update this environment to manage plugins.</T>
          ) : (
            <T>Choose an environment to manage its plugins.</T>
          )}
        </p>
      )}
      <DesktopPlugins />
    </SettingsPageContainer>
  );
}

export const PluginsSettingsPanel = definePluginFeature(
  "settings.plugins",
  BuiltinPluginsSettingsPanel,
);
