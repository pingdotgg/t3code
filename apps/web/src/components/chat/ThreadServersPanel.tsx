import { useAtomValue } from "@effect/atom-react";
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
import { GlobeIcon, LoaderCircleIcon, SquareIcon } from "lucide-react";
import { useState } from "react";

import { cn } from "../../lib/utils";
import { useThreadDiscoveredPorts } from "../../portDiscoveryState";
import { useEnvironment } from "../../state/environments";
import { previewEnvironment } from "../../state/preview";
import { useEnvironmentScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { openDiscoveredPort } from "../preview/openDiscoveredPort";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ThreadDetailsControl } from "./ThreadDetailsControl";
import { ThreadDetailsSection } from "./ThreadDetailsSection";
import { THREAD_DETAILS_PANEL_ICON_CLASS } from "./threadDetailsPanelStyles";

const serverKey = (server: DiscoveredLocalServer) => `${server.pid}:${server.port}`;

/** Web servers the thread's terminals and agent started. Hidden while none run. */
export function ThreadServersPanel(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
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

  if (servers.length === 0) return null;
  const threadRef = scopeThreadRef(props.environmentId, props.threadId);

  const reportFailure = (title: string, error: unknown) => {
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title,
        description: error instanceof Error ? error.message : String(error),
      }),
    );
  };

  const open = async (server: DiscoveredLocalServer) => {
    const result = await openDiscoveredPort({ threadRef, port: server, openPreview });
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      reportFailure("Unable to open preview", squashAtomCommandFailure(result));
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
      reportFailure("Could not stop server", squashAtomCommandFailure(result));
    }
  };

  return (
    <ThreadDetailsSection headingId="thread-details-servers-heading" title="Servers">
      <ul className="m-0 list-none p-0">
        {servers.map((server) => {
          const key = serverKey(server);
          const stoppable = canStop && supportsStop && server.pid !== null;
          return (
            <li key={key} className="group relative flex h-8 items-center rounded-lg">
              <Tooltip>
                <TooltipTrigger
                  delay={200}
                  render={
                    <ThreadDetailsControl
                      size="sm"
                      variant="ghost"
                      part="row"
                      disabled={!canOpen}
                      onClick={() => void open(server)}
                    />
                  }
                >
                  <GlobeIcon aria-hidden className={THREAD_DETAILS_PANEL_ICON_CLASS} />
                  <span className="shrink-0 text-sm font-medium leading-4 text-foreground/85">
                    localhost:{server.port}
                  </span>
                  {/* The stop button covers this while it shows. */}
                  <span
                    className={cn(
                      "ms-auto min-w-0 truncate text-2xs font-normal text-muted-foreground",
                      stoppable &&
                        "group-hover:opacity-0 group-focus-within:opacity-0 pointer-coarse:opacity-0 [@media(hover:none)]:opacity-0",
                    )}
                  >
                    {[server.terminal === null ? "Agent" : "Terminal", server.processName]
                      .filter(Boolean)
                      .join(" · ")}
                  </span>
                </TooltipTrigger>
                <TooltipPopup side="left">Open in the browser panel</TooltipPopup>
              </Tooltip>
              {stoppable ? (
                <div className="pointer-events-none absolute right-1 top-1/2 -translate-y-1/2 opacity-0 group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100 pointer-coarse:pointer-events-auto pointer-coarse:opacity-100 [@media(hover:none)]:pointer-events-auto [@media(hover:none)]:opacity-100">
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <ThreadDetailsControl
                          size="icon-xs"
                          variant="ghost"
                          part="icon"
                          tone="destructive"
                          aria-label={`Stop localhost:${server.port}`}
                          disabled={stoppingKey !== null}
                          onClick={() => void stop(server)}
                        />
                      }
                    >
                      {stoppingKey === key ? (
                        <LoaderCircleIcon aria-hidden className="size-3 animate-spin" />
                      ) : (
                        <SquareIcon aria-hidden className="size-3 fill-current" />
                      )}
                    </TooltipTrigger>
                    <TooltipPopup side="left">Stop server</TooltipPopup>
                  </Tooltip>
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
    </ThreadDetailsSection>
  );
}
