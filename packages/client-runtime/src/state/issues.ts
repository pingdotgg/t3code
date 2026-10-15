import {
  WS_METHODS,
  issueListCursorKey,
  issueScopeKeyOf,
  threadIssueKeyOf,
  type EnvironmentId,
  type IssueCapabilities,
  type IssueComment,
  type IssueInvolvement,
  type IssueListCursors,
  type IssueListEntry,
  type IssueListResult,
  type IssueRef,
  type IssueScopeRef,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { Atom, type AtomRegistry } from "effect/reactivity";

import {
  createAtomCommandScheduler,
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
} from "./runtime.ts";
import type { EnvironmentRegistry } from "../connection/registry.ts";

/** One row's identity across list pages and detail reads; hosts compare case-insensitively. */
export function issueEntryKey(
  entry: Pick<IssueListEntry, "projectId" | "host" | "scope" | "key"> & {
    readonly tracker: string;
  },
): string {
  return `${entry.projectId}\u0000${threadIssueKeyOf(entry)}`;
}

/**
 * Lay a continuation page over the rows already held. A page only covers the scopes it was asked
 * to continue, so rows from other scopes stay; a row the page repeats replaces the held one, so a
 * title or state that moved between reads shows the newer words. Order stays newest-updated first,
 * which is how every tracker hands them over.
 */
export function mergeIssueListPage(
  held: ReadonlyArray<IssueListEntry>,
  page: ReadonlyArray<IssueListEntry>,
): ReadonlyArray<IssueListEntry> {
  if (held.length === 0) return page;
  const byKey = new Map<string, IssueListEntry>();
  for (const entry of held) byKey.set(issueEntryKey(entry), entry);
  for (const entry of page) byKey.set(issueEntryKey(entry), entry);
  return [...byKey.values()].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
}

type IssueListPage = Pick<IssueListResult, "entries" | "nextCursors" | "errors"> & {
  readonly sources?: IssueListResult["sources"];
  readonly viewers?: IssueListResult["viewers"];
  readonly trackers?: IssueListResult["trackers"];
};
type HeldIssueList = IssueListPage & {
  readonly answer?: Pick<IssueListResult, "viewers"> & {
    readonly trackers?: IssueListResult["trackers"];
  };
  readonly scopeViewers?: ReadonlyMap<string, string | null>;
  readonly restartSources?: ReadonlyArray<IssueScopeRef>;
  readonly firstCursors: IssueListCursors;
  readonly firstKeys: ReadonlySet<string>;
};

type IssueListSource = {
  readonly projectId: string;
  readonly tracker: string;
  readonly host: string;
  readonly scope: string;
};

const sourceKey = (source: IssueListSource) =>
  issueListCursorKey({
    tracker: source.tracker,
    host: source.host,
    scope: issueScopeKeyOf(source),
  });

function cursorKeyOf(key: string, sources: ReadonlyArray<IssueListSource>): string {
  const [prefix = "", ...parts] = key.split(" ");
  if (prefix === "forgejo" && parts.length >= 2) {
    const host = parts.shift()!;
    return `forgejo ${host.toLowerCase()} ${issueScopeKeyOf({ tracker: prefix, scope: parts.join(" ") })}`;
  }
  const host = prefix.toLowerCase();
  const scope = parts.join(" ");
  const native = sources.some(
    (source) =>
      source.tracker === "forgejo" &&
      source.host.toLowerCase() === host &&
      issueScopeKeyOf({ tracker: source.tracker, scope }) === issueScopeKeyOf(source),
  );
  return native ? `${host} ${issueScopeKeyOf({ tracker: "forgejo", scope })}` : key.toLowerCase();
}

const scopeOf = (source: IssueListSource, cursors: ReadonlySet<string>) => {
  const qualified = sourceKey(source);
  const legacy = `${source.host.toLowerCase()} ${issueScopeKeyOf(source)}`;
  return cursors.has(qualified) || !cursors.has(legacy) ? qualified : legacy;
};

const heldSources = (held: HeldIssueList) => held.sources ?? held.entries;
const matchesSource = (error: IssueListPage["errors"][number], source: IssueListSource) =>
  error.projectId === source.projectId &&
  (error.host === undefined || error.host.toLowerCase() === source.host.toLowerCase()) &&
  (error.tracker === undefined || error.tracker === source.tracker);

function failedScopes(
  pool: ReadonlyArray<IssueListSource>,
  errors: IssueListPage["errors"],
  cursors: ReadonlySet<string>,
): ReadonlySet<string> {
  return new Set(
    pool
      .filter((source) => errors.some((error) => matchesSource(error, source)))
      .map((source) => scopeOf(source, cursors)),
  );
}

function issueListViewerChanges(
  held: HeldIssueList,
  page: IssueListPage,
  sources: ReadonlyArray<IssueListSource>,
  cursors: ReadonlySet<string>,
) {
  const previous = held.viewers ?? held.answer?.viewers;
  const previousSources = [...heldSources(held), ...(held.trackers ?? held.answer?.trackers ?? [])];
  const currentSources = [
    ...previousSources,
    ...(page.sources ?? []),
    ...page.entries,
    ...(page.trackers ?? []),
  ];
  const viewerFor = (
    viewers: IssueListResult["viewers"],
    source: IssueListSource,
    pool: ReadonlyArray<Pick<IssueListSource, "tracker" | "host"> & { readonly scope?: string }>,
  ) => {
    if (source.tracker === "forgejo") {
      const scoped = viewers[sourceKey(source)] ?? viewers[issueListCursorKey(source)];
      if (scoped !== undefined) return scoped;
      const mount = issueScopeKeyOf(source).split("/").slice(0, -2).join("/");
      if (
        pool.some(
          (each) =>
            each.tracker === source.tracker &&
            each.host.toLowerCase() === source.host.toLowerCase() &&
            each.scope !== undefined &&
            issueScopeKeyOf({ tracker: each.tracker, scope: each.scope })
              .split("/")
              .slice(0, -2)
              .join("/") !== mount,
        )
      )
        return undefined;
    }
    const qualified = viewers[`${source.tracker} ${source.host.toLowerCase()}`];
    if (qualified !== undefined) return qualified;
    const host = source.host.toLowerCase();
    const legacy = viewers[host];
    if (
      legacy !== undefined &&
      pool.some((each) => each.host.toLowerCase() === host && each.tracker !== source.tracker)
    )
      return undefined;
    return legacy ?? null;
  };
  const scopeViewers = new Map(held.scopeViewers);
  if (previous !== undefined) {
    for (const source of heldSources(held)) {
      const key = sourceKey(source);
      if (scopeViewers.has(key)) continue;
      const viewer = viewerFor(previous, source, previousSources);
      if (viewer !== undefined) scopeViewers.set(key, viewer);
    }
  }
  const changed = new Set<string>();
  if (page.viewers !== undefined) {
    for (const source of sources) {
      const key = sourceKey(source);
      const viewer = viewerFor(page.viewers, source, currentSources);
      if (viewer === undefined) continue;
      if (scopeViewers.has(key) && scopeViewers.get(key) !== viewer)
        changed.add(scopeOf(source, cursors));
      scopeViewers.set(key, viewer);
    }
  }
  return { scopeViewers, changed };
}

export function continueIssueListPage<T extends HeldIssueList>(
  held: T,
  sent: IssueListCursors,
  page: IssueListPage,
  sentFirstCursors: IssueListCursors,
): T & { readonly restartSources?: ReadonlyArray<IssueScopeRef> } {
  if (
    held.firstCursors !== sentFirstCursors ||
    Object.entries(sent).some(([key, cursor]) => held.nextCursors[key] !== cursor)
  ) {
    return held;
  }
  const sources = [...heldSources(held), ...(page.sources ?? []), ...page.entries];
  const keyOf = (key: string) => cursorKeyOf(key, sources);
  const sentScopes = new Set(Object.keys(sent).map(keyOf));
  const cursors = new Set(Object.keys(held.nextCursors).map(keyOf));
  const retried = sources.filter((source) => sentScopes.has(scopeOf(source, cursors)));
  const failed = failedScopes(sources, page.errors, cursors);
  const { scopeViewers, changed } = issueListViewerChanges(
    held,
    page,
    retried.filter((source) => !failed.has(scopeOf(source, cursors))),
    cursors,
  );
  const representatives = new Map<string, Pick<IssueListEntry, "projectId" | "projectTitle">>();
  for (const representative of [...page.entries, ...(page.sources ?? [])]) {
    const scope = scopeOf(representative, cursors);
    const key = sourceKey(representative);
    if (sentScopes.has(scope) && !failed.has(scope) && !representatives.has(key))
      representatives.set(key, representative);
  }
  const rebind = <Row extends IssueListSource & { readonly projectTitle: string }>(
    row: Row,
  ): Row => {
    const representative = representatives.get(sourceKey(row));
    return representative === undefined ||
      (representative.projectId === row.projectId &&
        representative.projectTitle === row.projectTitle)
      ? row
      : { ...row, projectId: representative.projectId, projectTitle: representative.projectTitle };
  };
  const firstKeys = new Set<string>();
  const rebound = held.entries
    .filter((entry) => !changed.has(scopeOf(entry, cursors)))
    .map((entry) => {
      const row = rebind(entry);
      if (held.firstKeys.has(issueEntryKey(entry))) firstKeys.add(issueEntryKey(row));
      return row;
    });
  for (const entry of page.entries) {
    if (changed.has(scopeOf(entry, cursors))) firstKeys.add(issueEntryKey(entry));
  }
  const kept = Object.entries(held.nextCursors).filter(
    ([key]) => sent[key] === undefined || failed.has(keyOf(key)),
  );
  const changedSources = retried.filter((source) => changed.has(scopeOf(source, cursors)));
  const changedCursorKeys = (values: IssueListCursors) => {
    const keys = new Set(Object.keys(values).map(keyOf));
    return new Set(changedSources.map((source) => scopeOf(source, keys)));
  };
  const changedFirst = changedCursorKeys(held.firstCursors);
  const changedNext = changedCursorKeys(page.nextCursors);
  return {
    ...held,
    entries: mergeIssueListPage(rebound, page.entries),
    restartSources: [
      ...new Map(changedSources.map((source) => [sourceKey(source), rebind(source)])).values(),
    ],
    scopeViewers,
    firstKeys,
    firstCursors:
      changed.size === 0
        ? held.firstCursors
        : {
            ...Object.fromEntries(
              Object.entries(held.firstCursors).filter(([key]) => !changedFirst.has(keyOf(key))),
            ),
            ...Object.fromEntries(
              Object.entries(page.nextCursors).filter(([key]) => changedNext.has(keyOf(key))),
            ),
          },
    sources: held.sources?.map(rebind) ?? page.sources,
    nextCursors: { ...Object.fromEntries(kept), ...page.nextCursors },
    errors: [
      ...held.errors.filter((error) => !retried.some((source) => matchesSource(error, source))),
      ...page.errors,
    ],
  };
}

export function refreshIssueListPage<T extends HeldIssueList>(
  held: T,
  fresh: IssueListPage,
  options: {
    readonly source?: Omit<IssueListSource, "tracker"> & { readonly tracker?: string };
    readonly removed?: string | ReadonlySet<string>;
  } = {},
): T {
  const sources = [...(fresh.sources ?? fresh.entries), ...heldSources(held)];
  const requestedSource = options.source;
  const source = requestedSource && {
    ...requestedSource,
    tracker:
      requestedSource.tracker ??
      sources.find(
        (each) =>
          each.projectId === requestedSource.projectId &&
          each.host.toLowerCase() === requestedSource.host.toLowerCase() &&
          issueScopeKeyOf(each) ===
            issueScopeKeyOf({ tracker: each.tracker, scope: requestedSource.scope }),
      )?.tracker ??
      "",
  };
  const cursorSources = [...sources, ...(source ? [source] : [])];
  const keyOf = (key: string) => cursorKeyOf(key, cursorSources);
  const aliases = new Map<string, string>();
  const legacyTrackers = new Map<string, string | null>();
  for (const each of sources) {
    const legacy = keyOf(`${each.host} ${each.scope}`);
    const tracker = legacyTrackers.get(legacy);
    legacyTrackers.set(
      legacy,
      tracker === undefined || tracker === each.tracker ? each.tracker : null,
    );
  }
  for (const each of sources) {
    const qualified = issueListCursorKey(each);
    const legacy = `${each.host} ${each.scope}`;
    if (legacyTrackers.get(keyOf(legacy)) === null) continue;
    if (fresh.nextCursors[qualified] !== undefined) aliases.set(keyOf(legacy), qualified);
    else if (fresh.nextCursors[legacy] !== undefined) aliases.set(keyOf(qualified), legacy);
  }
  const remap = (cursors: IssueListCursors) =>
    Object.fromEntries(
      Object.entries(cursors).map(([key, cursor]) => [
        fresh.nextCursors[key] !== undefined ? key : (aliases.get(keyOf(key)) ?? key),
        cursor,
      ]),
    );
  held = { ...held, firstCursors: remap(held.firstCursors), nextCursors: remap(held.nextCursors) };
  const cursors = new Set(
    [
      ...Object.keys(held.firstCursors),
      ...Object.keys(held.nextCursors),
      ...Object.keys(fresh.nextCursors),
    ].map(keyOf),
  );
  const failed = failedScopes(
    [
      ...(fresh.sources ?? []),
      ...heldSources(held),
      ...(held.restartSources ?? []).map((pending) => ({ ...pending, host: pending.host ?? "" })),
    ],
    fresh.errors,
    cursors,
  );
  const covered = (key: string) =>
    !failed.has(keyOf(key)) && (source === undefined || keyOf(key) === scopeOf(source, cursors));
  const continued = (key: string) =>
    held.nextCursors[key] !== undefined && held.nextCursors[key] !== held.firstCursors[key];
  const keys = new Set([...Object.keys(held.firstCursors), ...Object.keys(held.nextCursors)]);
  const tails = new Set([...keys].filter(continued).map(keyOf));
  const bound =
    source === undefined && fresh.sources !== undefined
      ? new Set(fresh.sources.map((each) => scopeOf(each, cursors)))
      : null;
  const isBound = (key: string) => bound === null || bound.has(keyOf(key));
  const { scopeViewers, changed } = issueListViewerChanges(
    held,
    fresh,
    [...heldSources(held), ...(fresh.sources ?? []), ...fresh.entries].filter((each) => {
      const key = scopeOf(each, cursors);
      return covered(key) && isBound(key);
    }),
    cursors,
  );
  const taken = fresh.entries.filter((entry) => covered(scopeOf(entry, cursors)));
  const freshKeys = new Set(taken.map(issueEntryKey));
  const representatives = new Map<string, string>();
  for (const representative of [...taken, ...(fresh.sources ?? [])]) {
    const scope = scopeOf(representative, cursors);
    if (!representatives.has(scope)) representatives.set(scope, representative.projectId);
  }
  const changedOwners = new Set(
    held.entries
      .filter((entry) => {
        const scope = scopeOf(entry, cursors);
        const owner = representatives.get(scope);
        return covered(scope) && owner !== undefined && owner !== entry.projectId;
      })
      .map((entry) => scopeOf(entry, cursors)),
  );
  const shifted = new Set(
    [...held.entries.filter((entry) => held.firstKeys.has(issueEntryKey(entry))), ...taken]
      .filter((row) => held.firstKeys.has(issueEntryKey(row)) !== freshKeys.has(issueEntryKey(row)))
      .map((row) => scopeOf(row, cursors)),
  );
  const continuing = new Set(Object.keys(fresh.nextCursors).map(keyOf));
  const firstCursors = new Map(
    Object.entries(held.firstCursors).map(([key, cursor]) => [keyOf(key), cursor]),
  );
  const pending = new Set(Object.keys(held.nextCursors).map(keyOf));
  const exhausted = new Set(
    Object.entries(fresh.nextCursors)
      .filter(
        ([key, cursor]) => !pending.has(keyOf(key)) && firstCursors.get(keyOf(key)) === cursor,
      )
      .map(([key]) => keyOf(key)),
  );
  const keep = (key: string) =>
    isBound(key) &&
    (!covered(key) ||
      (continuing.has(keyOf(key)) &&
        (tails.has(keyOf(key)) || exhausted.has(keyOf(key))) &&
        !shifted.has(keyOf(key)) &&
        !changedOwners.has(keyOf(key)) &&
        !changed.has(keyOf(key))));
  const pick = (cursors: IssueListCursors, take: (key: string) => boolean) =>
    Object.fromEntries(Object.entries(cursors).filter(([key]) => take(key)));
  const kept = held.entries.filter((entry) => {
    const scope = scopeOf(entry, cursors);
    const key = issueEntryKey(entry);
    return (
      isBound(scope) &&
      (!covered(scope) ||
        (continuing.has(scope) &&
          !changedOwners.has(scope) &&
          !changed.has(scope) &&
          !held.firstKeys.has(key) &&
          !(typeof options.removed === "string"
            ? key === options.removed
            : options.removed?.has(key))))
    );
  });
  return {
    ...held,
    entries: mergeIssueListPage(kept, taken),
    restartSources: (held.restartSources ?? []).filter((pending) => {
      const key = scopeOf({ ...pending, host: pending.host ?? "" }, cursors);
      return failed.has(key) || (isBound(key) && !covered(key));
    }),
    scopeViewers,
    firstKeys: new Set([
      ...kept.map(issueEntryKey).filter((key) => held.firstKeys.has(key)),
      ...taken.map(issueEntryKey),
    ]),
    nextCursors: {
      ...pick(held.nextCursors, keep),
      ...pick(fresh.nextCursors, (key) => !keep(key)),
    },
    firstCursors: {
      ...pick(held.firstCursors, (key) => isBound(key) && !covered(key)),
      ...pick(fresh.nextCursors, covered),
    },
    sources: source === undefined ? (fresh.sources ?? held.sources) : held.sources,
    errors: [
      ...(source === undefined ? [] : held.errors.filter((error) => !matchesSource(error, source))),
      ...fresh.errors,
    ],
  };
}

export function issueScopeKey(
  environmentId: EnvironmentId,
  scope: { readonly tracker: string; readonly host: string; readonly scope: string },
): string {
  return JSON.stringify([
    environmentId,
    scope.tracker,
    scope.host.toLowerCase(),
    issueScopeKeyOf(scope),
  ]);
}

export function offeredIssueInvolvements(
  trackers: ReadonlyArray<{ readonly capabilities: IssueCapabilities | null }>,
  active: IssueInvolvement,
): ReadonlySet<IssueInvolvement> | null {
  const offered = new Set<IssueInvolvement>([active]);
  let declared = false;
  for (const { capabilities } of trackers) {
    if (capabilities === null) continue;
    if (capabilities.involvements === undefined) return null;
    declared = true;
    for (const involvement of capabilities.involvements) offered.add(involvement);
  }
  return declared ? offered : null;
}

/** Older comments go in front: the detail carries the newest page and pages walk backwards. */
export function prependIssueComments(
  current: ReadonlyArray<IssueComment>,
  older: ReadonlyArray<IssueComment>,
): ReadonlyArray<IssueComment> {
  if (older.length === 0) return current;
  const seen = new Set(current.map((comment) => comment.id));
  return [...older.filter((comment) => !seen.has(comment.id)), ...current];
}

/**
 * Every read goes to a tracker API over the environment, so results are reused for a short while
 * and refreshed explicitly. Mutations run serially per environment: changes to one issue are
 * order-sensitive. Each confirmed write refreshes the detail it touched; the list is refreshed by
 * the page, which knows which listings it is showing.
 */
export function createIssueEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const commandScheduler = createAtomCommandScheduler();
  const serialPerEnvironment = {
    mode: "serial",
    key: ({ environmentId }: { readonly environmentId: string }) => environmentId,
  } as const;
  const detail = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:issues:detail",
    tag: WS_METHODS.issuesDetail,
    staleTimeMs: 30_000,
  });
  const detailRef = ({ projectId, tracker, host, scope, key }: IssueRef): IssueRef => ({
    projectId,
    tracker,
    ...(host === undefined ? {} : { host }),
    scope,
    key,
  });
  const refreshDetail = (
    { environmentId, input }: { readonly environmentId: EnvironmentId; readonly input: IssueRef },
    registry: AtomRegistry.AtomRegistry,
  ) => Effect.sync(() => registry.refresh(detail({ environmentId, input: detailRef(input) })));
  return {
    list: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:issues:list",
      tag: WS_METHODS.issuesList,
      staleTimeMs: 30_000,
    }),
    /**
     * A continuation of the listing, run as a command rather than read as a query: a page is
     * asked for once and laid over the rows held, and a refresh of the first page forgets it.
     */
    listPage: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:issues:list-page",
      tag: WS_METHODS.issuesList,
      scheduler: commandScheduler,
      concurrency: {
        mode: "singleFlight",
        key: ({ environmentId, input }) => JSON.stringify([environmentId, input]),
      },
    }),
    detail,
    resolveUrl: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:issues:resolve-url",
      tag: WS_METHODS.issuesResolveUrl,
      scheduler: commandScheduler,
      concurrency: {
        mode: "singleFlight",
        key: ({ environmentId, input }) => JSON.stringify([environmentId, input]),
      },
    }),
    /** Older comments past the cursor the detail handed over; the panel prepends what arrives. */
    comments: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:issues:comments",
      tag: WS_METHODS.issuesComments,
      scheduler: commandScheduler,
      concurrency: {
        mode: "singleFlight",
        key: ({ environmentId, input }) => JSON.stringify([environmentId, input]),
      },
    }),
    /** Read when the composer opens: what a scope offers a new issue changes with a commit. */
    templates: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:issues:templates",
      tag: WS_METHODS.issuesTemplates,
      staleTimeMs: 5 * 60_000,
    }),
    /** Read when a label or assignee picker opens, not with every issue. */
    candidates: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:issues:candidates",
      tag: WS_METHODS.issuesCandidates,
      staleTimeMs: 60_000,
    }),
    create: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:issues:create",
      tag: WS_METHODS.issuesCreate,
      scheduler: commandScheduler,
      concurrency: serialPerEnvironment,
    }),
    comment: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:issues:comment",
      tag: WS_METHODS.issuesComment,
      scheduler: commandScheduler,
      concurrency: serialPerEnvironment,
      onSuccess: refreshDetail,
    }),
    update: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:issues:update",
      tag: WS_METHODS.issuesUpdate,
      scheduler: commandScheduler,
      concurrency: serialPerEnvironment,
      onSuccess: refreshDetail,
    }),
    setState: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:issues:set-state",
      tag: WS_METHODS.issuesSetState,
      scheduler: commandScheduler,
      concurrency: serialPerEnvironment,
      onSuccess: refreshDetail,
    }),
    react: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:issues:react",
      tag: WS_METHODS.issuesReact,
      scheduler: commandScheduler,
      concurrency: serialPerEnvironment,
      onSuccess: refreshDetail,
    }),
  };
}

export type IssueListAnswer = IssueListResult;
