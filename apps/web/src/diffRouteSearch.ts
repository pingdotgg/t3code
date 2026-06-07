import { TurnId } from "@t3tools/contracts";

export type DiffSourceParam = "branch" | "working-tree" | "all-turns" | "last-turn";

const DIFF_SOURCE_VALUES: ReadonlySet<string> = new Set([
  "branch",
  "working-tree",
  "all-turns",
  "last-turn",
]);

export interface DiffRouteSearch {
  diff?: "1" | undefined;
  diffSource?: DiffSourceParam | undefined;
  diffBaseRef?: string | undefined;
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

export function stripDiffSearchParams<T extends Record<string, unknown>>(
  params: T,
): Omit<T, "diff" | "diffSource" | "diffBaseRef" | "diffTurnId" | "diffFilePath"> {
  const {
    diff: _diff,
    diffSource: _diffSource,
    diffBaseRef: _diffBaseRef,
    diffTurnId: _diffTurnId,
    diffFilePath: _diffFilePath,
    ...rest
  } = params;
  return rest as Omit<T, "diff" | "diffSource" | "diffBaseRef" | "diffTurnId" | "diffFilePath">;
}

export function parseDiffRouteSearch(search: Record<string, unknown>): DiffRouteSearch {
  const diff = isDiffOpenValue(search.diff) ? "1" : undefined;
  const diffSourceRaw = diff ? normalizeSearchString(search.diffSource) : undefined;
  const diffSource =
    diffSourceRaw && DIFF_SOURCE_VALUES.has(diffSourceRaw)
      ? (diffSourceRaw as DiffSourceParam)
      : undefined;
  const diffBaseRef =
    diff && diffSource === "branch" ? normalizeSearchString(search.diffBaseRef) : undefined;
  const diffTurnIdRaw = diff ? normalizeSearchString(search.diffTurnId) : undefined;
  const diffTurnId = diffTurnIdRaw ? TurnId.make(diffTurnIdRaw) : undefined;
  const diffFilePath = diff ? normalizeSearchString(search.diffFilePath) : undefined;

  return {
    ...(diff ? { diff } : {}),
    ...(diffSource ? { diffSource } : {}),
    ...(diffBaseRef ? { diffBaseRef } : {}),
    ...(diffTurnId ? { diffTurnId } : {}),
    ...(diffFilePath ? { diffFilePath } : {}),
  };
}
