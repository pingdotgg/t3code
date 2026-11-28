import type {
  EnvironmentId,
  IssueListCursors,
  IssueListEntry,
  IssueListProjectError,
  IssueListResult,
  IssueListSort,
  IssueScopeRef,
  IssueTrackerSummary,
  SourceControlProviderKind,
} from "@t3tools/contracts";

import { mergeIssueListPage } from "./state/issues.ts";
import { sourceControlClients } from "./sourceControlClients.ts";
import type { EnvironmentProject } from "./state/shell.ts";

export interface EnvironmentIssueEntry extends IssueListEntry {
  readonly environmentId: EnvironmentId;
}

/** Rows from every environment that answered, with any continuation pages laid over them. */
export interface HeldIssuePage {
  /** Which listing (its filters) the pages belong to; another listing starts over. */
  readonly list: string;
  readonly answer: IssueListResult;
  readonly entries: ReadonlyArray<IssueListEntry>;
  readonly errors: ReadonlyArray<IssueListProjectError>;
  /** What continuations reported, each beside the cursors it was asked to carry on. */
  readonly moreErrors: ReadonlyArray<{
    readonly asked: ReadonlyArray<string>;
    readonly errors: ReadonlyArray<IssueListProjectError>;
  }>;
  readonly nextCursors: IssueListCursors;
  /** Why the last "Load more" failed, until a retry succeeds or a new first page arrives. */
  readonly moreFailure: string | null;
  /** How many pages "Load more" laid over the first page, per cursor. */
  readonly depth: Readonly<Record<string, number>>;
  /** A newer first page these rows are being read again under. */
  readonly rereading: IssueListResult | null;
}

export function issueTrackerKey(tracker: Pick<IssueTrackerSummary, "tracker" | "host">): string {
  return `${tracker.tracker} ${tracker.host.toLowerCase()}`;
}

function freshIssuePage(answer: IssueListResult, list: string): HeldIssuePage {
  return {
    list,
    answer,
    entries: answer.entries,
    errors: answer.errors,
    moreErrors: [],
    nextCursors: answer.nextCursors,
    moreFailure: null,
    depth: {},
    rereading: null,
  };
}

/**
 * Continuations are laid over the first page they continue. A new first page of the same list
 * (`list` names its filters) keeps showing the pages held, marked `rereading`, until
 * `rereadIssuePage` has read as deep again under it; another list starts over.
 */
export function holdIssuePages(
  answers: ReadonlyArray<readonly [EnvironmentId, IssueListResult]>,
  pages: ReadonlyMap<EnvironmentId, HeldIssuePage>,
  list = "",
): ReadonlyMap<EnvironmentId, HeldIssuePage> {
  const next = new Map<EnvironmentId, HeldIssuePage>();
  for (const [environmentId, answer] of answers) {
    const previous = pages.get(environmentId);
    next.set(
      environmentId,
      previous?.list !== list
        ? freshIssuePage(answer, list)
        : previous.answer === answer
          ? previous
          : Object.keys(previous.depth).length > 0
            ? { ...previous, rereading: answer }
            : freshIssuePage(answer, list),
    );
  }
  return next;
}

/** Reads the pages "Load more" had reached again under the newer first page, so they show what changed. */
export async function rereadIssuePage(
  page: HeldIssuePage & { readonly rereading: IssueListResult },
  load: (cursors: IssueListCursors) => Promise<IssueListResult | { readonly failure: string }>,
): Promise<HeldIssuePage> {
  let next = freshIssuePage(page.rereading, page.list);
  for (;;) {
    const asked = Object.fromEntries(
      Object.entries(next.nextCursors).filter(
        ([key]) => (next.depth[key] ?? 0) < (page.depth[key] ?? 0),
      ),
    );
    if (Object.keys(asked).length === 0) return next;
    next = continueIssuePage(next, await load(asked), asked);
    if (next.moreFailure !== null) return next;
  }
}

/** The cursors of one tracker host, so its "Load more" leaves the other trackers where they are. */
export function issueCursorsForHost(cursors: IssueListCursors, host: string): IssueListCursors {
  return Object.fromEntries(Object.entries(cursors).filter(([key]) => key.startsWith(`${host} `)));
}

/**
 * Lays the next page over the rows held; a failure keeps them and says why. `asked` is the
 * cursors the page was asked to carry on: only those move, and what an earlier continuation
 * reported for any of them is replaced, so a retry that works takes its error away.
 */
export function continueIssuePage(
  page: HeldIssuePage,
  next: IssueListResult | { readonly failure: string },
  asked: IssueListCursors = page.nextCursors,
): HeldIssuePage {
  if ("failure" in next) return { ...page, moreFailure: next.failure };
  const moreErrors = page.moreErrors.filter((more) => !more.asked.some((key) => key in asked));
  if (next.errors.length > 0) moreErrors.push({ asked: Object.keys(asked), errors: next.errors });
  return {
    list: page.list,
    answer: page.answer,
    entries: mergeIssueListPage(page.entries, next.entries),
    errors: [...page.answer.errors, ...moreErrors.flatMap((more) => more.errors)],
    moreErrors,
    nextCursors: {
      ...Object.fromEntries(Object.entries(page.nextCursors).filter(([key]) => !(key in asked))),
      ...next.nextCursors,
    },
    moreFailure: null,
    depth: {
      ...page.depth,
      ...Object.fromEntries(Object.keys(asked).map((key) => [key, (page.depth[key] ?? 0) + 1])),
    },
    rereading: page.rereading,
  };
}

/** Newest first by the date the trackers were asked to sort on, so merged rows keep that order. */
export function issueOrder(sort: IssueListSort) {
  const date = (issue: IssueListEntry) =>
    Date.parse(sort === "created" ? issue.createdAt : issue.updatedAt);
  return (left: IssueListEntry, right: IssueListEntry) => date(right) - date(left);
}

export function groupIssues(
  held: ReadonlyMap<EnvironmentId, HeldIssuePage>,
  query: string,
  projects: ReadonlyArray<EnvironmentProject>,
  sort: IssueListSort = "updated",
) {
  const byTracker = new Map<
    string,
    {
      tracker: IssueTrackerSummary;
      rows: EnvironmentIssueEntry[];
      errors: Array<{ projectTitle: string; message: string; environmentId: EnvironmentId }>;
      more: EnvironmentId[];
    }
  >();
  const listed = new Set<string>();
  const needle = query.toLowerCase();
  for (const [environmentId, page] of held) {
    for (const tracker of page.answer.trackers) {
      const key = issueTrackerKey(tracker);
      if (!byTracker.has(key)) byTracker.set(key, { tracker, rows: [], errors: [], more: [] });
      const group = byTracker.get(key)!;
      if (!group.tracker.configured && tracker.configured) group.tracker = tracker;
      if (Object.keys(page.nextCursors).some((c) => c.startsWith(`${tracker.host} `)))
        group.more.push(environmentId);
    }
    for (const entry of page.entries) {
      const key = issueTrackerKey(entry);
      const group = byTracker.get(key);
      if (!group) continue;
      // A tracker that cannot search is narrowed here instead.
      if (
        needle.length > 0 &&
        group.tracker.capabilities?.search !== true &&
        !entry.title.toLowerCase().includes(needle) &&
        !entry.displayKey.toLowerCase().includes(needle)
      )
        continue;
      // Environments holding the same repository answer the same issue; the first one keeps it.
      if (listed.has(entry.url)) continue;
      listed.add(entry.url);
      group.rows.push({ ...entry, environmentId });
    }
    for (const error of page.errors) {
      const project = projects.find(
        (p) => p.environmentId === environmentId && p.id === error.projectId,
      );
      const kind = project?.repositoryIdentity?.provider as SourceControlProviderKind | undefined;
      const host = kind
        ? sourceControlClients.changeRequestHost(project?.repositoryIdentity, kind)
        : null;
      const group =
        (host ? byTracker.get(`${kind} ${host.toLowerCase()}`) : undefined) ??
        [...byTracker.values()][0];
      group?.errors.push({ ...error, environmentId });
    }
  }
  for (const group of byTracker.values()) group.rows.sort(issueOrder(sort));
  return [...byTracker.values()].sort((a, b) =>
    issueTrackerKey(a.tracker).localeCompare(issueTrackerKey(b.tracker)),
  );
}

/** The scopes whose labels and people a list filter offers, each reached through one project. */
export function issueFilterScopes(
  held: ReadonlyMap<EnvironmentId, HeldIssuePage>,
  projects: ReadonlyArray<EnvironmentProject>,
) {
  const scopes: Array<{ readonly environmentId: EnvironmentId; readonly input: IssueScopeRef }> =
    [];
  // A repository's scope is the same scope on every server. A bound tracker's scope is not: two
  // accounts, or two servers, may both have an ENG team, so those are deduplicated per server only.
  const fromRepository = new Set<IssueScopeRef>();
  for (const [environmentId, page] of held) {
    for (const project of projects) {
      if (project.environmentId !== environmentId) continue;
      for (const { tracker: kind, host, scope } of sourceControlClients.issueBindings(
        project.repositoryIdentity,
      )) {
        const tracker = page.answer.trackers.find(
          (t) => String(t.tracker) === kind && t.host.toLowerCase() === host.toLowerCase(),
        );
        if (!tracker?.configured || tracker.capabilities === null) continue;
        if (
          scopes.some(
            (s) => s.input.scope.toLowerCase() === scope.toLowerCase() && s.input.host === host,
          )
        )
          continue;
        const input = { projectId: project.id, tracker: tracker.tracker, host, scope };
        fromRepository.add(input);
        scopes.push({ environmentId, input });
      }
    }
    // A tracker bound in settings (a Linear team) is no repository's; the answer names its scope,
    // matched or not. Older servers do not, so their rows stand in.
    const covered: ReadonlyArray<IssueScopeRef> =
      page.answer.scopes ??
      page.entries.map(({ projectId, tracker, host, scope }) => ({
        projectId,
        tracker,
        host,
        scope,
      }));
    for (const input of covered) {
      const host = input.host?.toLowerCase();
      const tracker = page.answer.trackers.find(
        (t) => t.tracker === input.tracker && t.host.toLowerCase() === host,
      );
      if (!tracker?.configured) continue;
      if (!tracker.capabilities?.labels && !tracker.capabilities?.assignees) continue;
      // An answer names each scope once per account; rows standing in for one repeat.
      if (
        scopes.some(
          (s) =>
            (fromRepository.has(s.input) ||
              (page.answer.scopes === undefined && s.environmentId === environmentId)) &&
            s.input.scope.toLowerCase() === input.scope.toLowerCase() &&
            s.input.host?.toLowerCase() === host,
        )
      )
        continue;
      scopes.push({ environmentId, input });
    }
  }
  return scopes;
}
