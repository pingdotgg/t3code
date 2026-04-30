export interface PreviewRouteSearch {
  preview?: "1" | undefined;
}

function isPreviewOpenValue(value: unknown): boolean {
  return value === "1" || value === 1 || value === true;
}

export function stripPreviewSearchParams<T extends Record<string, unknown>>(
  params: T,
): Omit<T, "preview"> {
  const { preview: _preview, ...rest } = params;
  return rest as Omit<T, "preview">;
}

export function buildOpenPreviewSearch<T extends Record<string, unknown>>(
  params: T,
): Omit<T, "diff" | "diffTurnId" | "diffFilePath" | "preview"> & PreviewRouteSearch {
  const {
    diff: _diff,
    diffTurnId: _diffTurnId,
    diffFilePath: _diffFilePath,
    ...rest
  } = stripPreviewSearchParams(
    params as T & {
      diff?: unknown;
      diffTurnId?: unknown;
      diffFilePath?: unknown;
    },
  );
  return {
    ...rest,
    diff: undefined,
    diffTurnId: undefined,
    diffFilePath: undefined,
    preview: "1",
  } as Omit<T, "diff" | "diffTurnId" | "diffFilePath" | "preview"> & PreviewRouteSearch;
}

export function parsePreviewRouteSearch(search: Record<string, unknown>): PreviewRouteSearch {
  const preview = isPreviewOpenValue(search.preview) ? "1" : undefined;
  return preview ? { preview } : {};
}
