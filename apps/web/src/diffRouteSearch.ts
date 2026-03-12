import { TurnId } from "@t3tools/contracts";

export interface DiffRouteSearch {
  diff?: "1" | undefined;
  diffTurnId?: TurnId | undefined;
  diffFilePath?: string | undefined;
}

export interface DiffRouteSearchControls {
  clearDiff?: "1";
}

export type DiffRouteSearchNavigation = DiffRouteSearch & DiffRouteSearchControls;

function isDiffOpenValue(value: unknown): boolean {
  return value === "1" || value === 1 || value === true;
}

function isClearDiffValue(value: unknown): boolean {
  return value === "1" || value === 1 || value === true;
}

function normalizeSearchString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

export function stripDiffSearchParams<T extends object>(
  params: T,
): Omit<T, "diff" | "diffTurnId" | "diffFilePath"> {
  const {
    diff: _diff,
    diffTurnId: _diffTurnId,
    diffFilePath: _diffFilePath,
    ...rest
  } = params as T & {
    diff?: unknown;
    diffTurnId?: unknown;
    diffFilePath?: unknown;
  };
  return rest as Omit<T, "diff" | "diffTurnId" | "diffFilePath">;
}

export function closeDiffSearchParams<T extends object>(
  params: T,
): Omit<T, "diff" | "diffTurnId" | "diffFilePath"> & DiffRouteSearchControls {
  return {
    ...stripDiffSearchParams(params),
    clearDiff: "1",
  };
}

export function parseDiffRouteSearch(search: object): DiffRouteSearch {
  const rawSearch = search as {
    diff?: unknown;
    diffTurnId?: unknown;
    diffFilePath?: unknown;
  };
  const diff = isDiffOpenValue(rawSearch.diff) ? "1" : undefined;
  const diffTurnIdRaw = diff ? normalizeSearchString(rawSearch.diffTurnId) : undefined;
  const diffTurnId = diffTurnIdRaw ? TurnId.makeUnsafe(diffTurnIdRaw) : undefined;
  const diffFilePath =
    diff && diffTurnId ? normalizeSearchString(rawSearch.diffFilePath) : undefined;

  return {
    ...(diff ? { diff } : {}),
    ...(diffTurnId ? { diffTurnId } : {}),
    ...(diffFilePath ? { diffFilePath } : {}),
  };
}

export function parseDiffRouteSearchNavigation(search: object): DiffRouteSearchNavigation {
  const rawSearch = search as {
    clearDiff?: unknown;
  };
  const parsed = parseDiffRouteSearch(search);
  const clearDiff = isClearDiffValue(rawSearch.clearDiff) ? "1" : undefined;

  return {
    ...parsed,
    ...(clearDiff ? { clearDiff } : {}),
  };
}

export function retainDiffSearchParams({
  search,
  next,
}: {
  search: DiffRouteSearchNavigation;
  next: (newSearch: DiffRouteSearchNavigation) => DiffRouteSearchNavigation;
}): DiffRouteSearchNavigation {
  const result = next(search);

  if (result.clearDiff === "1") {
    return result;
  }

  if ("diff" in result) {
    return result;
  }

  return search.diff ? { ...result, diff: search.diff } : result;
}
