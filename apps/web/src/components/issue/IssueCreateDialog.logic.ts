export function resolveIssueType(
  types: ReadonlyArray<{ readonly id: string }>,
  chosen: string | null,
): string | null {
  if (types.length === 1) return types[0]!.id;
  return types.some((type) => type.id === chosen) ? chosen : null;
}

export function issueCreateBlocked(input: {
  readonly hasScope: boolean;
  readonly canWrite: boolean;
  readonly templates: {
    readonly pending: boolean;
    readonly error?: string | null;
    readonly list: {
      readonly blankIssuesEnabled: boolean;
      readonly templates: ReadonlyArray<unknown>;
    } | null;
  } | null;
  readonly blankChosen: boolean;
  readonly issueTypes: {
    readonly pending: boolean;
    readonly error: string | null;
    readonly count: number;
    readonly chosen: string | null;
  } | null;
}): string | null {
  if (!input.hasScope) return "No project here can file issues.";
  if (!input.canWrite) return "Creating issues needs the source-control write scope.";
  const templates = input.templates;
  if (templates !== null && input.blankChosen) {
    if (templates.list === null) {
      return templates.pending
        ? "Loading templates…"
        : (templates.error ?? "Templates could not be read.");
    }
    if (templates.list?.blankIssuesEnabled === false) {
      return templates.list.templates.length > 0
        ? "This tracker requires a template."
        : "This tracker requires a template, and none can be filled in here.";
    }
  }
  const types = input.issueTypes;
  if (types === null || types.chosen !== null) return null;
  if (types.pending) return "Loading issue types…";
  if (types.error !== null) return `Issue types could not be read: ${types.error}`;
  return types.count === 0 ? "This project offers no issue types." : "Choose an issue type.";
}
