import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  AuthPreviewOperateScope,
  nxtvironInstanceActions,
  type DiscoveredLocalServer,
  type EnvironmentId,
  type NxtvironInstance,
  type NxtvironInstanceAction,
  type ThreadId,
} from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { ChevronDown, ChevronUp } from "lucide";
import { GlobeIcon, LoaderCircleIcon, PlayIcon, SquareIcon, Trash2Icon } from "lucide-react";
import { type MouseEvent, useState } from "react";

import { resolveDiscoveredServerUrl } from "../../browser/browserTargetResolver";
import { readLocalApi } from "../../localApi";
import { cn, isMacPlatform } from "../../lib/utils";
import { useThreadDiscoveredPorts, useThreadNxtvironInstances } from "../../portDiscoveryState";
import { useEnvironment } from "../../state/environments";
import { previewEnvironment } from "../../state/preview";
import { useEnvironmentScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { MorphIcon } from "../MorphIcon";
import { openDiscoveredPort } from "../preview/openDiscoveredPort";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ThreadDetailsControl } from "./ThreadDetailsControl";
import { ThreadDetailsSection } from "./ThreadDetailsSection";
import { THREAD_DETAILS_PANEL_ICON_CLASS } from "./threadDetailsPanelStyles";

const SERVER_PAGE_COUNT = 4;

interface ServerRowAction {
  readonly id: string;
  readonly label: string;
  readonly tooltip: string;
  readonly destructive: boolean;
  readonly icon: "stop" | "resume" | "delete";
  readonly run: () => Promise<void>;
}

interface ServerRow {
  readonly key: string;
  readonly title: string;
  readonly subtitle: string;
  /** `null` rows can't be opened, such as a stopped nxtviron instance. */
  readonly url: string | null;
  readonly actions: ReadonlyArray<ServerRowAction>;
}

const serverKey = (server: DiscoveredLocalServer) => `${server.pid}:${server.port}`;

const nxtvironPort = (instance: NxtvironInstance) =>
  instance.ports.http ?? Object.values(instance.ports)[0] ?? null;

const NXTVIRON_STATE_LABEL: Partial<Record<NxtvironInstance["state"], string>> = {
  stopped: "Stopped",
  missing: "Missing",
  unavailable: "Unavailable",
};

const NXTVIRON_ACTION_COPY: Record<
  NxtvironInstanceAction,
  { readonly verb: string; readonly tooltip: string; readonly failure: string }
> = {
  stop: { verb: "Stop", tooltip: "Stop instance", failure: "Could not stop instance" },
  resume: { verb: "Resume", tooltip: "Resume instance", failure: "Could not resume instance" },
  delete: { verb: "Delete", tooltip: "Delete instance", failure: "Could not delete instance" },
};

const ACTION_ICONS = { stop: SquareIcon, resume: PlayIcon, delete: Trash2Icon } as const;

interface ThreadServersPanelProps {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}

/** Local servers the thread's terminals, agent, or nxtviron started. Hidden while none exist. */
export function ThreadServersPanel(props: ThreadServersPanelProps) {
  return <ThreadServersList key={`${props.environmentId}:${props.threadId}`} {...props} />;
}

function ThreadServersList(props: ThreadServersPanelProps) {
  const servers = useThreadDiscoveredPorts(props);
  const instances = useThreadNxtvironInstances(props);
  const canOpen = useEnvironmentScope(props.environmentId, AuthPreviewOperateScope);
  const canStop = useAtomValue(
    previewEnvironment.stopLocalServer.permissionAtom(props.environmentId),
  );
  const canActOnInstances = useAtomValue(
    previewEnvironment.nxtvironInstanceAction.permissionAtom(props.environmentId),
  );
  const supportsStop =
    useEnvironment(props.environmentId)?.serverConfig?.environment.capabilities.localServerStop ===
    true;
  const openPreview = useAtomCommand(previewEnvironment.open, { reportFailure: false });
  const stopServer = useAtomCommand(previewEnvironment.stopLocalServer, {
    label: "thread server stop",
  });
  const actOnInstance = useAtomCommand(previewEnvironment.nxtvironInstanceAction, {
    label: "thread nxtviron instance action",
  });
  const [pendingKey, setPendingKey] = useState<string | null>(null);
  const [visibleCount, setVisibleCount] = useState(SERVER_PAGE_COUNT);

  const reportFailure = (title: string, error: unknown) => {
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title,
        description: error instanceof Error ? error.message : String(error),
      }),
    );
  };

  const runPending = async (key: string, task: () => Promise<void>) => {
    if (pendingKey !== null) return;
    setPendingKey(key);
    await task();
    setPendingKey(null);
  };

  const instancePorts = new Set(
    instances
      .filter((instance) => instance.state === "running")
      .flatMap((instance) => Object.values(instance.ports)),
  );
  const rows: ReadonlyArray<ServerRow> = [
    ...servers
      .filter((server) => !instancePorts.has(server.port))
      .map((server): ServerRow => {
        const key = serverKey(server);
        const { pid } = server;
        return {
          key,
          title: `localhost:${server.port}`,
          subtitle: [server.terminal === null ? "Agent" : "Terminal", server.processName]
            .filter(Boolean)
            .join(" · "),
          url: server.url,
          actions:
            canStop && supportsStop && pid !== null
              ? [
                  {
                    id: `${key}:stop`,
                    label: `Stop localhost:${server.port}`,
                    tooltip: "Stop server",
                    destructive: true,
                    icon: "stop",
                    run: async () => {
                      const result = await stopServer({
                        environmentId: props.environmentId,
                        input: { pid, port: server.port },
                      });
                      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
                        reportFailure("Could not stop server", squashAtomCommandFailure(result));
                      }
                    },
                  },
                ]
              : [],
        };
      }),
    ...instances.map((instance): ServerRow => {
      const key = `nxtviron:${instance.ref}`;
      const port = nxtvironPort(instance);
      const stateLabel = NXTVIRON_STATE_LABEL[instance.state];
      return {
        key,
        title: instance.proxyHostname ?? (port === null ? instance.ref : `localhost:${port}`),
        subtitle: ["nxtviron", instance.process, instance.branch ?? instance.id, stateLabel]
          .filter(Boolean)
          .join(" · "),
        url: instance.state === "running" && port !== null ? `http://localhost:${port}` : null,
        actions: canActOnInstances
          ? nxtvironInstanceActions(instance.state).map((action) => {
              const copy = NXTVIRON_ACTION_COPY[action];
              return {
                id: `${key}:${action}`,
                label: `${copy.verb} ${instance.ref}`,
                tooltip: copy.tooltip,
                destructive: action !== "resume",
                icon: action,
                run: async () => {
                  const result = await actOnInstance({
                    environmentId: props.environmentId,
                    input: { ref: instance.ref, action },
                  });
                  if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
                    reportFailure(copy.failure, squashAtomCommandFailure(result));
                  }
                },
              };
            })
          : [],
      };
    }),
  ];

  if (rows.length === 0) return null;
  const externalClickLabel = isMacPlatform(navigator.platform) ? "⌘-click" : "Ctrl-click";
  const threadRef = scopeThreadRef(props.environmentId, props.threadId);
  const hiddenCount = Math.max(0, rows.length - visibleCount);

  const open = async (url: string, event: MouseEvent<HTMLElement>) => {
    if (event.button > 1) return;
    // Like links: modified and middle clicks go to the system browser.
    if (event.metaKey || event.ctrlKey || event.button === 1) {
      event.preventDefault();
      await readLocalApi()
        ?.shell.openExternal(resolveDiscoveredServerUrl(props.environmentId, url))
        .catch((error: unknown) => reportFailure("Unable to open in browser", error));
      return;
    }
    const result = await openDiscoveredPort({ threadRef, port: { url }, openPreview });
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      reportFailure("Unable to open preview", squashAtomCommandFailure(result));
    }
  };

  return (
    <ThreadDetailsSection headingId="thread-details-servers-heading" title="Servers">
      <ul className="m-0 list-none p-0">
        {rows.slice(0, visibleCount).map((row, index) => {
          const { url } = row;
          return (
            <li
              key={row.key}
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
                      tone={url === null ? "muted" : "default"}
                      multiline
                      disabled={!canOpen || url === null}
                      onClick={url === null ? undefined : (event) => void open(url, event)}
                      onAuxClick={url === null ? undefined : (event) => void open(url, event)}
                    />
                  }
                >
                  <GlobeIcon aria-hidden className={THREAD_DETAILS_PANEL_ICON_CLASS} />
                  {/* The end padding keeps text clear of the action buttons. */}
                  <span
                    className={cn(
                      "flex min-w-0 flex-1 flex-col gap-0.5",
                      row.actions.length === 1 && "pe-6",
                      row.actions.length > 1 && "pe-12",
                    )}
                  >
                    <span className="truncate text-sm font-medium leading-4 text-foreground/85">
                      {row.title}
                    </span>
                    <span className="truncate text-2xs font-normal leading-4 text-muted-foreground">
                      {row.subtitle}
                    </span>
                  </span>
                </TooltipTrigger>
                {url === null ? null : (
                  <TooltipPopup side="left">
                    Open in the browser panel. {externalClickLabel} for your browser.
                  </TooltipPopup>
                )}
              </Tooltip>
              <ServerRowActions
                actions={row.actions}
                pendingKey={pendingKey}
                onRun={(action) => void runPending(action.id, action.run)}
              />
            </li>
          );
        })}
      </ul>
      {rows.length > SERVER_PAGE_COUNT ? (
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
          <MorphIcon
            aria-hidden
            className="size-4 shrink-0"
            icon={hiddenCount > 0 ? ChevronDown : ChevronUp}
          />
          {hiddenCount > 0 ? `Show ${Math.min(hiddenCount, SERVER_PAGE_COUNT)} more` : "Show less"}
        </ThreadDetailsControl>
      ) : null}
    </ThreadDetailsSection>
  );
}

function ServerRowActions(props: {
  readonly actions: ReadonlyArray<ServerRowAction>;
  readonly pendingKey: string | null;
  readonly onRun: (action: ServerRowAction) => void;
}) {
  if (props.actions.length === 0) return null;
  return (
    <div className="pointer-events-none absolute right-1 top-1/2 flex -translate-y-1/2 items-center opacity-0 group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100 pointer-coarse:pointer-events-auto pointer-coarse:opacity-100 [@media(hover:none)]:pointer-events-auto [@media(hover:none)]:opacity-100">
      {props.actions.map((action) => {
        const Icon = ACTION_ICONS[action.icon];
        return (
          <Tooltip key={action.id}>
            <TooltipTrigger
              render={
                <ThreadDetailsControl
                  size="icon-xs"
                  variant="ghost"
                  part="icon"
                  tone={action.destructive ? "destructive" : "default"}
                  aria-label={action.label}
                  disabled={props.pendingKey !== null}
                  onClick={() => props.onRun(action)}
                />
              }
            >
              {props.pendingKey === action.id ? (
                <LoaderCircleIcon aria-hidden className="size-3 animate-spin" />
              ) : (
                <Icon
                  aria-hidden
                  className={cn("size-3", action.icon === "stop" && "fill-current")}
                />
              )}
            </TooltipTrigger>
            <TooltipPopup side="left">{action.tooltip}</TooltipPopup>
          </Tooltip>
        );
      })}
    </div>
  );
}
