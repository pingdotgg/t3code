import { TurnId, type TurnDiffScope } from "@t3tools/contracts";

export type DiffView = "chat" | "uncommitted";

export interface DiffRouteSearch {
  diff?: "1" | undefined;
  diffTurnId?: TurnId | undefined;
  diffFilePath?: string | undefined;
  diffScope?: TurnDiffScope | undefined;
  diffView?: DiffView | undefined;
  reviewFinding?: string | undefined;
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
): Omit<T, "diff" | "diffTurnId" | "diffFilePath" | "diffScope" | "diffView" | "reviewFinding"> {
  const {
    diff: _diff,
    diffTurnId: _diffTurnId,
    diffFilePath: _diffFilePath,
    diffScope: _diffScope,
    diffView: _diffView,
    reviewFinding: _reviewFinding,
    ...rest
  } = params;
  return rest as Omit<
    T,
    "diff" | "diffTurnId" | "diffFilePath" | "diffScope" | "diffView" | "reviewFinding"
  >;
}

export function buildClosedDiffRouteSearch(): DiffRouteSearch {
  // Keep the keys present so retainSearchParams doesn't restore a prior open diff state.
  return {
    diff: undefined,
    diffTurnId: undefined,
    diffFilePath: undefined,
    diffScope: undefined,
    diffView: undefined,
    reviewFinding: undefined,
  };
}

export function normalizeDiffRouteSearch(search: DiffRouteSearch): DiffRouteSearch {
  if (search.diff !== "1") {
    return buildClosedDiffRouteSearch();
  }

  return {
    diff: "1",
    ...(!search.diffView && search.diffTurnId ? { diffTurnId: search.diffTurnId } : {}),
    ...(!search.diffView && search.diffTurnId && search.diffFilePath
      ? { diffFilePath: search.diffFilePath }
      : {}),
    ...(!search.diffView && search.diffTurnId && search.diffScope
      ? { diffScope: search.diffScope }
      : {}),
    ...(search.diffView ? { diffView: search.diffView } : {}),
    ...(search.reviewFinding ? { reviewFinding: search.reviewFinding } : {}),
  };
}

export function mergeDiffRouteSearch<T extends Record<string, unknown>>(
  params: T,
  search: DiffRouteSearch,
): Omit<T, "diff" | "diffTurnId" | "diffFilePath" | "diffScope" | "diffView" | "reviewFinding"> &
  DiffRouteSearch {
  return {
    ...stripDiffSearchParams(params),
    ...normalizeDiffRouteSearch(search),
  };
}

export function parseDiffRouteSearch(search: Record<string, unknown>): DiffRouteSearch {
  const diff = isDiffOpenValue(search.diff) ? "1" : undefined;
  const reviewFinding = diff ? normalizeSearchString(search.reviewFinding) : undefined;
  const diffViewRaw = diff ? normalizeSearchString(search.diffView) : undefined;
  const diffView =
    reviewFinding !== undefined
      ? "uncommitted"
      : diffViewRaw === "chat" || diffViewRaw === "uncommitted"
        ? diffViewRaw
        : undefined;
  const diffTurnIdRaw = diff && !diffView ? normalizeSearchString(search.diffTurnId) : undefined;
  const diffTurnId = diffTurnIdRaw ? TurnId.make(diffTurnIdRaw) : undefined;
  const diffFilePath = diff && diffTurnId ? normalizeSearchString(search.diffFilePath) : undefined;
  const diffScopeRaw = diff && diffTurnId ? normalizeSearchString(search.diffScope) : undefined;
  const diffScope =
    diffScopeRaw === "turn" || diffScopeRaw === "snapshot" ? diffScopeRaw : undefined;

  return {
    ...(diff ? { diff } : {}),
    ...(diffTurnId ? { diffTurnId } : {}),
    ...(diffFilePath ? { diffFilePath } : {}),
    ...(diffScope ? { diffScope } : {}),
    ...(diffView ? { diffView } : {}),
    ...(reviewFinding ? { reviewFinding } : {}),
  };
}
