import { splitsSurrogatePair } from "@t3tools/shared/assistantCitations";
import { Atom } from "effect/reactivity";

export interface IssueListFilters {
  readonly labels: ReadonlyArray<string>;
  /** Kept with the name the picker showed, so the chip can say who without the candidates. */
  readonly assignee: { readonly login: string; readonly name: string | null } | null;
}

/** Shared by the list and the sheets that search a tracker for a label or person. */
export const issueListFiltersAtom = Atom.make<IssueListFilters>({
  labels: [],
  assignee: null,
}).pipe(Atom.keepAlive, Atom.withLabel("mobile:issues:list-filters"));

/** The picks the listed scopes no longer offer, which a picker still lists so they can be removed. */
export function unofferedIssueFilters(
  filters: IssueListFilters,
  offered: {
    readonly labels: ReadonlyArray<{ readonly name: string }>;
    readonly assignees: ReadonlyArray<{ readonly login: string }>;
  },
): IssueListFilters {
  const login = filters.assignee?.login;
  return {
    labels: filters.labels.filter((name) => !offered.labels.some((label) => label.name === name)),
    assignee: offered.assignees.some((actor) => actor.login === login) ? null : filters.assignee,
  };
}

/** A pasted wall of text searches by its start rather than failing the server's 200-unit limit. */
export function issueSearchQuery(typed: string): string {
  const trimmed = typed.trim();
  return trimmed.slice(0, splitsSurrogatePair(trimmed, 200) ? 199 : 200).trim();
}
