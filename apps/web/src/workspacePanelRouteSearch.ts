import { TurnId } from "@forma/contracts";

export interface WorkspacePanelRouteSearch {
  panel?: "1" | undefined;
  panelView?: "files" | "editor" | "diff" | "terminal" | undefined;
  diff?: "1" | undefined;
  diffView?: "files" | "editor" | undefined;
  diffTurnId?: TurnId | undefined;
  diffFilePath?: string | undefined;
  editorFilePath?: string | undefined;
  editorLine?: number | undefined;
  editorColumn?: number | undefined;
  editorBackToView?: "diff" | "files" | undefined;
}

export type WorkspacePanelDisplayMode =
  | "closed"
  | "terminal"
  | "diff"
  | "files"
  | "editor-diff"
  | "editor-files"
  | "editor-standalone";

function isPanelOpenValue(value: unknown): boolean {
  return value === "1" || value === 1 || value === true;
}

function normalizeSearchString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

function normalizePositiveInteger(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) {
    return value;
  }
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim();
  if (!/^\d+$/.test(normalized)) {
    return undefined;
  }
  const parsed = Number.parseInt(normalized, 10);
  return parsed > 0 ? parsed : undefined;
}

export function stripWorkspacePanelSearchParams<T extends Record<string, unknown>>(
  params: T,
): Omit<
  T,
  | "panel"
  | "panelView"
  | "diff"
  | "diffTurnId"
  | "diffFilePath"
  | "diffView"
  | "editorFilePath"
  | "editorLine"
  | "editorColumn"
  | "editorBackToView"
  | "editorBackToDiff"
> {
  const {
    panel: _panel,
    panelView: _panelView,
    diff: _diff,
    diffTurnId: _diffTurnId,
    diffFilePath: _diffFilePath,
    diffView: _diffView,
    editorFilePath: _editorFilePath,
    editorLine: _editorLine,
    editorColumn: _editorColumn,
    editorBackToView: _editorBackToView,
    editorBackToDiff: _editorBackToDiff,
    ...rest
  } = params;
  return rest as Omit<
    T,
    | "panel"
    | "panelView"
    | "diff"
    | "diffTurnId"
    | "diffFilePath"
    | "diffView"
    | "editorFilePath"
    | "editorLine"
    | "editorColumn"
    | "editorBackToView"
    | "editorBackToDiff"
  >;
}

function buildBaseWorkspacePanelSearch(previous: Record<string, unknown>) {
  return {
    ...stripWorkspacePanelSearchParams(previous),
    panel: "1" as const,
  };
}

export function buildWorkspacePanelOpenSearch(previous: Record<string, unknown>) {
  return {
    ...buildBaseWorkspacePanelSearch(previous),
    panelView: "diff" as const,
  };
}

export function buildWorkspacePanelFilesSearch(previous: Record<string, unknown>) {
  const parsedPrevious = parseWorkspacePanelRouteSearch(previous);
  return {
    ...buildBaseWorkspacePanelSearch(previous),
    ...(parsedPrevious.diffTurnId ? { diffTurnId: parsedPrevious.diffTurnId } : {}),
    ...(parsedPrevious.diffFilePath ? { diffFilePath: parsedPrevious.diffFilePath } : {}),
    panelView: "files" as const,
  };
}

export function buildWorkspacePanelTerminalSearch(previous: Record<string, unknown>) {
  return {
    ...buildBaseWorkspacePanelSearch(previous),
    panelView: "terminal" as const,
  };
}

export function buildWorkspacePanelDiffSearch(
  previous: Record<string, unknown>,
  input?: { turnId?: TurnId | undefined; filePath?: string | undefined },
) {
  const parsedPrevious = parseWorkspacePanelRouteSearch(previous);
  const turnId = input?.turnId ?? parsedPrevious.diffTurnId;
  const filePath =
    input?.turnId !== undefined ? input.filePath : (input?.filePath ?? parsedPrevious.diffFilePath);
  return {
    ...buildBaseWorkspacePanelSearch(previous),
    ...(turnId ? { diffTurnId: turnId } : {}),
    ...(turnId && filePath ? { diffFilePath: filePath } : {}),
    panelView: "diff" as const,
  };
}

export function buildWorkspacePanelTurnSearch(
  previous: Record<string, unknown>,
  input: { turnId: TurnId; filePath?: string | undefined },
) {
  return buildWorkspacePanelDiffSearch(previous, input);
}

export function buildWorkspacePanelEditorSearch(
  previous: Record<string, unknown>,
  input: {
    filePath: string;
    line?: number | undefined;
    column?: number | undefined;
    turnId?: TurnId | undefined;
    diffFilePath?: string | undefined;
    backToView?: "diff" | "files" | undefined;
  },
) {
  const parsedPrevious = parseWorkspacePanelRouteSearch(previous);
  const turnId = input.turnId ?? parsedPrevious.diffTurnId;
  const diffFilePath =
    input.turnId !== undefined
      ? input.diffFilePath
      : (input.diffFilePath ?? parsedPrevious.diffFilePath);
  return {
    ...buildBaseWorkspacePanelSearch(previous),
    panelView: "editor" as const,
    ...(turnId ? { diffTurnId: turnId } : {}),
    ...(turnId && diffFilePath ? { diffFilePath } : {}),
    editorFilePath: input.filePath,
    ...(typeof input.line === "number" ? { editorLine: input.line } : {}),
    ...(typeof input.column === "number" ? { editorColumn: input.column } : {}),
    ...(input.backToView ? { editorBackToView: input.backToView } : {}),
  };
}

export function buildWorkspacePanelClosedSearch(previous: Record<string, unknown>) {
  return {
    ...stripWorkspacePanelSearchParams(previous),
    panel: undefined,
    panelView: undefined,
    diff: undefined,
    diffTurnId: undefined,
    diffFilePath: undefined,
    diffView: undefined,
    editorFilePath: undefined,
    editorLine: undefined,
    editorColumn: undefined,
    editorBackToView: undefined,
    editorBackToDiff: undefined,
  };
}

export function buildWorkspacePanelSearchFromSnapshot(
  previous: Record<string, unknown>,
  snapshot: WorkspacePanelRouteSearch,
) {
  const panelOpen = snapshot.panel === "1" || snapshot.diff === "1";
  if (!panelOpen) {
    return buildWorkspacePanelClosedSearch(previous);
  }

  return {
    ...stripWorkspacePanelSearchParams(previous),
    panel: "1" as const,
    ...((snapshot.panelView ?? snapshot.diffView)
      ? { panelView: snapshot.panelView ?? snapshot.diffView }
      : {}),
    ...(snapshot.diffTurnId ? { diffTurnId: snapshot.diffTurnId } : {}),
    ...(snapshot.diffFilePath ? { diffFilePath: snapshot.diffFilePath } : {}),
    ...(snapshot.editorFilePath ? { editorFilePath: snapshot.editorFilePath } : {}),
    ...(snapshot.editorLine !== undefined ? { editorLine: snapshot.editorLine } : {}),
    ...(snapshot.editorColumn !== undefined ? { editorColumn: snapshot.editorColumn } : {}),
    ...(snapshot.editorBackToView ? { editorBackToView: snapshot.editorBackToView } : {}),
  };
}

export function parseWorkspacePanelRouteSearch(
  search: Record<string, unknown>,
): WorkspacePanelRouteSearch {
  const panel = isPanelOpenValue(search.panel) || isPanelOpenValue(search.diff) ? "1" : undefined;
  const diffTurnIdRaw = panel ? normalizeSearchString(search.diffTurnId) : undefined;
  const diffTurnId = diffTurnIdRaw ? TurnId.make(diffTurnIdRaw) : undefined;
  const diffFilePath = panel && diffTurnId ? normalizeSearchString(search.diffFilePath) : undefined;
  const panelViewRaw = panel
    ? (normalizeSearchString(search.panelView) ?? normalizeSearchString(search.diffView))
    : undefined;
  const editorFilePathRaw = panel ? normalizeSearchString(search.editorFilePath) : undefined;
  const panelView =
    panelViewRaw === "files"
      ? ("files" as const)
      : panelViewRaw === "editor" && editorFilePathRaw !== undefined
        ? ("editor" as const)
        : panelViewRaw === "terminal"
          ? ("terminal" as const)
          : panel
            ? ("diff" as const)
            : undefined;
  const editorFilePath = panelView === "editor" ? editorFilePathRaw : undefined;
  const editorLine = editorFilePath ? normalizePositiveInteger(search.editorLine) : undefined;
  const editorColumn =
    editorLine !== undefined ? normalizePositiveInteger(search.editorColumn) : undefined;
  const editorBackToViewRaw =
    panelView === "editor" ? normalizeSearchString(search.editorBackToView) : undefined;
  const editorBackToView =
    panelView === "editor"
      ? editorBackToViewRaw === "diff" || editorBackToViewRaw === "files"
        ? editorBackToViewRaw
        : isPanelOpenValue(search.editorBackToDiff)
          ? ("diff" as const)
          : undefined
      : undefined;

  return {
    ...(panel ? { panel } : {}),
    ...(panelView ? { panelView } : {}),
    ...(diffTurnId ? { diffTurnId } : {}),
    ...(diffFilePath ? { diffFilePath } : {}),
    ...(editorFilePath ? { editorFilePath } : {}),
    ...(editorLine !== undefined ? { editorLine } : {}),
    ...(editorColumn !== undefined ? { editorColumn } : {}),
    ...(editorBackToView ? { editorBackToView } : {}),
  };
}

export function resolveWorkspacePanelDisplayMode(
  search: WorkspacePanelRouteSearch,
): WorkspacePanelDisplayMode {
  if (search.panel !== "1") {
    return "closed";
  }
  if (search.panelView === "terminal") {
    return "terminal";
  }
  if (search.panelView === "files") {
    return "files";
  }
  if (search.panelView === "editor") {
    if (search.editorBackToView === "files") {
      return "editor-files";
    }
    if (search.editorBackToView === "diff" || search.diffTurnId) {
      return "editor-diff";
    }
    return "editor-standalone";
  }
  return "diff";
}
