const VISIBLE_CHOICES = 30;

export interface IssueLabelChoice {
  readonly name: string;
  readonly description?: string | null;
  readonly color: string | null;
}

export interface IssueAssigneeChoice {
  readonly login: string;
  readonly name: string | null;
}

export function matchesIssueFilterQuery(
  needle: string,
  ...fields: ReadonlyArray<string | null | undefined>
): boolean {
  return needle.length === 0 || fields.some((field) => field?.toLowerCase().includes(needle));
}

export function issueFilterLabelChoices(
  known: ReadonlyArray<IssueLabelChoice>,
  selected: ReadonlyArray<string>,
  query: string,
): ReadonlyArray<IssueLabelChoice> {
  const needle = query.trim().toLowerCase();
  const knownNames = new Set(known.map((label) => label.name));
  // Unoffered picks lead so one the tracker's first page lacks can still be seen and cleared.
  const combined: ReadonlyArray<IssueLabelChoice> = [
    ...[...new Set(selected)]
      .filter((name) => !knownNames.has(name))
      .map((name) => ({ name, description: null, color: null })),
    ...known,
  ];
  return combined
    .filter((label) => matchesIssueFilterQuery(needle, label.name, label.description))
    .slice(0, VISIBLE_CHOICES);
}

export function issueFilterAssigneeChoices(
  known: ReadonlyArray<IssueAssigneeChoice>,
  selected: string | undefined,
  query: string,
): ReadonlyArray<IssueAssigneeChoice> {
  const needle = query.trim().toLowerCase();
  const combined: ReadonlyArray<IssueAssigneeChoice> = [
    ...(selected !== undefined && !known.some((actor) => actor.login === selected)
      ? [{ login: selected, name: null }]
      : []),
    ...known,
  ];
  return combined
    .filter((actor) => matchesIssueFilterQuery(needle, actor.login, actor.name))
    .slice(0, VISIBLE_CHOICES);
}
