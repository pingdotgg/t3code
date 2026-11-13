// @effect-diagnostics anyUnknownInErrorContext:off
import { isSshRemoteUrl } from "@t3tools/shared/sourceControl";
import { parseDiffFilePaths } from "@t3tools/source-control-core/server/diffFileRevisions";
import * as Cache from "effect/Cache";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import {
  PullRequestOperationError,
  PullRequestUnavailableError,
  resolvePullRequestAuthorFilter,
  type OrchestrationProjectShell,
  type ProjectId,
  type PullRequestAction,
  type PullRequestActionInput,
  type PullRequestActivity,
  type PullRequestCommentInput,
  type PullRequestCommentUpdateInput,
  type PullRequestDetail,
  type PullRequestPreview,
  type PullRequestChecks,
  type PullRequestDiffFileContentsInput,
  type PullRequestDiffFileContentsResult,
  type PullRequestDiffStat,
  type PullRequestDiffInput,
  type PullRequestChangeBreakdown,
  type PullRequestFilesViewedResult,
  type PullRequestDiffResult,
  type PullRequestInvalidateInput,
  type PullRequestReportStateInput,
  type PullRequestListEntry,
  type PullRequestListFilters,
  type PullRequestListInput,
  type PullRequestListProjectError,
  type PullRequestListResult,
  type PullRequestListStatsInput,
  type PullRequestFilterOptions,
  type PullRequestFilterOptionsInput,
  type PullRequestActor,
  type PullRequestLabel,
  type PullRequestListStatsResult,
  type PullRequestProviderSummary,
  type PullRequestReactionInput,
  type PullRequestRef,
  type PullRequestRoutingResult,
  type PullRequestRoutingIdentityInput,
  type PullRequestRoutingIdentityResult,
  type PullRequestReviewVerdict,
  type PullRequestReviewerCandidateList,
  type PullRequestReviewerRequestInput,
  type PullRequestLabelCandidateList,
  type PullRequestLabelChangeInput,
  type PullRequestSetFilesViewedInput,
  type PullRequestState,
  type PullRequestSubmitReviewInput,
  PullRequestStack,
  PullRequestSummary,
  type PullRequestThreadReplyInput,
  type PullRequestThreadResolutionInput,
  type PullRequestThreadCommentsInput,
  type PullRequestThreadCommentsResult,
  type PullRequestUpdateInput,
  type SourceControlProviderInfo,
  SourceControlProviderKind,
  type ThreadPullRequestKey,
} from "@t3tools/contracts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import { sourceControlDefinitions } from "../sourceControl/sourceControlDefinitions.ts";

import * as ProjectService from "../project/ProjectService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as PullRequestFilesViewed from "../persistence/PullRequestFilesViewed.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import * as SourceControlProviderRegistry from "../sourceControl/SourceControlProviderRegistry.ts";
import type { SourceControlProviderContext } from "@t3tools/source-control-core/server/SourceControlProvider";
import * as SourceControlRateLimit from "@t3tools/source-control-core/server/SourceControlRateLimit";
import {
  type ProviderChangeRequest,
  type ProviderDiffFilePaths,
  type ProviderFilterOptionPage,
  type ProviderListCursor,
  type ProviderChangeRequestWatchFingerprint,
  type PullRequestProviderApi,
  PullRequestProviderError,
} from "@t3tools/source-control-core/server/PullRequestProvider";
import * as PullRequestReadCache from "./PullRequestReadCache.ts";
import * as PullRequestProviderRegistry from "./PullRequestProviderRegistry.ts";
import * as ViewedFiles from "./pullRequestViewedFiles.ts";
import { toChangeBreakdown } from "./pullRequestChangeBreakdown.ts";
import type { PullRequestService } from "./PullRequestService.ts";
import { DEFAULT_REPOSITORY_LIST_LIMIT, FILTERED_LIST_READS, LABEL_CHANGE_REFUSAL, LIST_CACHE_CAPACITY, LIST_CACHE_TTL, LIST_STATS_CACHE_CAPACITY, LIST_STATS_CACHE_TTL, REPOSITORY_CONCURRENCY, REPOSITORY_SEARCH_CHUNK, isProviderUnusable, listCursorAt, nextListCursor, observeRead, parseListCursor, providerDetail, rankFilterOptions, type SuccessOf } from "./pullRequestSupport.ts";
import type { ListCursor, PullRequestError, RepositoryBatch, SupportedProject } from "./pullRequestSupport.ts";
import { installRuntime } from "./pullRequestRuntime.ts";
import { installEpochs } from "./pullRequestEpochs.ts";
import { installWorkspace } from "./pullRequestWorkspace.ts";
import { installRouting } from "./pullRequestRouting.ts";
import { installDetailReads } from "./pullRequestDetailReads.ts";
import { installDiffs } from "./pullRequestDiffs.ts";

export type Deps = SuccessOf<typeof installRuntime> & SuccessOf<typeof installEpochs> & SuccessOf<typeof installWorkspace> & SuccessOf<typeof installRouting> & SuccessOf<typeof installDetailReads> & SuccessOf<typeof installDiffs>;

export const installListing = Effect.fn("pullRequest.installListing")(function* (d: Deps) {
    const { decodeCursors, listWorkspaceProjects, matchesRowFilters, recentStats, recordStats, refCacheKey, refEpoch, requireProject, requirementOf, resolveViewers, statsCacheKey, toEntry, toPullRequestError, viewerPermissionsOf } = d;
  const listUncached: PullRequestService["Service"]["list"] = Effect.fn(
    "PullRequestService.listUncached",
  )(function* (input) {
    const involvement = input.involvement ?? "all";
    const continuation = yield* decodeCursors(input.cursors);
    const { supported: projects, unimplemented, viewerRoots } = yield* listWorkspaceProjects(input);
    const projectCounts = new Map<string, number>();
    for (const { host } of projects) {
      projectCounts.set(host, (projectCounts.get(host) ?? 0) + 1);
    }

    const viewerResults = yield* resolveViewers(projects, viewerRoots);
    const viewers: Record<string, string> = {};
    for (const result of viewerResults) {
      if (result.viewer !== null) viewers[result.host] = result.viewer;
    }

    const providers: ReadonlyArray<PullRequestProviderSummary> = [
      ...viewerResults.map((result) => {
        const capabilities = projects.find((project) => project.host === result.host)?.api
          .capabilities;
        return {
          host: result.host,
          kind: result.kind,
          searchesOnHost: capabilities?.search ?? false,
          actions: capabilities?.actions ?? [],
          projectCount: projectCounts.get(result.host) ?? 1,
          configured: result.viewer !== null,
          detail: result.error === null ? null : providerDetail(requirementOf, result.error),
        };
      }),
      ...[...unimplemented].map(([host, { kind, projectCount }]) => ({
        host,
        kind,
        searchesOnHost: false,
        actions: [],
        projectCount,
        configured: false,
        detail: "This host cannot be browsed here yet.",
      })),
    ];

    const selected =
      continuation === null
        ? projects
        : projects.filter(({ cursorKey }) => continuation.has(cursorKey));
    const readable = selected.filter(({ host }) => viewers[host] !== undefined);
    const unreadable = selected
      .filter(({ host }) => viewers[host] === undefined)
      .map(({ project, repository }) => ({
        projectId: project.id,
        projectTitle: project.title,
        message: `${repository} could not be read.`,
      }));
    if (readable.length === 0) {
      const errors = viewerResults.flatMap((result) =>
        result.error === null || !selected.some(({ host }) => host === result.host)
          ? []
          : [result.error],
      );
      const blocking = errors.find(isProviderUnusable) ?? errors[0];
      if (blocking) {
        return yield* toPullRequestError("list")(blocking);
      }

      return {
        viewers: viewers as PullRequestListResult["viewers"],
        providers,
        entries: [],
        errors: [],
        truncated: false,
        nextCursors: {},
      };
    }

    const limit = input.limit ?? DEFAULT_REPOSITORY_LIST_LIMIT;
    const cursorOf = (project: SupportedProject): ListCursor | undefined =>
      continuation?.get(project.cursorKey);

    const readSlice = (
      project: SupportedProject,
      cursor: ListCursor | undefined,
    ): Effect.Effect<RepositoryBatch> => {
      {
        const viewer = viewers[project.host]!;
        const key = project.cursorKey;
        return project.api
          .listChangeRequests({
            cwd: project.project.workspaceRoot,
            repository: project.repository,
            host: project.host,
            state: input.state,
            involvement,
            viewer,
            limit,
            query: input.query,
            filters: input.filters,
            ...(cursor === undefined
              ? {}
              : {
                  cursor: {
                    updatedBefore: cursor.updatedBefore,
                    delivered: cursor.delivered,
                    seenAt: cursor.seenAt,
                    resumeAfter: cursor.resumeAfter,
                  },
                }),
          })
          .pipe(
            observeRead,
            Effect.map(({ value: page, observedAt }): RepositoryBatch => {
              // The boundary instant was asked for inclusively, so the rows already sent at it
              // come back with the slice. Dropping them here rather than asking for strictly
              // older is what keeps their neighbours at the same instant from being skipped.
              const items =
                cursor === undefined
                  ? page.items
                  : page.items.filter(
                      (item) =>
                        item.updatedAt !== cursor.updatedBefore ||
                        !cursor.seenAt.includes(item.number),
                    );
              return {
                key,
                entries: items
                  .filter((item) => matchesRowFilters(item, input.filters, viewer))
                  .map((item) => toEntry({ project, item, viewer, observedAt })),
                errors: [],
                truncated: page.truncated,
                nextCursor:
                  page.continues && page.truncated
                    ? nextListCursor(
                        cursor,
                        page.items,
                        items,
                        page.cursorAdvance,
                        page.resumeAfter,
                      )
                    : null,
              };
            }),
            Effect.catch((error): Effect.Effect<RepositoryBatch> =>
              Effect.succeed({
                key,
                entries: [],
                errors: [
                  {
                    projectId: project.project.id,
                    projectTitle: project.project.title,
                    message:
                      error.accessHint === undefined
                        ? `${project.repository} could not be read.`
                        : `${project.repository} could not be read. ${error.accessHint}`,
                  },
                ],
                truncated: false,
                nextCursor: null,
              }),
            ),
          );
      }
    };

    // Filters a host cannot apply thin out the slices it hands over, so a repository keeps
    // reading until it has a page's worth or runs out. The reads are bounded: a filter that
    // matches nothing would otherwise walk the repository's whole history in one request.
    const readRepository = (project: SupportedProject): Effect.Effect<RepositoryBatch> => {
      const fill = (batch: RepositoryBatch, reads: number): Effect.Effect<RepositoryBatch> => {
        const cursor = batch.nextCursor === null ? null : parseListCursor(batch.nextCursor);
        if (
          input.filters === undefined ||
          cursor === null ||
          batch.entries.length >= limit ||
          reads >= FILTERED_LIST_READS
        ) {
          return Effect.succeed(batch);
        }
        return readSlice(project, cursor).pipe(
          Effect.flatMap((next) =>
            // A slice that failed keeps the cursor before it, so the reader can try again.
            next.errors.length > 0
              ? Effect.succeed(batch)
              : fill({ ...next, entries: [...batch.entries, ...next.entries] }, reads + 1),
          ),
        );
      };
      return readSlice(project, cursorOf(project)).pipe(Effect.flatMap((batch) => fill(batch, 1)));
    };

    const readTogether = (
      chunk: ReadonlyArray<SupportedProject>,
    ): Effect.Effect<ReadonlyArray<RepositoryBatch>> => {
      const first = chunk[0]!;
      const readAcross = first.api.listChangeRequestsAcross;
      const separately = () =>
        Effect.forEach(chunk, readRepository, { concurrency: REPOSITORY_CONCURRENCY });
      if (readAcross === undefined) return separately();
      const viewer = viewers[first.host]!;
      const cursor = cursorOf(first);
      return readAcross({
        cwd: first.project.workspaceRoot,
        host: first.host,
        repositories: chunk.map((project) => project.repository),
        state: input.state,
        involvement,
        viewer,
        limit,
        query: input.query,
        filters: input.filters,
        ...(cursor === undefined
          ? {}
          : { cursor: { updatedBefore: cursor.updatedBefore, delivered: cursor.delivered } }),
      }).pipe(
        observeRead,
        Effect.flatMap(({ value: page, observedAt }) => {
          const rows = new Map<string, Array<ProviderChangeRequest>>();
          for (const item of page.items) {
            const key = item.repository.trim().toLowerCase();
            const held = rows.get(key);
            if (held === undefined) rows.set(key, [item]);
            else held.push(item);
          }
          const unresolved = new Set(
            (page.unresolved ?? []).map((repository) => repository.trim().toLowerCase()),
          );
          const boundary = page.items.reduce<string | null>(
            (oldest, item) =>
              oldest === null || item.updatedAt < oldest ? item.updatedAt : oldest,
            null,
          );
          return Effect.forEach(
            chunk,
            (project): Effect.Effect<RepositoryBatch> => {
              const key = project.repository.trim().toLowerCase();
              const fetched = rows.get(key) ?? [];
              if (fetched.length === 0 && unresolved.has(key)) return readRepository(project);
              const cursorHere = cursorOf(project);
              const items =
                cursorHere === undefined
                  ? fetched
                  : fetched.filter(
                      (item) =>
                        item.updatedAt !== cursorHere.updatedBefore ||
                        !cursorHere.seenAt.includes(item.number),
                    );
              return Effect.succeed({
                key: project.cursorKey,
                entries: items
                  .filter((item) => matchesRowFilters(item, input.filters, viewer))
                  .map((item) => toEntry({ project, item, viewer, observedAt })),
                errors: [],
                truncated: page.truncated,
                nextCursor:
                  page.truncated && boundary !== null
                    ? listCursorAt(cursorHere, boundary, fetched, items.length)
                    : null,
              });
            },
            { concurrency: REPOSITORY_CONCURRENCY },
          );
        }),
        Effect.catch(separately),
      );
    };

    const together = new Map<string, Array<SupportedProject>>();
    const separate: Array<SupportedProject> = [];
    for (const project of readable) {
      if (project.api.listChangeRequestsAcross === undefined) {
        separate.push(project);
        continue;
      }
      const key = `${project.host}\n${cursorOf(project)?.updatedBefore ?? ""}`;
      const group = together.get(key);
      if (group === undefined) together.set(key, [project]);
      else group.push(project);
    }
    const reads: Array<Effect.Effect<ReadonlyArray<RepositoryBatch>>> = separate.map((project) =>
      readRepository(project).pipe(Effect.map((batch) => [batch])),
    );
    for (const group of together.values()) {
      for (let start = 0; start < group.length; start += REPOSITORY_SEARCH_CHUNK) {
        reads.push(readTogether(group.slice(start, start + REPOSITORY_SEARCH_CHUNK)));
      }
    }
    const batches = (yield* Effect.all(reads, { concurrency: REPOSITORY_CONCURRENCY })).flat();

    const nextCursors: Record<string, string> = {};
    for (const batch of batches) {
      if (batch.nextCursor !== null) nextCursors[batch.key] = batch.nextCursor;
    }

    return {
      viewers: viewers as PullRequestListResult["viewers"],
      providers,
      entries: batches
        .flatMap((batch) => batch.entries)
        .toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt)),
      errors: [...unreadable, ...batches.flatMap((batch) => batch.errors)],
      truncated: batches.some((batch) => batch.truncated),
      nextCursors,
    };
  });

  const listCache = yield* Cache.makeWith(
    (key: string) => {
      const [
        ,
        state,
        involvement,
        filters,
        projectId,
        projectIds,
        host,
        limit,
        query,
        cursorEntries,
      ] = JSON.parse(key) as [
        number,
        string,
        string | null,
        ReadonlyArray<string | ReadonlyArray<string> | null> | null,
        string | null,
        ReadonlyArray<string> | null,
        string | null,
        number | null,
        string | null,
        ReadonlyArray<[string, string]> | null,
      ];
      return listUncached({
        state,
        ...(involvement === null ? {} : { involvement }),
        ...(filters === null ? {} : { filters: filtersOfKey(filters) }),
        ...(projectId === null ? {} : { projectId }),
        ...(projectIds === null ? {} : { projectIds }),
        ...(host === null ? {} : { host }),
        ...(limit === null ? {} : { limit }),
        ...(query === null ? {} : { query }),
        ...(cursorEntries === null ? {} : { cursors: Object.fromEntries(cursorEntries) }),
      } as PullRequestListInput);
    },
    {
      capacity: LIST_CACHE_CAPACITY,
      timeToLive: (exit) => (Exit.isSuccess(exit) ? LIST_CACHE_TTL : Duration.zero),
    },
  );

  const list: PullRequestService["Service"]["list"] = (input) => {
    const key = JSON.stringify([
      d.listingsEpoch,
      input.state,
      input.involvement ?? null,
      input.filters === undefined
        ? null
        : [
            input.filters.draft ?? null,
            input.filters.review ?? null,
            input.filters.checks ?? null,
            input.filters.author ?? null,
            input.filters.labels ?? null,
            input.filters.excludedLabels ?? null,
          ],
      input.projectId ?? null,
      input.projectIds === undefined ? null : [...input.projectIds].sort(),
      input.host ?? null,
      input.limit ?? null,
      input.query ?? null,
      input.cursors === undefined
        ? null
        : Object.entries(input.cursors).toSorted(([left], [right]) => left.localeCompare(right)),
    ]);
    // A replacement reader can join a lookup still finishing its previous reader's cancellation.
    return Cache.get(listCache, key).pipe(
      Effect.catchCauseIf(
        (cause) => Cause.hasInterruptsOnly(cause),
        (_cause) => Cache.get(listCache, key),
      ),
    );
  };

  const listStatsUncached: PullRequestService["Service"]["listStats"] = Effect.fn(
    "PullRequestService.listStatsUncached",
  )(function* (input) {
    if (input.refs.length === 0) return { stats: [] };
    const { supported } = yield* listWorkspaceProjects({});
    const byProject = new Map(supported.map((project) => [project.project.id, project]));
    const wanted = new Map<
      string,
      { readonly project: SupportedProject; readonly number: number }
    >();
    for (const ref of input.refs) {
      const project = byProject.get(ref.projectId);
      if (
        project === undefined ||
        project.api.listChangeRequestStats === undefined ||
        project.repository.toLowerCase() !== ref.repository.trim().toLowerCase()
      ) {
        continue;
      }
      wanted.set(`${project.project.id} ${ref.number}`, { project, number: ref.number });
    }
    const byHost = new Map<string, Array<{ project: SupportedProject; number: number }>>();
    for (const entry of wanted.values()) {
      const held = byHost.get(entry.project.host);
      if (held === undefined) byHost.set(entry.project.host, [entry]);
      else held.push(entry);
    }
    const stats = yield* Effect.forEach(
      [...byHost.values()],
      (entries) => {
        const first = entries[0]!;
        const readStats = first.project.api.listChangeRequestStats;
        if (readStats === undefined) return Effect.succeed<ReadonlyArray<PullRequestDiffStat>>([]);
        const projectsByRepository = new Map(
          entries.map((entry) => [
            `${entry.project.repository.toLowerCase()} ${entry.number}`,
            entry.project,
          ]),
        );
        return readStats({
          cwd: first.project.project.workspaceRoot,
          host: first.project.host,
          changeRequests: entries.map((entry) => ({
            repository: entry.project.repository,
            number: entry.number,
          })),
        }).pipe(
          Effect.map((read) =>
            read.flatMap((stat): ReadonlyArray<PullRequestDiffStat> => {
              const project = projectsByRepository.get(
                `${stat.repository.toLowerCase()} ${stat.number}`,
              );
              return project === undefined
                ? []
                : [
                    {
                      projectId: project.project.id,
                      repository: project.repository,
                      number: stat.number,
                      additions: stat.additions,
                      deletions: stat.deletions,
                    },
                  ];
            }),
          ),
          Effect.orElseSucceed((): ReadonlyArray<PullRequestDiffStat> => []),
        );
      },
      { concurrency: REPOSITORY_CONCURRENCY },
    );
    return { stats: stats.flat() };
  });

  const listStats: PullRequestService["Service"]["listStats"] = Effect.fn(
    "PullRequestService.listStats",
  )(function* (input: PullRequestListStatsInput) {
    if (input.refs.length === 0) return { stats: [] };
    const now = yield* Clock.currentTimeMillis;
    const held: PullRequestDiffStat[] = [];
    const missing = new Map<string, PullRequestRef>();
    for (const ref of input.refs) {
      const key = statsCacheKey(refCacheKey(ref));
      const cached = recentStats.get(key);
      if (cached !== undefined && now - cached.at < Duration.toMillis(LIST_STATS_CACHE_TTL)) {
        held.push(cached.value);
      } else {
        missing.set(key, ref);
      }
    }
    if (missing.size === 0) return { stats: held };
    const key = statsBatchKey(missing.values());
    const { result, at } = yield* Cache.get(listStatsCache, key).pipe(
      Effect.catchCauseIf(
        (cause) => Cause.hasInterruptsOnly(cause),
        (_cause) => Cache.get(listStatsCache, key),
      ),
    );
    for (const [key, ref] of missing) {
      const stat = result.stats.find(
        (stat) =>
          stat.projectId === ref.projectId &&
          stat.repository.toLowerCase() === ref.repository.toLowerCase() &&
          stat.number === ref.number,
      );
      if (stat !== undefined) recordStats(key, stat, at);
    }
    return { stats: [...held, ...result.stats] };
  });

  const listStatsCache = yield* Cache.makeWith(
    (key: string) => {
      const [, refs] = JSON.parse(key) as [number, ReadonlyArray<[string, string, number, number]>];
      return listStatsUncached({
        refs: refs.map(([projectId, repository, number]) => ({ projectId, repository, number })),
      } as unknown as PullRequestListStatsInput).pipe(
        Effect.flatMap((result) =>
          Clock.currentTimeMillis.pipe(Effect.map((at) => ({ result, at }))),
        ),
      );
    },
    {
      capacity: LIST_STATS_CACHE_CAPACITY,
      timeToLive: (exit) => (Exit.isSuccess(exit) ? LIST_STATS_CACHE_TTL : Duration.zero),
    },
  );

  const statsBatchKey = (refs: Iterable<PullRequestRef>) =>
    JSON.stringify([
      d.listingsEpoch,
      [...refs]
        .map((ref) => [ref.projectId, ref.repository, ref.number, refEpoch(ref)] as const)
        .toSorted((left, right) =>
          `${left[0]} ${left[1]} ${left[2]}`.localeCompare(`${right[0]} ${right[1]} ${right[2]}`),
        ),
    ]);

  const filtersOfKey = (
    slots: ReadonlyArray<
      string | ReadonlyArray<string> | ReadonlyArray<ReadonlyArray<string>> | null
    >,
  ): PullRequestListFilters => {
    const [draft, review, checks, author, labels, excludedLabels] = slots;
    return {
      ...(typeof draft === "string" ? { draft: draft as "only" | "hide" } : {}),
      ...(typeof review === "string" ? { review: review as PullRequestListFilters["review"] } : {}),
      ...(typeof checks === "string" ? { checks: checks as PullRequestListFilters["checks"] } : {}),
      ...(typeof author === "string" ? { author } : {}),
      ...(Array.isArray(labels) ? { labels: labels as ReadonlyArray<ReadonlyArray<string>> } : {}),
      ...(Array.isArray(excludedLabels) ? { excludedLabels } : {}),
    };
  };

  const filterOptions: PullRequestService["Service"]["filterOptions"] = Effect.fn(
    "PullRequestService.filterOptions",
  )(function* (input) {
    const { supported } = yield* listWorkspaceProjects(input);
    // Worktrees of one checkout are separate projects over the same repository.
    const repositories = [
      ...new Map(supported.map((project) => [project.cursorKey, project])).values(),
    ];
    const refOf = (project: SupportedProject) => ({
      cwd: project.project.workspaceRoot,
      repository: project.repository,
      host: project.host,
      query: input.query,
    });
    // One repository the host cannot read leaves the others' options standing, as a listing does.
    const gather = <A>(
      read: (
        project: SupportedProject,
      ) => Effect.Effect<ProviderFilterOptionPage<A>, PullRequestProviderError> | undefined,
    ) =>
      Effect.forEach(
        repositories,
        (project): Effect.Effect<ReadonlyArray<ProviderFilterOptionPage<A>>> => {
          const page = read(project);
          return page === undefined
            ? Effect.succeed([])
            : page.pipe(
                Effect.map((answered) => [answered]),
                Effect.orElseSucceed(() => []),
              );
        },
        { concurrency: REPOSITORY_CONCURRENCY },
      ).pipe(Effect.map((pages) => pages.flat()));
    if (input.kind === "labels") {
      const pages = yield* gather<PullRequestLabel>((project) =>
        project.api.listRepositoryLabels?.(refOf(project)),
      );
      const { items, truncated } = rankFilterOptions(pages, {
        query: input.query,
        keyOf: (label) => label.name,
        textsOf: (label) => [label.name],
      });
      return { labels: items, authors: [], truncated };
    }
    const pages = yield* gather<PullRequestActor>((project) =>
      project.api.searchRepositoryAuthors?.(refOf(project)),
    );
    const { items, truncated } = rankFilterOptions(pages, {
      query: input.query,
      keyOf: (author) => author.login,
      textsOf: (author) => [author.login, author.name],
    });
    return { labels: [], authors: items, truncated };
  });

  const labelCandidates: PullRequestService["Service"]["labelCandidates"] = (input) =>
    requireProject(input).pipe(
      Effect.flatMap((project): Effect.Effect<PullRequestLabelCandidateList, PullRequestError> => {
        const list = project.api.listLabelCandidates;
        if (project.api.capabilities.labels !== true || list === undefined) {
          return Effect.fail(
            new PullRequestOperationError({
              operation: "labelCandidates",
              detail: "This host cannot change the labels on a change request.",
            }),
          );
        }
        return viewerPermissionsOf(project, input, "labelCandidates").pipe(
          Effect.flatMap(
            (viewer): Effect.Effect<PullRequestLabelCandidateList, PullRequestError> =>
              viewer.labels === false
                ? Effect.fail(
                    new PullRequestOperationError({
                      operation: "labelCandidates",
                      detail: LABEL_CHANGE_REFUSAL,
                    }),
                  )
                : list({
                    cwd: project.project.workspaceRoot,
                    repository: project.repository,
                    host: project.host,
                    number: input.number,
                  }).pipe(Effect.mapError(toPullRequestError("labelCandidates"))),
          ),
        );
      }),
    );
    return {
      listUncached,
      listCache,
      list,
      listStatsUncached,
      listStats,
      listStatsCache,
      statsBatchKey,
      filtersOfKey,
      filterOptions,
      labelCandidates,
    };
  });
