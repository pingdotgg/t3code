import { useAtomValue } from "@effect/atom-react";
import { PLUGIN_SOURCE_PLUGINS_DIR, PluginId, type PluginSource } from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  FolderOpenIcon,
  GitBranchIcon,
  PlugIcon,
  PlusIcon,
  RefreshCwIcon,
  Trash2Icon,
} from "lucide-react";
import { useState, type FormEvent } from "react";

import { pluginEnvironment, primaryPluginCatalogResultAtom } from "../../state/plugins";
import { usePrimaryEnvironment, usePrimaryEnvironmentId } from "../../state/environments";
import { useAtomCommand } from "../../state/use-atom-command";
import { readLocalApi } from "../../localApi";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Badge } from "../ui/badge";
import { Input } from "../ui/input";
import { Switch } from "../ui/switch";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

/**
 * Mirrors the contract's `PluginSourceGitUrl` rule so the submit button only enables for
 * remotes the server will accept; the leading scheme also keeps a URL from parsing as a
 * git CLI option.
 */
const PLUGIN_SOURCE_GIT_URL_PATTERN = /^(?:https:\/\/|ssh:\/\/|git@)[^\s]+$/;

function isPluginSourceGitUrl(value: string): boolean {
  const trimmed = value.trim();
  return trimmed.length <= 512 && PLUGIN_SOURCE_GIT_URL_PATTERN.test(trimmed);
}

function slugify(value: string): string {
  return (
    value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .slice(0, 64)
      // Trim after slicing: a cut that lands on a word boundary would otherwise
      // reintroduce a trailing hyphen and fail this dialog's own validation.
      .replace(/^-+|-+$/g, "")
  );
}

function CreatePluginDialog({
  open,
  onOpenChange,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const environmentId = usePrimaryEnvironmentId();
  const createPlugin = useAtomCommand(pluginEnvironment.create, { reportFailure: false });
  const [name, setName] = useState("");
  const [id, setId] = useState("");
  const [description, setDescription] = useState("");
  const [idEdited, setIdEdited] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!environmentId) return;
    if (!name.trim()) {
      setError("Enter a plugin name.");
      return;
    }
    if (!id || slugify(id) !== id) {
      setError("Use lowercase letters, numbers, and hyphens for the plugin ID.");
      return;
    }
    setSaving(true);
    setError(null);
    const result = await createPlugin({
      environmentId,
      input: {
        id: PluginId.make(id),
        name: name.trim(),
        ...(description.trim() ? { description: description.trim() } : {}),
      },
    });
    setSaving(false);
    if (result._tag === "Failure") {
      const cause = squashAtomCommandFailure(result);
      setError(cause instanceof Error ? cause.message : "Could not create the plugin.");
      return;
    }
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup>
        <form onSubmit={(event) => void submit(event)}>
          <DialogHeader>
            <DialogTitle>Create plugin</DialogTitle>
            <DialogDescription>
              Creates a Raycast-style plugin package on this environment with a manifest, starter
              command, TSX source, and local SDK.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel className="space-y-4">
            <label className="block space-y-1.5">
              <span className="text-sm font-medium">Name</span>
              <Input
                autoFocus
                nativeInput
                value={name}
                placeholder="Deploy tools"
                onChange={(event) => {
                  const nextName = event.currentTarget.value;
                  setName(nextName);
                  if (!idEdited) setId(slugify(nextName));
                }}
              />
            </label>
            <label className="block space-y-1.5">
              <span className="text-sm font-medium">Plugin ID</span>
              <Input
                nativeInput
                value={id}
                placeholder="deploy-tools"
                onChange={(event) => {
                  setIdEdited(true);
                  setId(event.currentTarget.value);
                }}
              />
            </label>
            <label className="block space-y-1.5">
              <span className="text-sm font-medium">Description</span>
              <Input
                nativeInput
                value={description}
                placeholder="Internal deployment commands"
                onChange={(event) => setDescription(event.currentTarget.value)}
              />
            </label>
            {error ? <p className="text-xs text-destructive">{error}</p> : null}
          </DialogPanel>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={saving || !environmentId}>
              {saving ? "Creating…" : "Create plugin"}
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}

function AddPluginSourceDialog({
  open,
  onOpenChange,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const environmentId = usePrimaryEnvironmentId();
  const addSource = useAtomCommand(pluginEnvironment.addSource, { reportFailure: false });
  const [gitUrl, setGitUrl] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const trimmedUrl = gitUrl.trim();
  const urlValid = isPluginSourceGitUrl(gitUrl);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!environmentId) return;
    if (!urlValid) {
      setError("Enter an https://, ssh://, or git@ repository URL.");
      return;
    }
    setSaving(true);
    setError(null);
    const result = await addSource({ environmentId, input: { gitUrl: trimmedUrl } });
    setSaving(false);
    if (result._tag === "Failure") {
      const cause = squashAtomCommandFailure(result);
      setError(cause instanceof Error ? cause.message : "Could not add the plugin source.");
      return;
    }
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup>
        <form onSubmit={(event) => void submit(event)}>
          <DialogHeader>
            <DialogTitle>Add plugin source</DialogTitle>
            <DialogDescription>
              Clones a git repository onto this environment and installs every plugin it ships from{" "}
              <code>{`${PLUGIN_SOURCE_PLUGINS_DIR}/<plugin-id>/`}</code>. Plugin backends run
              locally with this environment's permissions, so only add repositories you trust.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel className="space-y-4">
            <label className="block space-y-1.5">
              <span className="text-sm font-medium">Repository URL</span>
              <Input
                autoFocus
                nativeInput
                value={gitUrl}
                placeholder="https://github.com/acme/t3-plugins.git"
                onChange={(event) => setGitUrl(event.currentTarget.value)}
              />
            </label>
            {trimmedUrl && !urlValid ? (
              <p className="text-xs text-muted-foreground">
                Use an <code>https://</code>, <code>ssh://</code>, or <code>git@</code> repository
                URL.
              </p>
            ) : null}
            {error ? <p className="text-xs text-destructive">{error}</p> : null}
          </DialogPanel>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={saving || !environmentId || !urlValid}>
              {saving ? "Adding…" : "Add source"}
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}

export function PluginSettingsPanel() {
  const environmentId = usePrimaryEnvironmentId();
  const primaryEnvironment = usePrimaryEnvironment();
  const pluginsSupported =
    primaryEnvironment?.serverConfig?.environment.capabilities.plugins === true;
  const catalogResult = useAtomValue(primaryPluginCatalogResultAtom);
  const setEnabled = useAtomCommand(pluginEnvironment.setEnabled, { reportFailure: false });
  const deletePlugin = useAtomCommand(pluginEnvironment.delete);
  const updateSource = useAtomCommand(pluginEnvironment.updateSource);
  const removeSource = useAtomCommand(pluginEnvironment.removeSource);
  const [createOpen, setCreateOpen] = useState(false);
  const [addSourceOpen, setAddSourceOpen] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [pendingSourceId, setPendingSourceId] = useState<string | null>(null);
  const catalog = catalogResult._tag === "Success" ? catalogResult.value : null;

  const requestDelete = async (plugin: NonNullable<typeof catalog>["plugins"][number]) => {
    if (!environmentId) return;
    const api = readLocalApi();
    const confirmed = api
      ? await api.dialogs.confirm(
          [
            `Delete plugin "${plugin.name}"?`,
            `ID: ${plugin.id}`,
            "This permanently removes the plugin package from this environment.",
          ].join("\n"),
          { variant: "destructive" },
        )
      : false;
    if (!confirmed) return;
    setDeletingId(plugin.id);
    await deletePlugin({ environmentId, input: { pluginId: plugin.id } });
    setDeletingId(null);
  };

  const requestUpdateSource = async (source: PluginSource) => {
    if (!environmentId) return;
    setPendingSourceId(source.id);
    await updateSource({ environmentId, input: { sourceId: source.id } });
    setPendingSourceId(null);
  };

  const requestRemoveSource = async (source: PluginSource) => {
    if (!environmentId) return;
    const api = readLocalApi();
    const confirmed = api
      ? await api.dialogs.confirm(
          [
            `Remove plugin source "${source.id}"?`,
            `Repository: ${source.gitUrl}`,
            `This uninstalls ${source.pluginIds.length} plugin${
              source.pluginIds.length === 1 ? "" : "s"
            } and deletes the cloned repository from this environment.`,
          ].join("\n"),
          { variant: "destructive" },
        )
      : false;
    if (!confirmed) return;
    setPendingSourceId(source.id);
    await removeSource({ environmentId, input: { sourceId: source.id } });
    setPendingSourceId(null);
  };

  const reload = () => {
    if (!environmentId || !pluginsSupported) return;
    appAtomRegistry.refresh(pluginEnvironment.catalog({ environmentId, input: {} }));
  };

  return (
    <SettingsPageContainer>
      <SettingsSection
        {...searchableSetting("plugins")}
        title="Plugins"
        icon={<PlugIcon className="size-4.5" />}
        headerAction={
          <div className="flex items-center gap-1">
            <Button
              size="icon-xs"
              variant="ghost"
              aria-label="Reload plugins"
              disabled={!pluginsSupported}
              onClick={reload}
            >
              <RefreshCwIcon />
            </Button>
            <Button size="xs" disabled={!pluginsSupported} onClick={() => setCreateOpen(true)}>
              <PlusIcon />
              Create
            </Button>
          </div>
        }
      >
        {!pluginsSupported ? (
          <SettingsRow
            title="Plugins require a newer server"
            description="Update this environment's T3 server to create and run plugins."
          />
        ) : catalogResult._tag === "Initial" ? (
          <SettingsRow title="Loading plugins…" description="Reading this environment's catalog." />
        ) : catalogResult._tag === "Failure" ? (
          <SettingsRow
            title="Could not load plugins"
            description="Reload the catalog or inspect the environment server logs."
          />
        ) : catalog && catalog.plugins.length > 0 ? (
          catalog.plugins.map((plugin) => (
            <SettingsRow
              key={plugin.id}
              title={
                <span className="flex min-w-0 items-center gap-1.5">
                  <span className="truncate">{plugin.name}</span>
                  {plugin.sourceId ? (
                    <Tooltip>
                      <TooltipTrigger
                        render={
                          <Badge
                            size="sm"
                            variant="outline"
                            className="font-normal text-muted-foreground"
                          >
                            {plugin.sourceId}
                          </Badge>
                        }
                      />
                      <TooltipPopup side="top" className="max-w-64">
                        {`Provided by the "${plugin.sourceId}" source. Remove that source below to uninstall this plugin.`}
                      </TooltipPopup>
                    </Tooltip>
                  ) : null}
                </span>
              }
              description={`${plugin.commands.length} page${plugin.commands.length === 1 ? "" : "s"} · ${plugin.id}`}
              control={
                <div className="flex items-center gap-1.5">
                  <Switch
                    checked={plugin.enabled}
                    aria-label={`${plugin.enabled ? "Disable" : "Enable"} ${plugin.name}`}
                    onCheckedChange={(enabled) => {
                      if (!environmentId) return;
                      void setEnabled({
                        environmentId,
                        input: { pluginId: plugin.id, enabled },
                      });
                    }}
                  />
                  {/* Source-provided plugins are removed by removing their source; the server
                      refuses the per-plugin delete, so the button is not offered. */}
                  {plugin.sourceId ? null : (
                    <Button
                      size="icon-xs"
                      variant="ghost"
                      aria-label={`Delete ${plugin.name}`}
                      className="text-muted-foreground hover:text-destructive"
                      disabled={deletingId === plugin.id}
                      onClick={() => void requestDelete(plugin)}
                    >
                      <Trash2Icon />
                    </Button>
                  )}
                </div>
              }
            />
          ))
        ) : (
          <SettingsRow
            title="No plugins installed"
            description="Create a starter here, add a shared source below, or drop a package with t3-plugin.json into the plugins directory."
          />
        )}
        {catalog?.issues.map((issue) => (
          <SettingsRow
            key={issue.directory}
            title={`Could not load ${issue.directory}`}
            description={issue.message}
          />
        ))}
        {catalog?.pluginsDirectory ? (
          <SettingsRow
            title="Plugins directory"
            description={catalog.pluginsDirectory}
            control={<FolderOpenIcon className="size-4 text-muted-foreground" />}
          />
        ) : null}
      </SettingsSection>

      <SettingsSection
        id="plugin-sources"
        title="Sources"
        icon={<GitBranchIcon className="size-4.5" />}
        headerAction={
          <Button size="xs" disabled={!pluginsSupported} onClick={() => setAddSourceOpen(true)}>
            <PlusIcon />
            Add source
          </Button>
        }
      >
        {!pluginsSupported ? (
          <SettingsRow
            title="Sources require a newer server"
            description="Update this environment's T3 server to install plugins from a git repository."
          />
        ) : catalog && catalog.sources.length > 0 ? (
          catalog.sources.map((source) => (
            <SettingsRow
              key={source.id}
              title={source.id}
              description={
                <span className="block space-y-0.5">
                  <span className="block truncate">{source.gitUrl}</span>
                  <span className="block">
                    {`Provides ${source.pluginIds.length} plugin${
                      source.pluginIds.length === 1 ? "" : "s"
                    }`}
                    {source.pluginIds.length > 0 ? ` · ${source.pluginIds.join(", ")}` : ""}
                  </span>
                </span>
              }
              status={
                source.issue ? (
                  <span className="text-warning-foreground">{source.issue}</span>
                ) : undefined
              }
              control={
                <div className="flex items-center gap-1.5">
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={pendingSourceId === source.id}
                    onClick={() => void requestUpdateSource(source)}
                  >
                    <RefreshCwIcon />
                    {pendingSourceId === source.id ? "Working…" : "Update"}
                  </Button>
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    aria-label={`Remove source ${source.id}`}
                    className="text-muted-foreground hover:text-destructive"
                    disabled={pendingSourceId === source.id}
                    onClick={() => void requestRemoveSource(source)}
                  >
                    <Trash2Icon />
                  </Button>
                </div>
              }
            />
          ))
        ) : catalogResult._tag === "Initial" ? (
          <SettingsRow title="Loading sources…" description="Reading this environment's catalog." />
        ) : catalogResult._tag === "Failure" ? (
          <SettingsRow
            title="Could not load sources"
            description="Reload the catalog or inspect the environment server logs."
          />
        ) : (
          <SettingsRow
            title="No sources added"
            description={`Add a git repository that ships plugins in ${PLUGIN_SOURCE_PLUGINS_DIR}/<plugin-id>/ to install them on this environment. Only add repositories you trust: plugin backends run locally with this environment's permissions.`}
          />
        )}
      </SettingsSection>

      {createOpen ? <CreatePluginDialog open onOpenChange={setCreateOpen} /> : null}
      {addSourceOpen ? <AddPluginSourceDialog open onOpenChange={setAddSourceOpen} /> : null}
    </SettingsPageContainer>
  );
}
