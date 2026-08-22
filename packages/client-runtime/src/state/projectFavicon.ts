import type { EnvironmentId } from "@t3tools/contracts";

import type { EnvironmentProject } from "./models.ts";
import { buildProjectGroups, derivePhysicalProjectKey } from "./projectGrouping.ts";

export interface ProjectFaviconSource {
  readonly projectKey: string;
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  readonly faviconPath: string | null;
}

export interface LoadedProjectFavicon {
  readonly cacheKey: string;
  readonly src: string;
}

const loadedFavicons = new Map<string, LoadedProjectFavicon>();
const faviconListeners = new Map<string, Set<() => void>>();
const MAX_LOADED_FAVICONS = 256;

function projectFreshness(project: EnvironmentProject): number {
  const updatedAt = Date.parse(project.updatedAt);
  if (Number.isFinite(updatedAt)) return updatedAt;

  const createdAt = Date.parse(project.createdAt);
  return Number.isFinite(createdAt) ? createdAt : 0;
}

function shouldReplaceFaviconSource(
  current: EnvironmentProject,
  candidate: EnvironmentProject,
): boolean {
  const currentHasOverride = current.faviconPath != null;
  const candidateHasOverride = candidate.faviconPath != null;
  if (currentHasOverride !== candidateHasOverride) return candidateHasOverride;

  const freshnessDifference = projectFreshness(candidate) - projectFreshness(current);
  if (freshnessDifference !== 0) return freshnessDifference > 0;

  return derivePhysicalProjectKey(candidate) < derivePhysicalProjectKey(current);
}

export function selectProjectFaviconSources(
  projects: ReadonlyArray<EnvironmentProject>,
): ReadonlyMap<string, ProjectFaviconSource> {
  const sources = new Map<string, ProjectFaviconSource>();
  const groups = buildProjectGroups({
    projects,
    settings: {
      sidebarProjectGroupingMode: "repository",
      sidebarProjectGroupingOverrides: {},
    },
  });

  for (const group of groups) {
    const source = group.members.reduce(
      (current, member) =>
        shouldReplaceFaviconSource(current, member.project) ? member.project : current,
      group.representative,
    );
    const faviconSource: ProjectFaviconSource = {
      projectKey: group.key,
      environmentId: source.environmentId,
      cwd: source.workspaceRoot,
      faviconPath: source.faviconPath ?? null,
    };

    for (const member of group.members) {
      sources.set(member.physicalProjectKey, faviconSource);
    }
  }

  return sources;
}

function notifyFaviconListeners(projectKey: string): void {
  for (const listener of faviconListeners.get(projectKey) ?? []) listener();
}

export function getLoadedProjectFavicon(projectKey: string): LoadedProjectFavicon | null {
  return loadedFavicons.get(projectKey) ?? null;
}

export function rememberProjectFavicon(projectKey: string, favicon: LoadedProjectFavicon): void {
  const existing = loadedFavicons.get(projectKey);
  if (existing?.cacheKey === favicon.cacheKey && existing.src === favicon.src) return;

  loadedFavicons.delete(projectKey);
  loadedFavicons.set(projectKey, favicon);
  if (loadedFavicons.size > MAX_LOADED_FAVICONS) {
    const oldestProjectKey = loadedFavicons.keys().next().value;
    if (oldestProjectKey !== undefined) {
      loadedFavicons.delete(oldestProjectKey);
      notifyFaviconListeners(oldestProjectKey);
    }
  }

  notifyFaviconListeners(projectKey);
}

export function forgetProjectFavicon(projectKey: string, src?: string): void {
  const existing = loadedFavicons.get(projectKey);
  if (!existing || (src !== undefined && existing.src !== src)) return;

  loadedFavicons.delete(projectKey);
  notifyFaviconListeners(projectKey);
}

export function subscribeProjectFavicons(projectKey: string, listener: () => void): () => void {
  let listeners = faviconListeners.get(projectKey);
  if (!listeners) {
    listeners = new Set();
    faviconListeners.set(projectKey, listeners);
  }
  listeners.add(listener);

  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) faviconListeners.delete(projectKey);
  };
}
