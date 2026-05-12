import type { TurnId } from "@forma/contracts";
import {
  buildWorkspacePanelClosedSearch,
  buildWorkspacePanelDiffSearch,
  buildWorkspacePanelEditorSearch,
  buildWorkspacePanelFilesSearch,
  buildWorkspacePanelOpenSearch,
  buildWorkspacePanelSearchFromSnapshot,
  buildWorkspacePanelTurnSearch,
  parseWorkspacePanelRouteSearch,
  resolveWorkspacePanelDisplayMode,
  stripWorkspacePanelSearchParams,
  type WorkspacePanelDisplayMode,
  type WorkspacePanelRouteSearch,
} from "./workspacePanelRouteSearch";

export type DiffRouteSearch = WorkspacePanelRouteSearch;

export {
  buildWorkspacePanelClosedSearch,
  buildWorkspacePanelDiffSearch,
  buildWorkspacePanelEditorSearch,
  buildWorkspacePanelFilesSearch,
  buildWorkspacePanelOpenSearch,
  buildWorkspacePanelSearchFromSnapshot,
  buildWorkspacePanelTurnSearch,
  parseWorkspacePanelRouteSearch,
  resolveWorkspacePanelDisplayMode,
  stripWorkspacePanelSearchParams,
  type WorkspacePanelDisplayMode,
  type WorkspacePanelRouteSearch,
};

export function buildDiffOpenSearch(previous: Record<string, unknown>) {
  return buildWorkspacePanelOpenSearch(previous);
}

export function buildDiffFilesSearch(previous: Record<string, unknown>) {
  return buildWorkspacePanelFilesSearch(previous);
}

export function buildDiffTurnSearch(
  previous: Record<string, unknown>,
  input: { turnId: TurnId; filePath?: string | undefined },
) {
  return buildWorkspacePanelTurnSearch(previous, input);
}

export function buildDiffEditorSearch(
  previous: Record<string, unknown>,
  input: Parameters<typeof buildWorkspacePanelEditorSearch>[1],
) {
  return buildWorkspacePanelEditorSearch(previous, input);
}

export function buildDiffClosedSearch(previous: Record<string, unknown>) {
  return buildWorkspacePanelClosedSearch(previous);
}

export function buildDiffSearchFromSnapshot(
  previous: Record<string, unknown>,
  snapshot: DiffRouteSearch,
) {
  return buildWorkspacePanelSearchFromSnapshot(previous, snapshot);
}

export function parseDiffRouteSearch(search: Record<string, unknown>) {
  return parseWorkspacePanelRouteSearch(search);
}
