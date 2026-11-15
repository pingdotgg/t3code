import type {
  EnvironmentId,
  IssueListCursors,
  IssueListEntry,
  IssueListProjectError,
  IssueListResult,
  IssueScopeRef,
  IssueTrackerSummary,
  SourceControlProviderKind,
} from "@t3tools/contracts";

import { mergeIssueListErrors, mergeIssueListPage } from "./state/issues.ts";
import { sourceControlClients } from "./sourceControlClients.ts";
import type { EnvironmentProject } from "./state/shell.ts";

export interface EnvironmentIssueEntry extends IssueListEntry {
  readonly environmentId: EnvironmentId;
}

/** A place a new issue can be filed: one tracker scope, reached through one project. */
export interface IssueCreateScope {
  readonly environmentId: EnvironmentId;
  readonly projectTitle: string;
  readonly scope: IssueScopeRef;
  readonly templates: boolean;
}

/** Rows from every environment that answered, with any continuation pages laid over them. */
export interface HeldIssuePage {
  readonly answer: IssueListResult;
  readonly entries: ReadonlyArray<IssueListEntry>;
  readonly errors: ReadonlyArray<IssueListProjectError>;
  readonly nextCursors: IssueListCursors;
  /** Why the last "Load more" failed, until a retry succeeds or a new first page arrives. */
  readonly moreFailure: string | null;
}

export function issueTrackerKey(tracker: Pick<IssueTrackerSummary, "tracker" | "host">): string {
  return `${tracker.tracker} ${tracker.host.toLowerCase()}`;
}

/** Continuations are laid over the first page they continue; a new first page forgets them. */
export function holdIssuePages(
  answers: ReadonlyArray<readonly [EnvironmentId, IssueListResult]>,
  pages: ReadonlyMap<EnvironmentId, HeldIssuePage>,
): ReadonlyMap<EnvironmentId, HeldIssuePage> {
  const next = new Map<EnvironmentId, HeldIssuePage>();
  for (const [environmentId, answer] of answers) {
    const previous = pages.get(environmentId);
    next.set(
      environmentId,
      previous?.answer === answer
        ? previous
        : {
            answer,
            entries: answer.entries,
            errors: answer.errors,
            nextCursors: answer.nextCursors,
            moreFailure: null,
          },
    );
  }
  return next;
}

/** Lays the next page over the rows held; a failure keeps them and says why. */
export function continueIssuePage(
  page: HeldIssuePage,
  next: IssueListResult | { readonly failure: string },
): HeldIssuePage {
  return "failure" in next
    ? { ...page, moreFailure: next.failure }
    : {
        answer: page.answer,
        entries: mergeIssueListPage(page.entries, next.entries),
        errors: mergeIssueListErrors(page.errors, next.errors),
        nextCursors: next.nextCursors,
        moreFailure: null,
      };
}

export function groupIssues(
  held: ReadonlyMap<EnvironmentId, HeldIssuePage>,
  query: string,
  projects: ReadonlyArray<EnvironmentProject>,
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
  for (const group of byTracker.values()) {
    group.rows.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  }
  return [...byTracker.values()].sort((a, b) =>
    issueTrackerKey(a.tracker).localeCompare(issueTrackerKey(b.tracker)),
  );
}

export function issueCreateScopes(
  held: ReadonlyMap<EnvironmentId, HeldIssuePage>,
  projects: ReadonlyArray<EnvironmentProject>,
): IssueCreateScope[] {
  const scopes: IssueCreateScope[] = [];
  for (const [environmentId, page] of held) {
    for (const project of projects) {
      if (project.environmentId !== environmentId) continue;
      const identity = project.repositoryIdentity;
      const kind = identity?.provider as SourceControlProviderKind | undefined;
      const scope = sourceControlClients.issueScope(identity);
      if (!identity || !kind || scope === null) continue;
      const host = sourceControlClients.changeRequestHost(identity, kind);
      const tracker = page.answer.trackers.find(
        (t) => String(t.tracker) === kind && t.host.toLowerCase() === host.toLowerCase(),
      );
      if (!tracker?.configured || tracker.capabilities?.create !== true) continue;
      if (
        scopes.some(
          (s) => s.scope.scope.toLowerCase() === scope.toLowerCase() && s.scope.host === host,
        )
      )
        continue;
      scopes.push({
        environmentId,
        projectTitle: project.title,
        templates: tracker.capabilities.templates,
        scope: { projectId: project.id, tracker: tracker.tracker, host, scope },
      });
    }
  }
  return scopes;
}
