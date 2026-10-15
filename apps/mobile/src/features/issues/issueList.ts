import {
  issueEntryKey,
  issueScopeKey,
  refreshIssueListPage,
} from "@t3tools/client-runtime/state/issues";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import {
  pullRequestHostOf,
  issueScopeKeyOf,
  type EnvironmentId,
  type IssueListEntry,
  type IssueListInput,
  type IssueListResult,
  type IssueScopeRef,
  type IssueTrackerSummary,
  type SourceControlProviderKind,
} from "@t3tools/contracts";
import { sourceControlRepositorySelector } from "@t3tools/shared/sourceControl";
import { Atom, type AtomRegistry } from "effect/reactivity";
import type { IssueListFilters } from "../../persistence/mobile-preferences";

export const ISSUE_LIST_PAGE_SIZE = 50;

export type IssueSourceWrite = {
  readonly revision: number;
  readonly environmentId: EnvironmentId;
  readonly source: IssueScopeRef;
  readonly removedKeys: ReadonlyMap<string, number>;
  readonly updatedAt: number;
  readonly failed?: boolean;
};

export const issueWrites = Atom.make<{
  readonly revision: number;
  readonly sources: ReadonlyMap<string, IssueSourceWrite>;
} | null>(null).pipe(Atom.keepAlive);

export function markIssueWritten(
  registry: AtomRegistry.AtomRegistry,
  environmentId: EnvironmentId,
  source: IssueScopeRef,
  removedKey?: string,
) {
  registry.update(issueWrites, (previous) => {
    const revision = (previous?.revision ?? 0) + 1;
    const now = Date.now();
    const cutoff = now - 5 * 60_000;
    const key = issueScopeKey(environmentId, { ...source, host: source.host ?? "" });
    const sources = new Map(
      [...(previous?.sources ?? [])].filter(([, write]) => write.updatedAt >= cutoff),
    );
    const removedKeys = new Map(
      [...(sources.get(key)?.removedKeys ?? [])].filter(([, updatedAt]) => updatedAt >= cutoff),
    );
    if (removedKey !== undefined) removedKeys.set(removedKey, now);
    sources.set(key, { revision, environmentId, source, removedKeys, updatedAt: now });
    return { revision, sources };
  });
}

export function issueListControlsFor(
  saved: IssueListFilters | undefined,
  environmentIds: ReadonlyArray<string>,
  projects: ReadonlyArray<Pick<EnvironmentProject, "environmentId" | "id">>,
): IssueListFilters {
  const controls = saved ?? { environmentId: null, state: "open", involvement: "all" };
  const environmentId =
    controls.environmentId !== null && environmentIds.includes(controls.environmentId)
      ? controls.environmentId
      : null;
  const { projectId, projectEnvironmentId, ...rest } = controls;
  const projectValid =
    projectId !== undefined &&
    projectEnvironmentId !== undefined &&
    environmentIds.includes(projectEnvironmentId) &&
    (controls.environmentId === null || controls.environmentId === projectEnvironmentId) &&
    projects.some(
      (project) => project.environmentId === projectEnvironmentId && project.id === projectId,
    );
  return { ...rest, environmentId, ...(projectValid ? { projectId, projectEnvironmentId } : {}) };
}

export function createIssueSourceRefreshQueue() {
  const lanes = new Map<string, { next: (() => Promise<void>) | null; task: Promise<void> }>();
  return (key: string, read: () => Promise<void>) => {
    const previous = lanes.get(key);
    if (previous) {
      previous.next = read;
      return previous.task;
    }
    const lane = { next: read as (() => Promise<void>) | null, task: Promise.resolve() };
    lane.task = Promise.resolve().then(async () => {
      try {
        while (lane.next) {
          const next = lane.next;
          lane.next = null;
          await next();
        }
      } finally {
        lanes.delete(key);
      }
    });
    lanes.set(key, lane);
    return lane.task;
  };
}

export const issueSourceRefreshQueue = Atom.family((_listKey: string) =>
  Atom.make(createIssueSourceRefreshQueue).pipe(Atom.setIdleTTL(5 * 60_000)),
);

export function issueListTargetIncludesSource(
  target: { readonly environmentId: EnvironmentId; readonly input: IssueListInput },
  environmentId: EnvironmentId,
  source: IssueScopeRef,
  held: HeldIssueList | null = null,
): boolean {
  const canonical = issueListCanonicalSource(held, source);
  return (
    target.environmentId === environmentId &&
    (target.input.projectId === undefined || target.input.projectId === canonical.projectId) &&
    (target.input.host === undefined ||
      target.input.host.toLowerCase() === source.host?.toLowerCase())
  );
}

export type EnvironmentIssueEntry = IssueListEntry & { readonly environmentId: EnvironmentId };

export interface HeldIssueList {
  readonly answer: IssueListResult;
  readonly entries: ReadonlyArray<IssueListEntry>;
  readonly nextCursors: IssueListResult["nextCursors"];
  readonly firstCursors: IssueListResult["nextCursors"];
  readonly firstKeys: ReadonlySet<string>;
  readonly errors: IssueListResult["errors"];
  readonly sources?: IssueListResult["sources"];
  readonly pendingWrites: ReadonlyMap<string, IssueSourceWrite>;
}

export function heldIssueList(answer: IssueListResult): HeldIssueList {
  return {
    answer,
    entries: answer.entries,
    nextCursors: answer.nextCursors,
    firstCursors: answer.nextCursors,
    firstKeys: new Set(answer.entries.map(issueEntryKey)),
    errors: answer.errors,
    sources: answer.sources,
    pendingWrites: new Map(),
  };
}

export function issueListCanonicalSource(
  held: HeldIssueList | null,
  source: IssueScopeRef,
): IssueScopeRef {
  const matches = (candidate: IssueScopeRef) =>
    candidate.tracker === source.tracker &&
    candidate.host?.toLowerCase() === source.host?.toLowerCase() &&
    issueScopeKeyOf(candidate) === issueScopeKeyOf(source);
  const representative = held?.entries.find(matches) ?? held?.sources?.find(matches);
  return representative ? { ...source, projectId: representative.projectId } : source;
}

export function issueListPendingWrites(
  target: { readonly environmentId: EnvironmentId; readonly input: IssueListInput },
  held: HeldIssueList | null,
  written: ReadonlyMap<string, IssueSourceWrite> | undefined,
  handled: ReadonlyMap<string, number>,
): ReadonlyMap<string, IssueSourceWrite> {
  const pending = new Map(held?.pendingWrites);
  for (const [key, write] of written ?? []) {
    if (
      write.updatedAt >= Date.now() - 5 * 60_000 &&
      (handled.get(key) ?? 0) < write.revision &&
      issueListTargetIncludesSource(target, write.environmentId, write.source, held) &&
      (pending.get(key)?.revision ?? 0) < write.revision
    )
      pending.set(key, {
        ...write,
        removedKeys: new Map([...(pending.get(key)?.removedKeys ?? []), ...write.removedKeys]),
      });
  }
  return pending;
}

export function retainFailedIssueWrites(
  held: HeldIssueList | null,
  writes: ReadonlyMap<string, IssueSourceWrite>,
) {
  if (!held) return held;
  const pendingWrites = new Map(held.pendingWrites);
  for (const [key, write] of writes) {
    const previous = pendingWrites.get(key);
    if ((previous?.revision ?? 0) > write.revision) continue;
    pendingWrites.set(key, {
      ...write,
      removedKeys: new Map([...(previous?.removedKeys ?? []), ...write.removedKeys]),
      failed: true,
    });
  }
  return { ...held, pendingWrites };
}

export function refreshWrittenIssueList(
  held: HeldIssueList | null,
  answer: IssueListResult,
  writes: ReadonlyMap<string, IssueSourceWrite>,
  source?: {
    readonly projectId: string;
    readonly tracker: string;
    readonly host: string;
    readonly scope: string;
  },
) {
  const removed = new Set<string>();
  const handledWrites = new Map<string, number>();
  for (const [key, write] of writes) {
    const canonical = issueListCanonicalSource(held, write.source);
    if (canonical.host === undefined) continue;
    for (const nativeKey of write.removedKeys.keys())
      removed.add(issueEntryKey({ ...canonical, host: canonical.host, key: nativeKey }));
    if (
      !answer.errors.some(
        (error) =>
          error.projectId === canonical.projectId &&
          (error.tracker === undefined || error.tracker === canonical.tracker) &&
          (error.host === undefined || error.host.toLowerCase() === canonical.host?.toLowerCase()),
      )
    )
      handledWrites.set(key, write.revision);
  }
  const page =
    held === null
      ? heldIssueList(answer)
      : {
          ...refreshIssueListPage(held, answer, { ...(source ? { source } : {}), removed }),
          answer: source ? held.answer : answer,
        };
  const pendingWrites = new Map(page.pendingWrites);
  for (const [key, write] of writes) {
    if (handledWrites.has(key)) {
      if ((pendingWrites.get(key)?.revision ?? 0) <= write.revision) pendingWrites.delete(key);
    } else if ((pendingWrites.get(key)?.revision ?? 0) <= write.revision)
      pendingWrites.set(key, { ...write, failed: true });
  }
  return { held: { ...page, pendingWrites }, handledWrites };
}

export type IssueListSource = {
  readonly environmentId: EnvironmentId;
  readonly held: HeldIssueList;
};

export function scopedIssueKey(
  entry: { readonly environmentId: EnvironmentId } & Pick<
    IssueListEntry,
    "projectId" | "host" | "scope" | "key" | "tracker"
  >,
): string {
  return `${entry.environmentId}:${issueEntryKey(entry)}`;
}

const trackerKey = (tracker: Pick<IssueTrackerSummary, "tracker" | "host">) =>
  `${tracker.tracker} ${tracker.host.toLowerCase()}`;

export function issueListRows(
  lists: ReadonlyArray<IssueListSource>,
  query: string,
): EnvironmentIssueEntry[] {
  const needle = query.toLowerCase();
  return lists
    .flatMap(({ environmentId, held }) => {
      const trackers = new Map(
        held.answer.trackers.map((tracker) => [trackerKey(tracker), tracker]),
      );
      return held.entries
        .filter(
          (entry) =>
            needle.length === 0 ||
            trackers.get(trackerKey(entry))?.capabilities?.search === true ||
            entry.title.toLowerCase().includes(needle) ||
            entry.displayKey.toLowerCase().includes(needle),
        )
        .map((entry) => ({ ...entry, environmentId }));
    })
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
}

export function issueListNotices(lists: ReadonlyArray<IssueListSource>): ReadonlyArray<{
  readonly key: string;
  readonly environmentId: EnvironmentId;
  readonly title: string;
  readonly message: string;
}> {
  const notices = lists.flatMap(({ environmentId, held }) => [
    ...held.errors.map((error) => ({
      key: JSON.stringify([
        environmentId,
        "error",
        error.projectId,
        error.tracker ?? null,
        error.host?.toLowerCase() ?? null,
        error.projectTitle,
        error.message,
      ]),
      environmentId,
      title: error.projectTitle,
      message: error.message,
    })),
    ...held.answer.trackers
      .filter((tracker) => !tracker.configured)
      .map((tracker) => ({
        key: JSON.stringify([environmentId, "tracker", trackerKey(tracker), tracker.detail]),
        environmentId,
        title: tracker.host,
        message: tracker.detail ?? "This tracker cannot be read right now.",
      })),
  ]);
  return [...new Map(notices.map((notice) => [notice.key, notice])).values()];
}

export function issueListTrackers(lists: ReadonlyArray<IssueListSource>): IssueTrackerSummary[] {
  const trackers = new Map<string, IssueTrackerSummary>();
  for (const { held } of lists) {
    for (const tracker of held.answer.trackers) {
      const key = trackerKey(tracker);
      const previous = trackers.get(key);
      if (!previous || (!previous.configured && tracker.configured)) trackers.set(key, tracker);
    }
  }
  return [...trackers.values()].sort((a, b) => trackerKey(a).localeCompare(trackerKey(b)));
}

export type IssueCreateScope = {
  readonly environmentId: EnvironmentId;
  readonly projectTitle: string;
  readonly templates: boolean;
  readonly createIssueTypes?: boolean;
  readonly scope: IssueScopeRef & { readonly host: string };
};

function azureDevOpsIssueScope(host: string, displayName: string | undefined): string | null {
  const segments = (displayName ?? "").split("/").filter((part) => part.length > 0);
  const marker = segments.indexOf("_git");
  const hostname = host.split(":")[0]!;
  const legacy = hostname.endsWith(".visualstudio.com");
  const valid = legacy
    ? marker === 1 || (marker === 2 && segments[0]?.toLowerCase() === "defaultcollection")
    : marker === 2;
  if (!valid || segments.length !== marker + 2) return null;
  const organization = legacy ? hostname.slice(0, -".visualstudio.com".length) : segments[0];
  const project = segments[marker - 1];
  if (!organization || !project) return null;
  try {
    const parts = [organization, project].map(decodeURIComponent);
    return parts.every(
      (part) => part.trim().length > 0 && !part.includes("/") && !part.includes("\\"),
    )
      ? parts.join("/")
      : null;
  } catch {
    return null;
  }
}

export function issueCreateScopes(
  lists: ReadonlyArray<IssueListSource>,
  projects: ReadonlyArray<
    Pick<EnvironmentProject, "environmentId" | "id" | "title" | "repositoryIdentity">
  >,
  project?: { readonly environmentId: EnvironmentId; readonly projectId: string },
): IssueCreateScope[] {
  const scopes: IssueCreateScope[] = [];
  const seen = new Set<string>();
  const addScope = (scope: IssueCreateScope) => {
    const key = issueScopeKey(scope.environmentId, scope.scope);
    if (seen.has(key)) return;
    seen.add(key);
    scopes.push(scope);
  };
  for (const { environmentId, held } of lists) {
    if (project && project.environmentId !== environmentId) continue;
    if (held.sources !== undefined) {
      for (const source of held.sources) {
        if (project && source.projectId !== project.projectId) continue;
        const tracker = held.answer.trackers.find(
          (tracker) => trackerKey(tracker) === trackerKey(source),
        );
        if (tracker?.configured === false || !source.capabilities.create) continue;
        addScope({
          environmentId,
          projectTitle: source.projectTitle,
          templates: source.capabilities.templates,
          ...(source.capabilities.createIssueTypes === undefined
            ? {}
            : { createIssueTypes: source.capabilities.createIssueTypes }),
          scope: {
            projectId: source.projectId,
            tracker: source.tracker,
            host: source.host,
            scope: source.scope,
          },
        });
      }
      continue;
    }
    for (const candidate of projects) {
      if (
        candidate.environmentId !== environmentId ||
        (project && candidate.id !== project.projectId)
      )
        continue;
      const identity = candidate.repositoryIdentity;
      const kind = identity?.provider as SourceControlProviderKind | undefined;
      if (!identity || !kind) continue;
      const host = pullRequestHostOf(identity, kind);
      const scope =
        kind === "azure-devops"
          ? azureDevOpsIssueScope(host, identity.displayName)
          : sourceControlRepositorySelector(identity);
      if (scope === null) continue;
      const tracker = held.answer.trackers.find(
        (tracker) =>
          String(tracker.tracker) === kind && tracker.host.toLowerCase() === host.toLowerCase(),
      );
      if (!tracker?.configured || tracker.capabilities?.create !== true) continue;
      addScope({
        environmentId,
        projectTitle: candidate.title,
        templates: tracker.capabilities.templates,
        ...(tracker.capabilities.createIssueTypes === undefined
          ? {}
          : { createIssueTypes: tracker.capabilities.createIssueTypes }),
        scope: { projectId: candidate.id, tracker: tracker.tracker, host, scope },
      });
    }
    for (const entry of held.entries) {
      if (project && entry.projectId !== project.projectId) continue;
      const candidate = projects.find(
        (candidate) =>
          candidate.environmentId === environmentId && candidate.id === entry.projectId,
      );
      if (!candidate) continue;
      const tracker = held.answer.trackers.find(
        (tracker) => trackerKey(tracker) === trackerKey(entry),
      );
      if (!tracker?.configured || tracker.capabilities?.create !== true) continue;
      addScope({
        environmentId,
        projectTitle: candidate.title,
        templates: tracker.capabilities.templates,
        ...(tracker.capabilities.createIssueTypes === undefined
          ? {}
          : { createIssueTypes: tracker.capabilities.createIssueTypes }),
        scope: {
          projectId: candidate.id,
          tracker: entry.tracker,
          host: entry.host,
          scope: entry.scope,
        },
      });
    }
  }
  return scopes;
}
