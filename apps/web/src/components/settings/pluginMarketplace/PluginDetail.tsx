import { Link, useCanGoBack, useNavigate } from "@tanstack/react-router";
import {
  AppWindowIcon,
  ArrowLeftIcon,
  BotIcon,
  BookOpenIcon,
  ChevronDownIcon,
  CommandIcon,
  ExternalLinkIcon,
  FileCodeIcon,
  KeyRoundIcon,
  PackageOpenIcon,
  RefreshCwIcon,
  ServerIcon,
  ShieldCheckIcon,
  SparklesIcon,
  WebhookIcon,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import type {
  PluginMarketplaceApp,
  PluginMarketplaceDetail,
  PluginMarketplaceExtension,
  PluginMarketplaceInstallTarget,
  PluginMarketplaceMcpServer,
  PluginMarketplaceMcpAuthConnection,
  PluginMarketplaceMcpAuthState,
  PluginMarketplaceSetupAction,
  PluginMarketplaceSkill,
} from "@t3tools/contracts";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "~/components/ui/collapsible";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "~/components/ui/empty";
import { Skeleton } from "~/components/ui/skeleton";
import { Input } from "~/components/ui/input";
import { Switch } from "~/components/ui/switch";
import { toastManager } from "~/components/ui/toast";
import { readLocalApi } from "~/localApi";
import { usePrimaryEnvironment } from "~/state/environments";
import {
  completePluginMcpAuth,
  disconnectPluginMcpAuth,
  fetchPluginMcpAuth,
  openPluginSetup,
  startPluginMcpAuth,
} from "~/pluginMarketplace/api";
import {
  MARKETPLACE_HARNESS_LABELS,
  marketplacePluginIncludeLabels,
} from "~/pluginMarketplace/catalog";
import {
  pluginMarketplaceErrorMessage,
  usePluginMarketplaceStore,
} from "~/pluginMarketplace/store";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "../settingsLayout";
import { HarnessIcon, HarnessSupportBadges, PluginLogo } from "./PluginMarketplacePresentation";

function LoadingPlugin() {
  return (
    <SettingsPageContainer className="max-w-4xl gap-10">
      <Skeleton className="h-8 w-24" />
      <div className="flex items-start gap-4">
        <Skeleton className="size-16 rounded-2xl" />
        <div className="flex-1 space-y-3">
          <Skeleton className="h-8 w-56" />
          <Skeleton className="h-4 w-3/4" />
        </div>
      </div>
      <Skeleton className="h-36 w-full rounded-xl" />
    </SettingsPageContainer>
  );
}

function MissingPlugin({
  error,
  onRetry,
}: {
  readonly error: string | null;
  readonly onRetry: () => void;
}) {
  return (
    <SettingsPageContainer>
      <Empty className="min-h-80 border border-dashed border-foreground/10">
        <EmptyMedia variant="icon">
          <PackageOpenIcon />
        </EmptyMedia>
        <EmptyHeader>
          <EmptyTitle>Plugin unavailable</EmptyTitle>
          <EmptyDescription>{error ?? "This Codex plugin could not be loaded."}</EmptyDescription>
        </EmptyHeader>
        <EmptyContent className="flex-row flex-wrap justify-center gap-2">
          <Button size="sm" variant="outline" render={<Link to="/settings/plugins" replace />}>
            <ArrowLeftIcon />
            Back to plugins
          </Button>
          <Button size="sm" variant="outline" onClick={onRetry}>
            <RefreshCwIcon />
            Try again
          </Button>
        </EmptyContent>
      </Empty>
    </SettingsPageContainer>
  );
}

function targetContents(target: PluginMarketplaceInstallTarget): string {
  const contents = [
    target.contents.mcpServerCount > 0
      ? `${target.contents.mcpServerCount} MCP ${target.contents.mcpServerCount === 1 ? "server" : "servers"}`
      : null,
    target.contents.skillCount > 0
      ? `${target.contents.skillCount} ${target.contents.skillCount === 1 ? "skill" : "skills"}`
      : null,
    target.contents.appCount > 0
      ? `${target.contents.appCount} ${target.contents.appCount === 1 ? "app" : "apps"}`
      : null,
    target.contents.commandCount > 0
      ? `${target.contents.commandCount} ${target.contents.commandCount === 1 ? "command" : "commands"}`
      : null,
    target.contents.agentCount > 0
      ? `${target.contents.agentCount} ${target.contents.agentCount === 1 ? "subagent" : "subagents"}`
      : null,
    target.contents.ruleCount > 0
      ? `${target.contents.ruleCount} ${target.contents.ruleCount === 1 ? "rule" : "rules"}`
      : null,
    target.contents.hookCount > 0
      ? `${target.contents.hookCount} ${target.contents.hookCount === 1 ? "hook" : "hooks"}`
      : null,
  ].filter((content): content is string => content !== null);
  return contents.length > 0 ? contents.join(" · ") : "Inventory available after installation";
}

function packageFormat(target: PluginMarketplaceInstallTarget): string {
  return target.harness === "codex"
    ? "Universal plugin bundle"
    : target.harness === "claude"
      ? "Claude Code package"
      : target.harness === "cursor"
        ? "Cursor editor plugin"
        : "Plugin package";
}

function InstallTargetRow({
  plugin,
  target,
}: {
  readonly plugin: PluginMarketplaceDetail;
  readonly target: PluginMarketplaceInstallTarget;
}) {
  const pending = usePluginMarketplaceStore((state) => state.pending[target.pluginId] === true);
  const setInstalled = usePluginMarketplaceStore((state) => state.setInstalled);
  const harnessName = MARKETPLACE_HARNESS_LABELS[target.harness];
  const externalHost = externalMarketplaceLabel(target, harnessName);
  const changeInstallation = (installed: boolean) => {
    void setInstalled(target.pluginId, installed)
      .then(() =>
        toastManager.add({
          type: "success",
          title: installed
            ? `${plugin.name} installed on ${harnessName}`
            : `${plugin.name} removed from ${harnessName}`,
          description: `Start a new ${harnessName} chat to load the updated plugin set.`,
        }),
      )
      .catch((error: unknown) =>
        toastManager.add({ type: "error", title: pluginMarketplaceErrorMessage(error) }),
      );
  };

  return (
    <SettingsRow
      className="rounded-none"
      title={
        <span className="flex items-center gap-2">
          <HarnessIcon harness={target.harness} className="size-4 shrink-0" />
          <span>{harnessName}</span>
        </span>
      }
      description={`${packageFormat(target)} · ${target.marketplaceName} · ${target.version}`}
      status={
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className={target.installed ? "text-success-foreground" : undefined}>
            {target.installPolicy === "EXTERNAL"
              ? `Managed in ${externalMarketplaceLabel(target, harnessName)}`
              : pending
                ? target.installed
                  ? "Removing…"
                  : "Installing…"
                : target.installed
                  ? target.enabled
                    ? "Installed and enabled · Ready in new chats"
                    : "Installed but disabled"
                  : "Not installed"}
          </span>
          <span>{targetContents(target)}</span>
          {target.pluginId === plugin.id ? (
            <span>Showing these package details</span>
          ) : (
            <Link
              to="/settings/plugins/$pluginId"
              params={{ pluginId: target.pluginId }}
              className="font-medium text-foreground underline-offset-4 hover:underline"
            >
              View package contents
            </Link>
          )}
        </div>
      }
      control={
        target.installPolicy === "EXTERNAL" ? (
          target.marketplaceUrl ? (
            <Button
              size="sm"
              variant="outline"
              render={<a href={target.marketplaceUrl} target="_blank" rel="noreferrer" />}
            >
              <ExternalLinkIcon />
              Open in {externalHost}
            </Button>
          ) : (
            <span className="text-muted-foreground text-sm">External</span>
          )
        ) : (
          <Switch
            aria-label={`${target.installed ? "Remove" : "Install"} ${plugin.name} ${target.installed ? "from" : "on"} ${harnessName}`}
            checked={target.installed}
            disabled={pending || target.installPolicy !== "AVAILABLE"}
            onCheckedChange={(checked) => changeInstallation(Boolean(checked))}
          />
        )
      }
    />
  );
}

function externalMarketplaceLabel(
  target: Pick<PluginMarketplaceInstallTarget, "marketplaceName" | "marketplaceUrl">,
  harnessName: string,
) {
  return target.marketplaceName === "ChatGPT Public" ||
    target.marketplaceUrl?.includes("chatgpt.com/plugins")
    ? "ChatGPT"
    : harnessName;
}

function InstallationSettings({ plugin }: { readonly plugin: PluginMarketplaceDetail }) {
  const manageable = plugin.installTargets.filter((target) => target.installPolicy === "AVAILABLE");
  const hasCursorTarget = plugin.installTargets.some((target) => target.harness === "cursor");
  const hasChatGptPublicTarget = plugin.installTargets.some(
    (target) => target.marketplaceName === "ChatGPT Public",
  );
  const managementDescription =
    manageable.length === 1
      ? `${MARKETPLACE_HARNESS_LABELS[manageable[0]!.harness]} is managed here.`
      : "This package is managed by its provider.";

  return (
    <SettingsSection title="Installation">
      <div className="divide-y divide-foreground/8 overflow-hidden rounded-xl border border-foreground/8 bg-card/24 dark:bg-card/40">
        {plugin.installTargets.map((target) => (
          <InstallTargetRow key={target.pluginId} plugin={plugin} target={target} />
        ))}
      </div>
      <p className="px-3 text-pretty text-base/7 text-muted-foreground sm:px-4 sm:text-sm/5">
        {managementDescription}{" "}
        {hasCursorTarget
          ? "Cursor keeps its own installation and opens its official plugin flow. "
          : null}
        {hasChatGptPublicTarget
          ? "ChatGPT Public listings open the ChatGPT plugin directory for install. "
          : null}
        Provider capabilities are fixed when a chat starts, so start a new chat after changing an
        installation.
      </p>
    </SettingsSection>
  );
}

function mcpAuthConnectionKey(connection: {
  readonly harness: PluginMarketplaceMcpAuthConnection["harness"];
  readonly serverId: string;
}): string {
  return `${connection.harness}:${connection.serverId}`;
}

function McpAuthStatusBadge({
  connection,
}: {
  readonly connection: PluginMarketplaceMcpAuthConnection;
}) {
  const [label, variant] =
    connection.status === "connected"
      ? (["Connected", "success"] as const)
      : connection.status === "not_connected"
        ? (["Sign in required", "warning"] as const)
        : connection.status === "connecting"
          ? (["Waiting for sign-in", "info"] as const)
          : connection.status === "failed"
            ? (["Sign-in failed", "error"] as const)
            : connection.status === "external"
              ? (["Managed externally", "secondary"] as const)
              : connection.status === "unsupported"
                ? (["No OAuth required", "secondary"] as const)
                : (["Unavailable", "secondary"] as const);
  return (
    <Badge size="sm" variant={variant} role="status" aria-live="polite">
      {label}
    </Badge>
  );
}

function McpAuthentication({ plugin }: { readonly plugin: PluginMarketplaceDetail }) {
  const [authState, setAuthState] = useState<PluginMarketplaceMcpAuthState | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadingAuth, setLoadingAuth] = useState(false);
  const [pendingKeys, setPendingKeys] = useState<ReadonlySet<string>>(() => new Set());
  const [authorizationUrls, setAuthorizationUrls] = useState<Readonly<Record<string, string>>>({});
  const [callbackUrls, setCallbackUrls] = useState<Readonly<Record<string, string>>>({});
  const requestGeneration = useRef(0);
  const installedMcpTargetKey = plugin.installTargets
    .filter((target) => target.installed && target.contents.mcpServerCount > 0)
    .map((target) => target.pluginId)
    .toSorted()
    .join("\u0000");
  const hasInstalledMcp = installedMcpTargetKey.length > 0;
  const loadAuth = useCallback(async () => {
    const generation = ++requestGeneration.current;
    if (!hasInstalledMcp) {
      setAuthState(null);
      setLoadError(null);
      setLoadingAuth(false);
      return;
    }
    setLoadingAuth(true);
    try {
      const state = await fetchPluginMcpAuth(plugin.id);
      if (requestGeneration.current !== generation) return;
      setAuthState(state);
      setLoadError(null);
    } catch (error) {
      if (requestGeneration.current !== generation) return;
      setLoadError(pluginMarketplaceErrorMessage(error));
    } finally {
      if (requestGeneration.current === generation) setLoadingAuth(false);
    }
  }, [hasInstalledMcp, plugin.id]);

  useEffect(() => {
    requestGeneration.current += 1;
    setAuthState(null);
    setLoadError(null);
    setLoadingAuth(false);
    setPendingKeys(new Set());
    setAuthorizationUrls({});
    setCallbackUrls({});
    void loadAuth();
    return () => {
      requestGeneration.current += 1;
    };
  }, [installedMcpTargetKey, loadAuth, plugin.id]);

  const hasPendingConnection = authState?.connections.some(
    (connection) => connection.status === "connecting",
  );
  useEffect(() => {
    if (!hasPendingConnection) return;
    let cancelled = false;
    let timer: number | undefined;
    const poll = async () => {
      await loadAuth();
      if (!cancelled) timer = window.setTimeout(() => void poll(), 2_000);
    };
    timer = window.setTimeout(() => void poll(), 2_000);
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [hasPendingConnection, loadAuth]);

  if (!hasInstalledMcp) return null;
  if (authState && authState.connections.length === 0 && !loadError) return null;

  const openAuthorizationUrl = async (url: string) => {
    const localApi = readLocalApi();
    if (localApi) await localApi.shell.openExternal(url);
  };
  const setConnectionPending = (key: string, pending: boolean) => {
    setPendingKeys((current) => {
      const next = new Set(current);
      if (pending) next.add(key);
      else next.delete(key);
      return next;
    });
  };
  const startConnection = (connection: PluginMarketplaceMcpAuthConnection) => {
    const key = mcpAuthConnectionKey(connection);
    const reservedWindow = window.desktopBridge ? null : window.open("about:blank", "_blank");
    if (reservedWindow) reservedWindow.opener = null;
    setConnectionPending(key, true);
    void startPluginMcpAuth(plugin.id, connection.harness, connection.serverId)
      .then(async (result) => {
        if (result.authorizationUrl) {
          setAuthorizationUrls((current) => ({ ...current, [key]: result.authorizationUrl! }));
          if (reservedWindow) {
            reservedWindow.location.href = result.authorizationUrl;
          } else if (window.desktopBridge) {
            await openAuthorizationUrl(result.authorizationUrl);
          }
        } else {
          reservedWindow?.close();
        }
        toastManager.add({
          type: "success",
          title:
            reservedWindow || window.desktopBridge ? "Continue in your browser" : "Sign-in ready",
          description: result.callbackRequired
            ? "If the callback cannot reach this environment, paste its full URL below."
            : reservedWindow || window.desktopBridge
              ? "Return here after the provider finishes authentication."
              : "Select Open sign-in to continue.",
        });
        await loadAuth();
      })
      .catch((error: unknown) => {
        reservedWindow?.close();
        toastManager.add({ type: "error", title: pluginMarketplaceErrorMessage(error) });
      })
      .finally(() => setConnectionPending(key, false));
  };
  const completeConnection = (connection: PluginMarketplaceMcpAuthConnection) => {
    const key = mcpAuthConnectionKey(connection);
    const callbackUrl = callbackUrls[key]?.trim();
    if (!callbackUrl) return;
    setConnectionPending(key, true);
    void completePluginMcpAuth(plugin.id, connection.harness, connection.serverId, callbackUrl)
      .then(async () => {
        setCallbackUrls((current) => ({ ...current, [key]: "" }));
        toastManager.add({ type: "success", title: "Callback sent to the provider" });
        await loadAuth();
      })
      .catch((error: unknown) =>
        toastManager.add({ type: "error", title: pluginMarketplaceErrorMessage(error) }),
      )
      .finally(() => setConnectionPending(key, false));
  };
  const disconnectConnection = (connection: PluginMarketplaceMcpAuthConnection) => {
    const key = mcpAuthConnectionKey(connection);
    setConnectionPending(key, true);
    void disconnectPluginMcpAuth(plugin.id, connection.harness, connection.serverId)
      .then(async () => {
        setAuthorizationUrls((current) => {
          const next = { ...current };
          delete next[key];
          return next;
        });
        toastManager.add({ type: "success", title: `${connection.serverName} disconnected` });
        await loadAuth();
      })
      .catch((error: unknown) =>
        toastManager.add({ type: "error", title: pluginMarketplaceErrorMessage(error) }),
      )
      .finally(() => setConnectionPending(key, false));
  };

  return (
    <SettingsSection
      title="MCP authentication"
      icon={<KeyRoundIcon className="size-4 text-muted-foreground" />}
    >
      <div className="divide-y divide-foreground/8 overflow-hidden rounded-xl border border-foreground/8 bg-card/24 dark:bg-card/40">
        {authState?.connections.map((connection) => {
          const key = mcpAuthConnectionKey(connection);
          const busy = pendingKeys.has(key);
          const authorizationUrl =
            authorizationUrls[key] ?? connection.authorizationUrl ?? undefined;
          const showCallback = connection.callbackRequired && connection.status === "connecting";
          const control =
            connection.status === "external" ? (
              connection.marketplaceUrl ? (
                <Button
                  size="sm"
                  variant="outline"
                  render={<a href={connection.marketplaceUrl} target="_blank" rel="noreferrer" />}
                >
                  <ExternalLinkIcon />
                  Open in Cursor
                </Button>
              ) : null
            ) : connection.canConnect || connection.status === "failed" ? (
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => startConnection(connection)}
              >
                <KeyRoundIcon />
                {busy ? "Starting…" : "Connect"}
              </Button>
            ) : connection.status === "connecting" ? (
              <div className="flex flex-wrap justify-end gap-2">
                {authorizationUrl ? (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy}
                    onClick={() =>
                      void openAuthorizationUrl(authorizationUrl).catch((error: unknown) =>
                        toastManager.add({
                          type: "error",
                          title: pluginMarketplaceErrorMessage(error),
                        }),
                      )
                    }
                  >
                    <ExternalLinkIcon />
                    Reopen sign-in
                  </Button>
                ) : null}
                {connection.canDisconnect ? (
                  <Button
                    size="sm"
                    variant="ghost-muted"
                    disabled={busy}
                    onClick={() => disconnectConnection(connection)}
                  >
                    Cancel
                  </Button>
                ) : null}
              </div>
            ) : connection.canDisconnect ? (
              <Button
                size="sm"
                variant="ghost-muted"
                disabled={busy}
                onClick={() => disconnectConnection(connection)}
              >
                {busy ? "Disconnecting…" : "Disconnect"}
              </Button>
            ) : null;
          return (
            <SettingsRow
              key={key}
              className="rounded-none"
              title={
                <span className="flex items-center gap-2">
                  <HarnessIcon harness={connection.harness} className="size-4 shrink-0" />
                  <span>{connection.serverName}</span>
                  <McpAuthStatusBadge connection={connection} />
                </span>
              }
              description={connection.endpoint ?? connection.detail ?? "Remote MCP server"}
              status={connection.endpoint && connection.detail ? connection.detail : undefined}
              control={control}
            >
              {showCallback ? (
                <div className="mt-3 flex flex-col gap-2 border-t border-foreground/8 pt-3 sm:ml-6 sm:flex-row">
                  <Input
                    nativeInput
                    size="sm"
                    value={callbackUrls[key] ?? ""}
                    placeholder="Paste the full callback URL"
                    aria-label={`OAuth callback URL for ${connection.serverName}`}
                    onChange={(event) =>
                      setCallbackUrls((current) => ({
                        ...current,
                        [key]: event.currentTarget.value,
                      }))
                    }
                  />
                  <Button
                    size="sm"
                    disabled={busy || (callbackUrls[key]?.trim().length ?? 0) === 0}
                    onClick={() => completeConnection(connection)}
                  >
                    {busy ? "Submitting…" : "Complete sign-in"}
                  </Button>
                </div>
              ) : null}
            </SettingsRow>
          );
        })}
        {!authState ? (
          <SettingsRow
            className="rounded-none"
            title={loadError ? "MCP connections unavailable" : "Checking MCP connections"}
            description={
              loadError ? (
                <span role="alert">{loadError}</span>
              ) : (
                "Reading authentication status from the installed harnesses."
              )
            }
            control={
              loadError ? (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={loadingAuth}
                  onClick={() => void loadAuth()}
                >
                  <RefreshCwIcon />
                  {loadingAuth ? "Retrying…" : "Try again"}
                </Button>
              ) : null
            }
          />
        ) : null}
      </div>
      {loadError && authState ? (
        <div className="flex items-center justify-between gap-3 px-4">
          <p className="text-destructive text-xs" role="alert">
            {loadError}
          </p>
          {authState ? (
            <Button
              size="xs"
              variant="ghost-muted"
              disabled={loadingAuth}
              onClick={() => void loadAuth()}
            >
              <RefreshCwIcon />
              {loadingAuth ? "Retrying…" : "Try again"}
            </Button>
          ) : null}
        </div>
      ) : null}
      <p className="px-3 text-pretty text-base/7 text-muted-foreground sm:px-4 sm:text-sm/5">
        Credentials stay in each harness&apos;s native OAuth store and are available to new chats.
        Local standard-input MCP servers do not use this OAuth flow.
      </p>
    </SettingsSection>
  );
}

function ComputerUsePermissions({ plugin }: { readonly plugin: PluginMarketplaceDetail }) {
  const [pendingAction, setPendingAction] = useState<PluginMarketplaceSetupAction | null>(null);
  const openSetup = (action: PluginMarketplaceSetupAction) => {
    setPendingAction(action);
    void openPluginSetup(plugin.id, action)
      .then(() =>
        toastManager.add({
          type: "success",
          title:
            action === "permissions"
              ? "Computer Use setup opened"
              : action === "accessibility"
                ? "Accessibility settings opened"
                : "Automation settings opened",
          description: "Finish granting access on the Mac that hosts this environment.",
        }),
      )
      .catch((error: unknown) =>
        toastManager.add({ type: "error", title: pluginMarketplaceErrorMessage(error) }),
      )
      .finally(() => setPendingAction(null));
  };
  const busy = pendingAction !== null;

  return (
    <SettingsSection
      title="Permission setup"
      icon={<ShieldCheckIcon className="size-4 text-muted-foreground" />}
    >
      <div className="divide-y divide-foreground/8 rounded-xl border border-foreground/8 bg-card/24 px-1 dark:bg-card/40">
        <SettingsRow
          title="Accessibility and screen recording"
          description="The signed Computer Use app guides the permissions needed to see and operate Mac apps."
          control={
            <div className="flex w-full flex-wrap gap-2 sm:w-auto sm:justify-end">
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => openSetup("permissions")}
              >
                <AppWindowIcon />
                {pendingAction === "permissions" ? "Opening…" : "Open setup"}
              </Button>
              <Button
                size="sm"
                variant="ghost-muted"
                disabled={busy}
                onClick={() => openSetup("accessibility")}
              >
                <ExternalLinkIcon />
                Accessibility
              </Button>
            </div>
          }
        />
        <SettingsRow
          title="App automation"
          description="Allow T3 Code to control System Events and each application you choose to use."
          control={
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => openSetup("automation")}
            >
              <ExternalLinkIcon />
              {pendingAction === "automation" ? "Opening…" : "Open settings"}
            </Button>
          }
        />
      </div>
      <p className="px-3 text-pretty text-base/7 text-muted-foreground sm:px-4 sm:text-sm/5">
        Computer Use runs locally on this environment. Permission changes stay on this Mac and can
        be reviewed in System Settings at any time.
      </p>
    </SettingsSection>
  );
}

function DetailLine({
  label,
  children,
}: {
  readonly label: string;
  readonly children: React.ReactNode;
}) {
  return (
    <div className="grid gap-1 sm:grid-cols-[8rem_minmax(0,1fr)]">
      <dt className="font-medium text-foreground">{label}</dt>
      <dd className="min-w-0 break-words text-muted-foreground">{children}</dd>
    </div>
  );
}

function McpServerRow({ server }: { readonly server: PluginMarketplaceMcpServer }) {
  return (
    <Collapsible>
      <CollapsibleTrigger className="group/mcp flex w-full items-center gap-3 rounded-xl px-3 py-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring sm:px-4">
        <ServerIcon className="size-4 shrink-0" />
        <span className="min-w-0 flex-1">
          <span className="block truncate font-medium text-sm text-foreground">{server.name}</span>
          <span className="block truncate text-muted-foreground text-xs">
            {server.url ?? "Configuration supplied by the plugin"}
          </span>
        </span>
        <Badge size="sm" variant="outline">
          {server.transport === "http"
            ? "Remote HTTP"
            : server.transport === "stdio"
              ? "Local stdio"
              : "MCP"}
        </Badge>
        <ChevronDownIcon className="size-4 text-muted-foreground transition-transform group-data-panel-open/mcp:rotate-180" />
      </CollapsibleTrigger>
      <CollapsiblePanel>
        <dl className="space-y-2 border-t border-foreground/8 px-4 py-3 text-xs">
          <DetailLine label="ID">{server.id}</DetailLine>
          {server.url ? <DetailLine label="Endpoint">{server.url}</DetailLine> : null}
          {server.oauthResource ? (
            <DetailLine label="OAuth resource">{server.oauthResource}</DetailLine>
          ) : null}
          {server.toolTimeoutSeconds !== null ? (
            <DetailLine label="Tool timeout">{server.toolTimeoutSeconds} seconds</DetailLine>
          ) : null}
          {server.environmentVariables.length > 0 ? (
            <DetailLine label="Environment">
              <span className="flex flex-wrap gap-1">
                {server.environmentVariables.map((name) => (
                  <Badge key={name} size="sm" variant="secondary">
                    {name}
                  </Badge>
                ))}
              </span>
            </DetailLine>
          ) : null}
          {server.note ? <DetailLine label="Note">{server.note}</DetailLine> : null}
        </dl>
      </CollapsiblePanel>
    </Collapsible>
  );
}

function SkillRow({ skill }: { readonly skill: PluginMarketplaceSkill }) {
  return (
    <Collapsible>
      <CollapsibleTrigger className="group/skill flex w-full items-center gap-3 rounded-xl px-3 py-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring sm:px-4">
        <SparklesIcon className="size-4 shrink-0" />
        <span className="min-w-0 flex-1">
          <span className="block font-medium text-sm text-foreground">{skill.name}</span>
          <span className="line-clamp-1 text-muted-foreground text-xs">{skill.description}</span>
        </span>
        <ChevronDownIcon className="size-4 text-muted-foreground transition-transform group-data-panel-open/skill:rotate-180" />
      </CollapsibleTrigger>
      <CollapsiblePanel>
        <div className="space-y-3 border-t border-foreground/8 px-4 py-3 text-xs">
          <p className="text-pretty text-muted-foreground">{skill.description}</p>
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium text-foreground">Skill identifier</span>
            <code className="rounded-md bg-muted px-2 py-1 text-foreground">
              {skill.invocation}
            </code>
          </div>
        </div>
      </CollapsiblePanel>
    </Collapsible>
  );
}

function AppRow({ app }: { readonly app: PluginMarketplaceApp }) {
  return (
    <SettingsRow
      title={
        <span className="flex items-center gap-2">
          <AppWindowIcon className="size-4 shrink-0" />
          <span>{app.name}</span>
        </span>
      }
      description={app.connectorId ? `Connector ${app.connectorId}` : `App definition ${app.id}`}
    />
  );
}

const EXTENSION_LABELS: Readonly<Record<PluginMarketplaceExtension["kind"], string>> = {
  command: "Command",
  agent: "Subagent",
  rule: "Rule",
  hook: "Hook",
  lsp: "Language server",
  monitor: "Monitor",
};
function ExtensionIcon({ kind }: { readonly kind: PluginMarketplaceExtension["kind"] }) {
  const Icon =
    kind === "command"
      ? CommandIcon
      : kind === "agent"
        ? BotIcon
        : kind === "rule"
          ? BookOpenIcon
          : kind === "hook"
            ? WebhookIcon
            : FileCodeIcon;
  return <Icon className="size-4 shrink-0" />;
}

function ExtensionRow({ extension }: { readonly extension: PluginMarketplaceExtension }) {
  return (
    <Collapsible>
      <CollapsibleTrigger className="group/extension flex w-full items-center gap-3 rounded-xl px-3 py-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring sm:px-4">
        <ExtensionIcon kind={extension.kind} />
        <span className="min-w-0 flex-1">
          <span className="block truncate font-medium text-sm text-foreground">
            {extension.name}
          </span>
          <span className="line-clamp-1 text-muted-foreground text-xs">
            {extension.description}
          </span>
        </span>
        <Badge size="sm" variant="outline">
          {EXTENSION_LABELS[extension.kind]}
        </Badge>
        <ChevronDownIcon className="size-4 text-muted-foreground transition-transform group-data-panel-open/extension:rotate-180" />
      </CollapsibleTrigger>
      <CollapsiblePanel>
        <div className="flex items-start justify-between gap-4 border-t border-foreground/8 px-4 py-3 text-xs">
          <p className="max-w-[72ch] text-pretty text-muted-foreground">{extension.description}</p>
          {extension.sourceUrl ? (
            <a
              href={extension.sourceUrl}
              target="_blank"
              rel="noreferrer"
              className="flex shrink-0 items-center gap-1 font-medium text-foreground underline-offset-4 hover:underline"
            >
              Source
              <ExternalLinkIcon className="size-3.5" />
            </a>
          ) : null}
        </div>
      </CollapsiblePanel>
    </Collapsible>
  );
}

function packageDescription(plugin: PluginMarketplaceDetail): string {
  return plugin.sourceHarness === "codex"
    ? "Codex bundles reusable skills, MCP connections, apps, and optional lifecycle hooks into one install."
    : plugin.sourceHarness === "claude"
      ? "Claude Code packages can add namespaced skills, commands, subagents, hooks, MCP servers, and language servers."
      : plugin.sourceHarness === "cursor"
        ? "Cursor plugins can add editor rules, commands, subagents, hooks, skills, and MCP servers. Installation completes in Cursor with its official plugin flow."
        : "This package extends the selected agent harness.";
}

function PluginContents({ plugin }: { readonly plugin: PluginMarketplaceDetail }) {
  const [expanded, setExpanded] = useState(false);
  const count =
    plugin.mcpServers.length + plugin.skills.length + plugin.apps.length + plugin.extensions.length;
  const rows = [
    ...plugin.mcpServers.map((server) => <McpServerRow key={`mcp:${server.id}`} server={server} />),
    ...plugin.skills.map((skill) => <SkillRow key={`skill:${skill.id}`} skill={skill} />),
    ...plugin.apps.map((app) => <AppRow key={`app:${app.id}`} app={app} />),
    ...plugin.extensions.map((extension) => (
      <ExtensionRow key={`extension:${extension.kind}:${extension.id}`} extension={extension} />
    )),
  ];
  const visibleRows = expanded ? rows : rows.slice(0, 5);
  return (
    <SettingsSection
      title={`${MARKETPLACE_HARNESS_LABELS[plugin.sourceHarness]} package`}
      headerAction={
        <Badge size="sm" variant="secondary">
          {MARKETPLACE_HARNESS_LABELS[plugin.sourceHarness]} · {count}
        </Badge>
      }
    >
      <p className="px-3 text-pretty text-base/7 text-muted-foreground sm:px-4 sm:text-sm/5">
        {packageDescription(plugin)}
      </p>
      {count > 0 ? (
        <div className="divide-y divide-foreground/8 rounded-xl border border-foreground/8 bg-card/24 px-1 dark:bg-card/40">
          {visibleRows}
          {rows.length > 5 ? (
            <div className="flex justify-center px-3 py-2">
              <Button
                size="sm"
                variant="ghost-muted"
                onClick={() => setExpanded((value) => !value)}
              >
                {expanded ? "Show less" : `Show ${rows.length - 5} more`}
              </Button>
            </div>
          ) : null}
        </div>
      ) : (
        <SettingsRow
          title="Package inventory unavailable"
          description={
            plugin.sourceHarness === "claude"
              ? "Claude does not expose this package inventory until the remote source can be inspected or the plugin is installed."
              : "This marketplace entry does not publish a component inventory."
          }
        />
      )}
    </SettingsSection>
  );
}

function PluginInformation({ plugin }: { readonly plugin: PluginMarketplaceDetail }) {
  const includes = marketplacePluginIncludeLabels(plugin);
  return (
    <SettingsSection title="Details">
      <Collapsible className="rounded-xl border border-foreground/8 bg-card/24 dark:bg-card/40">
        <CollapsibleTrigger className="group/details flex w-full items-center gap-3 rounded-xl px-3 py-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring sm:px-4">
          <div className="min-w-0 flex-1">
            <p className="font-medium text-base text-foreground sm:text-sm">Advanced details</p>
            <p className="truncate text-base/7 text-muted-foreground sm:text-sm/5">
              {plugin.developer} · {plugin.marketplaceName} · {plugin.version}
            </p>
          </div>
          <ChevronDownIcon className="size-4 shrink-0 text-muted-foreground transition-transform group-data-panel-open/details:rotate-180" />
        </CollapsibleTrigger>
        <CollapsiblePanel>
          <dl className="grid gap-x-8 gap-y-4 border-t border-foreground/8 p-4 sm:grid-cols-[10rem_minmax(0,1fr)]">
            <dt className="font-medium text-base text-foreground sm:text-sm">Developer</dt>
            <dd className="min-w-0 text-base text-muted-foreground sm:text-sm">
              {plugin.developer}
            </dd>
            {plugin.description !== plugin.summary ? (
              <>
                <dt className="font-medium text-base text-foreground sm:text-sm">Description</dt>
                <dd className="min-w-0 text-pretty text-base/7 text-muted-foreground sm:text-sm/6">
                  {plugin.description}
                </dd>
              </>
            ) : null}
            <dt className="font-medium text-base text-foreground sm:text-sm">Category</dt>
            <dd className="min-w-0 text-base text-muted-foreground sm:text-sm">
              {plugin.category}
            </dd>
            <dt className="font-medium text-base text-foreground sm:text-sm">Version</dt>
            <dd className="min-w-0 tabular-nums text-base text-muted-foreground sm:text-sm">
              {plugin.version}
            </dd>
            <dt className="font-medium text-base text-foreground sm:text-sm">Includes</dt>
            <dd className="flex min-w-0 flex-wrap gap-1">
              {includes.map((label) => (
                <Badge key={label} variant="secondary">
                  {label}
                </Badge>
              ))}
            </dd>
            <dt className="font-medium text-base text-foreground sm:text-sm">Marketplace</dt>
            <dd className="min-w-0 text-base text-muted-foreground sm:text-sm">
              {plugin.marketplaceName} · {plugin.marketplaceSourceType}
            </dd>
            <dt className="font-medium text-base text-foreground sm:text-sm">Package</dt>
            <dd className="min-w-0 break-all text-base text-muted-foreground sm:text-sm">
              {plugin.id}
            </dd>
            {plugin.capabilities.length > 0 ? (
              <>
                <dt className="font-medium text-base text-foreground sm:text-sm">Capabilities</dt>
                <dd className="flex min-w-0 flex-wrap gap-1">
                  {plugin.capabilities.map((capability) => (
                    <Badge key={capability} variant="outline">
                      {capability}
                    </Badge>
                  ))}
                </dd>
              </>
            ) : null}
            {plugin.homepage ? (
              <>
                <dt className="font-medium text-base text-foreground sm:text-sm">Website</dt>
                <dd className="min-w-0 break-all text-base sm:text-sm">
                  <a
                    href={plugin.homepage}
                    target="_blank"
                    rel="noreferrer"
                    className="font-medium text-foreground underline-offset-4 hover:underline"
                  >
                    {plugin.homepage}
                  </a>
                </dd>
              </>
            ) : null}
          </dl>
        </CollapsiblePanel>
      </Collapsible>
    </SettingsSection>
  );
}

export function PluginDetail({ pluginId }: { readonly pluginId: string }) {
  const canGoBack = useCanGoBack();
  const navigate = useNavigate();
  const primaryEnvironment = usePrimaryEnvironment();
  const state = usePluginMarketplaceStore((store) => store.details[pluginId]);
  const loadDetail = usePluginMarketplaceStore((store) => store.loadDetail);
  const handleBackToPlugins = useCallback(() => {
    if (canGoBack) {
      window.history.back();
      return;
    }
    void navigate({ to: "/settings/plugins", replace: true });
  }, [canGoBack, navigate]);

  useEffect(() => {
    void loadDetail(pluginId).catch(() => undefined);
  }, [loadDetail, pluginId]);

  if (!state || (state.status === "loading" && !state.plugin)) return <LoadingPlugin />;
  if (state.status === "error" || !state.plugin) {
    return (
      <MissingPlugin
        error={state.error}
        onRetry={() => void loadDetail(pluginId, true).catch(() => undefined)}
      />
    );
  }

  const plugin = state.plugin;
  const installedTargets = plugin.installTargets.filter(
    (target) => target.installPolicy !== "EXTERNAL" && target.installed,
  ).length;
  const hasInstalledCodexComputerUse =
    primaryEnvironment?.serverConfig?.environment.platform.os === "darwin" &&
    plugin.packageName === "computer-use" &&
    plugin.installTargets.some((target) => target.harness === "codex" && target.installed);
  return (
    <SettingsPageContainer className="max-w-4xl gap-10">
      <header className="flex flex-col gap-5 px-1 sm:px-0">
        <Button
          size="sm"
          variant="ghost-muted"
          className="self-start"
          onClick={handleBackToPlugins}
        >
          <ArrowLeftIcon />
          Plugins
        </Button>
        <div className="flex min-w-0 items-start gap-3">
          <PluginLogo plugin={plugin} size="large" />
          <div className="min-w-0 flex-1 space-y-2">
            <div>
              <h1 className="text-balance font-semibold text-2xl tracking-tight text-foreground">
                {plugin.name}
              </h1>
              <p className="max-w-[78ch] text-pretty text-base/7 text-muted-foreground sm:text-sm/6">
                {plugin.summary}
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
              <HarnessSupportBadges support={plugin.support} compact={false} />
              <p className="text-base text-muted-foreground sm:text-sm">
                {plugin.developer} · {plugin.category} · {installedTargets} managed{" "}
                {installedTargets === 1 ? "install" : "installs"}
              </p>
            </div>
          </div>
        </div>
      </header>

      <InstallationSettings plugin={plugin} />
      <McpAuthentication key={plugin.id} plugin={plugin} />
      {hasInstalledCodexComputerUse ? <ComputerUsePermissions plugin={plugin} /> : null}
      <PluginContents plugin={plugin} />
      <PluginInformation plugin={plugin} />
    </SettingsPageContainer>
  );
}
