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
import { GlobeIcon, SquareIcon } from "lucide-react";
import { useState } from "react";

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
        {servers.map((server) => (
          <li key={serverKey(server)} className="flex items-center gap-1">
            <ThreadDetailsControl
              className="flex-1"
              disabled={!canOpen}
              aria-label={`Open localhost:${server.port} in the browser`}
              onClick={() => void open(server)}
            >
              <GlobeIcon className={THREAD_DETAILS_PANEL_ICON_CLASS} />
              <span className="shrink-0">localhost:{server.port}</span>
              <span className="ms-auto min-w-0 truncate text-2xs text-muted-foreground">
                {[server.terminal === null ? "Agent" : "Terminal", server.processName]
                  .filter(Boolean)
                  .join(" · ")}
              </span>
            </ThreadDetailsControl>
            {canStop && supportsStop && server.pid !== null ? (
              <Tooltip>
                <TooltipTrigger
                  render={
                    <ThreadDetailsControl
                      size="icon-xs"
                      variant="ghost"
                      part="icon"
                      aria-label={`Stop localhost:${server.port}`}
                      disabled={stoppingKey !== null}
                      onClick={() => void stop(server)}
                    >
                      <SquareIcon className="size-3.5" />
                    </ThreadDetailsControl>
                  }
                />
                <TooltipPopup>Stop server</TooltipPopup>
              </Tooltip>
            ) : null}
          </li>
        ))}
      </ul>
    </ThreadDetailsSection>
  );
}
