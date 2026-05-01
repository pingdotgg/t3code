import type { EnvironmentId, ProjectReadFileResult } from "@forma/contracts";

import { readEnvironmentApi } from "../environmentApi";

const PROJECT_FILE_READ_CACHE_TTL_MS = 15_000;

interface CachedProjectFileRead {
  cachedAt: number;
  result: ProjectReadFileResult;
}

const cachedProjectFileReadsByKey = new Map<string, CachedProjectFileRead>();
const inFlightProjectFileReadsByKey = new Map<string, Promise<ProjectReadFileResult>>();

function buildProjectFileReadCacheKey(input: {
  environmentId: EnvironmentId;
  cwd: string;
  relativePath: string;
}): string {
  return `${input.environmentId}:${input.cwd}:${input.relativePath}`;
}

function readCachedProjectFile(input: {
  environmentId: EnvironmentId;
  cwd: string;
  relativePath: string;
}): ProjectReadFileResult | null {
  const cacheKey = buildProjectFileReadCacheKey(input);
  const cached = cachedProjectFileReadsByKey.get(cacheKey);
  if (!cached) {
    return null;
  }
  if (Date.now() - cached.cachedAt > PROJECT_FILE_READ_CACHE_TTL_MS) {
    cachedProjectFileReadsByKey.delete(cacheKey);
    return null;
  }
  return cached.result;
}

export function peekProjectFileForEditor(input: {
  environmentId: EnvironmentId;
  cwd: string;
  relativePath: string;
}): ProjectReadFileResult | null {
  return readCachedProjectFile(input);
}

export async function loadProjectFileForEditor(
  input: {
    environmentId: EnvironmentId;
    cwd: string;
    relativePath: string;
  },
  options?: {
    force?: boolean;
  },
): Promise<ProjectReadFileResult> {
  if (!options?.force) {
    const cached = readCachedProjectFile(input);
    if (cached) {
      return cached;
    }
  }

  const cacheKey = buildProjectFileReadCacheKey(input);
  if (!options?.force) {
    const inFlight = inFlightProjectFileReadsByKey.get(cacheKey);
    if (inFlight) {
      return inFlight;
    }
  }

  const api = readEnvironmentApi(input.environmentId);
  if (!api) {
    throw new Error("Environment connection is unavailable.");
  }

  const request = api.projects
    .readFile({
      cwd: input.cwd,
      relativePath: input.relativePath,
    })
    .then((result) => {
      cachedProjectFileReadsByKey.set(cacheKey, {
        cachedAt: Date.now(),
        result,
      });
      return result;
    })
    .finally(() => {
      inFlightProjectFileReadsByKey.delete(cacheKey);
    });

  inFlightProjectFileReadsByKey.set(cacheKey, request);
  return request;
}

export function prefetchProjectFileForEditor(input: {
  environmentId: EnvironmentId;
  cwd: string;
  relativePath: string;
}): void {
  if (readCachedProjectFile(input)) {
    return;
  }

  void loadProjectFileForEditor(input).catch(() => undefined);
}

export function storeProjectFileForEditor(input: {
  environmentId: EnvironmentId;
  cwd: string;
  relativePath: string;
  result: ProjectReadFileResult;
}): void {
  cachedProjectFileReadsByKey.set(buildProjectFileReadCacheKey(input), {
    cachedAt: Date.now(),
    result: input.result,
  });
}

export function invalidateProjectFileForEditor(input: {
  environmentId: EnvironmentId;
  cwd: string;
  relativePath: string;
}): void {
  const cacheKey = buildProjectFileReadCacheKey(input);
  cachedProjectFileReadsByKey.delete(cacheKey);
  inFlightProjectFileReadsByKey.delete(cacheKey);
}

export function __resetProjectFileReadCacheForTests(): void {
  cachedProjectFileReadsByKey.clear();
  inFlightProjectFileReadsByKey.clear();
}
