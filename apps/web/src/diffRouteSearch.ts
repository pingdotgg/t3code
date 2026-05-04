import { type EnvironmentId, type ThreadId, TurnId } from "@t3tools/contracts";

export interface DiffRouteSearch {
  diff?: "1" | undefined;
  diffTurnId?: TurnId | undefined;
  diffFilePath?: string | undefined;
  /** Secondary thread shown beside the route thread (split view). */
  splitEnvironmentId?: EnvironmentId | undefined;
  splitThreadId?: ThreadId | undefined;
  /**
   * When the diff panel shows a thread other than the route thread (e.g. split secondary pane).
   */
  diffThreadEnvironmentId?: EnvironmentId | undefined;
  diffThreadId?: ThreadId | undefined;
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
): Omit<T, "diff" | "diffTurnId" | "diffFilePath" | "diffThreadEnvironmentId" | "diffThreadId"> {
  const {
    diff: _diff,
    diffTurnId: _diffTurnId,
    diffFilePath: _diffFilePath,
    diffThreadEnvironmentId: _diffThreadEnvironmentId,
    diffThreadId: _diffThreadId,
    ...rest
  } = params;
  return rest as Omit<
    T,
    "diff" | "diffTurnId" | "diffFilePath" | "diffThreadEnvironmentId" | "diffThreadId"
  >;
}

export function stripSplitThreadSearchParams<T extends Record<string, unknown>>(
  params: T,
): Omit<T, "splitEnvironmentId" | "splitThreadId"> {
  const {
    splitEnvironmentId: _splitEnvironmentId,
    splitThreadId: _splitThreadId,
    ...rest
  } = params;
  return rest as Omit<T, "splitEnvironmentId" | "splitThreadId">;
}

export function parseDiffRouteSearch(search: Record<string, unknown>): DiffRouteSearch {
  const diff = isDiffOpenValue(search.diff) ? "1" : undefined;
  const diffTurnIdRaw = diff ? normalizeSearchString(search.diffTurnId) : undefined;
  const diffTurnId = diffTurnIdRaw ? TurnId.make(diffTurnIdRaw) : undefined;
  const diffFilePath = diff && diffTurnId ? normalizeSearchString(search.diffFilePath) : undefined;

  const splitEnvironmentIdRaw = normalizeSearchString(search.splitEnvironmentId);
  const splitThreadIdRaw = normalizeSearchString(search.splitThreadId);
  const splitPair =
    splitEnvironmentIdRaw && splitThreadIdRaw
      ? {
          splitEnvironmentId: splitEnvironmentIdRaw as EnvironmentId,
          splitThreadId: splitThreadIdRaw as ThreadId,
        }
      : null;

  const diffThreadEnvironmentIdRaw = diff
    ? normalizeSearchString(search.diffThreadEnvironmentId)
    : undefined;
  const diffThreadIdRaw = diff ? normalizeSearchString(search.diffThreadId) : undefined;
  const diffThreadPair =
    diff && diffThreadEnvironmentIdRaw && diffThreadIdRaw
      ? {
          diffThreadEnvironmentId: diffThreadEnvironmentIdRaw as EnvironmentId,
          diffThreadId: diffThreadIdRaw as ThreadId,
        }
      : null;

  return {
    ...(diff ? { diff } : {}),
    ...(diffTurnId ? { diffTurnId } : {}),
    ...(diffFilePath ? { diffFilePath } : {}),
    ...(splitPair ? splitPair : {}),
    ...(diffThreadPair ? diffThreadPair : {}),
  };
}
