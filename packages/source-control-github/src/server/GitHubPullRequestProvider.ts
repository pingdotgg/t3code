import { SourceControlProviderKind } from "@t3tools/contracts";
import { removeAgentCredits } from "@t3tools/source-control-core/server/mergeMessage";
import { normalizeHost } from "@t3tools/source-control-core/server/pullRequestUtils";
import * as Cache from "effect/Cache";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Equal from "effect/Equal";
import * as Exit from "effect/Exit";
import * as Hash from "effect/Hash";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type {
  PullRequestActor,
  PullRequestCapabilities,
  PullRequestCheck,
  PullRequestReaction,
  PullRequestViewerPermissions,
} from "@t3tools/contracts";

import * as SourceControlRateLimit from "@t3tools/source-control-core/server/SourceControlRateLimit";
import * as GitHubPullRequestApi from "./GitHubPullRequestApi.ts";
import * as GitHubRequestPolicy from "./GitHubRequestPolicy.ts";
import {
  PullRequestProviderError,
  type PullRequestProviderFailure,
  type ProviderChangeRequestActivity,
  type ProviderChangeRequestDetail,
  type PullRequestProviderApi,
  type ProviderRepositoryRef,
} from "@t3tools/source-control-core/server/PullRequestProvider";
import type { GitHubCredentialSource } from "./GitHubCredentials.ts";
import type {
  GitHubPullRequestCore,
  GitHubRepositoryAccess,
  GitHubViewerAccess,
  GitHubWorkflowRunApproval,
} from "./gitHubPullRequestJson.ts";
import { definition } from "../shared/definition.ts";

const CAPABILITIES: PullRequestCapabilities = {
  diff: true,
  comment: true,
  actions: [...definition.changeRequestActions],
  mergeMethods: ["merge", "squash", "rebase"],
  deleteBranch: true,
  updateMethods: ["merge", "rebase"],
  search: true,
  reactions: true,
  mentions: true,
  referenceSigils: ["#"],
  viewedFiles: "host",
  review: {
    inlineComment: true,
    rangeComment: true,
    reply: true,
    resolve: true,
    verdicts: ["comment", "approve", "request-changes"],
  },
  reviewers: { request: true, listCandidates: true, searchCandidates: true },
  edit: { changeRequest: true, comment: true, maintainerEdits: true },
  stacks: true,
  stackActions: true,
  labels: true,
  // Statuses and check runs land on the head commit itself and are read whole, so an empty list
  // after a push is CI that never started rather than a read that saw nothing.
  checksAlwaysReport: true,
};

const UNAVAILABLE_REQUIREMENT = {
  missing:
    "No GitHub credential on the server. Set GH_TOKEN, or install the GitHub CLI (https://cli.github.com/) and run `gh auth login`.",
  unauthenticated:
    "GitHub has no working credential for this host. Run `gh auth login`, or check the account and hosts in Settings → Source Control.",
};

/**
 * Asking somebody else for a review needs write access, which is the one thing here an author
 * cannot do on their own pull request: GitHub shows an outside contributor the reviewer control
 * and refuses the request behind it.
 */
export function gitHubViewerPermissions(
  access: GitHubViewerAccess & Pick<GitHubRepositoryAccess, "autoMergeAllowed">,
): PullRequestViewerPermissions {
  return {
    ...(access.canWrite ? { stackRebase: true } : {}),
    actions: [
      ...(access.canDeleteBranch === true ? (["delete-branch"] as const) : []),
      // Keep disabling available if the repository has since turned auto-merge off.
      ...(access.canWrite
        ? ([
            "merge",
            ...(access.autoMergeAllowed && access.canMergeNow !== true
              ? (["enable-auto-merge"] as const)
              : []),
            "disable-auto-merge",
            "revert",
            "approve-workflows",
          ] as const)
        : []),
      ...(access.canUpdate ? (["ready", "draft", "close", "reopen"] as const) : []),
      ...(access.canUpdateBranch === true ? (["update-branch"] as const) : []),
    ],
    comment: true,
    resolve: access.canWrite || access.didAuthor,
    // Authors may comment on their own PRs, but GitHub rejects their approvals and change requests.
    verdicts: access.didAuthor ? (["comment"] as const) : CAPABILITIES.review.verdicts,
    requestReviewers: access.canWrite,
    ...(access.canUpdateBranch === true ? { updateMethods: CAPABILITIES.updateMethods } : {}),
    labels: access.canTriage,
  };
}

function gitHubProviderFailure(
  error: GitHubPullRequestApi.GitHubPullRequestApiError,
): PullRequestProviderFailure {
  switch (error._tag) {
    case "GitHubCliMissingError":
      return { reason: "missing-tool" };
    case "GitHubNotSignedInError":
    case "GitHubHostDisabledError":
    case "SettingsSecretUnresolvedError":
    case "GitHubApiAuthenticationError":
      return { reason: "unauthenticated" };
    case "GitHubApiRateLimitError":
      return {
        reason: "rate-limited",
        ...(error.retryAt === undefined ? {} : { retryAt: error.retryAt }),
        pauseReason: error.resource === undefined ? "rate-limited" : "quota-exhausted",
        ...(error.resource === undefined ? {} : { resource: error.resource }),
      };
    case "SourceControlRateLimitPausedError":
      return {
        reason: "rate-limited",
        retryAt: error.retryAt,
        ...(error.pauseReason === undefined ? {} : { pauseReason: error.pauseReason }),
        ...(error.resource === undefined ? {} : { resource: error.resource }),
        ...(error.remaining === undefined ? {} : { remaining: error.remaining }),
        ...(error.limit === undefined ? {} : { limit: error.limit }),
      };
    case "GitHubApiResponseError":
      return {
        reason:
          error.status === 403 ||
          (error.githubErrorTypes?.includes("FORBIDDEN") &&
            error.githubErrorTypes.every((type) => type === "FORBIDDEN" || type === "NOT_FOUND"))
            ? "forbidden"
            : "failed",
      };
    case "GitHubApiNotFoundError":
      return error.credential === undefined || error.credential === "app"
        ? { reason: "not-found" }
        : { reason: "not-found", accessHint: REPOSITORY_ACCESS_HINTS[error.credential] };
    default:
      return { reason: "failed" };
  }
}

const REPOSITORY_ACCESS_HINTS: Record<Exclude<GitHubCredentialSource, "app">, string> = {
  settings:
    "Your saved GitHub token can't see it. Give it access, or change it in Settings → Source Control.",
  env: "The server's environment token can't see it. Give it access, or unset it.",
  gh: "Your gh login can't see it. Give it access, or save a token in Settings → Source Control.",
};

function withAvatar(
  actor: PullRequestActor | null,
  avatarsByLogin: ReadonlyMap<string, string>,
  host: string,
  botLogins?: ReadonlySet<string>,
): PullRequestActor | null {
  if (actor === null) return actor;
  if (botLogins?.has(actor.login)) actor = { ...actor, isBot: true };
  if (actor.avatarUrl !== null) return actor;
  const avatarUrl = avatarsByLogin.get(actor.login) ?? loginAvatarUrl(actor.login, host);
  return avatarUrl === null ? actor : { ...actor, avatarUrl };
}

function withWorkflowApprovals(
  checks: ReadonlyArray<PullRequestCheck>,
  runs: ReadonlyArray<GitHubWorkflowRunApproval>,
  unavailable: boolean,
): ReadonlyArray<PullRequestCheck> {
  const representedRunIds = new Set<number>();
  for (const check of checks) {
    if (check.status !== "action-required" || check.url === null) continue;
    const id = check.url.match(/\/actions\/runs\/(\d+)(?:\/|$)/)?.[1];
    if (id !== undefined) representedRunIds.add(Number(id));
  }
  const approvalChecks = runs
    .filter((run) => !representedRunIds.has(run.id))
    .map((run): PullRequestCheck => ({
      name: run.name,
      status: "action-required",
      description: "A maintainer must approve this workflow before it can run.",
      url: run.url,
    }));
  return [
    ...checks,
    ...approvalChecks,
    ...(unavailable
      ? [
          {
            name: "Workflow approval status",
            status: "action-required" as const,
            description: "GitHub could not determine whether workflows are awaiting approval.",
            url: null,
          },
        ]
      : []),
  ];
}

/** App logins have no profile page; guessed avatar URLs 404. */
export function loginAvatarUrl(login: string, host: string): string | null {
  return /^[a-z0-9][a-z0-9-]{0,38}$/iu.test(login) ? `https://${host}/${login}.png?size=80` : null;
}

// Whether search covers a repository changes only when the repository is renamed or moved.
const SEARCH_COVERAGE_TTL = Duration.hours(1);
const SEARCH_COVERAGE_CAPACITY = 4096;
const SEARCH_COVERAGE_CONCURRENCY = 4;

/**
 * Whether GitHub search covers a repository. `cwd` only says where to ask, so equality ignores
 * it and `lookup`, and every checkout of a repository shares one answer.
 */
class SearchCoverage {
  readonly key: string;
  readonly lookup: Effect.Effect<boolean, GitHubPullRequestApi.GitHubPullRequestApiError>;

  constructor(
    host: string,
    repository: string,
    lookup: Effect.Effect<boolean, GitHubPullRequestApi.GitHubPullRequestApiError>,
  ) {
    this.key = `${host.toLowerCase()}\n${repository.trim().toLowerCase()}`;
    this.lookup = lookup;
  }

  [Equal.symbol](that: unknown): boolean {
    return that instanceof SearchCoverage && that.key === this.key;
  }
  [Hash.symbol](): number {
    return Hash.string(this.key);
  }
}

const PULL_REQUEST_READ_TTL = Duration.seconds(45);
const PULL_REQUEST_READ_CAPACITY = 128;
type PullRequestRef = ProviderRepositoryRef & { readonly number: number };
type Observed<A> = A & { readonly observedAt: number };

/** The exact pinned token sees the same PR from every checkout; unpinned reads never share. */
class PullRequestRead<A> {
  readonly key: string;
  readonly repository: string;
  readonly number: number;
  readonly lookup: Effect.Effect<A, GitHubPullRequestApi.GitHubPullRequestApiError>;

  constructor(
    input: PullRequestRef,
    fingerprint: string,
    lookup: Effect.Effect<A, GitHubPullRequestApi.GitHubPullRequestApiError>,
  ) {
    this.repository = input.repository.trim().toLowerCase();
    this.number = input.number;
    this.lookup = lookup;
    this.key = JSON.stringify([
      fingerprint,
      normalizeHost(input.host),
      this.repository,
      this.number,
    ]);
  }

  [Equal.symbol](that: unknown): boolean {
    return that instanceof PullRequestRead && that.key === this.key;
  }
  [Hash.symbol](): number {
    return Hash.string(this.key);
  }
}

const rendersEmpty = (body: string): boolean =>
  body.replace(/<!--[\s\S]*?-->/g, "").trim().length === 0;

export const make = Effect.gen(function* () {
  const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;
  const clock = yield* Clock.Clock;

  // GitHub does not index every repository for search: a renamed one answers for its old name
  // with silence rather than with an error. Where search has any pull request for a repository it
  // covers it, so its silence on a page is a real empty answer; any other the caller reads on its
  // own. A failed check is not kept.
  const searchCoverage = yield* Cache.makeWith((request: SearchCoverage) => request.lookup, {
    capacity: SEARCH_COVERAGE_CAPACITY,
    timeToLive: (exit) => (Exit.isSuccess(exit) ? SEARCH_COVERAGE_TTL : Duration.zero),
  });
  const coverageOf = (
    input: Parameters<NonNullable<PullRequestProviderApi["listChangeRequestsAcross"]>>[0],
    repository: string,
  ) =>
    new SearchCoverage(
      input.host,
      repository,
      Effect.suspend(() =>
        cli.searchPullRequests({
          cwd: input.cwd,
          host: input.host,
          repositories: [repository],
          state: "all",
          involvement: "all",
          viewer: input.viewer,
          limit: 1,
        }),
      ).pipe(Effect.map((batch) => batch.items.length > 0)),
    );
  const unresolvedBySearch = Effect.fn("GitHubPullRequestProvider.unresolvedBySearch")(function* (
    input: Parameters<NonNullable<PullRequestProviderApi["listChangeRequestsAcross"]>>[0],
    batch: GitHubPullRequestApi.GitHubPullRequestSearchBatch,
  ) {
    // A repository a page has rows for is covered without asking.
    yield* Effect.forEach(
      batch.items,
      (item) => Cache.set(searchCoverage, coverageOf(input, item.repository), true),
      { discard: true },
    );
    const answered = new Set(batch.items.map((item) => item.repository.trim().toLowerCase()));
    const silent = input.repositories.filter(
      (repository) => !answered.has(repository.trim().toLowerCase()),
    );
    // A truncated first slice can be silent about a covered repository whose rows are just
    // older than the cut, so it vouches for none. Past the first slice silence from a covered
    // repository means its rows are older rather than absent.
    if (input.cursor === undefined && batch.truncated) return silent;
    return yield* Effect.filter(
      silent,
      (repository) =>
        Cache.get(searchCoverage, coverageOf(input, repository)).pipe(
          Effect.map((covered) => !covered),
          Effect.orElseSucceed(() => true),
        ),
      { concurrency: SEARCH_COVERAGE_CONCURRENCY },
    );
  });

  const fail = (operation: string) => (error: GitHubPullRequestApi.GitHubPullRequestApiError) =>
    new PullRequestProviderError({
      provider: SourceControlProviderKind.make("github"),
      operation,
      ...gitHubProviderFailure(error),
      detail: error.message,
      cause: error,
    });

  const withWorkflowChecks = <
    A extends Pick<
      GitHubPullRequestCore,
      "state" | "checks" | "headSha" | "headBranch" | "headRepositoryOwner" | "isCrossRepository"
    >,
  >(
    input: ProviderRepositoryRef & { readonly number: number },
    read: Effect.Effect<A, GitHubPullRequestApi.GitHubPullRequestApiError>,
  ) =>
    read.pipe(
      Effect.flatMap((pullRequest) =>
        (pullRequest.state !== "open" || pullRequest.isCrossRepository !== true
          ? Effect.succeed({
              runs: [] as ReadonlyArray<GitHubWorkflowRunApproval>,
              unavailable: false,
            })
          : pullRequest.headSha == null || pullRequest.headRepositoryOwner == null
            ? Effect.succeed({
                runs: [] as ReadonlyArray<GitHubWorkflowRunApproval>,
                unavailable: true,
              })
            : cli
                .listWorkflowRunsRequiringApproval({
                  ...input,
                  headSha: pullRequest.headSha,
                  headBranch: pullRequest.headBranch,
                  headRepositoryOwner: pullRequest.headRepositoryOwner,
                  isCrossRepository: true,
                })
                .pipe(
                  Effect.matchEffect({
                    onFailure: (error) =>
                      error._tag === "GitHubApiRateLimitError" ||
                      error._tag === "SourceControlRateLimitPausedError"
                        ? Effect.fail(error)
                        : Effect.succeed({
                            runs: [] as ReadonlyArray<GitHubWorkflowRunApproval>,
                            unavailable: true,
                          }),
                    onSuccess: (runs) => Effect.succeed({ runs, unavailable: false }),
                  }),
                )
        ).pipe(
          Effect.map((workflowApprovals) => ({
            ...pullRequest,
            checks: withWorkflowApprovals(
              pullRequest.checks,
              workflowApprovals.runs,
              workflowApprovals.unavailable,
            ),
            ...(workflowApprovals.unavailable
              ? {}
              : { workflowApprovalsRequired: workflowApprovals.runs.length }),
          })),
        ),
      ),
    );

  const observe = Effect.fnUntraced(function* <A>(
    read: Effect.Effect<A, GitHubPullRequestApi.GitHubPullRequestApiError>,
  ) {
    const observedAt = yield* Clock.currentTimeMillis;
    return { ...(yield* read), observedAt };
  });
  const sharedReadTtl = <A extends { readonly observedAt: number }>(
    exit: Exit.Exit<A, GitHubPullRequestApi.GitHubPullRequestApiError>,
  ) =>
    Exit.isSuccess(exit)
      ? Duration.millis(
          Math.max(
            0,
            exit.value.observedAt +
              Duration.toMillis(PULL_REQUEST_READ_TTL) -
              clock.currentTimeMillisUnsafe(),
          ),
        )
      : Duration.zero;
  const detailRequest = (input: PullRequestRef, fingerprint: string) =>
    new PullRequestRead(
      input,
      fingerprint,
      observe(withWorkflowChecks(input, cli.getPullRequestDetail(input))),
    );
  type DetailObservation = Effect.Success<ReturnType<typeof detailRequest>["lookup"]>;
  const details = yield* Cache.makeWith(
    (request: PullRequestRead<DetailObservation>) => request.lookup,
    {
      capacity: PULL_REQUEST_READ_CAPACITY,
      timeToLive: sharedReadTtl,
    },
  );
  const readChecks = (input: PullRequestRef) =>
    cli.revalidateChecks(input, withWorkflowChecks(input, cli.getPullRequestChecks(input)));
  type ChecksObservation = Observed<Effect.Success<ReturnType<typeof readChecks>>>;
  const checkReads = yield* Cache.makeWith(
    (request: PullRequestRead<ChecksObservation>) => request.lookup,
    {
      capacity: PULL_REQUEST_READ_CAPACITY,
      timeToLive: sharedReadTtl,
    },
  );
  const pinnedFingerprint = Effect.fnUntraced(function* (input: PullRequestRef) {
    const credential = yield* GitHubRequestPolicy.PinnedGitHubCredential;
    return credential !== null &&
      normalizeHost(credential.host) === normalizeHost(input.host) &&
      credential.credentialFingerprint.length > 0
      ? credential.credentialFingerprint
      : null;
  });
  const readSharedDetail = Effect.fn("GitHubPullRequestProvider.readSharedDetail")(function* (
    input: PullRequestRef,
  ) {
    const fingerprint = yield* pinnedFingerprint(input);
    return fingerprint === null
      ? yield* withWorkflowChecks(input, cli.getPullRequestDetail(input))
      : yield* Cache.get(details, detailRequest(input, fingerprint));
  });
  const readSharedChecks = Effect.fn("GitHubPullRequestProvider.readSharedChecks")(function* (
    input: PullRequestRef,
  ) {
    const fingerprint = yield* pinnedFingerprint(input);
    if (fingerprint === null) return yield* readChecks(input);
    return yield* Cache.get(
      checkReads,
      new PullRequestRead<ChecksObservation>(
        input,
        fingerprint,
        Effect.gen(function* () {
          const detail = yield* Cache.getOption(details, detailRequest(input, fingerprint)).pipe(
            Effect.orElseSucceed(() => Option.none<DetailObservation>()),
          );
          if (Option.isNone(detail)) return yield* observe(readChecks(input));
          return {
            state: detail.value.state,
            checks: detail.value.checks,
            ...(detail.value.headSha == null ? {} : { headSha: detail.value.headSha }),
            observedAt: detail.value.observedAt,
          };
        }),
      ),
    );
  });
  type ReadScope = Parameters<NonNullable<PullRequestProviderApi["forgetChangeRequestReads"]>>[0];
  const forgetCache = <A>(
    cache: Cache.Cache<PullRequestRead<A>, A, GitHubPullRequestApi.GitHubPullRequestApiError>,
    scope: ReadScope,
  ) =>
    Cache.keys(cache).pipe(
      Effect.flatMap((keys) =>
        Effect.forEach(
          Array.from(keys).filter(
            (key) =>
              scope === undefined ||
              (key.repository === scope.repository.trim().toLowerCase() &&
                (scope.number === undefined || key.number === scope.number)),
          ),
          (key) => Cache.invalidate(cache, key),
          { discard: true },
        ),
      ),
    );
  const forgetChangeRequestReads = Effect.fn("GitHubPullRequestProvider.forgetChangeRequestReads")(
    function* (scope?: ReadScope) {
      // Removing an entry detaches its in-flight lookup too; completion cannot put it back.
      yield* forgetCache(details, scope);
      yield* forgetCache(checkReads, scope);
    },
  );
  const writing =
    <I extends PullRequestRef, A, E>(write: (input: I) => Effect.Effect<A, E>) =>
    (input: I) => {
      const invalidate = forgetChangeRequestReads({
        repository: input.repository,
        ...("stackNumber" in input && input.stackNumber !== undefined
          ? {}
          : { number: input.number }),
      });
      return invalidate.pipe(
        Effect.andThen(() => write(input)),
        Effect.ensuring(invalidate),
      );
    };

  const provider: PullRequestProviderApi = {
    kind: SourceControlProviderKind.make("github"),
    capabilities: CAPABILITIES,
    unavailableRequirement: UNAVAILABLE_REQUIREMENT,
    readsPublicHostWithoutCheckout: true,
    mergeMessageRewrite: removeAgentCredits,
    getRoutingIdentity: (input) =>
      cli.getRoutingIdentity(input).pipe(Effect.mapError(fail("routeIdentity"))),
    withVerifiedCredential: (input, use) =>
      cli
        .withVerifiedCredential(input, (identity) => use(identity).pipe(Effect.result))
        .pipe(Effect.mapError(fail("routeIdentity")), Effect.flatMap(Effect.fromResult)),

    getViewer: (input) =>
      cli
        .getViewerLogin({ cwd: input.cwd, host: input.host ?? "github.com" })
        .pipe(Effect.mapError(fail("getViewer"))),

    listChangeRequests: (input) =>
      cli
        .listPullRequests({
          cwd: input.cwd,
          repository: input.repository,
          host: input.host,
          state: input.state,
          involvement: input.involvement,
          viewer: input.viewer,
          limit: input.limit,
          query: input.query,
          cursor: input.cursor,
          filters: input.filters,
        })
        .pipe(
          Effect.mapError(fail("listChangeRequests")),
          Effect.map((page) => ({
            ...page,
            items: page.items.map((item) => ({
              ...item,
              author: withAvatar(item.author, new Map<string, string>(), input.host),
            })),
          })),
        ),

    listChangeRequestsAcross: (input) =>
      cli
        .searchPullRequests({
          cwd: input.cwd,
          host: input.host,
          repositories: input.repositories,
          state: input.state,
          involvement: input.involvement,
          viewer: input.viewer,
          limit: input.limit,
          query: input.query,
          cursor: input.cursor,
          filters: input.filters,
        })
        .pipe(
          Effect.mapError(fail("listChangeRequestsAcross")),
          Effect.flatMap((batch) =>
            Effect.map(unresolvedBySearch(input, batch), (unresolved) => ({
              truncated: batch.truncated,
              items: batch.items.map((item) => ({
                ...item,
                author: withAvatar(item.author, new Map<string, string>(), input.host),
              })),
              unresolved,
            })),
          ),
        ),

    listChangeRequestStats: (input) =>
      cli
        .listPullRequestStats({
          cwd: input.cwd,
          host: input.host,
          changeRequests: input.changeRequests,
        })
        .pipe(Effect.mapError(fail("listChangeRequestStats"))),

    getChangeRequestSummary: (input) =>
      cli.getPullRequestSummary(input).pipe(
        Effect.map((summary) => ({
          ...summary,
          ...(summary.author === undefined
            ? {}
            : { author: withAvatar(summary.author, new Map(), input.host) }),
        })),
        Effect.mapError(fail("getChangeRequestSummary")),
      ),

    getChangeRequestStack: (input) =>
      cli.getPullRequestStack(input).pipe(Effect.mapError(fail("getChangeRequestStack"))),

    getChangeRequestWatchFingerprint: (input) =>
      cli
        .getPullRequestWatchFingerprint(input)
        .pipe(Effect.mapError(fail("getChangeRequestWatchFingerprint"))),

    getChangeRequestPreview: (input) =>
      cli.getPullRequestPreview(input).pipe(Effect.mapError(fail("getChangeRequestPreview"))),

    getChangeRequestCheckFailure: (input) =>
      cli.getCheckFailure(input).pipe(Effect.mapError(fail("getChangeRequestCheckFailure"))),

    getChangeRequestChecks: (input) =>
      readSharedChecks(input).pipe(
        Effect.map((value) => ({
          ...("observedAt" in value ? { observedAt: value.observedAt } : {}),
          state: value.state,
          checks: value.checks,
          ...(value.headSha == null ? {} : { headSha: value.headSha }),
        })),
        Effect.mapError(fail("getChangeRequestChecks")),
      ),

    getChangeRequest: (input) =>
      readSharedDetail(input).pipe(
        Effect.map((pullRequest): ProviderChangeRequestDetail => ({
          ...pullRequest,
          author: withAvatar(pullRequest.author, new Map<string, string>(), input.host),
          reviewers: [
            ...pullRequest.reviewRequestLogins.map((login) => ({
              login,
              name: null,
              avatarUrl: null,
            })),
            ...pullRequest.reviewRequestTeams,
          ],
          mergeCapabilities: pullRequest.viewerAccess.mergeCapabilities,
          viewerPermissions: {
            ...gitHubViewerPermissions({
              ...pullRequest.viewerAccess,
              canUpdateBranch: pullRequest.comparison?.viewerCanUpdate === true,
            }),
            maintainerEdits: pullRequest.canEditMaintainerEdits,
          },
          baseComparison:
            pullRequest.comparison === null || pullRequest.comparison.behindBy === null
              ? "unknown"
              : pullRequest.comparison.behindBy > 0
                ? "behind"
                : "up-to-date",
          ...(pullRequest.comparison?.behindBy == null
            ? {}
            : { behindBy: pullRequest.comparison.behindBy }),
        })),
        Effect.mapError(fail("getChangeRequest")),
      ),

    forgetChangeRequestReads,

    getChangeRequestActivity: (input) =>
      Effect.all(
        [
          cli.getPullRequestActivity(input),
          cli.listReviewThreadComments(input).pipe(
            Effect.orElseSucceed(() => ({
              comments: [],
              dismissalsByReviewId: new Map<string, string>(),
              reactions: [],
              reactionsById: new Map<string, ReadonlyArray<PullRequestReaction>>(),
              editedAtById: new Map<string, string>(),
              reviewThreads: [],
              commentCount: 0,
              truncated: true,
              reviewThreadsTruncated: true,
              reviewers: [],
              avatarsByLogin: new Map<string, string>(),
              botLogins: new Set<string>(),
              commits: [],
              viewer: { canUpdate: true, didAuthor: false },
            })),
          ),
        ],
        { concurrency: 2 },
      ).pipe(
        Effect.mapError(fail("getChangeRequestActivity")),
        Effect.map(([pullRequest, reviewThreads]): ProviderChangeRequestActivity => {
          const commitStats = new Map(
            pullRequest.commits.map(({ oid, additions, deletions }) => [
              oid,
              additions === undefined ? {} : { additions, deletions },
            ]),
          );
          return {
            author: withAvatar(
              pullRequest.author,
              reviewThreads.avatarsByLogin,
              input.host,
              reviewThreads.botLogins,
            ),
            reviewers: reviewThreads.reviewers,
            reactions: reviewThreads.reactions,
            commits: (reviewThreads.commits.length > 0
              ? reviewThreads.commits
              : pullRequest.commits
            ).map((commit) => ({
              ...commit,
              ...commitStats.get(commit.oid),
              authors: commit.authors?.map(
                (author) =>
                  withAvatar(
                    author,
                    reviewThreads.avatarsByLogin,
                    input.host,
                    reviewThreads.botLogins,
                  ) ?? author,
              ),
            })),
            comments: [...pullRequest.comments, ...reviewThreads.comments]
              .map((comment) => ({
                ...comment,
                // Dismissal reasons live on timeline events; HTML-only bot reviews need that fallback too.
                body:
                  comment.kind === "review" &&
                  comment.reviewState?.toUpperCase() === "DISMISSED" &&
                  rendersEmpty(comment.body)
                    ? (reviewThreads.dismissalsByReviewId.get(comment.id) ?? comment.body)
                    : comment.body,
                author: withAvatar(
                  comment.author,
                  reviewThreads.avatarsByLogin,
                  input.host,
                  reviewThreads.botLogins,
                ),
                reactions: comment.reactions ?? reviewThreads.reactionsById.get(comment.id) ?? [],
                editedAt: reviewThreads.editedAtById.get(comment.id) ?? comment.editedAt ?? null,
              }))
              .toSorted((left, right) => left.createdAt.localeCompare(right.createdAt)),
            commentCount: pullRequest.comments.length + reviewThreads.commentCount,
            commentsTruncated: reviewThreads.truncated,
            reviewThreadsTruncated: reviewThreads.reviewThreadsTruncated,
            reviewThreads: reviewThreads.reviewThreads.map((thread) => ({
              ...thread,
              comments: thread.comments.map((comment) => ({
                ...comment,
                author: withAvatar(
                  comment.author,
                  reviewThreads.avatarsByLogin,
                  input.host,
                  reviewThreads.botLogins,
                ),
              })),
            })),
          };
        }),
      ),

    getReviewThreadComments: (input) =>
      cli.getReviewThreadComments(input).pipe(Effect.mapError(fail("getReviewThreadComments"))),

    getViewerPermissions: (input) => {
      const lightAccess = cli
        .getViewerAccess({ ...input, allowReserve: true })
        .pipe(Effect.map((access) => gitHubViewerPermissions(access)));
      if (input.includeUpdateBranch === false) {
        return lightAccess.pipe(Effect.mapError(fail("getViewerPermissions")));
      }
      return cli.getPullRequestDetail(input).pipe(
        Effect.provideService(SourceControlRateLimit.Interactive, true),
        Effect.map((pullRequest) =>
          gitHubViewerPermissions({
            ...pullRequest.viewerAccess,
            canUpdateBranch:
              pullRequest.state === "open" && pullRequest.comparison?.viewerCanUpdate === true,
          }),
        ),
        Effect.catchIf(
          (error) =>
            error._tag !== "GitHubApiRateLimitError" &&
            error._tag !== "SourceControlRateLimitPausedError",
          () => lightAccess,
        ),
        Effect.mapError(fail("getViewerPermissions")),
      );
    },

    getDiff: (input) => cli.getPullRequestDiff(input).pipe(Effect.mapError(fail("getDiff"))),

    getDiffFileContents: (input) =>
      cli.getPullRequestDiffFileContents(input).pipe(Effect.mapError(fail("getDiffFileContents"))),

    getFilesViewed: (input) =>
      cli.getPullRequestFilesViewed(input).pipe(Effect.mapError(fail("getFilesViewed"))),

    getFileStats: (input) =>
      cli.getPullRequestFileStats(input).pipe(Effect.mapError(fail("getFileStats"))),
    setFilesViewed: (input) =>
      cli.setPullRequestFilesViewed(input).pipe(Effect.mapError(fail("setFilesViewed"))),

    listReviewerCandidates: (input) =>
      cli.listReviewerCandidates(input).pipe(Effect.mapError(fail("listReviewerCandidates"))),

    setReviewerRequest: writing((input) =>
      cli
        .setReviewerRequest({
          cwd: input.cwd,
          repository: input.repository,
          host: input.host,
          number: input.number,
          reviewers: input.reviewers,
          requested: input.requested,
        })
        .pipe(Effect.mapError(fail("setReviewerRequest"))),
    ),

    listLabelCandidates: (input) =>
      cli.listLabelCandidates(input).pipe(Effect.mapError(fail("listLabelCandidates"))),

    listRepositoryLabels: (input) =>
      cli.listRepositoryLabels(input).pipe(Effect.mapError(fail("listRepositoryLabels"))),

    searchRepositoryAuthors: (input) =>
      cli.searchRepositoryAuthors(input).pipe(Effect.mapError(fail("searchRepositoryAuthors"))),

    searchRepositoryReferences: (input) =>
      cli
        .searchRepositoryReferences(input)
        .pipe(Effect.mapError(fail("searchRepositoryReferences"))),

    setLabels: writing((input) =>
      cli
        .setLabels({
          cwd: input.cwd,
          repository: input.repository,
          host: input.host,
          number: input.number,
          labels: input.labels,
          applied: input.applied,
        })
        .pipe(Effect.mapError(fail("setLabels"))),
    ),

    runAction: writing((input) =>
      cli
        .runPullRequestAction({
          cwd: input.cwd,
          repository: input.repository,
          host: input.host,
          number: input.number,
          action: input.action,
          ...(input.removeAgentCreditsOnMerge === true ? { removeAgentCreditsOnMerge: true } : {}),
          ...(input.stackNumber === undefined ? {} : { stackNumber: input.stackNumber }),
          ...(input.expectedStackHeads === undefined
            ? {}
            : { expectedStackHeads: input.expectedStackHeads }),
          ...(input.mergeMethod === undefined ? {} : { mergeMethod: input.mergeMethod }),
          ...(input.updateMethod === undefined ? {} : { updateMethod: input.updateMethod }),
        })
        .pipe(Effect.mapError(fail("runAction"))),
    ),

    updateChangeRequest: writing((input) =>
      cli
        .updatePullRequest({
          ...(input.maintainerCanModify === undefined
            ? {}
            : { maintainerCanModify: input.maintainerCanModify }),
          cwd: input.cwd,
          repository: input.repository,
          host: input.host,
          number: input.number,
          ...(input.title === undefined ? {} : { title: input.title }),
          ...(input.body === undefined ? {} : { body: input.body }),
        })
        .pipe(Effect.mapError(fail("updateChangeRequest"))),
    ),

    comment: writing((input) =>
      cli.commentOnPullRequest(input).pipe(Effect.mapError(fail("comment"))),
    ),

    updateComment: writing((input) =>
      cli
        .updateComment({
          cwd: input.cwd,
          repository: input.repository,
          host: input.host,
          number: input.number,
          commentId: input.commentId,
          kind: input.kind,
          body: input.body,
        })
        .pipe(Effect.mapError(fail("updateComment"))),
    ),

    submitReview: writing((input) =>
      cli.submitReview(input).pipe(Effect.mapError(fail("submitReview"))),
    ),

    replyToThread: writing((input) =>
      cli
        .replyToReviewThread({
          cwd: input.cwd,
          repository: input.repository,
          host: input.host,
          threadId: input.threadId,
          body: input.body,
        })
        .pipe(Effect.mapError(fail("replyToThread"))),
    ),

    setReaction: writing((input) =>
      cli
        .setReaction({
          cwd: input.cwd,
          repository: input.repository,
          host: input.host,
          number: input.number,
          ...(input.subjectId === undefined ? {} : { subjectId: input.subjectId }),
          content: input.content,
          reacted: input.reacted,
        })
        .pipe(Effect.mapError(fail("setReaction"))),
    ),

    setThreadResolution: writing((input) =>
      cli
        .setReviewThreadResolution({
          cwd: input.cwd,
          repository: input.repository,
          host: input.host,
          threadId: input.threadId,
          resolved: input.resolved,
        })
        .pipe(Effect.mapError(fail("setThreadResolution"))),
    ),
  };

  return provider;
});
