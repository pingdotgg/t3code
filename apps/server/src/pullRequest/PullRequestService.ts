import * as Cache from "effect/Cache";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import {
  PullRequestOperationError,
  PullRequestUnavailableError,
  pullRequestHostOf,
  pullRequestProviderRequirement,
  resolvePullRequestAuthorFilter,
  type OrchestrationProjectShell,
  type PullRequestAction,
  type PullRequestActionInput,
  type PullRequestActivity,
  type PullRequestCommentInput,
  type PullRequestCommentUpdateInput,
  type PullRequestDetail,
  type PullRequestDiffFileContentsInput,
  type PullRequestDiffFileContentsResult,
  type PullRequestDiffStat,
  type PullRequestDiffInput,
  type PullRequestDiffResult,
  type PullRequestInvalidateInput,
  type PullRequestListEntry,
  type PullRequestListFilters,
  type PullRequestListInput,
  type PullRequestListProjectError,
  type PullRequestListResult,
  type PullRequestListStatsInput,
  type PullRequestListStatsResult,
  type PullRequestProviderSummary,
  type PullRequestReactionInput,
  type PullRequestRef,
  type PullRequestReviewVerdict,
  type PullRequestReviewerCandidateList,
  type PullRequestReviewerRequestInput,
  type PullRequestSubmitReviewInput,
  type PullRequestThreadReplyInput,
  type PullRequestThreadResolutionInput,
  type PullRequestThreadCommentsInput,
  type PullRequestThreadCommentsResult,
  type PullRequestUpdateInput,
  type SourceControlProviderInfo,
  type SourceControlProviderKind,
} from "@t3tools/contracts";
import { detectSourceControlProviderFromRemoteUrl } from "@t3tools/shared/sourceControl";

import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as SourceControlProviderRegistry from "../sourceControl/SourceControlProviderRegistry.ts";
import * as SourceControlRateLimit from "../sourceControl/SourceControlRateLimit.ts";
import {
  type ProviderChangeRequest,
  type ProviderListCursor,
  type PullRequestProviderApi,
  PullRequestProviderError,
} from "./PullRequestProvider.ts";
import { PullRequestProviderRegistry } from "./PullRequestProviderRegistry.ts";

/**
 * Rows per repository when the client does not ask for a page size, and rows per slice when a
 * listing is carried on from a cursor.
 *
 * 99 and not 100, because every provider asks its host for one row over this to probe for a next
 * page: 99 requests 100, which is exactly what a page of GitHub's API serves — GraphQL refuses
 * `first` over 100 with EXCESSIVE_PAGINATION and REST clamps `per_page` to it — and what GitLab
 * caps `per_page` at. Asking for 100 here would request 101 and buy a whole second round trip for
 * one row (measured: `gh pr list --limit 100` makes 1 HTTP request, `--limit 101` makes 2).
 */
const DEFAULT_REPOSITORY_LIST_LIMIT = 99;
/**
 * Repositories read at once. Each one is a CLI process that spends nearly all its wall clock
 * waiting on the host, so the useful ceiling is far above the core count; measured over 12
 * repositories on this listing's own command, 4 took ~12.7s, 8 ~8.9s and 12 ~4.9s, with 16 and 24
 * no faster because 12 already reads every repository in one wave.
 */
const REPOSITORY_CONCURRENCY = 12;
/**
 * Repositories named in one read across a host. Measured against GitHub's search: six hundred
 * `repo:` qualifiers in one query — 14.7KB of it — were all still honoured, and the answer took
 * the same three to six seconds at twelve repositories as at four hundred. A hundred is well
 * inside that and past the size of a workspace anyone opens, so a larger one reads in a handful
 * of searches rather than in a request per repository.
 */
const REPOSITORY_SEARCH_CHUNK = 100;

/**
 * Every read leaves the process — a CLI per repository, against hosts whose limits are low
 * (GitHub's search API allows ~30 requests a minute) — so answers are shared for a short
 * while and concurrent identical reads share one request. The windows sit near the clients'
 * own stale times: long enough that two people opening the same page cost one round trip,
 * short enough that "cached" and "fresh" never need telling apart on screen. Reads that
 * must not share — the refresh button, a client reloading after its own action — go through
 * `invalidate` rather than a flag on the read, so an ordinary read can never opt out.
 */
const LIST_CACHE_TTL = Duration.seconds(30);
const DETAIL_CACHE_TTL = Duration.seconds(15);
const DIFF_CACHE_TTL = Duration.seconds(60);
/** A commit is content-addressed, so its own diff cannot change under its key. */
const COMMIT_DIFF_CACHE_TTL = Duration.minutes(10);
/** Sized like the client's own stale time; a row's counts move only when somebody pushes. */
const LIST_STATS_CACHE_TTL = Duration.seconds(60);
/** A diff can stay interactive while its next cached value is fetched off the critical path. */
const DIFF_STALE_WINDOW = Duration.minutes(10);
/** How long one host's signed-in login is believed without asking its CLI again. */
const VIEWER_CACHE_TTL = Duration.minutes(10);
const LIST_CACHE_CAPACITY = 64;
const LIST_STATS_CACHE_CAPACITY = 32;
const DETAIL_CACHE_CAPACITY = 128;
const DIFF_CACHE_CAPACITY = 128;

export type PullRequestError = PullRequestUnavailableError | PullRequestOperationError;

export class PullRequestService extends Context.Service<
  PullRequestService,
  {
    readonly list: (
      input: PullRequestListInput,
    ) => Effect.Effect<PullRequestListResult, PullRequestError>;
    readonly listStats: (
      input: PullRequestListStatsInput,
    ) => Effect.Effect<PullRequestListStatsResult, PullRequestError>;
    readonly detail: (input: PullRequestRef) => Effect.Effect<PullRequestDetail, PullRequestError>;
    readonly activity: (
      input: PullRequestRef,
    ) => Effect.Effect<PullRequestActivity, PullRequestError>;
    readonly threadComments: (
      input: PullRequestThreadCommentsInput,
    ) => Effect.Effect<PullRequestThreadCommentsResult, PullRequestError>;
    readonly diff: (
      input: PullRequestDiffInput,
    ) => Effect.Effect<PullRequestDiffResult, PullRequestError>;
    readonly diffFileContents: (
      input: PullRequestDiffFileContentsInput,
    ) => Effect.Effect<PullRequestDiffFileContentsResult, PullRequestError>;
    readonly runAction: (input: PullRequestActionInput) => Effect.Effect<void, PullRequestError>;
    readonly update: (input: PullRequestUpdateInput) => Effect.Effect<void, PullRequestError>;
    readonly comment: (input: PullRequestCommentInput) => Effect.Effect<void, PullRequestError>;
    readonly updateComment: (
      input: PullRequestCommentUpdateInput,
    ) => Effect.Effect<void, PullRequestError>;
    readonly submitReview: (
      input: PullRequestSubmitReviewInput,
    ) => Effect.Effect<void, PullRequestError>;
    readonly replyToThread: (
      input: PullRequestThreadReplyInput,
    ) => Effect.Effect<void, PullRequestError>;
    readonly setThreadResolution: (
      input: PullRequestThreadResolutionInput,
    ) => Effect.Effect<void, PullRequestError>;
    readonly setReaction: (
      input: PullRequestReactionInput,
    ) => Effect.Effect<void, PullRequestError>;
    readonly reviewerCandidates: (
      input: PullRequestRef,
    ) => Effect.Effect<PullRequestReviewerCandidateList, PullRequestError>;
    readonly requestReviewers: (
      input: PullRequestReviewerRequestInput,
    ) => Effect.Effect<void, PullRequestError>;
    readonly invalidate: (input: PullRequestInvalidateInput) => Effect.Effect<void>;
  }
>()("t3/pullRequest/PullRequestService") {}

/** What a verdict is called when refusing it, so the sentence reads as an action. */
const VERDICT_LABELS: Record<PullRequestReviewVerdict, string> = {
  comment: "review",
  approve: "approve",
  "request-changes": "request changes on",
};

/**
 * Why an action is refused to this viewer, said as the access it would take rather than as the
 * refusal the host would have answered with. Merging is the one that needs write and nothing
 * else; the other four are also the author's to take, whatever access they have.
 */
const ACTION_ACCESS_REFUSALS: Record<PullRequestAction, string> = {
  merge: "You need write access on this repository to merge.",
  ready:
    "You need write access on this repository, or to have opened this change request, to mark it ready for review.",
  draft:
    "You need write access on this repository, or to have opened this change request, to return it to a draft.",
  close:
    "You need write access on this repository, or to have opened this change request, to close it.",
  "update-branch":
    "You need write access on this repository, or to have opened this change request, to update its branch.",
  reopen:
    "You need write access on this repository, or to have opened this change request, to reopen it.",
  "enable-auto-merge":
    "You need write access on this repository to have it merged for you once it is ready.",
  "disable-auto-merge":
    "You need write access on this repository to stop it being merged for you once it is ready.",
};

/**
 * Why asking for a review is refused, and why the menu behind it is too. Write access is what the
 * hosts that state anything about this want; the ones that state nothing grant it, so this
 * sentence is only ever the answer where a host said no.
 */
const REVIEWER_REQUEST_REFUSAL = "You need write access on this repository to ask for a review.";

/** A project this page can read: its remote is on a host with an implementation. */
interface SupportedProject {
  readonly project: OrchestrationProjectShell;
  readonly api: PullRequestProviderApi;
  readonly repository: string;
  /** The host the repository lives on, which is the account boundary rather than the kind. */
  readonly host: string;
}

/**
 * What the workspace has, split by whether this build can read it. Hosts with no
 * implementation are counted rather than dropped, so their projects are explained in the
 * provider list instead of quietly missing from the page.
 */
interface WorkspaceProjects {
  readonly supported: ReadonlyArray<SupportedProject>;
  /** Keyed by host, as the readable ones are: an unimplemented host is its own switcher entry. */
  readonly unimplemented: ReadonlyMap<
    string,
    { readonly kind: SourceControlProviderKind; readonly projectCount: number }
  >;
  /**
   * Every checkout on a host, including the ones the listing de-duplicated away. Asking who is
   * signed in is a question about the host rather than about a repository, and any checkout can
   * answer it — so a broken worktree is not allowed to take the host down with it just because
   * it happened to be the one the listing kept.
   */
  readonly viewerRoots: ReadonlyMap<string, ReadonlyArray<string>>;
}

interface RepositoryBatch {
  /** Which repository this slice came from, which is what a cursor for it is filed under. */
  readonly key: string;
  readonly entries: ReadonlyArray<PullRequestListEntry>;
  readonly errors: ReadonlyArray<PullRequestListProjectError>;
  readonly truncated: boolean;
  readonly nextCursor: string | null;
}

/** What the providers are told, plus the part only the service acts on. */
interface ListCursor extends ProviderListCursor {
  /**
   * The rows already handed over at exactly `updatedBefore`. The next read asks for that instant
   * inclusively, so these are what keeps it from sending them a second time.
   */
  readonly seenAt: ReadonlyArray<number>;
}

/**
 * A continuation as it travels through the page and back. Written out rather than encoded because
 * it comes back from a client and has to be believed or refused on sight: everything a host is
 * given is either a timestamp of this shape or a number of this length, which is what lets a
 * provider drop it into a filter without checking it again.
 */
const LIST_CURSOR_PATTERN =
  /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2}))\|(\d{1,9})\|(\d{1,9}(?:,\d{1,9})*)?$/;

function parseListCursor(raw: string): ListCursor | null {
  const match = LIST_CURSOR_PATTERN.exec(raw);
  if (match === null) return null;
  const seenAt = match[3];
  return {
    updatedBefore: match[1]!,
    delivered: Number(match[2]),
    seenAt: seenAt === undefined ? [] : seenAt.split(",").map(Number),
  };
}

/**
 * How a listing tells two repositories apart. The host is part of it because the same
 * `owner/repo` exists on github.com and on an Enterprise install, and they are two repositories.
 */
function listCursorKey(host: string, repository: string): string {
  return `${host} ${repository.toLowerCase()}`;
}

/**
 * Where a repository carries on, worked out from the slice just handed over. The boundary is the
 * instant of the oldest row in it: the next read asks for that instant and everything before it,
 * and names the rows already sent at it so none of them arrives twice.
 *
 * The names carry over when the boundary has not moved. A slice that ends on the same instant it
 * began on has to keep the earlier rows excluded as well as its own, or the read after it would
 * hand them over again.
 */
function nextListCursor(
  previous: ListCursor | undefined,
  /** What the host handed over, before the rows already sent were dropped from it. */
  fetched: ReadonlyArray<ProviderChangeRequest>,
  /** What is being sent on, which is what the count of delivered rows is about. */
  delivered: ReadonlyArray<ProviderChangeRequest>,
  /** A provider may consume malformed offset-paged rows that never appear in `delivered`. */
  cursorAdvance = delivered.length,
): string | null {
  // The host had nothing at all, so there is no row to carry on from — and repeating the cursor
  // that produced the empty slice would ask the same question forever.
  if (fetched.length === 0) return null;
  // Taken from what the host answered rather than from what survived de-duplication: a slice can
  // be entirely rows already sent — a hundred change requests touched in the same second is one
  // repository's boring afternoon — and reading "nothing new" as "nothing left" would end the
  // walk on the instant it was stuck on, with everything older unreachable for good.
  const oldest = fetched.reduce((left, right) => (right.updatedAt < left.updatedAt ? right : left));
  return listCursorAt(previous, oldest.updatedAt, fetched, cursorAdvance);
}

/**
 * The same cursor against a boundary chosen elsewhere, which is what a slice read across several
 * repositories at once needs: every repository in it is read up to the oldest row of the whole
 * slice, including the ones that contributed nothing to it — their rows are simply all older, and
 * a repository that carried on from its own oldest row would be right about where it stopped and
 * silent about the ones that never appeared.
 */
function listCursorAt(
  previous: ListCursor | undefined,
  boundary: string,
  /** This repository's own rows in the slice, before the ones already sent were dropped. */
  fetched: ReadonlyArray<ProviderChangeRequest>,
  deliveredCount: number,
): string {
  const seenAt = [
    ...(previous?.updatedBefore === boundary ? previous.seenAt : []),
    ...fetched.filter((item) => item.updatedAt === boundary).map((item) => item.number),
  ];
  return `${boundary}|${(previous?.delivered ?? 0) + deliveredCount}|${seenAt.join(",")}`;
}

/** A host that cannot be read at all, as opposed to one request that failed. */
function isProviderUnusable(error: PullRequestProviderError): boolean {
  return error.reason === "missing-tool" || error.reason === "unauthenticated";
}

/**
 * Why a host is not readable, told as the thing to do about it. A host that is simply not set up
 * says so in the same words the whole-page state uses, rather than repeating whatever its tool
 * printed — "HTTP 401" names the symptom, not the fix.
 */
function providerDetail(error: PullRequestProviderError): string {
  if (!isProviderUnusable(error)) return error.detail;
  return (
    pullRequestProviderRequirement(
      error.provider,
      error.reason === "missing-tool" ? "cli-missing" : "cli-unauthenticated",
    ) ?? error.detail
  );
}

function toUnavailableError(error: PullRequestProviderError): PullRequestUnavailableError {
  return new PullRequestUnavailableError({
    reason: error.reason === "missing-tool" ? "cli-missing" : "cli-unauthenticated",
    provider: error.provider,
    cause: error,
  });
}

function toPullRequestError(
  operation: string,
): (error: PullRequestProviderError) => PullRequestError {
  return (error) =>
    isProviderUnusable(error)
      ? toUnavailableError(error)
      : new PullRequestOperationError({ operation, detail: error.detail, cause: error });
}

function withRateLimitBackoff(
  api: PullRequestProviderApi,
  host: string,
  limits: SourceControlRateLimit.SourceControlRateLimit["Service"],
): PullRequestProviderApi {
  const key = { provider: api.kind, host };
  const protect = <A>(
    operation: string,
    effect: Effect.Effect<A, PullRequestProviderError>,
    allowPaused: boolean,
  ) =>
    limits.check(key, allowPaused ? { allowPaused: true } : undefined).pipe(
      Effect.mapError(
        (error) =>
          new PullRequestProviderError({
            provider: api.kind,
            operation,
            reason: "rate-limited",
            detail: error.detail,
            retryAt: error.retryAt,
            cause: error,
          }),
      ),
      Effect.flatMap((lease) =>
        effect.pipe(
          Effect.tap(() => limits.recordSuccess({ ...key, lease })),
          Effect.tapError((error) =>
            error.reason === "rate-limited"
              ? limits.recordRateLimit({
                  ...key,
                  lease,
                  ...(error.retryAt === undefined ? {} : { retryAt: error.retryAt }),
                })
              : Effect.void,
          ),
        ),
      ),
    );
  const wrap =
    <Args extends ReadonlyArray<unknown>, A>(
      operation: string,
      call: (...args: Args) => Effect.Effect<A, PullRequestProviderError>,
      allowPaused = false,
    ) =>
    (...args: Args) =>
      protect(operation, call(...args), allowPaused);
  const interactive = <Args extends ReadonlyArray<unknown>, A>(
    operation: string,
    call: (...args: Args) => Effect.Effect<A, PullRequestProviderError>,
  ) => wrap(operation, call, true);

  return {
    kind: api.kind,
    capabilities: api.capabilities,
    getViewer: wrap("getViewer", api.getViewer),
    listChangeRequests: wrap("listChangeRequests", api.listChangeRequests),
    ...(api.listChangeRequestsAcross === undefined
      ? {}
      : {
          listChangeRequestsAcross: wrap("listChangeRequestsAcross", api.listChangeRequestsAcross),
        }),
    ...(api.listChangeRequestStats === undefined
      ? {}
      : {
          listChangeRequestStats: wrap("listChangeRequestStats", api.listChangeRequestStats),
        }),
    getChangeRequest: wrap("getChangeRequest", api.getChangeRequest),
    getChangeRequestActivity: wrap("getChangeRequestActivity", api.getChangeRequestActivity),
    ...(api.getReviewThreadComments === undefined
      ? {}
      : {
          getReviewThreadComments: wrap("getReviewThreadComments", api.getReviewThreadComments),
        }),
    getViewerPermissions: interactive("getViewerPermissions", api.getViewerPermissions),
    getDiff: wrap("getDiff", api.getDiff),
    ...(api.getDiffFileContents === undefined
      ? {}
      : { getDiffFileContents: wrap("getDiffFileContents", api.getDiffFileContents) }),
    runAction: interactive("runAction", api.runAction),
    ...(api.updateChangeRequest === undefined
      ? {}
      : {
          updateChangeRequest: interactive("updateChangeRequest", api.updateChangeRequest),
        }),
    comment: interactive("comment", api.comment),
    ...(api.updateComment === undefined
      ? {}
      : { updateComment: interactive("updateComment", api.updateComment) }),
    submitReview: interactive("submitReview", api.submitReview),
    listReviewerCandidates: interactive("listReviewerCandidates", api.listReviewerCandidates),
    setReviewerRequest: interactive("setReviewerRequest", api.setReviewerRequest),
    replyToThread: interactive("replyToThread", api.replyToThread),
    setReaction: interactive("setReaction", api.setReaction),
    setThreadResolution: interactive("setThreadResolution", api.setThreadResolution),
  };
}

/**
 * The provider-native repository selector. `displayName` is the full path below the host, which
 * is what nested GitLab groups need; owner/name is the two-segment fallback for identities
 * recorded before that field existed.
 *
 * Azure DevOps is the exception: `az repos pr list --repository` takes a repository name, and
 * takes the organisation and project from the checkout it detects — so the recorded
 * `org/project/_git/repo` path is refused outright and the whole repository reads as
 * unavailable. Its name is the last segment, which is what this hands over.
 *
 * One function because everything downstream is keyed by what it answers: the rows' own
 * `repository`, the per-repository cursors, and the detail and diff reads a row leads to.
 */
export function repositoryIdentityOf(project: OrchestrationProjectShell): string | null {
  const identity = project.repositoryIdentity;
  if (!identity) return null;
  if (identity.provider === "azure-devops") {
    const segments = (identity.displayName ?? "").split("/").filter((part) => part !== "_git");
    return identity.name || segments.at(-1) || null;
  }
  if (identity.displayName) return identity.displayName;
  return identity.owner && identity.name ? `${identity.owner}/${identity.name}` : null;
}

export const make = Effect.gen(function* () {
  const registry = yield* PullRequestProviderRegistry;
  const projections = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const sourceControlProviders = yield* SourceControlProviderRegistry.SourceControlProviderRegistry;
  const rateLimits = yield* SourceControlRateLimit.SourceControlRateLimit;

  const refineUnknownProjectKinds = (
    projects: ReadonlyArray<OrchestrationProjectShell>,
    filter: Pick<PullRequestListInput, "projectId" | "host">,
  ) => {
    type RefinementCandidate = {
      readonly project: OrchestrationProjectShell;
      readonly provider: SourceControlProviderInfo;
      readonly remoteName: string;
      readonly remoteUrl: string;
    };
    const refinements = new Map<string, RefinementCandidate[]>();
    for (const project of projects) {
      if (filter.projectId !== undefined && project.id !== filter.projectId) continue;
      const identity = project.repositoryIdentity;
      if (identity?.provider !== "unknown" || repositoryIdentityOf(project) === null) continue;
      const host = pullRequestHostOf(identity, "unknown");
      // A legacy identity has no canonical host until its provider is refined, so it must reach
      // the refinement before a host filter can decide whether it belongs in the result.
      if (filter.host !== undefined && host !== "unknown" && host !== filter.host.toLowerCase()) {
        continue;
      }
      const { remoteName, remoteUrl } = identity.locator;
      const provider = detectSourceControlProviderFromRemoteUrl(remoteUrl);
      if (provider !== null) {
        const candidates = refinements.get(provider.baseUrl);
        const candidate = { project, provider, remoteName, remoteUrl };
        if (candidates === undefined) refinements.set(provider.baseUrl, [candidate]);
        else candidates.push(candidate);
      }
    }

    return Effect.forEach(
      refinements,
      ([baseUrl, candidates]) =>
        Effect.firstSuccessOf(
          candidates.map(({ project, provider, remoteName, remoteUrl }) =>
            Effect.suspend(() =>
              sourceControlProviders.resolveHandle({
                cwd: project.workspaceRoot,
                context: { provider, remoteName, remoteUrl },
              }),
            ).pipe(
              Effect.flatMap((handle) => {
                const kind = handle.context?.provider.kind;
                return kind === undefined || kind === "unknown"
                  ? Effect.fail(undefined)
                  : Effect.succeed(kind);
              }),
            ),
          ),
        ).pipe(
          Effect.map((kind) => [baseUrl, kind] as const),
          Effect.orElseSucceed(() => [baseUrl, "unknown"] as const),
        ),
      { concurrency: REPOSITORY_CONCURRENCY },
    ).pipe(Effect.map((resolved) => new Map(resolved)));
  };

  const listWorkspaceProjects = (
    filter: Pick<PullRequestListInput, "projectId" | "projectIds" | "host">,
  ): Effect.Effect<WorkspaceProjects, PullRequestError> =>
    projections.getShellSnapshot().pipe(
      Effect.mapError(
        (error) =>
          new PullRequestOperationError({
            operation: "listProjects",
            detail: "The project list could not be read.",
            cause: error,
          }),
      ),
      Effect.flatMap((snapshot) =>
        refineUnknownProjectKinds(snapshot.projects, filter).pipe(
          Effect.map((refinedKinds) => ({ refinedKinds, snapshot })),
        ),
      ),
      Effect.map(({ refinedKinds, snapshot }) => {
        const supported: SupportedProject[] = [];
        const unimplemented = new Map<
          string,
          { kind: SourceControlProviderKind; projectCount: number }
        >();
        const viewerRoots = new Map<string, string[]>();
        const seen = new Set<string>();
        for (const project of snapshot.projects) {
          if (filter.projectId !== undefined && project.id !== filter.projectId) continue;
          if (filter.projectIds !== undefined && !filter.projectIds.includes(project.id)) continue;
          const identity = project.repositoryIdentity;
          let kind = identity?.provider as SourceControlProviderKind | undefined;
          const repository = repositoryIdentityOf(project);
          if (!identity || kind === undefined || repository === null) continue;
          // Worktrees of one repository are separate projects; reading the remote once keeps
          // the page from repeating every change request per local checkout. The host is part
          // of the key, so the same `owner/repo` on two hosts stays two repositories.
          if (kind === "unknown") {
            const provider = detectSourceControlProviderFromRemoteUrl(identity.locator.remoteUrl);
            kind = provider === null ? kind : (refinedKinds.get(provider.baseUrl) ?? kind);
          }
          const host = pullRequestHostOf(identity, kind);
          if (filter.host !== undefined && host !== filter.host.toLowerCase()) continue;
          const api = registry.get(kind);
          // Recorded before the de-duplication below, so the viewer lookup keeps the alternates
          // the listing is about to drop.
          if (api !== null) {
            const roots = viewerRoots.get(host);
            if (roots === undefined) viewerRoots.set(host, [project.workspaceRoot]);
            else if (!roots.includes(project.workspaceRoot)) roots.push(project.workspaceRoot);
          }
          const key = listCursorKey(host, repository);
          if (seen.has(key)) continue;
          seen.add(key);
          if (api === null) {
            const counted = unimplemented.get(host);
            if (counted === undefined) unimplemented.set(host, { kind, projectCount: 1 });
            else counted.projectCount += 1;
            continue;
          }
          supported.push({
            project,
            api: withRateLimitBackoff(api, host, rateLimits),
            repository,
            host,
          });
        }
        return { supported, unimplemented, viewerRoots };
      }),
    );

  const requireProject = (ref: PullRequestRef): Effect.Effect<SupportedProject, PullRequestError> =>
    listWorkspaceProjects({ projectId: ref.projectId }).pipe(
      Effect.flatMap(({ supported }): Effect.Effect<SupportedProject, PullRequestError> => {
        const match = supported[0];
        if (!match) {
          return Effect.fail(new PullRequestUnavailableError({ reason: "provider-unsupported" }));
        }
        // The repository travels through the client, so it is checked against the project's
        // own remote rather than being handed to a provider verbatim.
        if (match.repository.toLowerCase() !== ref.repository.trim().toLowerCase()) {
          return Effect.fail(
            new PullRequestOperationError({
              operation: "resolveRepository",
              detail: "The change request does not belong to the selected project.",
            }),
          );
        }
        return Effect.succeed(match);
      }),
    );

  /**
   * What the signed-in account may do with this change request, asked of the host itself. Every
   * write goes through it: the page hides what a viewer may not do, and a request that arrived
   * without passing through the page — or after the access behind it was withdrawn — must not be
   * handed to a provider on the client's word. Read freshly for that reason, rather than taken
   * from whatever the detail said when the page loaded.
   */
  const viewerPermissionsOf = (project: SupportedProject, ref: PullRequestRef, operation: string) =>
    project.api
      .getViewerPermissions({
        cwd: project.project.workspaceRoot,
        repository: project.repository,
        host: project.host,
        number: ref.number,
      })
      .pipe(Effect.mapError(toPullRequestError(operation)));

  /**
   * The cursors the page sent back, read once before any host is asked anything. Null where the
   * page sent none, which is the listing read from its newest row.
   */
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

  /**
   * One viewer lookup per host, tried across that host's workspaces so a single broken checkout
   * cannot hide every healthy repository on it. Per host and not per provider kind: two GitHub
   * hosts are two accounts, and the wrong login would misattribute every review request.
   *
   * Its failure doubles as the answer to "is this host set up", which is what the provider
   * switcher shows.
   */
  type ResolvedViewer = {
    readonly host: string;
    readonly kind: SourceControlProviderKind;
    readonly viewer: string | null;
    readonly error: PullRequestProviderError | null;
  };
  // Who is signed in moves on the timescale of `gh auth login`, not of a page visit, yet every
  // list read was asking each host's CLI again — a subprocess and a network round trip per host
  // per read, three reads per page. Only a success is believed for a while: a failure is the
  // "is this host set up" answer the provider switcher shows, and holding it would keep saying
  // signed-out after the reader has signed in.
  const viewersByHost = new Map<string, { readonly at: number; readonly result: ResolvedViewer }>();

  const resolveViewers = (
    projects: ReadonlyArray<SupportedProject>,
    viewerRoots: WorkspaceProjects["viewerRoots"],
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
          // Every checkout on the host, not just the ones that survived de-duplication: one
          // unreadable worktree would otherwise report the whole host as signed out.
          const roots =
            viewerRoots.get(host) ?? forHost.map(({ project }) => project.workspaceRoot);
          return Effect.firstSuccessOf(roots.map((cwd) => api.getViewer({ cwd }))).pipe(
            Effect.map((viewer) => ({
              host,
              kind: api.kind,
              viewer: viewer as string | null,
              error: null as PullRequestProviderError | null,
            })),
            Effect.tap((result) =>
              Effect.map(Clock.currentTimeMillis, (at) => viewersByHost.set(host, { at, result })),
            ),
            Effect.catch((error) => Effect.succeed({ host, kind: api.kind, viewer: null, error })),
          );
        }),
      { concurrency: REPOSITORY_CONCURRENCY },
    );

  /**
   * The narrowings a row can be judged by from its own fields, applied here rather than trusted
   * to the host. Only GitHub is asked to narrow a listing for itself; every other provider
   * answers unnarrowed, and without this pass a draft filter or a label filter would be sent,
   * accepted and quietly ignored. Idempotent for the hosts that did narrow.
   *
   * `checks` is absent because no listed row carries its check state: that one filter is the
   * host's alone, and a row nobody narrowed stays rather than being guessed at.
   */
  const matchesRowFilters = (
    item: ProviderChangeRequest,
    filters: PullRequestListFilters | undefined,
    viewer: string,
  ): boolean => {
    if (filters === undefined) return true;
    const labels = item.labels.map((label) => label.name.trim().toLowerCase());
    const holds = (label: string) => labels.includes(label.trim().toLowerCase());
    return (
      (filters.draft === undefined || item.isDraft === (filters.draft === "only")) &&
      // Judged on the provider row rather than the entry, because the two absences mean
      // different things and the entry keeps only one of them: `null` is a host that summarises
      // its reviews saying there is no decision yet, which is what "none" asks for, while
      // `undefined` is a host that does not summarise at all — an unjudgeable row, left alone
      // the way an unreadable check state is.
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
  }): PullRequestListEntry => {
    const viewer = input.viewer.toLowerCase();
    return {
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

  const listUncached: PullRequestService["Service"]["list"] = (input) =>
    Effect.gen(function* () {
      const involvement = input.involvement ?? "all";
      // Refused whole rather than per repository: a cursor is only ever a value this service
      // issued, so one that does not read as one means the page is sending something it made up,
      // and reading part of the listing under that assumption would quietly lose rows.
      const continuation = yield* decodeCursors(input.cursors);
      const {
        supported: projects,
        unimplemented,
        viewerRoots,
      } = yield* listWorkspaceProjects(input);
      const projectCounts = new Map<string, number>();
      for (const { host } of projects) {
        projectCounts.set(host, (projectCounts.get(host) ?? 0) + 1);
      }

      const viewerResults = yield* resolveViewers(projects, viewerRoots);
      const viewers: Record<string, string> = {};
      for (const result of viewerResults) {
        if (result.viewer !== null) viewers[result.host] = result.viewer;
      }

      // One summary per host, which is what the viewer lookup already answers for: two GitHub
      // hosts sign in separately, so collapsing them by kind would report one as the other.
      const providers: ReadonlyArray<PullRequestProviderSummary> = [
        ...viewerResults.map((result) => ({
          host: result.host,
          kind: result.kind,
          searchesOnHost:
            projects.find((project) => project.host === result.host)?.api.capabilities.search ??
            false,
          projectCount: projectCounts.get(result.host) ?? 1,
          configured: result.viewer !== null,
          detail: result.error === null ? null : providerDetail(result.error),
        })),
        ...[...unimplemented].map(([host, { kind, projectCount }]) => ({
          host,
          kind,
          searchesOnHost: false,
          projectCount,
          configured: false,
          detail: "This host cannot be browsed here yet.",
        })),
      ];

      // A continued listing reads only the repositories it was asked to carry on with: every
      // other one is already on the page, and reading it again is the whole cost this is here to
      // avoid. The host summaries above stay over the whole workspace, because the switcher they
      // fill is about the workspace rather than about this slice.
      const selected =
        continuation === null
          ? projects
          : projects.filter(({ host, repository }) =>
              continuation.has(listCursorKey(host, repository)),
            );
      const readable = selected.filter(({ host }) => viewers[host] !== undefined);
      // A host that could not be read still has projects, and they are absent from the list.
      // Reporting them keeps "N repositories were unavailable" honest instead of dropping them.
      const unreadable = selected
        .filter(({ host }) => viewers[host] === undefined)
        .map(({ project, repository }) => ({
          projectId: project.id,
          projectTitle: project.title,
          message: `${repository} could not be read.`,
        }));
      if (readable.length === 0) {
        // No host this request covers can be read, so it is not a per-project problem. An
        // unusable host is preferred as the reported cause because it names the fix; a host
        // that merely failed reports as a failed operation rather than as a signed-out CLI,
        // which would send the reader to `auth login` over a transient error.
        //
        // Only the hosts this request was actually going to read: a continuation that named
        // nothing has asked for nothing, and a host it never mentioned being signed out is no
        // reason to refuse it.
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
        continuation?.get(listCursorKey(project.host, project.repository));

      /**
       * One repository asked on its own. What every host without a search across repositories
       * does, and what a batched read falls back to for a repository it could not answer for.
       */
      const readRepository = (project: SupportedProject): Effect.Effect<RepositoryBatch> => {
        {
          const viewer = viewers[project.host]!;
          const key = listCursorKey(project.host, project.repository);
          const cursor = cursorOf(project);
          return project.api
            .listChangeRequests({
              cwd: project.project.workspaceRoot,
              repository: project.repository,
              host: project.host,
              state: input.state,
              involvement,
              viewer,
              limit,
              // Each host matches this its own way, and one that cannot match text at all
              // answers unnarrowed rather than failing.
              query: input.query,
              filters: input.filters,
              // Only the two fields a host can act on: which rows have already been sent at the
              // boundary instant is this service's business, not a provider's.
              ...(cursor === undefined
                ? {}
                : {
                    cursor: { updatedBefore: cursor.updatedBefore, delivered: cursor.delivered },
                  }),
            })
            .pipe(
              Effect.map((page): RepositoryBatch => {
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
                    .map((item) => toEntry({ project, item, viewer })),
                  errors: [],
                  truncated: page.truncated,
                  nextCursor:
                    page.continues && page.truncated
                      ? nextListCursor(cursor, page.items, items, page.cursorAdvance)
                      : null,
                };
              }),
              // One unreachable repository must not blank the page. A host-level failure is
              // already reported through `providers`, so it degrades the same way here.
              Effect.orElseSucceed(
                (): RepositoryBatch => ({
                  key,
                  entries: [],
                  errors: [
                    {
                      projectId: project.project.id,
                      projectTitle: project.project.title,
                      message: `${project.repository} could not be read.`,
                    },
                  ],
                  truncated: false,
                  nextCursor: null,
                }),
              ),
            );
        }
      };

      /**
       * One host's repositories in one read. The slice is the newest `limit` rows across all of
       * them, so it is split back up by repository here: the page still reports per project, and
       * each repository still carries on from a cursor of its own.
       *
       * A read that fails is read the long way instead. The batch is an optimisation, and a host
       * that could not answer one question about twelve repositories should not report twelve
       * repositories as unreadable before anyone has asked it about them one at a time.
       */
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
          Effect.flatMap((page) => {
            const rows = new Map<string, Array<ProviderChangeRequest>>();
            for (const item of page.items) {
              const key = item.repository.trim().toLowerCase();
              const held = rows.get(key);
              if (held === undefined) rows.set(key, [item]);
              else held.push(item);
            }
            // The oldest row of the whole slice, which is how far every repository in it has now
            // been read — including the ones that contributed nothing to it.
            const boundary = page.items.reduce<string | null>(
              (oldest, item) =>
                oldest === null || item.updatedAt < oldest ? item.updatedAt : oldest,
              null,
            );
            return Effect.forEach(
              chunk,
              (project): Effect.Effect<RepositoryBatch> => {
                const fetched = rows.get(project.repository.trim().toLowerCase()) ?? [];
                // GitHub does not index every repository for search — a renamed one answers for
                // its old name with silence rather than with an error — so a repository the
                // search said nothing at all about is read on its own, once, before it is
                // believed. Only on its first slice: after that it has a boundary to carry on
                // from, and silence past one means the rows are older rather than absent. That
                // keeps a search-invisible repository from disappearing on a busy host, at the
                // price of one request per repository with nothing in the first slice — which
                // run together, and only there.
                if (fetched.length === 0 && cursorOf(project) === undefined) {
                  return readRepository(project);
                }
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
                  key: listCursorKey(project.host, project.repository),
                  entries: items
                    .filter((item) => matchesRowFilters(item, input.filters, viewer))
                    .map((item) => toEntry({ project, item, viewer })),
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

      // A host with a search across repositories is asked once for all of them; everyone else is
      // asked once each. Repositories standing at different points of the same listing are
      // different questions, so they are grouped by the boundary they carry on from.
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

  /**
   * Who this project's host says the reader is. Shared with the listing's own lookup — the same
   * ten-minute answer per host — so a page that has already listed anything pays nothing for it,
   * and a host that cannot say leaves it null rather than failing the read it decorates.
   */
  const viewerOf = (project: SupportedProject): Effect.Effect<string | null> =>
    resolveViewers([project], new Map()).pipe(Effect.map(([resolved]) => resolved?.viewer ?? null));

  const detailUncached: PullRequestService["Service"]["detail"] = (input) =>
    requireProject(input).pipe(
      Effect.flatMap((project) =>
        Effect.all(
          [
            project.api
              .getChangeRequest({
                cwd: project.project.workspaceRoot,
                repository: project.repository,
                host: project.host,
                number: input.number,
              })
              .pipe(Effect.mapError(toPullRequestError("detail"))),
            viewerOf(project),
          ],
          { concurrency: 2 },
        ).pipe(
          Effect.map(
            ([changeRequest, viewer]): PullRequestDetail => ({
              provider: project.api.kind,
              capabilities: project.api.capabilities,
              projectId: project.project.id,
              projectTitle: project.project.title,
              workspaceRoot: project.project.workspaceRoot,
              repository: project.repository,
              number: changeRequest.number,
              title: changeRequest.title,
              body: changeRequest.body,
              url: changeRequest.url,
              author: changeRequest.author,
              state: changeRequest.state,
              isDraft: changeRequest.isDraft,
              mergeability: changeRequest.mergeability,
              additions: changeRequest.additions,
              deletions: changeRequest.deletions,
              changedFiles: changeRequest.changedFiles,
              headBranch: changeRequest.headBranch,
              ...(changeRequest.headRepositoryNameWithOwner === undefined
                ? {}
                : { headRepositoryNameWithOwner: changeRequest.headRepositoryNameWithOwner }),
              baseBranch: changeRequest.baseBranch,
              createdAt: changeRequest.createdAt,
              updatedAt: changeRequest.updatedAt,
              mergedAt: changeRequest.mergedAt,
              closedAt: changeRequest.closedAt,
              reviewers: changeRequest.reviewers,
              labels: changeRequest.labels,
              checks: changeRequest.checks,
              mergeCapabilities: changeRequest.mergeCapabilities,
              viewerPermissions: changeRequest.viewerPermissions,
              ...(viewer === null || viewer.trim().length === 0 ? {} : { viewer }),
              ...(changeRequest.baseComparison === undefined
                ? {}
                : { baseComparison: changeRequest.baseComparison }),
              ...(changeRequest.behindBy === undefined ? {} : { behindBy: changeRequest.behindBy }),
              ...(changeRequest.autoMergeEnabled === undefined
                ? {}
                : { autoMergeEnabled: changeRequest.autoMergeEnabled }),
            }),
          ),
        ),
      ),
    );

  const activityUncached: PullRequestService["Service"]["activity"] = (input) =>
    requireProject(input).pipe(
      Effect.flatMap((project) =>
        project.api
          .getChangeRequestActivity({
            cwd: project.project.workspaceRoot,
            repository: project.repository,
            host: project.host,
            number: input.number,
          })
          .pipe(
            Effect.mapError(toPullRequestError("activity")),
            Effect.map(
              (activity): PullRequestActivity => ({
                ...(activity.author === undefined ? {} : { author: activity.author }),
                ...(activity.reviewers === undefined ? {} : { reviewers: activity.reviewers }),
                comments: activity.comments,
                commentCount: activity.commentCount,
                commentsTruncated: activity.commentsTruncated,
                reviewThreads: activity.reviewThreads,
                commits: activity.commits,
                ...(activity.reactions === undefined ? {} : { reactions: activity.reactions }),
              }),
            ),
          ),
      ),
    );

  const threadComments: PullRequestService["Service"]["threadComments"] = (input) =>
    requireProject(input).pipe(
      Effect.flatMap(
        (project): Effect.Effect<PullRequestThreadCommentsResult, PullRequestError> => {
          const read = project.api.getReviewThreadComments;
          if (read === undefined) {
            return Effect.fail(
              new PullRequestOperationError({
                operation: "threadComments",
                detail: "This host does not page review thread comments.",
              }),
            );
          }
          return read({
            cwd: project.project.workspaceRoot,
            repository: project.repository,
            host: project.host,
            number: input.number,
            threadId: input.threadId,
            cursor: input.cursor,
          }).pipe(Effect.mapError(toPullRequestError("threadComments")));
        },
      ),
    );

  const diffUncached: PullRequestService["Service"]["diff"] = (input) =>
    requireProject(input).pipe(
      Effect.flatMap((project) =>
        project.api.capabilities.diff
          ? project.api
              .getDiff({
                cwd: project.project.workspaceRoot,
                repository: project.repository,
                host: project.host,
                number: input.number,
                ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
                ...(input.commit === undefined ? {} : { commit: input.commit }),
              })
              .pipe(Effect.mapError(toPullRequestError("diff")))
          : Effect.fail(
              new PullRequestOperationError({
                operation: "diff",
                detail: "This host cannot provide a diff for a change request.",
              }),
            ),
      ),
    );

  const diffFileContents: PullRequestService["Service"]["diffFileContents"] = (input) =>
    requireProject(input).pipe(
      Effect.flatMap((project) => {
        const read = project.api.getDiffFileContents;
        return project.api.capabilities.diff && read
          ? read({
              cwd: project.project.workspaceRoot,
              repository: project.repository,
              host: project.host,
              number: input.number,
              ...(input.commit === undefined ? {} : { commit: input.commit }),
              changeType: input.changeType,
              oldPath: input.oldPath,
              newPath: input.newPath,
            }).pipe(Effect.mapError(toPullRequestError("diffFileContents")))
          : Effect.fail(
              new PullRequestOperationError({
                operation: "diffFileContents",
                detail: "This host cannot expand unchanged pull request lines.",
              }),
            );
      }),
    );

  const runAction: PullRequestService["Service"]["runAction"] = (input) =>
    requireProject(input).pipe(
      Effect.flatMap((project): Effect.Effect<void, PullRequestError> => {
        // The surface hides what a host cannot do, and this refuses it as well: a request that
        // reached here anyway must not be handed to a provider that never claimed the action.
        if (!project.api.capabilities.actions.includes(input.action)) {
          return Effect.fail(
            new PullRequestOperationError({
              operation: "runAction",
              detail: `This host cannot ${input.action} a change request.`,
            }),
          );
        }
        // A strategy the host does not offer must be refused rather than passed on: every
        // provider maps an unrecognised method to its own default, so asking Azure DevOps to
        // rebase would quietly merge instead of failing.
        if (
          input.mergeMethod !== undefined &&
          !project.api.capabilities.mergeMethods.includes(input.mergeMethod)
        ) {
          return Effect.fail(
            new PullRequestOperationError({
              operation: "runAction",
              detail: `This host cannot merge with the ${input.mergeMethod} strategy.`,
            }),
          );
        }
        // The same for the way a stale branch is brought up to date: a host that only merges
        // must not be asked to rebase and left to pick something else.
        if (
          input.updateMethod !== undefined &&
          !(project.api.capabilities.updateMethods ?? []).includes(input.updateMethod)
        ) {
          return Effect.fail(
            new PullRequestOperationError({
              operation: "runAction",
              detail: `This host cannot update a branch by ${input.updateMethod}.`,
            }),
          );
        }
        // What the host can do and what this account may ask of it are two questions, and both
        // have to say yes. The second is asked last, because it costs a request and the checks
        // above do not.
        return viewerPermissionsOf(project, input, "runAction").pipe(
          Effect.flatMap((viewer): Effect.Effect<void, PullRequestError> => {
            if (!viewer.actions.includes(input.action)) {
              return Effect.fail(
                new PullRequestOperationError({
                  operation: "runAction",
                  detail: ACTION_ACCESS_REFUSALS[input.action],
                }),
              );
            }
            if (
              input.updateMethod !== undefined &&
              !(viewer.updateMethods ?? []).includes(input.updateMethod)
            ) {
              return Effect.fail(
                new PullRequestOperationError({
                  operation: "runAction",
                  detail: ACTION_ACCESS_REFUSALS["update-branch"],
                }),
              );
            }
            return project.api
              .runAction({
                cwd: project.project.workspaceRoot,
                repository: project.repository,
                host: project.host,
                number: input.number,
                action: input.action,
                ...(input.mergeMethod === undefined ? {} : { mergeMethod: input.mergeMethod }),
                ...(input.updateMethod === undefined ? {} : { updateMethod: input.updateMethod }),
              })
              .pipe(Effect.mapError(toPullRequestError("runAction")));
          }),
        );
      }),
    );

  const comment: PullRequestService["Service"]["comment"] = (input) =>
    // The contract keeps the body verbatim because it is markdown, so the "did the user
    // actually write something" check lives here.
    (input.body.trim().length === 0
      ? Effect.fail(
          new PullRequestOperationError({
            operation: "comment",
            detail: "A comment cannot be empty.",
          }),
        )
      : requireProject(input)
    ).pipe(
      Effect.flatMap((project): Effect.Effect<void, PullRequestError> => {
        if (!project.api.capabilities.comment) {
          return Effect.fail(
            new PullRequestOperationError({
              operation: "comment",
              detail: "This host cannot post a comment on a change request.",
            }),
          );
        }
        return viewerPermissionsOf(project, input, "comment").pipe(
          Effect.flatMap((viewer): Effect.Effect<void, PullRequestError> => {
            if (!viewer.comment) {
              return Effect.fail(
                new PullRequestOperationError({
                  operation: "comment",
                  detail:
                    "You need write access on this repository to comment on a change request.",
                }),
              );
            }
            return project.api
              .comment({
                cwd: project.project.workspaceRoot,
                repository: project.repository,
                host: project.host,
                number: input.number,
                body: input.body,
              })
              .pipe(Effect.mapError(toPullRequestError("comment")));
          }),
        );
      }),
    );

  /**
   * Rewriting the change request's own words, and rewriting a remark, are both left to the host to
   * allow or refuse. Neither is a question a permission read answers: every host lets the person
   * who wrote something rewrite it whatever access they have otherwise, and none of them reports
   * that as a permission — so a check here could only guess, and a wrong guess takes the control
   * away from the one person certain to be allowed.
   */
  const update: PullRequestService["Service"]["update"] = (input) =>
    requireProject(input).pipe(
      Effect.flatMap((project): Effect.Effect<void, PullRequestError> => {
        const rewrite = project.api.updateChangeRequest;
        if (project.api.capabilities.edit?.changeRequest !== true || rewrite === undefined) {
          return Effect.fail(
            new PullRequestOperationError({
              operation: "update",
              detail: "This host cannot rewrite a change request.",
            }),
          );
        }
        if (input.title === undefined && input.body === undefined) {
          return Effect.fail(
            new PullRequestOperationError({
              operation: "update",
              detail: "Nothing was changed.",
            }),
          );
        }
        return rewrite({
          cwd: project.project.workspaceRoot,
          repository: project.repository,
          host: project.host,
          number: input.number,
          ...(input.title === undefined ? {} : { title: input.title }),
          ...(input.body === undefined ? {} : { body: input.body }),
        }).pipe(Effect.mapError(toPullRequestError("update")));
      }),
    );

  const updateComment: PullRequestService["Service"]["updateComment"] = (input) =>
    (input.body.trim().length === 0
      ? Effect.fail(
          new PullRequestOperationError({
            operation: "updateComment",
            detail: "A comment cannot be empty.",
          }),
        )
      : requireProject(input)
    ).pipe(
      Effect.flatMap((project): Effect.Effect<void, PullRequestError> => {
        const rewrite = project.api.updateComment;
        if (project.api.capabilities.edit?.comment !== true || rewrite === undefined) {
          return Effect.fail(
            new PullRequestOperationError({
              operation: "updateComment",
              detail: "This host cannot rewrite a comment.",
            }),
          );
        }
        return rewrite({
          cwd: project.project.workspaceRoot,
          repository: project.repository,
          host: project.host,
          number: input.number,
          commentId: input.commentId,
          kind: input.kind,
          body: input.body,
        }).pipe(Effect.mapError(toPullRequestError("updateComment")));
      }),
    );

  const submitReview: PullRequestService["Service"]["submitReview"] = (input) =>
    requireProject(input).pipe(
      Effect.flatMap((project): Effect.Effect<void, PullRequestError> => {
        const review = project.api.capabilities.review;
        const refuse = (detail: string) =>
          Effect.fail(new PullRequestOperationError({ operation: "submitReview", detail }));
        // The surface hides what a host cannot do, and this refuses it as well: a request that
        // reached here anyway must not be handed to a provider that never claimed it.
        if (!review.verdicts.includes(input.verdict)) {
          return refuse(`This host cannot ${VERDICT_LABELS[input.verdict]} a change request.`);
        }
        if (input.comments.length > 0 && !review.inlineComment) {
          return refuse("This host cannot comment on a line of a change request.");
        }
        // A verdict with nothing attached to it is a request every host rejects, and doing so
        // here says which of the two is missing rather than reporting the host's refusal.
        if (
          input.verdict !== "approve" &&
          input.body.trim().length === 0 &&
          input.comments.length === 0
        ) {
          return refuse("A review needs a summary or at least one comment.");
        }
        return viewerPermissionsOf(project, input, "submitReview").pipe(
          Effect.flatMap((viewer): Effect.Effect<void, PullRequestError> => {
            if (!viewer.verdicts.includes(input.verdict)) {
              return refuse(
                `You need write access on this repository to ${
                  VERDICT_LABELS[input.verdict]
                } a change request.`,
              );
            }
            if (input.comments.length > 0 && !viewer.comment) {
              return refuse(
                "You need write access on this repository to comment on a line of a change request.",
              );
            }
            return project.api
              .submitReview({
                cwd: project.project.workspaceRoot,
                repository: project.repository,
                host: project.host,
                number: input.number,
                verdict: input.verdict,
                body: input.body,
                comments: input.comments,
              })
              .pipe(Effect.mapError(toPullRequestError("submitReview")));
          }),
        );
      }),
    );

  const replyToThread: PullRequestService["Service"]["replyToThread"] = (input) =>
    (input.body.trim().length === 0
      ? Effect.fail(
          new PullRequestOperationError({
            operation: "replyToThread",
            detail: "A reply cannot be empty.",
          }),
        )
      : requireProject(input)
    ).pipe(
      Effect.flatMap((project): Effect.Effect<void, PullRequestError> => {
        if (!project.api.capabilities.review.reply) {
          return Effect.fail(
            new PullRequestOperationError({
              operation: "replyToThread",
              detail: "This host cannot reply to a review conversation.",
            }),
          );
        }
        return viewerPermissionsOf(project, input, "replyToThread").pipe(
          Effect.flatMap((viewer): Effect.Effect<void, PullRequestError> => {
            if (!viewer.comment) {
              return Effect.fail(
                new PullRequestOperationError({
                  operation: "replyToThread",
                  detail:
                    "You need write access on this repository to reply to a review conversation.",
                }),
              );
            }
            return project.api
              .replyToThread({
                cwd: project.project.workspaceRoot,
                repository: project.repository,
                host: project.host,
                number: input.number,
                threadId: input.threadId,
                body: input.body,
              })
              .pipe(Effect.mapError(toPullRequestError("replyToThread")));
          }),
        );
      }),
    );

  const setThreadResolution: PullRequestService["Service"]["setThreadResolution"] = (input) =>
    requireProject(input).pipe(
      Effect.flatMap((project): Effect.Effect<void, PullRequestError> => {
        if (!project.api.capabilities.review.resolve) {
          return Effect.fail(
            new PullRequestOperationError({
              operation: "setThreadResolution",
              detail: "This host cannot resolve a review conversation.",
            }),
          );
        }
        return viewerPermissionsOf(project, input, "setThreadResolution").pipe(
          Effect.flatMap((viewer): Effect.Effect<void, PullRequestError> => {
            if (!viewer.resolve) {
              return Effect.fail(
                new PullRequestOperationError({
                  operation: "setThreadResolution",
                  detail:
                    "You need write access on this repository, or to have opened this change request, to resolve a review conversation.",
                }),
              );
            }
            return project.api
              .setThreadResolution({
                cwd: project.project.workspaceRoot,
                repository: project.repository,
                host: project.host,
                number: input.number,
                threadId: input.threadId,
                resolved: input.resolved,
              })
              .pipe(Effect.mapError(toPullRequestError("setThreadResolution")));
          }),
        );
      }),
    );

  /**
   * Reacting is gated on the host alone. Every host with reactions takes one from whoever can read
   * the change request, so there is no access left to check that reading it has not already
   * settled.
   */
  const setReaction: PullRequestService["Service"]["setReaction"] = (input) =>
    requireProject(input).pipe(
      Effect.flatMap((project): Effect.Effect<void, PullRequestError> => {
        if (project.api.capabilities.reactions !== true) {
          return Effect.fail(
            new PullRequestOperationError({
              operation: "setReaction",
              detail: "This host has no reactions.",
            }),
          );
        }
        return project.api
          .setReaction({
            cwd: project.project.workspaceRoot,
            repository: project.repository,
            host: project.host,
            number: input.number,
            ...(input.subjectId === undefined ? {} : { subjectId: input.subjectId }),
            content: input.content,
            reacted: input.reacted,
          })
          .pipe(Effect.mapError(toPullRequestError("setReaction")));
      }),
    );

  /**
   * Who may be asked is only ever wanted by somebody about to ask, because the menu it fills is
   * the one the request is made from. So the same permission guards both: a page that could open
   * the menu without it would offer a list whose every press was going to be turned down.
   */
  const reviewerCandidates: PullRequestService["Service"]["reviewerCandidates"] = (input) =>
    requireProject(input).pipe(
      Effect.flatMap(
        (project): Effect.Effect<PullRequestReviewerCandidateList, PullRequestError> => {
          if (!project.api.capabilities.reviewers.listCandidates) {
            return Effect.fail(
              new PullRequestOperationError({
                operation: "reviewerCandidates",
                detail: "This host cannot say who may review a change request.",
              }),
            );
          }
          return viewerPermissionsOf(project, input, "reviewerCandidates").pipe(
            Effect.flatMap(
              (viewer): Effect.Effect<PullRequestReviewerCandidateList, PullRequestError> =>
                viewer.requestReviewers
                  ? project.api
                      .listReviewerCandidates({
                        cwd: project.project.workspaceRoot,
                        repository: project.repository,
                        host: project.host,
                        number: input.number,
                      })
                      .pipe(Effect.mapError(toPullRequestError("reviewerCandidates")))
                  : Effect.fail(
                      new PullRequestOperationError({
                        operation: "reviewerCandidates",
                        detail: REVIEWER_REQUEST_REFUSAL,
                      }),
                    ),
            ),
          );
        },
      ),
    );

  const requestReviewers: PullRequestService["Service"]["requestReviewers"] = (input) =>
    requireProject(input).pipe(
      Effect.flatMap((project): Effect.Effect<void, PullRequestError> => {
        if (!project.api.capabilities.reviewers.request) {
          return Effect.fail(
            new PullRequestOperationError({
              operation: "requestReviewers",
              detail: "This host cannot ask somebody for a review.",
            }),
          );
        }
        return viewerPermissionsOf(project, input, "requestReviewers").pipe(
          Effect.flatMap((viewer): Effect.Effect<void, PullRequestError> => {
            if (!viewer.requestReviewers) {
              return Effect.fail(
                new PullRequestOperationError({
                  operation: "requestReviewers",
                  detail: REVIEWER_REQUEST_REFUSAL,
                }),
              );
            }
            return project.api
              .setReviewerRequest({
                cwd: project.project.workspaceRoot,
                repository: project.repository,
                host: project.host,
                number: input.number,
                reviewers: input.reviewers,
                requested: input.requested,
              })
              .pipe(Effect.mapError(toPullRequestError("requestReviewers")));
          }),
        );
      }),
    );

  /**
   * The line counts for rows already on the page, which the listing left out because on GitHub
   * they cost more than everything else on the row put together.
   *
   * One read per host rather than per row, and only for a host whose listing defers them; a row
   * whose host answered with the counts in the first place is not here to be asked about. A ref
   * that names no project this workspace has, or a repository that is not the one the project's
   * remote points at, is dropped rather than refused: it is one row's two numbers, and the page
   * that asked has already moved on.
   */
  const listStatsUncached: PullRequestService["Service"]["listStats"] = (input) =>
    Effect.gen(function* () {
      if (input.refs.length === 0) return { stats: [] };
      const { supported } = yield* listWorkspaceProjects({});
      const byProject = new Map(supported.map((project) => [project.project.id, project]));
      const wanted = new Map<
        string,
        { readonly project: SupportedProject; readonly number: number }
      >();
      for (const ref of input.refs) {
        const project = byProject.get(ref.projectId);
        // The repository travels through the client, so it is checked against the project's own
        // remote rather than being handed to a provider verbatim.
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
          if (readStats === undefined)
            return Effect.succeed<ReadonlyArray<PullRequestDiffStat>>([]);
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
            // A row without its counts is a row the page already draws without them, so a host
            // that could not answer costs the numbers rather than the answer.
            Effect.orElseSucceed((): ReadonlyArray<PullRequestDiffStat> => []),
          );
        },
        { concurrency: REPOSITORY_CONCURRENCY },
      );
      return { stats: stats.flat() };
    });

  const context = yield* Effect.context<never>();
  const runFork = Effect.runForkWith(context);

  /**
   * The diff is not live-polled and is expensive enough to keep its stale-while-revalidate path.
   * Explicit refreshes and mutations still strand held values through the reference epoch.
   */
  const staleDiff = (() => {
    const staleMs = Duration.toMillis(DIFF_STALE_WINDOW);
    const held = new Map<string, { readonly at: number; readonly value: PullRequestDiffResult }>();
    const record = (key: string, value: PullRequestDiffResult) =>
      Effect.map(Clock.currentTimeMillis, (at) => {
        held.delete(key);
        if (held.size >= DIFF_CACHE_CAPACITY) {
          const oldest = held.keys().next().value;
          if (oldest !== undefined) held.delete(oldest);
        }
        held.set(key, { at, value });
      });
    return <E>(key: string, read: Effect.Effect<PullRequestDiffResult, E>) => {
      const recorded = read.pipe(Effect.tap((value) => record(key, value)));
      return Effect.flatMap(Clock.currentTimeMillis, (now) => {
        const snapshot = held.get(key);
        if (snapshot === undefined || now - snapshot.at > staleMs) return recorded;
        // Run as its own fiber rather than a child: the caller is answered and gone before the
        // refresh lands. The read still coalesces on the cache key, so ten stale reads in one
        // window cost one host request — and a failed refresh costs nothing but the retry.
        return Effect.sync(() => runFork(Effect.ignore(recorded))).pipe(Effect.as(snapshot.value));
      });
    };
  })();

  // Epochs are the invalidation mechanism: a key carries its scope's epoch, so bumping the
  // epoch strands every entry made under the old one — no enumerating a cache whose keys
  // (cursors, commits) nothing holds a list of. The counter is shared and monotonic so a
  // scope re-entering `refEpochs` after eviction can never mint a key an old entry still has.
  let epochCounter = 0;
  let listingsEpoch = 0;
  const refEpochs = new Map<string, number>();
  const REF_EPOCH_CAPACITY = 2_048;
  const refScope = (ref: PullRequestRef) => `${ref.projectId} ${ref.repository} ${ref.number}`;
  const refEpoch = (ref: PullRequestRef) => refEpochs.get(refScope(ref)) ?? 0;
  const bumpRefEpoch = (ref: PullRequestRef) => {
    const scope = refScope(ref);
    if (!refEpochs.has(scope) && refEpochs.size >= REF_EPOCH_CAPACITY) {
      const oldest = refEpochs.keys().next().value;
      if (oldest !== undefined) refEpochs.delete(oldest);
    }
    refEpochs.set(scope, ++epochCounter);
  };

  /** The positional filter slot of a cache key, back as the record `listUncached` takes. */
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

  // Keys serialize positionally and parse back in the lookup, so the cache is the only holder
  // of in-flight state: concurrent identical reads coalesce on the key into one host request.
  // The continuation cursors are part of the key, entries sorted so one continuation is one
  // key however its record was assembled — a further slice is its own answer, cached like any.
  const listCache = yield* Cache.makeWith(
    (key: string) => {
      // The parse undoes this module's own serialization, so the shapes are known exactly;
      // the cast restores the branded field types JSON cannot carry.
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
      listingsEpoch,
      input.state,
      input.involvement ?? null,
      // Positional so two identical filter sets key alike however their record was assembled.
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
      // Sorted so the same narrowing keys alike however the caller ordered it.
      input.projectIds === undefined ? null : [...input.projectIds].sort(),
      input.host ?? null,
      input.limit ?? null,
      input.query ?? null,
      input.cursors === undefined
        ? null
        : Object.entries(input.cursors).toSorted(([left], [right]) => left.localeCompare(right)),
    ]);
    return Cache.get(listCache, key);
  };

  const detailCache = yield* Cache.makeWith(
    (key: string) => {
      const [, projectId, repository, number] = JSON.parse(key) as [number, string, string, number];
      return detailUncached({ projectId, repository, number } as PullRequestRef);
    },
    {
      capacity: DETAIL_CACHE_CAPACITY,
      timeToLive: (exit) => (Exit.isSuccess(exit) ? DETAIL_CACHE_TTL : Duration.zero),
    },
  );
  const detail: PullRequestService["Service"]["detail"] = (input) => {
    const key = JSON.stringify([refEpoch(input), input.projectId, input.repository, input.number]);
    return Cache.get(detailCache, key);
  };

  const activityCache = yield* Cache.makeWith(
    (key: string) => {
      const [, projectId, repository, number] = JSON.parse(key) as [number, string, string, number];
      return activityUncached({ projectId, repository, number } as PullRequestRef);
    },
    {
      capacity: DETAIL_CACHE_CAPACITY,
      timeToLive: (exit) => (Exit.isSuccess(exit) ? DETAIL_CACHE_TTL : Duration.zero),
    },
  );
  const activity: PullRequestService["Service"]["activity"] = (input) => {
    const key = JSON.stringify([refEpoch(input), input.projectId, input.repository, input.number]);
    return Cache.get(activityCache, key);
  };

  const diffCache = yield* Cache.makeWith(
    (key: string) => {
      const [, projectId, repository, number, cursor, commit] = JSON.parse(key) as [
        number,
        string,
        string,
        number,
        string | null,
        string | null,
      ];
      return diffUncached({
        projectId,
        repository,
        number,
        ...(cursor === null ? {} : { cursor }),
        ...(commit === null ? {} : { commit }),
      } as PullRequestDiffInput);
    },
    {
      capacity: DIFF_CACHE_CAPACITY,
      timeToLive: (exit, key) => {
        if (!Exit.isSuccess(exit)) return Duration.zero;
        const commit = (JSON.parse(key) as ReadonlyArray<unknown>)[5];
        return commit === null ? DIFF_CACHE_TTL : COMMIT_DIFF_CACHE_TTL;
      },
    },
  );
  const diff: PullRequestService["Service"]["diff"] = (input) => {
    const key = JSON.stringify([
      refEpoch(input),
      input.projectId,
      input.repository,
      input.number,
      input.cursor ?? null,
      input.commit ?? null,
    ]);
    return staleDiff(key, Cache.get(diffCache, key));
  };

  const listStatsCache = yield* Cache.makeWith(
    (key: string) => {
      const [, refs] = JSON.parse(key) as [number, ReadonlyArray<[string, string, number]>];
      return listStatsUncached({
        refs: refs.map(([projectId, repository, number]) => ({ projectId, repository, number })),
      } as unknown as PullRequestListStatsInput);
    },
    {
      capacity: LIST_STATS_CACHE_CAPACITY,
      timeToLive: (exit) => (Exit.isSuccess(exit) ? LIST_STATS_CACHE_TTL : Duration.zero),
    },
  );
  // The stats read leans on the host's search API — the scarcest limit of them all — so it
  // shares between clients like every other read. Refs are sorted so one page's worth of rows
  // is one key however the client assembled them, and the listings epoch rides along so the
  // refresh that forgets the listing forgets its decorations with it.
  const listStats: PullRequestService["Service"]["listStats"] = (input) => {
    if (input.refs.length === 0) return Effect.succeed({ stats: [] });
    const key = JSON.stringify([
      listingsEpoch,
      input.refs
        .map((ref) => [ref.projectId, ref.repository, ref.number] as const)
        .toSorted((left, right) =>
          `${left[0]} ${left[1]} ${left[2]}`.localeCompare(`${right[0]} ${right[1]} ${right[2]}`),
        ),
    ]);
    return Cache.get(listStatsCache, key);
  };

  const invalidate: PullRequestService["Service"]["invalidate"] = (input) =>
    Effect.sync(() => {
      if (input.reference === undefined) {
        listingsEpoch = ++epochCounter;
        // A whole-workspace refresh is the reader asking to be re-answered from the hosts,
        // and that includes who the hosts say they are.
        viewersByHost.clear();
        return;
      }
      bumpRefEpoch(input.reference);
    });

  // A mutation's own client re-reads right after it, and every other client's next read must
  // see the action too — so a write forgets the change request it touched and the listings its
  // state change reorders, for everyone, without any client asking.
  const invalidatedByMutation =
    <I extends PullRequestRef>(
      method: (input: I) => Effect.Effect<void, PullRequestError>,
    ): ((input: I) => Effect.Effect<void, PullRequestError>) =>
    (input) =>
      method(input).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            bumpRefEpoch(input);
            listingsEpoch = ++epochCounter;
          }),
        ),
      );

  return PullRequestService.of({
    list,
    listStats,
    detail,
    activity,
    threadComments,
    diff,
    diffFileContents,
    runAction: invalidatedByMutation(runAction),
    update: invalidatedByMutation(update),
    comment: invalidatedByMutation(comment),
    updateComment: invalidatedByMutation(updateComment),
    submitReview: invalidatedByMutation(submitReview),
    replyToThread: invalidatedByMutation(replyToThread),
    setThreadResolution: invalidatedByMutation(setThreadResolution),
    setReaction: invalidatedByMutation(setReaction),
    // The candidate list is deliberately read fresh per menu-open, so it stays uncached.
    reviewerCandidates,
    requestReviewers: invalidatedByMutation(requestReviewers),
    invalidate,
  });
});

export const layer = Layer.effect(PullRequestService, make);
