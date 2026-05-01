import { TurnId } from "@t3tools/contracts";

export interface DiffRouteSearch {
  diffTurnId?: TurnId | undefined;
  diffFilePath?: string | undefined;
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
): Omit<T, "diff" | "diffTurnId" | "diffFilePath"> {
  // "diff" is intentionally still listed here so any legacy URLs with the old
  // open/closed flag are stripped on first interaction; the panel state now
  // lives in the UI store, scoped per thread.
  const { diff: _diff, diffTurnId: _diffTurnId, diffFilePath: _diffFilePath, ...rest } = params;
  return rest as Omit<T, "diff" | "diffTurnId" | "diffFilePath">;
}

export function parseDiffRouteSearch(search: Record<string, unknown>): DiffRouteSearch {
  const diffTurnIdRaw = normalizeSearchString(search.diffTurnId);
  const diffTurnId = diffTurnIdRaw ? TurnId.make(diffTurnIdRaw) : undefined;
  const diffFilePath = diffTurnId ? normalizeSearchString(search.diffFilePath) : undefined;

  return {
    ...(diffTurnId ? { diffTurnId } : {}),
    ...(diffFilePath ? { diffFilePath } : {}),
  };
}
