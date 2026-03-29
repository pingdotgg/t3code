import { TurnId } from "@t3tools/contracts";

export type RightPanelTab = "diff" | "browser";

export interface DiffRouteSearch {
  diff?: "1" | undefined;
  diffTurnId?: TurnId | undefined;
  diffFilePath?: string | undefined;
  rpt?: RightPanelTab | undefined;
}

function isDiffOpenValue(value: unknown): boolean {
  return value === "1" || value === 1 || value === true;
}

function isRightPanelTabValue(value: unknown): value is RightPanelTab {
  return value === "diff" || value === "browser";
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
): Omit<T, "diff" | "diffTurnId" | "diffFilePath" | "rpt"> {
  const { diff: _diff, diffTurnId: _diffTurnId, diffFilePath: _diffFilePath, rpt: _rpt, ...rest } = params;
  return rest as Omit<T, "diff" | "diffTurnId" | "diffFilePath" | "rpt">;
}

export function parseDiffRouteSearch(search: Record<string, unknown>): DiffRouteSearch {
  const diff = isDiffOpenValue(search.diff) ? "1" : undefined;
  const diffTurnIdRaw = diff ? normalizeSearchString(search.diffTurnId) : undefined;
  const diffTurnId = diffTurnIdRaw ? TurnId.makeUnsafe(diffTurnIdRaw) : undefined;
  const diffFilePath = diff && diffTurnId ? normalizeSearchString(search.diffFilePath) : undefined;
  const rpt = diff && isRightPanelTabValue(search.rpt) ? search.rpt : undefined;

  return {
    ...(diff ? { diff } : {}),
    ...(diffTurnId ? { diffTurnId } : {}),
    ...(diffFilePath ? { diffFilePath } : {}),
    ...(rpt ? { rpt } : {}),
  };
}
