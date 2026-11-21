import {
  AuthTerminalOperateScope,
  type DesktopPortForward,
  type EnvironmentId,
  type ThreadId,
} from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { useGT } from "gt-react";
import { CableIcon, ClipboardCopyIcon, ExternalLinkIcon, SquareIcon } from "lucide-react";

import { writeTextToClipboard } from "../hooks/useCopyToClipboard";
import { readLocalApi } from "../localApi";
import { useThreadDiscoveredPorts } from "../portDiscoveryState";
import { useEnvironments } from "../state/environments";
import {
  canForwardPorts,
  findPortForward,
  forwardedUrl,
  forwardPort,
  forwardLocalitiesAtom,
  stopPortForward,
  usePortForwards,
} from "../state/portForwards";
import { environmentIdsKey } from "../state/environmentAtomList";
import { useEnvironmentsWithScope } from "../state/session";
import {
  ADDON_ICON_CLASS,
  ITEM_ICON_CLASS,
  type CommandPaletteActionItem,
  type CommandPaletteGroup,
  type CommandPaletteSubmenuItem,
} from "./CommandPalette.logic";
import { toastManager } from "./ui/toast";

/** Prefix of this submenu's group values; the palette rebuilds them live while it is open. */
export const PORT_FORWARD_GROUP_PREFIX = "port-forwards:";

const parsePort = (query: string) => {
  const trimmed = query.trim();
  if (!/^\d{1,5}$/.test(trimmed)) return null;
  const port = Number(trimmed);
  return port >= 1 && port <= 65_535 ? port : null;
};

/** "Forwarded ports": each forward with its actions, then ports to forward from the thread or the query. */
export function useCommandPalettePortForwardItem(input: {
  readonly activeThread: {
    readonly environmentId: EnvironmentId;
    readonly id: ThreadId;
  } | null;
  readonly query: string;
}): CommandPaletteSubmenuItem | null {
  const gt = useGT();
  const forwards = usePortForwards();
  const { environments } = useEnvironments();
  const reachable = environments.filter(
    (environment) => environment.connection.phase === "connected" && canForwardPorts(environment),
  );
  const tunnelling = useEnvironmentsWithScope(reachable, AuthTerminalOperateScope);
  const tunnelled = reachable.filter((environment) => tunnelling.has(environment.environmentId));
  const localities = useAtomValue(
    forwardLocalitiesAtom(environmentIdsKey(tunnelled.map(({ environmentId }) => environmentId))),
  );
  const sources = tunnelled.filter((_, index) => localities[index] === "remote");
  // Only a forwardable thread's servers are listed, so other clients never subscribe to them.
  const threadEnvironmentId = sources.some(
    (environment) => environment.environmentId === input.activeThread?.environmentId,
  )
    ? (input.activeThread?.environmentId ?? null)
    : null;
  const threadServers = useThreadDiscoveredPorts({
    environmentId: threadEnvironmentId,
    threadId: threadEnvironmentId === null ? null : (input.activeThread?.id ?? null),
  });
  if (forwards.length === 0 && sources.length === 0) return null;

  const labelOf = (environmentId: EnvironmentId) =>
    environments.find((environment) => environment.environmentId === environmentId)?.label ??
    environmentId;

  const start = async (environmentId: EnvironmentId, remotePort: number) => {
    const forward = await forwardPort(environmentId, remotePort);
    toastManager.add({
      type: "success",
      title: gt("Forwarded port {port}", { port: remotePort }),
      description: gt("Apps on this machine reach it at localhost:{port}.", {
        port: forward.localPort,
      }),
    });
  };

  const forwardedItem = (forward: DesktopPortForward): CommandPaletteSubmenuItem => {
    const address = `localhost:${forward.localPort}`;
    const environment = labelOf(forward.environmentId);
    return {
      kind: "submenu",
      value: `port-forward:${forward.environmentId}:${forward.remotePort}`,
      title: address,
      description: gt("Port {port} on {environment}", { port: forward.remotePort, environment }),
      searchTerms: [address, String(forward.remotePort), environment, "forwarded port"],
      icon: <CableIcon className={ITEM_ICON_CLASS} />,
      addonIcon: <CableIcon className={ADDON_ICON_CLASS} />,
      groups: [
        {
          value: "port-forward-actions",
          label: address,
          items: [
            {
              kind: "action",
              value: "port-forward:open",
              title: gt("Open in browser"),
              searchTerms: ["open", "browser"],
              icon: <ExternalLinkIcon className={ITEM_ICON_CLASS} />,
              run: async () => {
                await readLocalApi()?.shell.openExternal(forwardedUrl(forward));
              },
            },
            {
              kind: "action",
              value: "port-forward:copy",
              title: gt("Copy address"),
              searchTerms: ["copy", "address", "url"],
              icon: <ClipboardCopyIcon className={ITEM_ICON_CLASS} />,
              run: async () => {
                await writeTextToClipboard(forwardedUrl(forward));
              },
            },
            {
              kind: "action",
              value: "port-forward:stop",
              title: gt("Stop forwarding"),
              searchTerms: ["stop", "remove", "close"],
              icon: <SquareIcon className={ITEM_ICON_CLASS} />,
              run: () => stopPortForward(forward.environmentId, forward.remotePort),
            },
          ],
        },
      ],
    };
  };

  const startItems: CommandPaletteActionItem[] = [];
  for (const server of threadServers) {
    const environmentId = threadEnvironmentId;
    if (environmentId === null) break;
    if (findPortForward(forwards, environmentId, server.port)) continue;
    startItems.push({
      kind: "action",
      value: `port-forward:start:${environmentId}:${server.port}`,
      title: gt("Forward localhost:{port}", { port: server.port }),
      description: labelOf(environmentId),
      searchTerms: [String(server.port), server.processName ?? "", "forward"],
      icon: <CableIcon className={ITEM_ICON_CLASS} />,
      run: () => start(environmentId, server.port),
    });
  }
  const typedPort = parsePort(input.query);
  if (typedPort !== null) {
    for (const environment of sources) {
      if (findPortForward(forwards, environment.environmentId, typedPort)) continue;
      if (
        startItems.some((item) => item.value.endsWith(`:${environment.environmentId}:${typedPort}`))
      )
        continue;
      startItems.push({
        kind: "action",
        value: `port-forward:start:${environment.environmentId}:${typedPort}`,
        title: gt("Forward port {port} from {environment}", {
          port: typedPort,
          environment: environment.label,
        }),
        searchTerms: [String(typedPort), "forward"],
        icon: <CableIcon className={ITEM_ICON_CLASS} />,
        run: () => start(environment.environmentId, typedPort),
      });
    }
  }

  const groups: CommandPaletteGroup[] = [];
  if (forwards.length > 0) {
    groups.push({
      value: `${PORT_FORWARD_GROUP_PREFIX}forwarded`,
      label: gt("Forwarded"),
      items: forwards.map(forwardedItem),
    });
  }
  if (startItems.length === 0 && sources.length > 0) {
    startItems.push({
      kind: "action",
      value: "port-forward:hint",
      title: gt("Type a port number to forward it"),
      searchTerms: [],
      icon: <CableIcon className={ITEM_ICON_CLASS} />,
      disabled: true,
      run: async () => {},
    });
  }
  // Always present, so the open submenu keeps a group to be recognized by.
  groups.push({
    value: `${PORT_FORWARD_GROUP_PREFIX}start`,
    label: startItems.length > 0 ? gt("Forward a port") : "",
    items: startItems,
  });

  return {
    kind: "submenu",
    value: "action:port-forwards",
    title: gt("Forwarded ports"),
    searchTerms: ["forward port", "port forwarding", "forwarded ports", "ports", "tunnel"],
    icon: <CableIcon className={ITEM_ICON_CLASS} />,
    addonIcon: <CableIcon className={ADDON_ICON_CLASS} />,
    groups,
  };
}
