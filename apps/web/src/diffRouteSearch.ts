import { TurnId } from "@forma/contracts";

export interface DiffRouteSearch {
  diff?: "1" | undefined;
  diffTurnId?: TurnId | undefined;
  diffFilePath?: string | undefined;
  diffView?: "files" | "editor" | undefined;
  editorFilePath?: string | undefined;
  editorLine?: number | undefined;
  editorColumn?: number | undefined;
  editorBackToView?: "diff" | "files" | undefined;
}

export type WorkspacePanelDisplayMode =
  | "closed"
  | "diff"
  | "files"
  | "editor-diff"
  | "editor-files"
  | "editor-standalone";

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

export function stripDiffSearchParams<T extends Record<string, unknown>>(
  params: T,
): Omit<
  T,
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

function buildBaseDiffSearch(previous: Record<string, unknown>) {
  return {
    ...stripDiffSearchParams(previous),
    diff: "1" as const,
  };
}

export function buildDiffOpenSearch(previous: Record<string, unknown>) {
  return buildBaseDiffSearch(previous);
}

export function buildDiffFilesSearch(previous: Record<string, unknown>) {
  const parsedPrevious = parseDiffRouteSearch(previous);
  return {
    ...buildBaseDiffSearch(previous),
    ...(parsedPrevious.diffTurnId ? { diffTurnId: parsedPrevious.diffTurnId } : {}),
    ...(parsedPrevious.diffFilePath ? { diffFilePath: parsedPrevious.diffFilePath } : {}),
    diffView: "files" as const,
  };
}

export function buildDiffTurnSearch(
  previous: Record<string, unknown>,
  input: { turnId: TurnId; filePath?: string | undefined },
) {
  return {
    ...buildBaseDiffSearch(previous),
    diffTurnId: input.turnId,
    ...(input.filePath ? { diffFilePath: input.filePath } : {}),
  };
}

export function buildDiffEditorSearch(
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
  const parsedPrevious = parseDiffRouteSearch(previous);
  const turnId = input.turnId ?? parsedPrevious.diffTurnId;
  const diffFilePath =
    input.turnId !== undefined
      ? input.diffFilePath
      : (input.diffFilePath ?? parsedPrevious.diffFilePath);
  return {
    ...buildBaseDiffSearch(previous),
    ...(turnId ? { diffTurnId: turnId } : {}),
    ...(turnId && diffFilePath ? { diffFilePath } : {}),
    diffView: "editor" as const,
    editorFilePath: input.filePath,
    ...(typeof input.line === "number" ? { editorLine: input.line } : {}),
    ...(typeof input.column === "number" ? { editorColumn: input.column } : {}),
    ...(input.backToView ? { editorBackToView: input.backToView } : {}),
  };
}

export function buildDiffClosedSearch(previous: Record<string, unknown>) {
  return {
    ...stripDiffSearchParams(previous),
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

export function buildDiffSearchFromSnapshot(
  previous: Record<string, unknown>,
  snapshot: DiffRouteSearch,
) {
  if (snapshot.diff !== "1") {
    return buildDiffClosedSearch(previous);
  }

  return {
    ...stripDiffSearchParams(previous),
    diff: "1" as const,
    ...(snapshot.diffTurnId ? { diffTurnId: snapshot.diffTurnId } : {}),
    ...(snapshot.diffFilePath ? { diffFilePath: snapshot.diffFilePath } : {}),
    ...(snapshot.diffView ? { diffView: snapshot.diffView } : {}),
    ...(snapshot.editorFilePath ? { editorFilePath: snapshot.editorFilePath } : {}),
    ...(snapshot.editorLine !== undefined ? { editorLine: snapshot.editorLine } : {}),
    ...(snapshot.editorColumn !== undefined ? { editorColumn: snapshot.editorColumn } : {}),
    ...(snapshot.editorBackToView ? { editorBackToView: snapshot.editorBackToView } : {}),
  };
}

export function parseDiffRouteSearch(search: Record<string, unknown>): DiffRouteSearch {
  const diff = isDiffOpenValue(search.diff) ? "1" : undefined;
  const diffTurnIdRaw = diff ? normalizeSearchString(search.diffTurnId) : undefined;
  const diffTurnId = diffTurnIdRaw ? TurnId.make(diffTurnIdRaw) : undefined;
  const diffFilePath = diff && diffTurnId ? normalizeSearchString(search.diffFilePath) : undefined;
  const diffViewRaw = diff ? normalizeSearchString(search.diffView) : undefined;
  const editorFilePathRaw = diff ? normalizeSearchString(search.editorFilePath) : undefined;
  const diffView =
    diffViewRaw === "files"
      ? ("files" as const)
      : diffViewRaw === "editor" && editorFilePathRaw !== undefined
        ? ("editor" as const)
        : undefined;
  const editorFilePath = diffView === "editor" ? editorFilePathRaw : undefined;
  const editorLine = editorFilePath ? normalizePositiveInteger(search.editorLine) : undefined;
  const editorColumn =
    editorLine !== undefined ? normalizePositiveInteger(search.editorColumn) : undefined;
  const editorBackToViewRaw =
    diffView === "editor" ? normalizeSearchString(search.editorBackToView) : undefined;
  const editorBackToView =
    diffView === "editor"
      ? editorBackToViewRaw === "diff" || editorBackToViewRaw === "files"
        ? editorBackToViewRaw
        : isDiffOpenValue(search.editorBackToDiff)
          ? ("diff" as const)
          : undefined
      : undefined;

  return {
    ...(diff ? { diff } : {}),
    ...(diffTurnId ? { diffTurnId } : {}),
    ...(diffFilePath ? { diffFilePath } : {}),
    ...(diffView ? { diffView } : {}),
    ...(editorFilePath ? { editorFilePath } : {}),
    ...(editorLine !== undefined ? { editorLine } : {}),
    ...(editorColumn !== undefined ? { editorColumn } : {}),
    ...(editorBackToView ? { editorBackToView } : {}),
  };
}

export function resolveWorkspacePanelDisplayMode(
  search: DiffRouteSearch,
): WorkspacePanelDisplayMode {
  if (search.diff !== "1") {
    return "closed";
  }
  if (search.diffView === "files") {
    return "files";
  }
  if (search.diffView === "editor") {
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
