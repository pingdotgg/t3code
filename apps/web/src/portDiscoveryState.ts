import {
  CONFIGURED_LOCAL_SERVER_URLS_MAX_ITEMS,
  PREVIEW_URL_MAX_LENGTH,
  type DiscoveredLocalServer,
  type EnvironmentId,
  type ThreadId,
} from "@t3tools/contracts";
import { isLoopbackHost } from "@t3tools/shared/preview";
import { useAtomValue } from "@effect/atom-react";
import { AsyncResult, Atom } from "effect/reactivity";

import { previewEnvironment } from "./state/preview";
import { useEnvironmentQuery } from "./state/query";

const EMPTY_PORTS: ReadonlyArray<DiscoveredLocalServer> = Object.freeze([]);

interface DiscoveredPortsState {
  readonly servers: ReadonlyArray<DiscoveredLocalServer>;
  readonly configuredUrlProbing: boolean;
}

export function boundConfiguredLocalServerUrls(
  urls: ReadonlyArray<string> | undefined,
): ReadonlyArray<string> {
  const bounded: string[] = [];
  const seen = new Set<string>();
  for (const raw of urls ?? []) {
    if (raw.length === 0 || raw.length > PREVIEW_URL_MAX_LENGTH || raw.trim().length !== raw.length)
      continue;
    try {
      const url = new URL(raw);
      if (url.protocol !== "http:" && url.protocol !== "https:") continue;
      if (!isLoopbackHost(url.hostname) || url.href.length > PREVIEW_URL_MAX_LENGTH) continue;
      const resourceUrl = new URL(url.href);
      resourceUrl.hash = "";
      if (seen.has(resourceUrl.href)) continue;
      seen.add(resourceUrl.href);
      bounded.push(url.href);
      if (bounded.length >= CONFIGURED_LOCAL_SERVER_URLS_MAX_ITEMS) break;
    } catch {}
  }
  return bounded;
}

const lastDiscoveredServersAtom = Atom.family((_environmentId: EnvironmentId) =>
  Atom.make<ReadonlyArray<DiscoveredLocalServer> | null>(null).pipe(Atom.keepAlive),
);

// The subscription closes with its last reader, so fall back to its last answer until it reopens.
const discoveredServersAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make((get) => {
    const last = lastDiscoveredServersAtom(environmentId);
    const result = get(previewEnvironment.discoveredServers({ environmentId, input: {} }));
    const live = AsyncResult.getOrElse(result, () => null)?.servers;
    if (live === undefined) return get.once(last) ?? EMPTY_PORTS;
    get.set(last, live);
    return live;
  }),
);

const NO_ENVIRONMENT_SERVERS_ATOM = Atom.make(EMPTY_PORTS);

export function useDiscoveredPorts(
  environmentId: EnvironmentId | null,
): ReadonlyArray<DiscoveredLocalServer> {
  return useAtomValue(
    environmentId === null ? NO_ENVIRONMENT_SERVERS_ATOM : discoveredServersAtom(environmentId),
  );
}

export function useDiscoveredPortsState(
  environmentId: EnvironmentId | null,
  configuredUrls?: ReadonlyArray<string>,
): DiscoveredPortsState {
  const boundedConfiguredUrls = boundConfiguredLocalServerUrls(configuredUrls);
  const query = useEnvironmentQuery(
    environmentId === null
      ? null
      : previewEnvironment.discoveredServers({
          environmentId,
          input: boundedConfiguredUrls.length ? { configuredUrls: boundedConfiguredUrls } : {},
        }),
  );
  return {
    servers: query.data?.servers ?? EMPTY_PORTS,
    configuredUrlProbing: query.data?.configuredUrlProbing === true,
  };
}

export function useThreadDiscoveredPorts(input: {
  readonly environmentId: EnvironmentId | null;
  readonly threadId: ThreadId | null;
}): ReadonlyArray<DiscoveredLocalServer> {
  const ports = useDiscoveredPorts(input.environmentId);
  return input.threadId
    ? ports.filter(
        (port) =>
          port.terminal?.threadId === input.threadId || port.agent?.threadId === input.threadId,
      )
    : EMPTY_PORTS;
}
