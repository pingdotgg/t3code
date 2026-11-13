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
import { REPOSITORY_CONCURRENCY, VIEWER_CACHE_CAPACITY, VIEWER_CACHE_TTL, credentialNamespace, httpRemoteHost, listCursorKey, parseListCursor, remoteHostKey, routingCredential, sharedProjectReads, withRateLimitBackoff, type SuccessOf } from "./pullRequestSupport.ts";
import type { ListCursor, PullRequestError, SupportedProject, WorkspaceProjects } from "./pullRequestSupport.ts";
import { installRuntime } from "./pullRequestRuntime.ts";
import { installEpochs } from "./pullRequestEpochs.ts";

export type Deps = SuccessOf<typeof installRuntime> & SuccessOf<typeof installEpochs>;

export const installWorkspace = Effect.fn("pullRequest.installWorkspace")(function* (d: Deps) {
    const { context, projects, rateLimits, registry, repositoryIdentities, sourceControlProviders, toPullRequestError } = d;
  const resolveRemoteHosts = Effect.fn("PullRequestService.resolveRemoteHosts")(function* (
    projects: ReadonlyArray<OrchestrationProjectShell>,
    filter: Pick<PullRequestListInput, "projectId" | "host">,
  ) {
    type Candidate = {
      readonly project: OrchestrationProjectShell;
      readonly context: SourceControlProviderContext;
    };
    const candidatesByKey = new Map<string, Candidate[]>();
    for (const project of projects) {
      if (filter.projectId !== undefined && project.id !== filter.projectId) continue;
      const identity = project.repositoryIdentity;
      if (
        !identity ||
        identity.provider === undefined ||
        sourceControlDefinitions.repositorySelector(identity) === null
      )
        continue;
      if (identity.provider !== "unknown") {
        const provider = yield* sourceControlProviders
          .get(identity.provider)
          .pipe(Effect.orElseSucceed(() => null));
        if (provider?.resolveRemoteWebHost === undefined) continue;
      }
      const host = sourceControlDefinitions.changeRequestHost(identity, "unknown");
      if (
        filter.host !== undefined &&
        host !== "unknown" &&
        host !== filter.host.toLowerCase() &&
        httpRemoteHost(identity.locator.remoteUrl) !== filter.host.toLowerCase() &&
        !isSshRemoteUrl(identity.locator.remoteUrl)
      ) {
        continue;
      }
      const { remoteName, remoteUrl } = identity.locator;
      const recognized = sourceControlDefinitions.recognizeRemote(remoteUrl);
      if (recognized === null) continue;
      const candidate = {
        project,
        context: {
          provider:
            identity.provider === "unknown"
              ? recognized
              : { ...recognized, kind: identity.provider },
          remoteName,
          remoteUrl,
          ...(filter.host !== undefined && isSshRemoteUrl(remoteUrl)
            ? { requestedHost: filter.host }
            : {}),
        },
      };
      const key = remoteHostKey(recognized, remoteUrl);
      const candidates = candidatesByKey.get(key);
      if (candidates === undefined) candidatesByKey.set(key, [candidate]);
      else candidates.push(candidate);
    }

    const resolveContext = (input: {
      readonly cwd: string;
      readonly context: SourceControlProviderContext;
    }) => sourceControlProviders.resolveHandle(input).pipe(Effect.map((handle) => handle.context));
    type RemoteHost = { readonly kind: SourceControlProviderKind; readonly host: string | null };
    const resolveCandidate = ({ project, context }: Candidate) =>
      (context.provider.kind === "unknown"
        ? resolveContext({ cwd: project.workspaceRoot, context }).pipe(
            Effect.map((resolved) =>
              resolved === null || resolved.provider.kind === "unknown"
                ? null
                : { context: resolved, discovered: true },
            ),
          )
        : Effect.succeed({ context, discovered: false })
      ).pipe(
        Effect.flatMap((found) =>
          found === null
            ? Effect.succeed(null)
            : sourceControlProviders.get(found.context.provider.kind).pipe(
                Effect.flatMap(
                  (provider) =>
                    provider.resolveRemoteWebHost?.({
                      cwd: project.workspaceRoot,
                      context: found.context,
                      // A remote discovery just placed is not looked up a second time.
                      resolveContext: found.discovered
                        ? () => Effect.succeed(found.context)
                        : resolveContext,
                    }) ?? Effect.succeed(null),
                ),
                Effect.orElseSucceed(() => null),
                Effect.map((host): RemoteHost => ({ kind: found.context.provider.kind, host })),
              ),
        ),
        Effect.orElseSucceed(() => null),
      );

    // An SSH remote whose web host one checkout could not name may be named by the next; a
    // kind found without a host still stands if none can.
    const resolveKey = Effect.fn("PullRequestService.resolveRemoteHost")(function* (
      candidates: ReadonlyArray<Candidate>,
    ) {
      let fallback: RemoteHost | null = null;
      for (const candidate of candidates) {
        const resolved = yield* resolveCandidate(candidate);
        if (resolved === null) continue;
        if (resolved.host !== null || !isSshRemoteUrl(candidate.context.remoteUrl)) {
          return resolved;
        }
        fallback ??= resolved;
      }
      return fallback;
    });

    return yield* Effect.forEach(
      candidatesByKey,
      ([key, candidates]) =>
        resolveKey(candidates).pipe(Effect.map((resolved) => [key, resolved] as const)),
      { concurrency: REPOSITORY_CONCURRENCY },
    ).pipe(Effect.map((resolved) => new Map(resolved)));
  });

  const listWorkspaceProjects = (
    filter: Pick<PullRequestListInput, "projectId" | "projectIds" | "host">,
  ): Effect.Effect<WorkspaceProjects, PullRequestError> =>
    Effect.flatMap(sharedProjectReads, (shared) => {
      if (shared === null || !shared.open) return readWorkspaceProjects(filter);
      const key = JSON.stringify([filter.projectId, filter.projectIds, filter.host]);
      const existing = shared.reads.get(key);
      if (existing !== undefined) return existing;
      return Effect.cached(readWorkspaceProjects(filter)).pipe(
        Effect.tap((read) => Effect.sync(() => shared.reads.set(key, read))),
        Effect.flatten,
      );
    });

  const withSharedProjectReads = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.suspend(() => {
      const shared = { open: true, reads: new Map() };
      return effect.pipe(
        Effect.provideService(sharedProjectReads, shared),
        Effect.ensuring(
          Effect.sync(() => {
            shared.open = false;
            shared.reads.clear();
          }),
        ),
      );
    });

  const readWorkspaceProjects = (
    filter: Pick<PullRequestListInput, "projectId" | "projectIds" | "host">,
  ): Effect.Effect<WorkspaceProjects, PullRequestError> =>
    (filter.projectId === undefined
      ? projects.listShells(
          filter.projectIds === undefined ? undefined : { projectIds: filter.projectIds },
        )
      : projects.getShell(filter.projectId).pipe(Effect.map(Option.toArray))
    ).pipe(
      Effect.mapError(
        (error) =>
          new PullRequestOperationError({
            operation: "listProjects",
            detail: "The project list could not be read.",
            cause: error,
          }),
      ),
      Effect.flatMap((projects) =>
        Effect.forEach(
          projects,
          (project) =>
            project.repositoryIdentity != null
              ? Effect.succeed(project)
              : repositoryIdentities
                  .resolve(project.workspaceRoot)
                  .pipe(Effect.map((repositoryIdentity) => ({ ...project, repositoryIdentity }))),
          { concurrency: REPOSITORY_CONCURRENCY },
        ),
      ),
      Effect.flatMap((projects) =>
        resolveRemoteHosts(projects, filter).pipe(
          Effect.map((remoteHosts) => ({ remoteHosts, projects })),
        ),
      ),
      Effect.map(({ remoteHosts, projects }) => {
        const supported: SupportedProject[] = [];
        const unimplemented = new Map<
          string,
          { kind: SourceControlProviderKind; projectCount: number }
        >();
        const viewerRoots = new Map<string, string[]>();
        const seen = new Set<string>();
        for (const project of projects) {
          if (filter.projectId !== undefined && project.id !== filter.projectId) continue;
          if (filter.projectIds !== undefined && !filter.projectIds.includes(project.id)) continue;
          const identity = project.repositoryIdentity;
          let kind = identity?.provider;
          const repository = sourceControlDefinitions.repositorySelector(
            project.repositoryIdentity,
          );
          if (!identity || kind === undefined || repository === null) continue;
          const recognized = sourceControlDefinitions.recognizeRemote(identity.locator.remoteUrl);
          const remote =
            recognized === null
              ? undefined
              : remoteHosts.get(remoteHostKey(recognized, identity.locator.remoteUrl));
          kind = remote?.kind ?? kind;
          const host = remote?.host ?? sourceControlDefinitions.changeRequestHost(identity, kind);
          if (filter.host !== undefined && host !== filter.host.toLowerCase()) {
            continue;
          }
          const registered = registry.get(kind);
          const api = registered?.servesHost?.(host) === false ? null : registered;
          if (api !== null) {
            const roots = viewerRoots.get(host);
            if (roots === undefined) viewerRoots.set(host, [project.workspaceRoot]);
            else if (!roots.includes(project.workspaceRoot)) roots.push(project.workspaceRoot);
          }
          const repositoryKey =
            api?.repositoryKey?.({ canonicalKey: identity.canonicalKey }) ?? null;
          const key = listCursorKey(host, repositoryKey ?? repository);
          if (seen.has(key)) continue;
          seen.add(key);
          if (api === null) {
            const counted = unimplemented.get(host);
            if (counted === undefined) unimplemented.set(host, { kind, projectCount: 1 });
            else counted.projectCount += 1;
            continue;
          }
          supported.push({
            cursorKey: key,
            project,
            api: withRateLimitBackoff(api, host, rateLimits),
            repository,
            host,
            remote:
              repositoryKey ??
              sourceControlDefinitions.repositoryKeyFromRemote(`https://${host}/${repository}`),
            repositoryKey:
              repositoryKey === null
                ? null
                : sourceControlDefinitions.canonicalRepositoryKey(repositoryKey.toLowerCase()),
          });
        }
        return { supported, unimplemented, viewerRoots };
      }),
    );

  // Azure derives organization from the checkout; require the matching repository.

  const requireProject = (ref: PullRequestRef): Effect.Effect<SupportedProject, PullRequestError> =>
    listWorkspaceProjects({ projectId: ref.projectId }).pipe(
      Effect.flatMap(({ supported }): Effect.Effect<SupportedProject, PullRequestError> => {
        const own = supported[0];
        const repository = ref.repository.trim();
        const host = ref.host?.trim().toLowerCase();
        if (own !== undefined && own.repository.toLowerCase() === repository.toLowerCase()) {
          if (host === undefined || host === own.host) return Effect.succeed(own);
        }
        if (host === undefined) {
          if (own === undefined) {
            return Effect.fail(new PullRequestUnavailableError({ reason: "provider-unsupported" }));
          }
          return Effect.fail(
            new PullRequestOperationError({
              operation: "resolveRepository",
              detail: "The change request does not belong to the selected project.",
            }),
          );
        }
        const referenceKey = `${host}/${repository}`.toLowerCase();
        const repositoryKey = sourceControlDefinitions.canonicalRepositoryKey(referenceKey);
        // A host that spells one repository several ways (Azure's SSH and legacy clone hosts)
        // can differ from the browser URL's host. Compare the complete repository identity
        // before narrowing those checkouts by host.
        return listWorkspaceProjects(
          sourceControlDefinitions.findByRepositoryKey(referenceKey) ? {} : { host },
        ).pipe(
          Effect.flatMap(({ supported }) => {
            const onHost = supported.filter((candidate) => candidate.host === host);
            const route =
              supported.find(
                (candidate) =>
                  candidate.repositoryKey !== null && candidate.repositoryKey === repositoryKey,
              ) ??
              onHost.find(
                (candidate) =>
                  candidate.repositoryKey === null &&
                  candidate.repository.toLowerCase() === repository.toLowerCase(),
              ) ??
              onHost.find((candidate) => candidate.repositoryKey === null);
            if (route === undefined) {
              return Effect.gen(function* () {
                const publicHost = sourceControlDefinitions.findByPublicHost(host);
                const api = publicHost === undefined ? null : registry.get(publicHost.kind);
                if (api?.readsPublicHostWithoutCheckout) {
                  const selected = yield* projects.getShell(ref.projectId).pipe(
                    Effect.mapError(
                      (cause) =>
                        new PullRequestOperationError({
                          operation: "resolveRepository",
                          detail: "The selected project could not be read.",
                          cause,
                        }),
                    ),
                  );
                  if (Option.isSome(selected)) {
                    return {
                      cursorKey: listCursorKey(host, repository),
                      project: selected.value,
                      api: withRateLimitBackoff(api, host, rateLimits),
                      repository,
                      host,
                      remote: sourceControlDefinitions.repositoryKeyFromRemote(
                        `https://${host}/${repository}`,
                      ),
                      repositoryKey: null,
                    };
                  }
                }
                return yield* new PullRequestUnavailableError({ reason: "provider-unsupported" });
              });
            }
            return Effect.succeed(
              route.repositoryKey !== null ||
                route.repository.toLowerCase() === repository.toLowerCase()
                ? route
                : {
                    ...route,
                    repository,
                    remote: sourceControlDefinitions.repositoryKeyFromRemote(
                      `https://${host}/${repository}`,
                    ),
                  },
            );
          }),
        );
      }),
    );

  const canonicalRef = Effect.fn("PullRequestService.canonicalRef")(function* <
    I extends PullRequestRef,
  >(input: I) {
    const project = yield* requireProject(input);
    return {
      ...input,
      projectId: project.project.id,
      host: project.host,
      repository: project.repository,
    };
  });

  // Access can change after page load; recheck every write.

  const viewerPermissionsOf = (
    project: SupportedProject,
    ref: PullRequestRef,
    operation: string,
    includeUpdateBranch = false,
  ) =>
    project.api
      .getViewerPermissions({
        cwd: project.project.workspaceRoot,
        repository: project.repository,
        host: project.host,
        number: ref.number,
        includeUpdateBranch,
      })
      .pipe(Effect.mapError(toPullRequestError(operation)));

  const decodeCursors = (
    cursors: PullRequestListInput["cursors"],
  ): Effect.Effect<ReadonlyMap<string, ListCursor> | null, PullRequestError> => {
    if (cursors === undefined) return Effect.succeed(null);
    const decoded = new Map<string, ListCursor>();
    for (const [key, raw] of Object.entries(cursors)) {
      const cursor = parseListCursor(raw);
      if (cursor === null) {
        return Effect.fail(
          new PullRequestOperationError({
            operation: "list",
            detail: "The list could not be carried on from where it left off.",
          }),
        );
      }
      decoded.set(key, cursor);
    }
    return Effect.succeed(decoded);
  };

  type ResolvedViewer = {
    readonly host: string;
    readonly kind: SourceControlProviderKind;
    readonly viewer: string | null;
    readonly error: PullRequestProviderError | null;
  };

  const viewersByHost = new Map<string, { readonly at: number; readonly result: ResolvedViewer }>();

  const viewerFlights = yield* Cache.makeWith(
    (key: string): Effect.Effect<ResolvedViewer> => {
      const [host, kind, roots] = JSON.parse(key) as [
        string,
        SourceControlProviderKind,
        ReadonlyArray<string>,
      ];
      const registered = registry.get(kind);
      if (registered === null) {
        return Effect.die(new Error(`Missing pull request provider: ${kind}`));
      }
      const api = withRateLimitBackoff(registered, host, rateLimits, { viewerAllowsPause: true });
      return Effect.firstSuccessOf(roots.map((cwd) => api.getViewer({ cwd, host }))).pipe(
        Effect.map((viewer) => ({
          host,
          kind,
          viewer: viewer as string | null,
          error: null as PullRequestProviderError | null,
        })),
        Effect.tap((result) =>
          Effect.map(Clock.currentTimeMillis, (at) => viewersByHost.set(host, { at, result })),
        ),
        Effect.catch((error) =>
          Effect.succeed({
            host,
            kind,
            viewer: null,
            error,
          }),
        ),
      );
    },
    {
      capacity: VIEWER_CACHE_CAPACITY,
      // Share cold-page lookups briefly; keep failures retryable.
      timeToLive: (exit) =>
        Exit.isSuccess(exit) && exit.value.error === null ? Duration.seconds(1) : Duration.zero,
    },
  );

  const resolveViewers = (
    projects: ReadonlyArray<SupportedProject>,
    viewerRoots: WorkspaceProjects["viewerRoots"],
    options?: { readonly allowPaused: boolean },
  ) =>
    Effect.forEach(
      [...new Set(projects.map(({ host }) => host))],
      (host) =>
        Effect.flatMap(Clock.currentTimeMillis, (now): Effect.Effect<ResolvedViewer> => {
          const held = viewersByHost.get(host);
          if (held !== undefined && now - held.at <= Duration.toMillis(VIEWER_CACHE_TTL)) {
            return Effect.succeed(held.result);
          }
          const forHost = projects.filter((project) => project.host === host);
          const api = forHost[0]!.api;
          // Include deduplicated checkouts too; one unreadable worktree must not mark the whole host signed out.
          const roots =
            viewerRoots.get(host) ?? forHost.map(({ project }) => project.workspaceRoot);
          const key = JSON.stringify([host, api.kind, [...new Set(roots)].sort()]);
          if (options?.allowPaused === true) return Cache.get(viewerFlights, key);
          // Check pauses outside the shared lookup so background reads cannot spawn repeated failing CLIs and extend the pause.
          return rateLimits.check({ provider: api.kind, host }).pipe(
            Effect.flatMap(() => Cache.get(viewerFlights, key)),
            Effect.catch((error) =>
              Effect.succeed<ResolvedViewer>({
                host,
                kind: api.kind,
                viewer: null,
                error: new PullRequestProviderError({
                  provider: api.kind,
                  operation: "getViewer",
                  reason: "rate-limited",
                  detail: error.detail,
                  retryAt: error.retryAt,
                  cause: error,
                }),
              }),
            ),
          );
        }),
      { concurrency: REPOSITORY_CONCURRENCY },
    );

  // Only the host can filter checks; listed rows have no check state.

  const viewerOf = (project: SupportedProject): Effect.Effect<string | null> =>
    routingCredential.pipe(
      Effect.flatMap((credential) =>
        credential !== null
          ? Effect.succeed(credential.viewer)
          : resolveViewers([project], new Map()).pipe(
              Effect.map(([resolved]) => resolved?.viewer ?? null),
            ),
      ),
    );

  const matchesRowFilters = (
    item: ProviderChangeRequest,
    filters: PullRequestListFilters | undefined,
    viewer: string,
  ): boolean => {
    if (filters === undefined) return true;
    const labels = new Set(item.labels.map((label) => label.name.trim().toLowerCase()));
    const holds = (label: string) => labels.has(label.trim().toLowerCase());
    return (
      (filters.draft === undefined || item.isDraft === (filters.draft === "only")) &&
      (filters.review === undefined ||
        item.reviewDecision === undefined ||
        (filters.review === "none"
          ? item.reviewDecision === null
          : item.reviewDecision === filters.review)) &&
      (filters.labels === undefined || filters.labels.every((group) => group.some(holds))) &&
      (filters.excludedLabels === undefined || !filters.excludedLabels.some(holds)) &&
      (filters.author === undefined ||
        item.author?.login.toLowerCase() ===
          resolvePullRequestAuthorFilter(filters.author, viewer).toLowerCase())
    );
  };

  const toEntry = (input: {
    readonly project: SupportedProject;
    readonly item: ProviderChangeRequest;
    readonly viewer: string;
    readonly observedAt: number;
  }): PullRequestListEntry => {
    const viewer = input.viewer.toLowerCase();
    return {
      ...(input.item.stack === undefined ? {} : { stack: input.item.stack }),
      provider: input.project.api.kind,
      host: input.project.host,
      projectId: input.project.project.id,
      projectTitle: input.project.project.title,
      repository: input.project.repository,
      number: input.item.number,
      title: input.item.title,
      url: input.item.url,
      author: input.item.author,
      headBranch: input.item.headBranch,
      baseBranch: input.item.baseBranch,
      state: input.item.state,
      isDraft: input.item.isDraft,
      mergeability: input.item.mergeability,
      additions: input.item.additions,
      deletions: input.item.deletions,
      createdAt: input.item.createdAt,
      updatedAt: input.item.updatedAt,
      observedAt: input.observedAt,
      ...(input.item.checksState === undefined || input.item.checksState === null
        ? {}
        : { checksState: input.item.checksState }),
      viewerReviewRequested:
        input.item.author?.login.toLowerCase() !== viewer &&
        input.item.reviewRequestLogins.some((login) => login.toLowerCase() === viewer),
      labels: input.item.labels,
      ...(input.item.reviewDecision === undefined || input.item.reviewDecision === null
        ? {}
        : { reviewDecision: input.item.reviewDecision }),
    };
  };

  const credentialCached =
    <I extends PullRequestRef, Args extends ReadonlyArray<unknown>, A, E>(
      read: (input: I, ...args: Args) => Effect.Effect<A, E>,
    ) =>
    (input: I, ...args: Args) =>
      Effect.gen(function* () {
        const ref = yield* canonicalRef(input);
        const credential = yield* routingCredential;
        return yield* read(
          credential === null
            ? ref
            : { ...ref, [credentialNamespace]: credential.credentialFingerprint },
          ...args,
        );
      });

  // Cache small filename lists even when patches exceed limits, avoiding diff refetches on file expansion.

  const requiredViewerOf = (
    project: SupportedProject,
    operation: string,
  ): Effect.Effect<string | null, PullRequestError> =>
    resolveViewers([project], new Map(), { allowPaused: true }).pipe(
      Effect.flatMap(([resolved]) => {
        const error = resolved?.error ?? null;
        return error === null
          ? Effect.succeed(resolved?.viewer ?? null)
          : Effect.fail(toPullRequestError(operation)(error));
      }),
    );
    return {
      resolveRemoteHosts,
      listWorkspaceProjects,
      withSharedProjectReads,
      readWorkspaceProjects,
      requireProject,
      canonicalRef,
      viewerPermissionsOf,
      decodeCursors,
      // type ResolvedViewer
      viewersByHost,
      viewerFlights,
      resolveViewers,
      viewerOf,
      matchesRowFilters,
      toEntry,
      credentialCached,
      requiredViewerOf,
    };
  });
