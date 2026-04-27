import { TurnId } from "@forma/contracts";

export interface DiffRouteSearch {
  diff?: "1" | undefined;
  diffTurnId?: TurnId | undefined;
  diffFilePath?: string | undefined;
  diffView?: "editor" | undefined;
  editorFilePath?: string | undefined;
  editorLine?: number | undefined;
  editorColumn?: number | undefined;
  editorBackToDiff?: "1" | undefined;
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
    backToDiff?: boolean | undefined;
  },
) {
  return {
    ...buildBaseDiffSearch(previous),
    ...(input.turnId ? { diffTurnId: input.turnId } : {}),
    ...(input.turnId && input.diffFilePath ? { diffFilePath: input.diffFilePath } : {}),
    diffView: "editor" as const,
    editorFilePath: input.filePath,
    ...(typeof input.line === "number" ? { editorLine: input.line } : {}),
    ...(typeof input.column === "number" ? { editorColumn: input.column } : {}),
    ...(input.backToDiff ? { editorBackToDiff: "1" as const } : {}),
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
    editorBackToDiff: undefined,
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
    diffViewRaw === "editor" && editorFilePathRaw !== undefined ? ("editor" as const) : undefined;
  const editorFilePath = diffView === "editor" ? editorFilePathRaw : undefined;
  const editorLine = editorFilePath ? normalizePositiveInteger(search.editorLine) : undefined;
  const editorColumn =
    editorLine !== undefined ? normalizePositiveInteger(search.editorColumn) : undefined;
  const editorBackToDiff =
    diffView === "editor" && isDiffOpenValue(search.editorBackToDiff) ? ("1" as const) : undefined;

  return {
    ...(diff ? { diff } : {}),
    ...(diffTurnId ? { diffTurnId } : {}),
    ...(diffFilePath ? { diffFilePath } : {}),
    ...(diffView ? { diffView } : {}),
    ...(editorFilePath ? { editorFilePath } : {}),
    ...(editorLine !== undefined ? { editorLine } : {}),
    ...(editorColumn !== undefined ? { editorColumn } : {}),
    ...(editorBackToDiff ? { editorBackToDiff } : {}),
  };
}
