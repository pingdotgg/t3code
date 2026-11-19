import { useAtomValue } from "@effect/atom-react";
import { thrownErrorMessage } from "@t3tools/client-runtime/errors";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  AuthPreviewOperateScope,
  type DiscoveredLocalServer,
  type EnvironmentId,
  type ThreadId,
} from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { T, useGT, Var } from "gt-react";
import { m } from "~/i18n/messages";
import { GlobeIcon, SquareIcon, ChevronDownIcon, ChevronUpIcon } from "lucide-react";
import { type MouseEvent, useState } from "react";

import { resolveDiscoveredServerUrl } from "../../browser/browserTargetResolver";
import { readLocalApi } from "../../localApi";
import { cn, isMacPlatform } from "../../lib/utils";
import { useThreadDiscoveredPorts } from "../../portDiscoveryState";
import { useEnvironment } from "../../state/environments";
import { previewEnvironment } from "../../state/preview";
import { useEnvironmentScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { openDiscoveredPort } from "../preview/openDiscoveredPort";
import { Spinner } from "../ui/spinner";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ThreadDetailsControl } from "./ThreadDetailsControl";
import { ThreadDetailsSection } from "./ThreadDetailsSection";
import { THREAD_DETAILS_PANEL_ICON_CLASS } from "./threadDetailsPanelStyles";

const SERVER_PAGE_COUNT = 4;

const serverKey = (server: DiscoveredLocalServer) => `${server.pid}:${server.port}`;

interface ThreadServersPanelProps {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}

/** Local servers the thread's terminals and agent started. Includes a quiet state while none run. */
export function ThreadServersPanel(props: ThreadServersPanelProps) {
  return <ThreadServersList key={`${props.environmentId}:${props.threadId}`} {...props} />;
}

function ThreadServersList(props: ThreadServersPanelProps) {
  const gt = useGT();
  const servers = useThreadDiscoveredPorts(props);
  const canOpen = useEnvironmentScope(props.environmentId, AuthPreviewOperateScope);
  const canStop = useAtomValue(
    previewEnvironment.stopLocalServer.permissionAtom(props.environmentId),
  );
  const supportsStop =
    useEnvironment(props.environmentId)?.serverConfig?.environment.capabilities.localServerStop ===
    true;
  const openPreview = useAtomCommand(previewEnvironment.open, { reportFailure: false });
  const stopServer = useAtomCommand(previewEnvironment.stopLocalServer, {
    label: "thread server stop",
  });
  const [stoppingKey, setStoppingKey] = useState<string | null>(null);
  const [visibleCount, setVisibleCount] = useState(SERVER_PAGE_COUNT);

  const externalClickLabel = isMacPlatform(navigator.platform) ? "⌘-click" : "Ctrl-click";
  const threadRef = scopeThreadRef(props.environmentId, props.threadId);
  const hiddenCount = Math.max(0, servers.length - visibleCount);

  const reportFailure = (title: string, error: unknown) => {
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title,
        description: thrownErrorMessage(error, m) ?? String(error),
      }),
    );
  };

  const open = async (server: DiscoveredLocalServer, event: MouseEvent<HTMLElement>) => {
    if (event.button > 1) return;
    // Like links: modified and middle clicks go to the system browser.
    if (event.metaKey || event.ctrlKey || event.button === 1) {
      event.preventDefault();
      const url = resolveDiscoveredServerUrl(props.environmentId, server.url);
      await readLocalApi()
        ?.shell.openExternal(url)
        .catch((error: unknown) => reportFailure(gt("Unable to open in browser"), error));
      return;
    }
    const result = await openDiscoveredPort({ threadRef, port: server, openPreview });
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      reportFailure(gt("Unable to open preview"), squashAtomCommandFailure(result));
    }
  };

  const stop = async (server: DiscoveredLocalServer) => {
    if (server.pid === null || stoppingKey !== null) return;
    setStoppingKey(serverKey(server));
    const result = await stopServer({
      environmentId: props.environmentId,
      input: { pid: server.pid, port: server.port },
    });
    setStoppingKey(null);
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      reportFailure(gt("Could not stop server"), squashAtomCommandFailure(result));
    }
  };

  return (
    <ThreadDetailsSection
      title={gt("Servers", { $context: "thread details section: running dev servers" })}
      summary={
        servers.length
          ? gt("{count} running", { count: servers.length, $context: "running dev servers" })
          : gt("None running", { $context: "running dev servers" })
      }
    >
      {servers.length === 0 ? (
        <div className="flex h-9 items-center gap-2.5 px-2.5 text-caption text-dim-foreground">
          <GlobeIcon className="size-4" />
          <T>No servers running</T>
        </div>
      ) : null}
      <ul className="m-0 list-none p-0">
        {servers.slice(0, visibleCount).map((server, index) => {
          const key = serverKey(server);
          const stoppable = canStop && supportsStop && server.pid !== null;
          return (
            <li
              key={key}
              data-thread-details-server-overflow={index >= SERVER_PAGE_COUNT || undefined}
              className="group relative flex items-center rounded-lg"
            >
              <Tooltip>
                <TooltipTrigger
                  delay={200}
                  render={
                    <ThreadDetailsControl
                      size="sm"
                      variant="ghost"
                      part="row"
                      multiline
                      disabled={!canOpen}
                      onClick={(event) => void open(server, event)}
                      onAuxClick={(event) => void open(server, event)}
                    />
                  }
                >
                  <span className="relative shrink-0">
                    <GlobeIcon aria-hidden className={THREAD_DETAILS_PANEL_ICON_CLASS} />
                    <span className="absolute -right-0.5 -top-0.5 size-1.5 rounded-full bg-success" />
                  </span>
                  {/* The end padding keeps text clear of the stop button. */}
                  <span className={cn("flex min-w-0 flex-1 flex-col gap-0.5", stoppable && "pe-6")}>
                    <span className="truncate text-label text-foreground">
                      localhost:{server.port}
                    </span>
                    <span className="truncate text-caption text-dim-foreground">
                      {server.processName ??
                        (server.terminal === null
                          ? gt("Agent", { $context: "who started a dev server" })
                          : gt("Terminal", { $context: "who started a dev server" }))}
                    </span>
                  </span>
                </TooltipTrigger>
                <TooltipPopup side="left">
                  <T>
                    Open in the browser panel. <Var>{externalClickLabel}</Var> for your browser.
                  </T>
                </TooltipPopup>
              </Tooltip>
              {stoppable ? (
                <div className="absolute right-1 top-1/2 -translate-y-1/2">
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <ThreadDetailsControl
                          size="icon-xs"
                          variant="ghost"
                          part="icon"
                          tone="destructive"
                          aria-label={gt("Stop localhost:{port}", { port: server.port })}
                          disabled={stoppingKey !== null}
                          onClick={() => void stop(server)}
                        />
                      }
                    >
                      {stoppingKey === key ? (
                        <Spinner aria-hidden size="xs" />
                      ) : (
                        <SquareIcon aria-hidden className="size-3.5" />
                      )}
                    </TooltipTrigger>
                    <TooltipPopup side="left">
                      <T>Stop server</T>
                    </TooltipPopup>
                  </Tooltip>
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
      {servers.length > SERVER_PAGE_COUNT ? (
        <ThreadDetailsControl
          variant="ghost"
          size="sm"
          onClick={() =>
            setVisibleCount(hiddenCount > 0 ? visibleCount + SERVER_PAGE_COUNT : SERVER_PAGE_COUNT)
          }
          part="row"
          tone="muted"
          className="w-full active:scale-100"
        >
          {hiddenCount > 0 ? (
            <ChevronDownIcon aria-hidden className="size-4 shrink-0" />
          ) : (
            <ChevronUpIcon aria-hidden className="size-4 shrink-0" />
          )}
          {hiddenCount > 0 ? (
            <T>
              Show <Var>{Math.min(hiddenCount, SERVER_PAGE_COUNT)}</Var> more
            </T>
          ) : (
            <T>Show less</T>
          )}
        </ThreadDetailsControl>
      ) : null}
    </ThreadDetailsSection>
  );
}
