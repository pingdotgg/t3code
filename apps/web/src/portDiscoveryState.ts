import {
  CONFIGURED_LOCAL_SERVER_URLS_MAX_ITEMS,
  PREVIEW_URL_MAX_LENGTH,
  type DiscoveredLocalServer,
  type EnvironmentId,
  type ThreadId,
} from "@t3tools/contracts";
import { isLoopbackHost } from "@t3tools/shared/preview";
import { useMemo } from "react";

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
    } catch {
      // Invalid and non-local project preview URLs are not discovery candidates.
    }
  }
  return bounded;
}

function useDiscoveredPorts(
  environmentId: EnvironmentId | null,
  configuredUrls?: ReadonlyArray<string>,
): ReadonlyArray<DiscoveredLocalServer> {
  return useDiscoveredPortsState(environmentId, configuredUrls).servers;
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
  return useMemo(
    () => ({
      servers: query.data?.servers ?? EMPTY_PORTS,
      configuredUrlProbing: query.data?.configuredUrlProbing === true,
    }),
    [query.data?.configuredUrlProbing, query.data?.servers],
  );
}

export function useThreadDiscoveredPorts(input: {
  readonly environmentId: EnvironmentId | null;
  readonly threadId: ThreadId | null;
}): ReadonlyArray<DiscoveredLocalServer> {
  const ports = useDiscoveredPorts(input.environmentId);
  return useMemo(
    () =>
      input.threadId
        ? ports.filter((port) => port.terminal?.threadId === input.threadId)
        : EMPTY_PORTS,
    [input.threadId, ports],
  );
}
