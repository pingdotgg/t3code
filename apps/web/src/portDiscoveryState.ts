import {
  CONFIGURED_LOCAL_SERVER_URLS_MAX_ITEMS,
  PREVIEW_URL_MAX_LENGTH,
  type DiscoveredLocalServer,
  type EnvironmentId,
  type NxtvironInstance,
  type ThreadId,
} from "@t3tools/contracts";
import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { isLoopbackHost } from "@t3tools/shared/preview";

import { useProject, useQuietThreadShell } from "./state/entities";
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
  return {
    servers: query.data?.servers ?? EMPTY_PORTS,
    configuredUrlProbing: query.data?.configuredUrlProbing === true,
  };
}

const EMPTY_NXTVIRON_INSTANCES: ReadonlyArray<NxtvironInstance> = Object.freeze([]);

const trimTrailingSeparators = (path: string) => path.replace(/[\\/]+$/, "");

/** True when `path` is `root` or inside it; `/a/foobar` is not inside `/a/foo`. */
export function isPathWithin(path: string, root: string): boolean {
  const child = trimTrailingSeparators(path);
  const parent = trimTrailingSeparators(root);
  if (parent === "" || child === "") return false;
  if (child === parent) return true;
  return child.startsWith(`${parent}/`) || child.startsWith(`${parent}\\`);
}

/** nxtviron instances whose working directory is inside the thread's worktree or project. */
export function useThreadNxtvironInstances(input: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}): ReadonlyArray<NxtvironInstance> {
  const thread = useQuietThreadShell(scopeThreadRef(input.environmentId, input.threadId));
  const project = useProject(
    thread === null ? null : scopeProjectRef(input.environmentId, thread.projectId),
  );
  const query = useEnvironmentQuery(
    previewEnvironment.nxtvironInstances({ environmentId: input.environmentId, input: {} }),
  );
  const root = thread?.worktreePath ?? project?.workspaceRoot ?? null;
  const instances = query.data?.instances;
  if (root === null || instances === undefined) return EMPTY_NXTVIRON_INSTANCES;
  return instances.filter((instance) => isPathWithin(instance.workingDir, root));
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
