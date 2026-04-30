import { type DiffRouteSearch, parseDiffRouteSearch } from "./diffRouteSearch";
import { type PreviewRouteSearch, parsePreviewRouteSearch } from "./previewRouteSearch";

export type RightPanelMode = "diff" | "preview";

export type RightPanelRouteSearch = DiffRouteSearch & PreviewRouteSearch;

export function parseRightPanelRouteSearch(search: Record<string, unknown>): RightPanelRouteSearch {
  const diffSearch = parseDiffRouteSearch(search);
  if (diffSearch.diff === "1") {
    return diffSearch;
  }
  return parsePreviewRouteSearch(search);
}

export function getRightPanelMode(search: RightPanelRouteSearch): RightPanelMode | null {
  if (search.diff === "1") return "diff";
  if (search.preview === "1") return "preview";
  return null;
}
