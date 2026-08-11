import { useAtomValue } from "@effect/atom-react";
import { Link } from "@tanstack/react-router";
import { PlugIcon, RefreshCwIcon, SettingsIcon } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import * as Option from "effect/Option";

import { resolveAssetUrl } from "@t3tools/client-runtime/state/assets";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { PluginPageContribution } from "../../pluginCatalog";
import { findPluginPage } from "../../pluginCatalog";
import { ensureLocalApi } from "../../localApi";
import { pluginEnvironment, primaryPluginCatalogResultAtom } from "../../state/plugins";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { usePreparedConnection } from "../../state/session";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { isElectron } from "../../env";
import { cn, randomUUID } from "../../lib/utils";
import { COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS } from "../../workspaceTitlebar";
import { Button } from "../ui/button";
import { SidebarInset } from "../ui/sidebar";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { WorkspaceBreadcrumb, WorkspaceBreadcrumbItem } from "../WorkspaceBreadcrumb";

function PluginPageHeader({
  page,
  onReload,
}: {
  readonly page: PluginPageContribution;
  readonly onReload: () => void;
}) {
  const content = (
    <div className="flex w-full min-w-0 items-center gap-2">
      <WorkspaceBreadcrumb ariaLabel={`${page.command.title} breadcrumb`}>
        <WorkspaceBreadcrumbItem className="truncate">{page.plugin.name}</WorkspaceBreadcrumbItem>
        <WorkspaceBreadcrumbItem current className="truncate">
          {page.command.title}
        </WorkspaceBreadcrumbItem>
      </WorkspaceBreadcrumb>
      <div className="ms-auto flex shrink-0 items-center gap-1 [-webkit-app-region:no-drag]">
        <Button size="icon-xs" variant="ghost" aria-label="Reload plugin page" onClick={onReload}>
          <RefreshCwIcon />
        </Button>
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label="Manage plugins"
          render={<Link to="/settings/plugins" />}
        >
          <SettingsIcon />
        </Button>
      </div>
    </div>
  );

  return isElectron ? (
    <div
      className={cn(
        "drag-region flex h-[52px] shrink-0 items-center px-5 transition-[padding-left] duration-200 ease-linear motion-reduce:transition-none wco:h-[env(titlebar-area-height)] wco:pr-[calc(100vw-env(titlebar-area-width)-env(titlebar-area-x)+1em)]",
        COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS,
      )}
    >
      {content}
    </div>
  ) : (
    <header
      className={cn(
        "workspace-topbar px-3 transition-[padding-left] duration-200 ease-linear motion-reduce:transition-none sm:px-5",
        COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS,
      )}
    >
      {content}
    </header>
  );
}

function PluginPageMessage({
  title,
  description,
  action,
}: {
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden bg-background text-foreground isolate">
      <div className="flex min-h-0 flex-1 items-center justify-center px-6">
        <div className="flex max-w-sm flex-col items-center gap-3 text-center">
          <div className="flex size-10 items-center justify-center rounded-xl bg-muted">
            <PlugIcon className="size-5 text-muted-foreground" />
          </div>
          <div className="space-y-1">
            <h1 className="font-medium">{title}</h1>
            <p className="text-sm text-muted-foreground">{description}</p>
          </div>
          {action ?? (
            <Button size="sm" render={<Link to="/settings/plugins" />}>
              Manage plugins
            </Button>
          )}
        </div>
      </div>
    </SidebarInset>
  );
}

function LoadedPluginPage({
  environmentId,
  page,
}: {
  readonly environmentId: NonNullable<ReturnType<typeof usePrimaryEnvironmentId>>;
  readonly page: PluginPageContribution;
}) {
  const preparedConnection = usePreparedConnection(environmentId);
  const viewUrlAtom = pluginEnvironment.createViewUrl({
    environmentId,
    input: { pluginId: page.plugin.id, commandName: page.command.name },
  });
  const viewUrlResult = useAtomValue(viewUrlAtom);
  const frameRef = useRef<HTMLIFrameElement>(null);
  const invocationIdsRef = useRef(new Set<string>());
  const [frameGeneration, setFrameGeneration] = useState(0);
  const lastOpenExternalRef = useRef(0);

  // Per-mount nonce that authenticates inbound plugin messages. A sandboxed iframe
  // (allow-scripts, no allow-same-origin) can self-navigate to a foreign origin while
  // keeping the same contentWindow, and event.origin is opaque "null" either way, so
  // event.source alone is spoofable. The nonce travels in the iframe src fragment
  // (client-only, never sent to the server) and every plugin->host message must echo it.
  // It is minted with the frame snapshot below (not via useMemo, which React does not
  // promise to retain) and regenerated whenever the frame is deliberately reloaded.
  const nonceRef = useRef("");

  useEffect(() => {
    const onMessage = (event: MessageEvent<unknown>) => {
      const frameWindow = frameRef.current?.contentWindow;
      if (!frameWindow || event.source !== frameWindow) return;
      if (!event.data || typeof event.data !== "object") return;
      const message = event.data as Record<string, unknown>;
      if (
        message.source !== "t3-plugin" ||
        message.nonce !== nonceRef.current ||
        typeof message.type !== "string"
      ) {
        return;
      }
      if (message.type === "show-toast" && typeof message.title === "string") {
        toastManager.add(
          stackedThreadToast({
            type: "info",
            title: message.title.slice(0, 120),
            ...(typeof message.message === "string"
              ? { description: message.message.slice(0, 500) }
              : {}),
          }),
        );
        return;
      }
      if (message.type === "open-external" && typeof message.url === "string") {
        // Throttle so a runaway plugin loop can't spam the OS browser. A single
        // user-driven open comfortably clears the minimum interval.
        const now = Date.now();
        if (now - lastOpenExternalRef.current < 1_000) return;
        try {
          const url = new URL(message.url);
          if (url.protocol === "http:" || url.protocol === "https:") {
            // Spend the throttle only on an open we actually perform, so a malformed
            // or non-http message can't suppress the user's next real one.
            lastOpenExternalRef.current = now;
            void ensureLocalApi().shell.openExternal(url.toString());
          }
        } catch {
          // Ignore malformed plugin messages at the host boundary.
        }
        return;
      }
      if (
        message.type === "invoke" &&
        typeof message.requestId === "string" &&
        message.requestId.length <= 120 &&
        typeof message.action === "string"
      ) {
        const requestId = message.requestId;
        const respond = (result: Record<string, unknown>) => {
          frameWindow.postMessage(
            { source: "t3-host", type: "invoke-result", requestId, ...result },
            "*",
          );
        };
        if (invocationIdsRef.current.has(requestId)) {
          respond({ ok: false, error: "Duplicate plugin request." });
          return;
        }
        if (invocationIdsRef.current.size >= 4) {
          respond({ ok: false, error: "Too many plugin requests are already running." });
          return;
        }
        let inputJson: string;
        try {
          inputJson = JSON.stringify(message.input ?? null);
        } catch {
          respond({ ok: false, error: "Plugin action input is not serializable." });
          return;
        }
        invocationIdsRef.current.add(requestId);
        void pluginEnvironment.invoke
          .run(appAtomRegistry, {
            environmentId,
            input: { pluginId: page.plugin.id, action: message.action, inputJson },
          })
          .then((result) => {
            if (result._tag === "Failure") {
              const cause = squashAtomCommandFailure(result);
              respond({
                ok: false,
                error: cause instanceof Error ? cause.message : "Plugin action failed.",
              });
              return;
            }
            try {
              respond({ ok: true, value: JSON.parse(result.value.outputJson) });
            } catch {
              respond({ ok: false, error: "Plugin backend returned invalid JSON." });
            }
          })
          .finally(() => invocationIdsRef.current.delete(requestId));
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [environmentId, page.plugin.id]);

  // Resolve the view URL only from a settled (non-waiting) success. Every createViewUrl
  // execution mints a new token, so relativeUrl changes on background SWR revalidation and
  // websocket reconnects. Snapshot the first settled URL per generation and ignore later
  // background refreshes so the iframe never hard-navigates and wipes in-frame state; a
  // deliberate Reload bumps frameGeneration (fresh nonce) and recaptures a fresh URL.
  const resolvedUrl =
    Option.isSome(preparedConnection) && viewUrlResult._tag === "Success" && !viewUrlResult.waiting
      ? resolveAssetUrl(preparedConnection.value.httpBaseUrl, viewUrlResult.value.relativeUrl)
      : null;

  const [frame, setFrame] = useState<{ generation: number; src: string } | null>(null);
  useEffect(() => {
    if (resolvedUrl !== null && frame?.generation !== frameGeneration) {
      // Mint the nonce together with the src it is embedded in, so the value the host
      // checks can never drift from the value the frame was handed.
      const nonce = randomUUID();
      nonceRef.current = nonce;
      setFrame({ generation: frameGeneration, src: `${resolvedUrl}#t3-nonce=${nonce}` });
    }
  }, [resolvedUrl, frameGeneration, frame]);

  const frameUrl = frame && frame.generation === frameGeneration ? frame.src : null;

  if (viewUrlResult._tag === "Failure") {
    // Surface the server's reason ("Plugin is disabled", a missing built entry, an auth
    // failure); they are not all fixed by rebuilding, so a fixed string misleads.
    const cause = squashAtomCommandFailure(viewUrlResult);
    return (
      <PluginPageMessage
        title="Plugin page failed to load"
        description={
          cause instanceof Error
            ? cause.message
            : "Build the command entry, reload the plugin catalog, and try again."
        }
      />
    );
  }
  if (!frameUrl) {
    return <PluginPageMessage title="Loading plugin…" description="Preparing its sandbox." />;
  }

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground isolate">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground">
        <PluginPageHeader
          page={page}
          onReload={() => {
            appAtomRegistry.refresh(viewUrlAtom);
            setFrameGeneration((generation) => generation + 1);
          }}
        />
        <iframe
          ref={frameRef}
          key={frameGeneration}
          className="min-h-0 flex-1 border-0 bg-[#111]"
          referrerPolicy="no-referrer"
          sandbox="allow-scripts"
          src={frameUrl}
          title={`${page.plugin.name}: ${page.command.title}`}
        />
      </div>
    </SidebarInset>
  );
}

export function PluginPage({
  pluginId,
  commandName,
}: {
  readonly pluginId: string;
  readonly commandName: string;
}) {
  const environmentId = usePrimaryEnvironmentId();
  const catalogResult = useAtomValue(primaryPluginCatalogResultAtom);

  if (catalogResult._tag === "Initial") {
    return (
      <PluginPageMessage title="Loading plugin…" description="Reading the environment catalog." />
    );
  }
  // A transient plugins.list failure (e.g. during a reconnect) must not masquerade as a
  // permanently removed plugin. Offer a retry that refreshes the catalog instead.
  if (catalogResult._tag === "Failure") {
    return (
      <PluginPageMessage
        title="Couldn't load plugins"
        description="The plugin catalog failed to load, possibly during a reconnect. Try again."
        action={
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              onClick={() => {
                if (environmentId) {
                  appAtomRegistry.refresh(pluginEnvironment.catalog({ environmentId, input: {} }));
                }
              }}
            >
              <RefreshCwIcon />
              Retry
            </Button>
            <Button size="sm" variant="ghost" render={<Link to="/settings/plugins" />}>
              Manage plugins
            </Button>
          </div>
        }
      />
    );
  }

  const page = findPluginPage(catalogResult.value, pluginId, commandName);
  if (!page || !environmentId) {
    return (
      <PluginPageMessage
        title="Plugin page not found"
        description="It may be disabled, invalid, or removed from this environment."
      />
    );
  }
  // Keyed by plugin+command so navigating between plugin pages mounts a fresh frame,
  // nonce, and snapshot instead of reusing the previous plugin's iframe.
  return (
    <LoadedPluginPage
      key={`${page.plugin.id}:${page.command.name}`}
      environmentId={environmentId}
      page={page}
    />
  );
}
