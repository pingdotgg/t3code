import { TurnId } from "@t3tools/contracts";

export type DiffRouteSource = "unstaged" | "staged";

export interface DiffRouteSearch {
  diff?: "1" | undefined;
  diffSource?: DiffRouteSource | undefined;
  diffTurnId?: TurnId | undefined;
  diffFilePath?: string | undefined;
}

function isDiffOpenValue(value: unknown): boolean {
  return value === "1" || value === 1 || value === true;
}

function normalizeSearchString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

function normalizeDiffSource(value: unknown): DiffRouteSource | undefined {
  const normalized = normalizeSearchString(value);
  return normalized === "unstaged" || normalized === "staged" ? normalized : undefined;
}

export function stripDiffSearchParams<T extends Record<string, unknown>>(
  params: T,
): Omit<T, "diff" | "diffSource" | "diffTurnId" | "diffFilePath"> {
  const {
    diff: _diff,
    diffSource: _diffSource,
    diffTurnId: _diffTurnId,
    diffFilePath: _diffFilePath,
    ...rest
  } = params;
  return rest as Omit<T, "diff" | "diffSource" | "diffTurnId" | "diffFilePath">;
}

export function buildOpenDiffSearch<T extends Record<string, unknown>>(
  params: T,
  options?: { source?: DiffRouteSource | undefined },
): Omit<T, "diff" | "diffSource" | "diffTurnId" | "diffFilePath"> & DiffRouteSearch {
  const rest = stripDiffSearchParams(params);
  return {
    ...rest,
    diff: "1",
    ...(options?.source ? { diffSource: options.source } : {}),
  };
}

export function parseDiffRouteSearch(search: Record<string, unknown>): DiffRouteSearch {
  const diff = isDiffOpenValue(search.diff) ? "1" : undefined;
  const diffSource = diff ? normalizeDiffSource(search.diffSource) : undefined;
  const diffTurnIdRaw = diff && !diffSource ? normalizeSearchString(search.diffTurnId) : undefined;
  const diffTurnId = diffTurnIdRaw ? TurnId.make(diffTurnIdRaw) : undefined;
  const diffFilePath =
    diff && (diffSource || diffTurnId) ? normalizeSearchString(search.diffFilePath) : undefined;

  return {
    ...(diff ? { diff } : {}),
    ...(diffSource ? { diffSource } : {}),
    ...(diffTurnId ? { diffTurnId } : {}),
    ...(diffFilePath ? { diffFilePath } : {}),
  };
}
