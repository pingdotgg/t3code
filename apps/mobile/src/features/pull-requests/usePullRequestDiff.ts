import type { ChangeRequestTerminology } from "@t3tools/client-runtime/source-control-clients";
import {
  EnvironmentId,
  ProjectId,
  type PullRequestListEntry,
  type PullRequestSummary,
} from "@t3tools/contracts";
import { RegistryContext, useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { Atom, type AsyncResult } from "effect/reactivity";
import { useLocale, useMessages } from "gt-react-native";
import { useContext, useLayoutEffect, useMemo, useState } from "react";

import { composerPullRequests } from "../../state/pull-requests";
import { useEnvironmentQuery } from "../../state/query";
import { usePullToRefresh } from "../../state/use-pull-to-refresh";
import {
  getCachedPullRequestDiffPages,
  retainPullRequestDiffPage,
  withWithheldFiles,
  type PullRequestDiffPage,
  type WithheldFileLoad,
} from "./pullRequestDiffPages";

export type PullRequestParams = {
  readonly environmentId: string;
  readonly projectId: string;
  readonly repository: string;
  readonly number: number;
  readonly host?: string;
  readonly navigationUrl?: string;
  readonly navigationId?: number;
  readonly initialSummary?: PullRequestListEntry | PullRequestSummary;
};

export type PullRequestDiffParams = PullRequestParams & { readonly commit?: string };

export function pullRequestTarget(params: PullRequestParams) {
  return {
    environmentId: EnvironmentId.make(params.environmentId),
    input: {
      projectId: ProjectId.make(params.projectId),
      repository: params.repository,
      number: params.number,
      ...(params.host ? { host: params.host } : {}),
    },
  };
}

const NO_PAGES: readonly PullRequestDiffPage[] = [];
const NO_PATHS: readonly string[] = [];

type PullRequestDiffTarget = Parameters<typeof composerPullRequests.diff>[0];

// Keyed by the diff's serialized target, which the hook already holds as its scope.
const withheldFileDiff = (targetKey: string, path: string) => {
  const target = JSON.parse(targetKey) as PullRequestDiffTarget;
  return composerPullRequests.diff({ ...target, input: { ...target.input, path } });
};

// One read per withheld file the reader asked for, so only that file's diff crosses the wire.
const withheldFileDiffsAtom = Atom.family((key: string) => {
  const { targetKey, paths } = JSON.parse(key) as {
    readonly targetKey: string;
    readonly paths: readonly string[];
  };
  return Atom.make((get) => paths.map((path) => get(withheldFileDiff(targetKey, path)))).pipe(
    Atom.withLabel(`mobile:pull-request-withheld-file-diffs:${key}`),
  );
});

export function usePullRequestDiffEntry(navigation: {
  readonly addListener: (
    type: "transitionStart" | "transitionEnd",
    listener: (event: { readonly data: { readonly closing: boolean } }) => void,
  ) => () => void;
}) {
  const [ready, setReady] = useState(false);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- subscribes to navigator transition events and frames to defer the diff until the opening transition ends
  useLayoutEffect(() => {
    if (ready) return;
    let opening = false;
    let closing = false;
    const finish = () => {
      if (!closing) setReady(true);
    };
    const removeStart = navigation.addListener("transitionStart", ({ data }) => {
      closing = data.closing;
      if (!closing) opening = true;
    });
    const removeEnd = navigation.addListener("transitionEnd", ({ data }) => {
      closing = data.closing;
      if (!closing) finish();
    });
    // Initial and unanimated presentations may have no transition events; let the shell paint first.
    let frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => {
        if (!opening) finish();
      });
    });
    // A missing native completion must not strand the route on its loading state.
    const fallback = setTimeout(finish, 1_000);
    return () => {
      removeStart();
      removeEnd();
      cancelAnimationFrame(frame);
      clearTimeout(fallback);
    };
  }, [navigation, ready]);
  return ready;
}

export function usePullRequestDiff(
  params: PullRequestDiffParams,
  terminology: ChangeRequestTerminology,
) {
  const reference = pullRequestTarget(params);
  const target = {
    ...reference,
    input: { ...reference.input, ...(params.commit ? { commit: params.commit } : {}) },
  };
  const key = JSON.stringify(target);
  const messages = useMessages();
  const locale = useLocale();
  const firstPageAtom = composerPullRequests.diff(target);
  const firstPage = useAtomValue(firstPageAtom);
  const refreshFirstPage = useAtomRefresh(firstPageAtom);
  const registry = useContext(RegistryContext);
  const { refreshing, onRefresh } = usePullToRefresh(firstPageAtom);
  const [state, setState] = useState<{
    key: string;
    cursor: string | null;
    pages: readonly PullRequestDiffPage[];
    /** The first page as it stood when a reload was asked for; unset until one is. */
    reloadedFrom?: AsyncResult.AsyncResult<unknown, unknown>;
  }>({ key, cursor: null, pages: NO_PAGES });
  const cursor = state.key === key ? state.cursor : null;
  const reloadedFrom = state.key === key ? state.reloadedFrom : undefined;
  const pageAtom = (pageCursor: string | null) =>
    composerPullRequests.diff({
      ...target,
      input: { ...target.input, ...(pageCursor ? { cursor: pageCursor } : {}) },
    });
  const query = useEnvironmentQuery(pageAtom(cursor));
  const pages = useMemo(() => {
    const loaded = state.key === key ? state.pages : NO_PAGES;
    return query.data ? retainPullRequestDiffPage(loaded, cursor, query.data) : loaded;
  }, [cursor, key, query.data, state.key, state.pages]);
  if (state.key !== key || state.pages !== pages) setState({ key, cursor, pages, reloadedFrom });

  const [withheldLoads, setWithheldLoads] = useState<{
    readonly key: string;
    readonly paths: readonly string[];
  }>({ key: "", paths: NO_PATHS });
  const withheldPaths = withheldLoads.key === key ? withheldLoads.paths : NO_PATHS;
  const withheldResults = useAtomValue(
    withheldFileDiffsAtom(JSON.stringify({ targetKey: key, paths: withheldPaths })),
  );
  const refreshWithheldFiles = () => {
    for (const path of withheldPaths) registry.refresh(withheldFileDiff(key, path));
  };
  const loadWithheldFile = (path: string) => {
    // The read is keyed without the head, so even a first load must not reuse an older one.
    registry.refresh(withheldFileDiff(key, path));
    if (!withheldPaths.includes(path)) setWithheldLoads({ key, paths: [...withheldPaths, path] });
  };
  // A refetch keeps showing the last patch, whose lines may not exist at the new head.
  const withheldRefetching = withheldResults.some((result) => result.waiting);
  const loads = new Map<string, WithheldFileLoad>();
  withheldPaths.forEach((path, index) => {
    const result = withheldResults[index];
    if (result === undefined) return;
    // A failed refetch still carries the last patch; show the failure instead.
    loads.set(
      path,
      result._tag === "Failure"
        ? { status: "error" }
        : result._tag === "Success"
          ? { status: "loaded", result: result.value }
          : { status: "loading" },
    );
  });
  const pagesParsed = useMemo(
    () => getCachedPullRequestDiffPages(pages, key, terminology, messages, locale),
    [key, pages, terminology, messages, locale],
  );
  // The server says whether a withheld file can be read alone; GitHub may refuse the whole diff.
  const withheldFilesReadable = pages[0]?.result.withheldFilesReadable === true;
  const parsed = withWithheldFiles(
    pagesParsed,
    loads,
    withheldFilesReadable,
    key,
    messages,
    locale,
  );
  const patch = useMemo(() => pages.map((page) => page.result.patch).join("\n"), [pages]);
  const nextCursor = pages.at(-1)?.result.nextCursor ?? null;
  // Pull to refresh starts its refetch a tick later; until then the first page's cursor is the old one.
  const reloadStarting = reloadedFrom !== undefined && firstPage === reloadedFrom;
  const canLoadMore =
    nextCursor !== null &&
    nextCursor !== cursor &&
    !query.isPending &&
    query.error === null &&
    !reloadStarting;
  const loadMore = () => {
    if (!canLoadMore) return;
    // Cursors are page numbers, so a page cached before the reload may hold an older head's lines.
    if (reloadedFrom !== undefined) registry.refresh(pageAtom(nextCursor));
    setState({ key, cursor: nextCursor, pages, reloadedFrom });
  };
  const reload = (refreshFirst: () => void) => {
    setState({ key, cursor: null, pages: NO_PAGES, reloadedFrom: firstPage });
    refreshFirst();
    refreshWithheldFiles();
  };
  return {
    ...query,
    /** Reads the whole diff again from page one, whichever page was showing or had failed. */
    refresh: () => reload(refreshFirstPage),
    /** Reads only the page that failed again, keeping the files already loaded. */
    retry: query.refresh,
    parsed,
    loadWithheldFile,
    withheldRefetching,
    patch,
    nextCursor,
    canLoadMore,
    loadMore,
    refreshing,
    onPullRefresh: () => reload(onRefresh),
  };
}
