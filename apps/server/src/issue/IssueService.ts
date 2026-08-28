import * as Cache from "effect/Cache";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import {
  IssueOperationError,
  IssueUnavailableError,
  issueProjectSourceKey,
  issueRepositoryKey,
  issueSourceKey,
  issueProviderRequirement,
  type IssueAction,
  type IssueActionInput,
  type IssueActivity,
  type IssueAssigneeCandidateList,
  type IssueAssigneesInput,
  type IssueCommentInput,
  type IssueCommentsPageInput,
  type IssueCommentsPageResult,
  type IssueCommentUpdateInput,
  type IssueCreateInput,
  type IssueCreateResult,
  type IssueDetail,
  type IssueInvalidateInput,
  type IssueLabelCandidateList,
  type IssueLabelsInput,
  type IssueListEntry,
  type IssueListInput,
  type IssueListProjectError,
  type IssueListResult,
  type IssueListOrder,
  type IssueListSort,
  type IssueReactionContent,
  type IssueProviderSummary,
  type IssueReactionInput,
  type IssueRef,
  type IssueRepositoryRef,
  type IssueTemplateList,
  type IssueUpdateInput,
  type IssueProviderKind,
} from "@t3tools/contracts";

import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import {
  issueProviderContextKey,
  type IssueProviderError,
  type ProviderIssue,
  type ProviderListCursor,
} from "./IssueProvider.ts";
import {
  type IssueProjectSource,
  IssueProviderRegistry,
  type IssueWorkspaceProjects,
} from "./IssueProviderRegistry.ts";

/**
 * Rows per repository when the client does not ask for a page size, and rows per slice when a
 * listing is carried on from a cursor. 99 and not 100 because every provider asks its host for one
 * row over this to probe for a next page, and 100 is exactly what GitHub and GitLab serve in one
 * request — so 100 here would buy a whole second round trip for a single row.
 */
const DEFAULT_REPOSITORY_LIST_LIMIT = 99;
/**
 * Repositories read at once. Each one is a CLI process that spends nearly all its wall clock
 * waiting on the host, so the useful ceiling is far above the core count.
 */
const REPOSITORY_CONCURRENCY = 12;

/**
 * Cursor keys shipped before adapters were pluggable. Keep them for current source-control
 * adapters so older remote clients and servers can carry the same listing on.
 */
const LEGACY_CURSOR_ADAPTERS = new Set<IssueProviderKind>([
  "github",
  "gitlab",
  "bitbucket",
  "azure-devops",
]);

/**
 * Repositories named in one read across a host. Well inside what a host's search accepts in one
 * query, and past the size of a workspace anyone opens, so a larger one reads in a handful of
 * searches rather than in a request per repository.
 */
const REPOSITORY_SEARCH_CHUNK = 100;

/**
 * Every read leaves the process — a CLI per repository, against hosts whose limits are low — so
 * answers are shared for a short while and concurrent identical reads share one request. The
 * windows sit near the clients' own stale times: long enough that two people opening the same page
 * cost one round trip, short enough that "cached" and "fresh" never need telling apart on screen.
 * Reads that must not share — the refresh button, a client reloading after its own action — go
 * through `invalidate` rather than a flag on the read, so an ordinary read can never opt out.
 */
const LIST_CACHE_TTL = Duration.seconds(30);
const DETAIL_CACHE_TTL = Duration.seconds(15);
/**
 * How long a cache's last success may still be served while a fresh read runs behind it. Bounded
 * by how the page actually revalidates: clients re-read on mount and once a minute while open, and
 * every one of those reads repopulates the cache in the background. An explicit refresh or a
 * mutation bumps the epochs and skips held answers entirely.
 */
const LIST_STALE_WINDOW = Duration.minutes(10);
const DETAIL_STALE_WINDOW = Duration.minutes(5);
/** How long one host's signed-in login is believed without asking its CLI again. */
const VIEWER_CACHE_TTL = Duration.minutes(10);
const LIST_CACHE_CAPACITY = 64;
const DETAIL_CACHE_CAPACITY = 128;
/**
 * What a repository offers a new issue is a file in the repository rather than a record on the
 * host, so it changes with a commit rather than with an issue — held far longer than a listing for
 * that reason, and forgotten only when somebody asks for the whole page to be re-read.
 */
const TEMPLATE_CACHE_TTL = Duration.minutes(10);
const TEMPLATE_CACHE_CAPACITY = 64;

export type IssueError = IssueUnavailableError | IssueOperationError;

export class IssueService extends Context.Service<
  IssueService,
  {
    readonly list: (input: IssueListInput) => Effect.Effect<IssueListResult, IssueError>;
    readonly detail: (input: IssueRef) => Effect.Effect<IssueDetail, IssueError>;
    readonly activity: (input: IssueRef) => Effect.Effect<IssueActivity, IssueError>;
    readonly commentsPage: (
      input: IssueCommentsPageInput,
    ) => Effect.Effect<IssueCommentsPageResult, IssueError>;
    readonly runAction: (input: IssueActionInput) => Effect.Effect<void, IssueError>;
    readonly comment: (input: IssueCommentInput) => Effect.Effect<void, IssueError>;
    readonly updateComment: (input: IssueCommentUpdateInput) => Effect.Effect<void, IssueError>;
    readonly setReaction: (input: IssueReactionInput) => Effect.Effect<void, IssueError>;
    readonly create: (input: IssueCreateInput) => Effect.Effect<IssueCreateResult, IssueError>;
    readonly update: (input: IssueUpdateInput) => Effect.Effect<void, IssueError>;
    readonly setLabels: (input: IssueLabelsInput) => Effect.Effect<void, IssueError>;
    readonly setAssignees: (input: IssueAssigneesInput) => Effect.Effect<void, IssueError>;
    readonly labelCandidates: (
      input: IssueRef,
    ) => Effect.Effect<IssueLabelCandidateList, IssueError>;
    readonly assigneeCandidates: (
      input: IssueRef,
    ) => Effect.Effect<IssueAssigneeCandidateList, IssueError>;
    readonly templates: (input: IssueRepositoryRef) => Effect.Effect<IssueTemplateList, IssueError>;
    readonly invalidate: (input: IssueInvalidateInput) => Effect.Effect<void>;
  }
>()("t3/issue/IssueService") {}

/**
 * Why a state change is refused to this viewer, said as the access it would take rather than as
 * the refusal the host would have answered with. Both are also the author's to take, whatever
 * access they have.
 */
const ACTION_ACCESS_REFUSALS: Record<IssueAction, string> = {
  close: "You need write access on this repository, or to have opened this issue, to close it.",
  reopen: "You need write access on this repository, or to have opened this issue, to reopen it.",
};

/** Why changing labels is refused, and why the picker behind it is too. */
const LABEL_ACCESS_REFUSAL =
  "You need write access on this repository to change the labels on an issue.";

/** The same, for assignment: the list of people is only ever wanted by somebody about to assign. */
const ASSIGNEE_ACCESS_REFUSAL =
  "You need write access on this repository to change who an issue is assigned to.";

interface RepositoryBatch {
  readonly projectId: IssueListEntry["projectId"];
  /** Which repository this slice came from, which is what a cursor for it is filed under. */
  readonly key: string;
  readonly entries: ReadonlyArray<IssueListEntry>;
  readonly errors: ReadonlyArray<IssueListProjectError>;
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

/**
 * The middle field, which used to be the count of rows a repository had handed over: no host here
 * pages by counting any more, so nothing reads it. Written as a constant and ignored on the way in
 * rather than dropped, so a cursor still travels between a client and a server of either age.
 */
const RETIRED_DELIVERED_COUNT = "0";

function parseListCursor(raw: string): ListCursor | null {
  const match = LIST_CURSOR_PATTERN.exec(raw);
  if (match === null) return null;
  const seenAt = match[3];
  return {
    updatedBefore: match[1]!,
    seenAt: seenAt === undefined ? [] : seenAt.split(",").map(Number),
  };
}

function sourceKeyOf(project: IssueProjectSource): string {
  return issueProviderContextKey(project.adapter.kind, project.host, project.credentialId);
}

const providerContextOf = (project: IssueProjectSource) =>
  project.credentialId === undefined ? {} : { credentialId: project.credentialId };

/**
 * How a listing tells two adapter repositories apart. The account also matters when one provider
 * has more than one credential for the same native repository.
 */
function listCursorKey(project: IssueProjectSource): string {
  if (LEGACY_CURSOR_ADAPTERS.has(project.adapter.kind)) {
    return `${project.host} ${project.repository.toLowerCase()}`;
  }
  if (project.credentialId === undefined) {
    return issueRepositoryKey(project.adapter.kind, project.host, project.repository);
  }
  return JSON.stringify([
    project.adapter.kind,
    project.host.toLowerCase(),
    project.repository.toLowerCase(),
    project.credentialId,
  ]);
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
  fetched: ReadonlyArray<ProviderIssue>,
): string | null {
  // The host had nothing at all, so there is no row to carry on from — and repeating the cursor
  // that produced the empty slice would ask the same question forever.
  if (fetched.length === 0) return null;
  // Taken from what the host answered rather than from what survived de-duplication: a slice can
  // be entirely rows already sent — a hundred issues touched in the same second is one triage
  // afternoon — and reading "nothing new" as "nothing left" would end the walk on the instant it
  // was stuck on, with everything older unreachable for good.
  const oldest = fetched.reduce((left, right) => (right.updatedAt < left.updatedAt ? right : left));
  return listCursorAt(previous, oldest.updatedAt, fetched);
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
  fetched: ReadonlyArray<ProviderIssue>,
): string {
  // De-duplicated because the boundary instant is asked for inclusively: the rows already named
  // here come back with the next slice and would otherwise be named a second time, growing the
  // cursor by one number per round trip until it outgrows what the page may send back.
  const seenAt = [
    ...new Set([
      ...(previous?.updatedBefore === boundary ? previous.seenAt : []),
      ...fetched.filter((item) => item.updatedAt === boundary).map((item) => item.number),
    ]),
  ];
  return `${boundary}|${RETIRED_DELIVERED_COUNT}|${seenAt.join(",")}`;
}

/**
 * A host that cannot be read at all, as opposed to one request that failed. A switched-off tracker
 * is deliberately not one of these: it is one repository's setting, and reporting it as a dead
 * host would hide every other repository on that account.
 */
function isProviderUnusable(error: IssueProviderError): boolean {
  return error.reason === "missing-tool" || error.reason === "unauthenticated";
}

/**
 * Why a host is not readable, told as the thing to do about it. A host that is simply not set up
 * says so in the same words the whole-page state uses, rather than repeating whatever its tool
 * printed — "HTTP 401" names the symptom, not the fix.
 */
function providerDetail(error: IssueProviderError): string {
  if (!isProviderUnusable(error)) return error.detail;
  return (
    issueProviderRequirement(
      error.provider,
      error.reason === "missing-tool" ? "cli-missing" : "cli-unauthenticated",
    ) ?? error.detail
  );
}

function toIssueError(operation: string): (error: IssueProviderError) => IssueError {
  return (error) => {
    switch (error.reason) {
      case "missing-tool":
      case "unauthenticated":
        return new IssueUnavailableError({
          reason: error.reason === "missing-tool" ? "cli-missing" : "cli-unauthenticated",
          provider: error.provider,
          cause: error,
        });
      // A read of one issue on a repository whose tracker is off has no issue to answer with, and
      // saying so as an unavailability is what lets the page explain the setting rather than
      // report a failure the reader cannot act on.
      case "tracker-disabled":
        return new IssueUnavailableError({
          reason: "tracker-disabled",
          provider: error.provider,
          cause: error,
        });
      case "failed":
        return new IssueOperationError({ operation, detail: error.detail, cause: error });
    }
  };
}

export const make = Effect.gen(function* () {
  const registry = yield* IssueProviderRegistry;
  const projections = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;

  const listWorkspaceProjects = (
    filter: Pick<IssueListInput, "projectId" | "host">,
  ): Effect.Effect<IssueWorkspaceProjects, IssueError> =>
    projections.getShellSnapshot().pipe(
      Effect.mapError(
        (error) =>
          new IssueOperationError({
            operation: "listProjects",
            detail: "The project list could not be read.",
            cause: error,
          }),
      ),
      Effect.flatMap((snapshot) => registry.resolveProjects(snapshot.projects, filter)),
    );

  /**
   * The project a request names, with the repository it claims checked against the project's own
   * remote: that field travels through the client, so it is never handed to a provider verbatim.
   */
  const requireProject = (
    ref: Pick<IssueRef, "projectId" | "provider" | "repository">,
  ): Effect.Effect<IssueProjectSource, IssueError> =>
    listWorkspaceProjects({ projectId: ref.projectId }).pipe(
      Effect.flatMap(({ supported }): Effect.Effect<IssueProjectSource, IssueError> => {
        if (supported.length === 0) {
          return Effect.fail(new IssueUnavailableError({ reason: "provider-unsupported" }));
        }
        const repository = ref.repository.trim().toLowerCase();
        const match = supported.find(
          (project) =>
            project.repository.toLowerCase() === repository &&
            (ref.provider === undefined || project.adapter.kind === ref.provider),
        );
        if (match === undefined) {
          return Effect.fail(
            new IssueOperationError({
              operation: "resolveRepository",
              detail: "The issue does not belong to the selected project.",
            }),
          );
        }
        return Effect.succeed(match);
      }),
    );

  /**
   * What the signed-in account may do with this issue, asked of the host itself. Every write goes
   * through it: the page hides what a viewer may not do, and a request that arrived without
   * passing through the page — or after the access behind it was withdrawn — must not be handed to
   * a provider on the client's word. Read freshly for that reason, rather than taken from whatever
   * the detail said when the page loaded.
   */
  const viewerPermissionsOf = (project: IssueProjectSource, ref: IssueRef, operation: string) =>
    project.adapter
      .getViewerPermissions({
        ...providerContextOf(project),
        cwd: project.project.workspaceRoot,
        repository: project.repository,
        host: project.host,
        number: ref.number,
      })
      .pipe(Effect.mapError(toIssueError(operation)));

  /**
   * The cursors the page sent back, read once before any host is asked anything. Null where the
   * page sent none, which is the listing read from its newest row.
   */
  const decodeCursors = (
    cursors: IssueListInput["cursors"],
  ): Effect.Effect<ReadonlyMap<string, ListCursor> | null, IssueError> => {
    if (cursors === undefined) return Effect.succeed(null);
    const decoded = new Map<string, ListCursor>();
    for (const [key, raw] of Object.entries(cursors)) {
      const cursor = parseListCursor(raw);
      if (cursor === null) {
        return Effect.fail(
          new IssueOperationError({
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
   * hosts are two accounts, and the wrong login would misattribute every assignment.
   *
   * Its failure doubles as the answer to "is this host set up", which is what the provider
   * switcher shows.
   */
  type ResolvedViewer = {
    readonly key: string;
    readonly host: string;
    readonly kind: IssueProviderKind;
    readonly projectIds: ReadonlyArray<IssueProjectSource["project"]["id"]>;
    readonly viewer: string | null;
    readonly error: IssueProviderError | null;
  };
  // Who is signed in moves on the timescale of `gh auth login`, not of a page visit. Only a
  // success is believed for a while: a failure is the "is this host set up" answer the provider
  // switcher shows, and holding it would keep saying signed-out after the reader has signed in.
  const viewersBySource = new Map<
    string,
    { readonly at: number; readonly result: ResolvedViewer }
  >();

  const resolveViewers = (
    projects: ReadonlyArray<IssueProjectSource>,
    viewerRoots: IssueWorkspaceProjects["viewerRoots"],
  ) =>
    Effect.forEach(
      new Map(projects.map((project) => [sourceKeyOf(project), project])),
      ([key, first]) =>
        Effect.flatMap(Clock.currentTimeMillis, (now): Effect.Effect<ResolvedViewer> => {
          const held = viewersBySource.get(key);
          if (held !== undefined && now - held.at <= Duration.toMillis(VIEWER_CACHE_TTL)) {
            return Effect.succeed(held.result);
          }
          const forSource = projects.filter((project) => sourceKeyOf(project) === key);
          const adapter = first.adapter;
          // Every checkout on the host, not just the ones that survived de-duplication: one
          // unreadable worktree would otherwise report the whole host as signed out.
          const roots =
            viewerRoots.get(key) ?? forSource.map(({ project }) => project.workspaceRoot);
          return Effect.firstSuccessOf(
            roots.map((cwd) =>
              adapter.getViewer({ ...providerContextOf(first), cwd, host: first.host }),
            ),
          ).pipe(
            Effect.map((viewer) => ({
              key,
              host: first.host,
              kind: adapter.kind,
              projectIds: forSource.map(({ project }) => project.id),
              viewer: viewer as string | null,
              error: null as IssueProviderError | null,
            })),
            Effect.tap((result) =>
              Effect.map(Clock.currentTimeMillis, (at) => viewersBySource.set(key, { at, result })),
            ),
            Effect.catch((error) =>
              Effect.succeed({
                key,
                host: first.host,
                kind: adapter.kind,
                projectIds: forSource.map(({ project }) => project.id),
                viewer: null,
                error,
              }),
            ),
          );
        }),
      { concurrency: REPOSITORY_CONCURRENCY },
    );

  const toEntry = (input: {
    readonly project: IssueProjectSource;
    readonly item: ProviderIssue;
  }): IssueListEntry => ({
    provider: input.project.adapter.kind,
    host: input.project.host,
    projectId: input.project.project.id,
    projectTitle: input.project.project.title,
    repository: input.project.repository,
    number: input.item.number,
    title: input.item.title,
    url: input.item.url,
    author: input.item.author,
    state: input.item.state,
    stateReason: input.item.stateReason,
    createdAt: input.item.createdAt,
    updatedAt: input.item.updatedAt,
    closedAt: input.item.closedAt,
    assignees: input.item.assignees,
    labels: input.item.labels,
    milestone: input.item.milestone,
    commentCount: input.item.commentCount,
    ...(input.item.reactions === undefined ? {} : { reactions: input.item.reactions }),
  });

  /**
   * Why one repository produced no rows. A switched-off tracker is a setting rather than a fault,
   * so it is said as one — the repository is simply not a place issues live.
   */
  const repositoryFailure = (
    project: IssueProjectSource,
    error: IssueProviderError,
  ): IssueListProjectError => ({
    projectId: project.project.id,
    projectTitle: project.project.title,
    message:
      error.reason === "tracker-disabled"
        ? `Issue tracker is switched off for ${project.repository}.`
        : `${project.repository} could not be read.`,
  });

  const reactionContentBySort: Partial<Record<IssueListSort, IssueReactionContent>> = {
    "reactions-thumbs-up": "thumbs-up",
    "reactions-thumbs-down": "thumbs-down",
    "reactions-rocket": "rocket",
    "reactions-hooray": "hooray",
    "reactions-eyes": "eyes",
    "reactions-heart": "heart",
    "reactions-laugh": "laugh",
    "reactions-confused": "confused",
  };

  const reactionCount = (entry: IssueListEntry, sort: IssueListSort): number => {
    const content = reactionContentBySort[sort];
    return (entry.reactions ?? []).reduce(
      (total, reaction) =>
        content === undefined || reaction.content === content ? total + reaction.count : total,
      0,
    );
  };

  const sortEntries = (
    entries: ReadonlyArray<IssueListEntry>,
    sort: IssueListSort,
    order: IssueListOrder,
  ): ReadonlyArray<IssueListEntry> => {
    if (sort === "best-match") return entries;
    const compare = (left: IssueListEntry, right: IssueListEntry): number => {
      switch (sort) {
        case "created":
          return left.createdAt.localeCompare(right.createdAt);
        case "updated":
          return left.updatedAt.localeCompare(right.updatedAt);
        case "comments":
          return left.commentCount - right.commentCount;
        default:
          return reactionCount(left, sort) - reactionCount(right, sort);
      }
    };
    const direction = order === "asc" ? 1 : -1;
    return entries.toSorted(
      (left, right) =>
        direction * compare(left, right) ||
        right.updatedAt.localeCompare(left.updatedAt) ||
        left.repository.localeCompare(right.repository) ||
        left.number - right.number,
    );
  };

  const listUncached: IssueService["Service"]["list"] = (input) =>
    Effect.gen(function* () {
      const involvement = input.involvement ?? "all";
      const sort = input.sort ?? "updated";
      const order = input.order ?? "desc";
      // Refused whole rather than per repository: a cursor is only ever a value this service
      // issued, so one that does not read as one means the page is sending something it made up,
      // and reading part of the listing under that assumption would quietly lose rows.
      const continuation =
        sort === "updated" && order === "desc" ? yield* decodeCursors(input.cursors) : null;
      const {
        supported: projects,
        unimplemented,
        viewerRoots,
      } = yield* listWorkspaceProjects(input);
      const viewerResults = yield* resolveViewers(projects, viewerRoots);
      const viewers: Record<string, string> = {};
      for (const result of viewerResults) {
        if (result.viewer === null) continue;
        viewers[result.key] = result.viewer;
        for (const projectId of result.projectIds) {
          viewers[issueProjectSourceKey(result.kind, result.host, projectId)] = result.viewer;
        }
        viewers[issueSourceKey(result.kind, result.host)] ??= result.viewer;
        // Older clients read the host-only key. New clients prefer the adapter-safe key above.
        viewers[result.host] ??= result.viewer;
      }

      // One user-facing summary per adapter and host, even when internal routing has one viewer
      // per saved credential on that host.
      const configuredProviders = new Map<string, IssueProviderSummary>();
      for (const result of viewerResults) {
        const key = issueSourceKey(result.kind, result.host);
        const held = configuredProviders.get(key);
        const configured = result.viewer !== null || held?.configured === true;
        configuredProviders.set(key, {
          host: result.host,
          kind: result.kind,
          searchesOnHost:
            projects.find(
              (project) => project.adapter.kind === result.kind && project.host === result.host,
            )?.adapter.capabilities.search ?? false,
          projectCount: projects.filter(
            (project) => project.adapter.kind === result.kind && project.host === result.host,
          ).length,
          configured,
          detail: configured
            ? null
            : (held?.detail ?? (result.error === null ? null : providerDetail(result.error))),
        });
      }
      const providers: ReadonlyArray<IssueProviderSummary> = [
        ...configuredProviders.values(),
        ...[...unimplemented.values()].map(({ host, kind, projectCount }) => ({
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
          : projects.filter((project) => continuation.has(listCursorKey(project)));
      const readable = selected.filter((project) => viewers[sourceKeyOf(project)] !== undefined);
      // A host that could not be read still has projects, and they are absent from the list.
      // Reporting them keeps "N repositories were unavailable" honest instead of dropping them.
      const unreadable = selected
        .filter((project) => viewers[sourceKeyOf(project)] === undefined)
        .map(({ project, repository }) => ({
          projectId: project.id,
          projectTitle: project.title,
          message: `${repository} could not be read.`,
        }));
      if (readable.length === 0) {
        // No host this request covers can be read, so it is not a per-project problem. An unusable
        // host is preferred as the reported cause because it names the fix; a host that merely
        // failed reports as a failed operation rather than as a signed-out CLI, which would send
        // the reader to `auth login` over a transient error.
        //
        // Only the hosts this request was actually going to read: a continuation that named
        // nothing has asked for nothing, and a host it never mentioned being signed out is no
        // reason to refuse it.
        const errors = viewerResults.flatMap((result) =>
          result.error === null || !selected.some((project) => sourceKeyOf(project) === result.key)
            ? []
            : [result.error],
        );
        const blocking = errors.find(isProviderUnusable) ?? errors[0];
        if (blocking) {
          return yield* toIssueError("list")(blocking);
        }

        return {
          viewers: viewers as IssueListResult["viewers"],
          providers,
          entries: [],
          errors: [],
          truncated: false,
          nextCursors: {},
        };
      }

      const limit = input.limit ?? DEFAULT_REPOSITORY_LIST_LIMIT;
      const cursorOf = (project: IssueProjectSource): ListCursor | undefined =>
        continuation?.get(listCursorKey(project));

      /**
       * One repository asked on its own. What every host without a search across repositories
       * does, and what a batched read falls back to for a repository it could not answer for.
       */
      const readRepository = (project: IssueProjectSource): Effect.Effect<RepositoryBatch> => {
        const viewer = viewers[sourceKeyOf(project)]!;
        const key = listCursorKey(project);
        const cursor = cursorOf(project);
        return project.adapter
          .listIssues({
            ...providerContextOf(project),
            cwd: project.project.workspaceRoot,
            repository: project.repository,
            host: project.host,
            state: input.state,
            involvement,
            viewer,
            limit,
            sort,
            order,
            // Each host matches this its own way, and one that cannot match text at all answers
            // unnarrowed rather than failing.
            query: input.query,
            // Only the field a host can act on: which rows have already been sent at the boundary
            // instant is this service's business, not a provider's.
            ...(cursor === undefined ? {} : { cursor: { updatedBefore: cursor.updatedBefore } }),
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
                projectId: project.project.id,
                key,
                entries: items.map((item) => toEntry({ project, item })),
                errors: [],
                truncated: page.truncated,
                nextCursor:
                  sort === "updated" && order === "desc" && page.continues && page.truncated
                    ? nextListCursor(cursor, page.items)
                    : null,
              };
            }),
            // One unreadable repository must not blank the page — including the one whose tracker
            // is switched off, which is a host-supported repository that simply has no issues to
            // give rather than a host that cannot be read.
            Effect.catch((error) =>
              Effect.succeed<RepositoryBatch>({
                projectId: project.project.id,
                key,
                entries: [],
                errors: [repositoryFailure(project, error)],
                truncated: false,
                nextCursor: null,
              }),
            ),
          );
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
        chunk: ReadonlyArray<IssueProjectSource>,
      ): Effect.Effect<ReadonlyArray<RepositoryBatch>> => {
        const first = chunk[0]!;
        const readAcross = first.adapter.listIssuesAcross;
        const separately = () =>
          Effect.forEach(chunk, readRepository, { concurrency: REPOSITORY_CONCURRENCY });
        if (readAcross === undefined) return separately();
        const viewer = viewers[sourceKeyOf(first)]!;
        const cursor = cursorOf(first);
        return readAcross({
          ...providerContextOf(first),
          cwd: first.project.workspaceRoot,
          host: first.host,
          repositories: chunk.map((project) => project.repository),
          state: input.state,
          involvement,
          viewer,
          limit,
          sort,
          order,
          query: input.query,
          ...(cursor === undefined ? {} : { cursor: { updatedBefore: cursor.updatedBefore } }),
        }).pipe(
          Effect.flatMap((page) => {
            const rows = new Map<string, Array<ProviderIssue>>();
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
                // A host does not index every repository for search — a renamed one answers for
                // its old name with silence rather than with an error, and a switched-off tracker
                // is silent too — so a repository the search said nothing at all about is read on
                // its own, once, before it is believed. Only on its first slice: after that it has
                // a boundary to carry on from, and silence past one means the rows are older
                // rather than absent.
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
                  projectId: project.project.id,
                  key: listCursorKey(project),
                  entries: items.map((item) => toEntry({ project, item })),
                  errors: [],
                  truncated: page.truncated,
                  nextCursor:
                    sort === "updated" && order === "desc" && page.truncated && boundary !== null
                      ? listCursorAt(cursorHere, boundary, fetched)
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
      const together = new Map<string, Array<IssueProjectSource>>();
      const separate: Array<IssueProjectSource> = [];
      for (const project of readable) {
        if (project.adapter.listIssuesAcross === undefined) {
          separate.push(project);
          continue;
        }
        const key = `${sourceKeyOf(project)}\n${cursorOf(project)?.updatedBefore ?? ""}`;
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
      const readableProjectIds = new Set(
        batches.filter((batch) => batch.errors.length === 0).map((batch) => batch.projectId),
      );
      const errors = [...unreadable, ...batches.flatMap((batch) => batch.errors)].filter(
        (error) => !readableProjectIds.has(error.projectId),
      );

      const nextCursors: Record<string, string> = {};
      for (const batch of batches) {
        if (batch.nextCursor !== null) nextCursors[batch.key] = batch.nextCursor;
      }

      return {
        viewers: viewers as IssueListResult["viewers"],
        providers,
        entries: sortEntries(
          batches.flatMap((batch) => batch.entries),
          sort,
          order,
        ),
        errors,
        truncated: batches.some((batch) => batch.truncated),
        nextCursors,
      };
    });

  const detailUncached: IssueService["Service"]["detail"] = (input) =>
    requireProject(input).pipe(
      Effect.flatMap((project) =>
        Effect.all(
          [
            project.adapter.getIssue({
              ...providerContextOf(project),
              cwd: project.project.workspaceRoot,
              repository: project.repository,
              host: project.host,
              number: input.number,
            }),
            project.adapter.capabilities.editComment === true
              ? project.adapter
                  .getViewer({
                    ...providerContextOf(project),
                    cwd: project.project.workspaceRoot,
                    host: project.host,
                  })
                  .pipe(
                    Effect.map((viewer): string | undefined => viewer),
                    Effect.orElseSucceed(() => undefined),
                  )
              : Effect.void,
          ],
          { concurrency: 2 },
        ).pipe(
          Effect.mapError(toIssueError("detail")),
          Effect.map(
            ([issue, viewer]): IssueDetail => ({
              provider: project.adapter.kind,
              capabilities: project.adapter.capabilities,
              viewerPermissions: issue.viewerPermissions,
              projectId: project.project.id,
              projectTitle: project.project.title,
              workspaceRoot: project.project.workspaceRoot,
              repository: project.repository,
              number: issue.number,
              title: issue.title,
              body: issue.body,
              url: issue.url,
              author: issue.author,
              state: issue.state,
              stateReason: issue.stateReason,
              createdAt: issue.createdAt,
              updatedAt: issue.updatedAt,
              closedAt: issue.closedAt,
              assignees: issue.assignees,
              labels: issue.labels,
              milestone: issue.milestone,
              ...(viewer === undefined ? {} : { viewer }),
              commentCount: issue.commentCount,
              linkedPullRequests: issue.linkedPullRequests,
            }),
          ),
        ),
      ),
    );

  const activityUncached: IssueService["Service"]["activity"] = (input) =>
    requireProject(input).pipe(
      Effect.flatMap((project) =>
        project.adapter
          .getIssueActivity({
            ...providerContextOf(project),
            cwd: project.project.workspaceRoot,
            repository: project.repository,
            host: project.host,
            number: input.number,
          })
          .pipe(
            Effect.mapError(toIssueError("activity")),
            Effect.map(
              (activity): IssueActivity => ({
                ...(activity.author === undefined ? {} : { author: activity.author }),
                comments: activity.comments,
                commentCount: activity.commentCount,
                commentsTruncated: activity.commentsTruncated,
                ...(activity.nextCommentsCursor === undefined
                  ? {}
                  : { nextCommentsCursor: activity.nextCommentsCursor }),
                events: activity.events,
                ...(activity.reactions === undefined ? {} : { reactions: activity.reactions }),
              }),
            ),
          ),
      ),
    );

  const commentsPage: IssueService["Service"]["commentsPage"] = (input) =>
    requireProject(input).pipe(
      Effect.flatMap((project): Effect.Effect<IssueCommentsPageResult, IssueError> => {
        if (project.adapter.getIssueComments === undefined) {
          return Effect.fail(
            new IssueOperationError({
              operation: "commentsPage",
              detail: "This host cannot continue an issue conversation.",
            }),
          );
        }
        return project.adapter
          .getIssueComments({
            ...providerContextOf(project),
            cwd: project.project.workspaceRoot,
            repository: project.repository,
            host: project.host,
            number: input.number,
            cursor: input.cursor,
          })
          .pipe(Effect.mapError(toIssueError("commentsPage")));
      }),
    );

  const runAction: IssueService["Service"]["runAction"] = (input) =>
    requireProject(input).pipe(
      Effect.flatMap((project): Effect.Effect<void, IssueError> => {
        // The surface hides what a host cannot do, and this refuses it as well: a request that
        // reached here anyway must not be handed to a provider that never claimed the action.
        if (!project.adapter.capabilities.actions.includes(input.action)) {
          return Effect.fail(
            new IssueOperationError({
              operation: "runAction",
              detail: `This host cannot ${input.action} an issue.`,
            }),
          );
        }
        // A reason the host does not record must be refused rather than passed on: a provider
        // that never had one to give would close the issue with no reason at all instead.
        if (
          input.reason !== undefined &&
          !project.adapter.capabilities.closeReasons.includes(input.reason)
        ) {
          return Effect.fail(
            new IssueOperationError({
              operation: "runAction",
              detail: "This host does not record why an issue was closed.",
            }),
          );
        }
        // What the host can do and what this account may ask of it are two questions, and both
        // have to say yes. The second is asked last, because it costs a request and the checks
        // above do not.
        return viewerPermissionsOf(project, input, "runAction").pipe(
          Effect.flatMap((viewer): Effect.Effect<void, IssueError> => {
            if (!viewer.actions.includes(input.action)) {
              return Effect.fail(
                new IssueOperationError({
                  operation: "runAction",
                  detail: ACTION_ACCESS_REFUSALS[input.action],
                }),
              );
            }
            return project.adapter
              .runAction({
                ...providerContextOf(project),
                cwd: project.project.workspaceRoot,
                repository: project.repository,
                host: project.host,
                number: input.number,
                action: input.action,
                ...(input.reason === undefined ? {} : { reason: input.reason }),
              })
              .pipe(Effect.mapError(toIssueError("runAction")));
          }),
        );
      }),
    );

  const comment: IssueService["Service"]["comment"] = (input) =>
    // The contract keeps the body verbatim because it is markdown, so the "did the user actually
    // write something" check lives here.
    (input.body.trim().length === 0
      ? Effect.fail(
          new IssueOperationError({ operation: "comment", detail: "A comment cannot be empty." }),
        )
      : requireProject(input)
    ).pipe(
      Effect.flatMap((project): Effect.Effect<void, IssueError> => {
        if (!project.adapter.capabilities.comment) {
          return Effect.fail(
            new IssueOperationError({
              operation: "comment",
              detail: "This host cannot post a comment on an issue.",
            }),
          );
        }
        return viewerPermissionsOf(project, input, "comment").pipe(
          Effect.flatMap((viewer): Effect.Effect<void, IssueError> => {
            if (!viewer.comment) {
              return Effect.fail(
                new IssueOperationError({
                  operation: "comment",
                  detail: "You need write access on this repository to comment on an issue.",
                }),
              );
            }
            return project.adapter
              .comment({
                ...providerContextOf(project),
                cwd: project.project.workspaceRoot,
                repository: project.repository,
                host: project.host,
                number: input.number,
                body: input.body,
              })
              .pipe(Effect.mapError(toIssueError("comment")));
          }),
        );
      }),
    );

  const updateComment: IssueService["Service"]["updateComment"] = (input) =>
    (input.body.trim().length === 0
      ? Effect.fail(
          new IssueOperationError({
            operation: "updateComment",
            detail: "A comment cannot be empty.",
          }),
        )
      : requireProject(input)
    ).pipe(
      Effect.flatMap((project): Effect.Effect<void, IssueError> => {
        const rewrite = project.adapter.updateComment;
        if (project.adapter.capabilities.editComment !== true || rewrite === undefined) {
          return Effect.fail(
            new IssueOperationError({
              operation: "updateComment",
              detail: "This host cannot rewrite an issue comment.",
            }),
          );
        }
        return rewrite({
          ...providerContextOf(project),
          cwd: project.project.workspaceRoot,
          repository: project.repository,
          host: project.host,
          number: input.number,
          commentId: input.commentId,
          body: input.body,
        }).pipe(Effect.mapError(toIssueError("updateComment")));
      }),
    );

  const setReaction: IssueService["Service"]["setReaction"] = (input) =>
    requireProject(input).pipe(
      Effect.flatMap((project): Effect.Effect<void, IssueError> => {
        const react = project.adapter.setReaction;
        if (project.adapter.capabilities.reactions !== true || react === undefined) {
          return Effect.fail(
            new IssueOperationError({
              operation: "setReaction",
              detail: "This host has no reactions.",
            }),
          );
        }
        return react({
          ...providerContextOf(project),
          cwd: project.project.workspaceRoot,
          repository: project.repository,
          host: project.host,
          number: input.number,
          ...(input.subjectId === undefined ? {} : { subjectId: input.subjectId }),
          content: input.content,
          reacted: input.reacted,
        }).pipe(Effect.mapError(toIssueError("setReaction")));
      }),
    );

  /**
   * Filing a new issue, which is the one write with no issue to ask permissions about: every
   * host answers "may this account do X" for an issue that exists, and there is none yet. So the
   * host's own capability is the whole gate here, and an account without the access is refused by
   * the host — which says why — rather than by a check that had nothing to read.
   */
  const create: IssueService["Service"]["create"] = (input) =>
    requireProject(input).pipe(
      Effect.flatMap((project): Effect.Effect<IssueCreateResult, IssueError> => {
        if (!project.adapter.capabilities.create) {
          return Effect.fail(
            new IssueOperationError({
              operation: "create",
              detail: "This host cannot open an issue.",
            }),
          );
        }
        return project.adapter
          .create({
            ...providerContextOf(project),
            cwd: project.project.workspaceRoot,
            repository: project.repository,
            host: project.host,
            title: input.title,
            body: input.body,
            labels: input.labels,
            assignees: input.assignees,
          })
          .pipe(Effect.mapError(toIssueError("create")));
      }),
    );

  const update: IssueService["Service"]["update"] = (input) =>
    requireProject(input).pipe(
      Effect.flatMap((project): Effect.Effect<void, IssueError> => {
        const refuse = (detail: string) =>
          Effect.fail(new IssueOperationError({ operation: "update", detail }));
        if (!project.adapter.capabilities.edit) {
          return refuse("This host cannot rewrite an issue.");
        }
        if (input.title === undefined && input.body === undefined) {
          return refuse("An edit needs a new title or a new body.");
        }
        if (input.title !== undefined && input.title.trim().length === 0) {
          return refuse("A title cannot be empty.");
        }
        // A body is markdown and may legitimately be cleared, so only one written out of spaces
        // is refused — the same "did the user actually write something" check a comment gets.
        if (input.body !== undefined && input.body.length > 0 && input.body.trim().length === 0) {
          return refuse("A body cannot be only whitespace.");
        }
        return viewerPermissionsOf(project, input, "update").pipe(
          Effect.flatMap((viewer): Effect.Effect<void, IssueError> => {
            if (!viewer.edit) {
              return refuse(
                "You need write access on this repository, or to have opened this issue, to edit it.",
              );
            }
            return project.adapter
              .update({
                ...providerContextOf(project),
                cwd: project.project.workspaceRoot,
                repository: project.repository,
                host: project.host,
                number: input.number,
                ...(input.title === undefined ? {} : { title: input.title }),
                ...(input.body === undefined ? {} : { body: input.body }),
              })
              .pipe(Effect.mapError(toIssueError("update")));
          }),
        );
      }),
    );

  const setLabels: IssueService["Service"]["setLabels"] = (input) =>
    requireProject(input).pipe(
      Effect.flatMap((project): Effect.Effect<void, IssueError> => {
        if (!project.adapter.capabilities.labels) {
          return Effect.fail(
            new IssueOperationError({
              operation: "setLabels",
              detail: "This host cannot label an issue.",
            }),
          );
        }
        return viewerPermissionsOf(project, input, "setLabels").pipe(
          Effect.flatMap((viewer): Effect.Effect<void, IssueError> => {
            if (!viewer.labels) {
              return Effect.fail(
                new IssueOperationError({ operation: "setLabels", detail: LABEL_ACCESS_REFUSAL }),
              );
            }
            return project.adapter
              .setLabels({
                ...providerContextOf(project),
                cwd: project.project.workspaceRoot,
                repository: project.repository,
                host: project.host,
                number: input.number,
                labels: input.labels,
              })
              .pipe(Effect.mapError(toIssueError("setLabels")));
          }),
        );
      }),
    );

  const setAssignees: IssueService["Service"]["setAssignees"] = (input) =>
    requireProject(input).pipe(
      Effect.flatMap((project): Effect.Effect<void, IssueError> => {
        if (!project.adapter.capabilities.assignees) {
          return Effect.fail(
            new IssueOperationError({
              operation: "setAssignees",
              detail: "This host cannot assign an issue to somebody.",
            }),
          );
        }
        return viewerPermissionsOf(project, input, "setAssignees").pipe(
          Effect.flatMap((viewer): Effect.Effect<void, IssueError> => {
            if (!viewer.assignees) {
              return Effect.fail(
                new IssueOperationError({
                  operation: "setAssignees",
                  detail: ASSIGNEE_ACCESS_REFUSAL,
                }),
              );
            }
            return project.adapter
              .setAssignees({
                ...providerContextOf(project),
                cwd: project.project.workspaceRoot,
                repository: project.repository,
                host: project.host,
                number: input.number,
                assignees: input.assignees,
              })
              .pipe(Effect.mapError(toIssueError("setAssignees")));
          }),
        );
      }),
    );

  /**
   * What a repository has to offer is only ever wanted by somebody about to apply it, because the
   * picker it fills is the one the change is made from. So the same permission guards both: a page
   * that could open the picker without it would offer a list whose every press was going to be
   * turned down.
   */
  const labelCandidates: IssueService["Service"]["labelCandidates"] = (input) =>
    requireProject(input).pipe(
      Effect.flatMap((project): Effect.Effect<IssueLabelCandidateList, IssueError> => {
        if (!project.adapter.capabilities.listLabelCandidates) {
          return Effect.fail(
            new IssueOperationError({
              operation: "labelCandidates",
              detail: "This host cannot say which labels a repository has.",
            }),
          );
        }
        return viewerPermissionsOf(project, input, "labelCandidates").pipe(
          Effect.flatMap(
            (viewer): Effect.Effect<IssueLabelCandidateList, IssueError> =>
              viewer.labels
                ? project.adapter
                    .listLabelCandidates({
                      ...providerContextOf(project),
                      cwd: project.project.workspaceRoot,
                      repository: project.repository,
                      host: project.host,
                      number: input.number,
                    })
                    .pipe(Effect.mapError(toIssueError("labelCandidates")))
                : Effect.fail(
                    new IssueOperationError({
                      operation: "labelCandidates",
                      detail: LABEL_ACCESS_REFUSAL,
                    }),
                  ),
          ),
        );
      }),
    );

  const assigneeCandidates: IssueService["Service"]["assigneeCandidates"] = (input) =>
    requireProject(input).pipe(
      Effect.flatMap((project): Effect.Effect<IssueAssigneeCandidateList, IssueError> => {
        if (!project.adapter.capabilities.listAssigneeCandidates) {
          return Effect.fail(
            new IssueOperationError({
              operation: "assigneeCandidates",
              detail: "This host cannot say who may be assigned an issue.",
            }),
          );
        }
        return viewerPermissionsOf(project, input, "assigneeCandidates").pipe(
          Effect.flatMap(
            (viewer): Effect.Effect<IssueAssigneeCandidateList, IssueError> =>
              viewer.assignees
                ? project.adapter
                    .listAssigneeCandidates({
                      ...providerContextOf(project),
                      cwd: project.project.workspaceRoot,
                      repository: project.repository,
                      host: project.host,
                      number: input.number,
                    })
                    .pipe(Effect.mapError(toIssueError("assigneeCandidates")))
                : Effect.fail(
                    new IssueOperationError({
                      operation: "assigneeCandidates",
                      detail: ASSIGNEE_ACCESS_REFUSAL,
                    }),
                  ),
          ),
        );
      }),
    );

  /**
   * What a repository offers a new issue. Nothing about the viewer gates it, unlike the candidate
   * lists above: this is the repository describing what it wants filed, and anybody who can see
   * the repository is being told the same thing.
   */
  const templatesUncached = (
    input: IssueRepositoryRef,
  ): Effect.Effect<IssueTemplateList, IssueError> =>
    requireProject(input).pipe(
      Effect.flatMap((project): Effect.Effect<IssueTemplateList, IssueError> => {
        const capabilities = project.adapter.capabilities;
        const read = project.adapter.listIssueTemplates;
        // A host with nothing to offer still has to say what it can do: this is the only answer a
        // composer gets before an issue exists, so refusing it would leave the form guessing about
        // exactly the two hosts that take no template — and one of them takes no issue either.
        if (!capabilities.issueTemplates || read === undefined) {
          return Effect.succeed({
            capabilities,
            templates: [],
            contactLinks: [],
            blankIssuesEnabled: true,
          });
        }
        return read({
          ...providerContextOf(project),
          cwd: project.project.workspaceRoot,
          repository: project.repository,
          host: project.host,
        }).pipe(
          Effect.map((offer): IssueTemplateList => ({ ...offer, capabilities })),
          Effect.mapError(toIssueError("templates")),
        );
      }),
    );

  const context = yield* Effect.context<never>();
  const runFork = Effect.runForkWith(context);

  /**
   * Stale answers served while a fresh one is fetched behind them. Every read here leaves the
   * process for a CLI whose wall clock is the host's — seconds on a good day, tens of them on a
   * slow network — and the short cache windows above mean almost every page visit pays that clock
   * again. The last success per key is therefore held a while longer: a read inside the window
   * answers with it at once and refreshes the cache in the background, so the next read is fresh
   * without anyone having waited on it.
   *
   * Correctness leans on the epochs: an explicit refresh or a mutation bumps them, the epoch is
   * part of every key, and a held answer under the old key is simply never asked for again.
   */
  const staleWhileRevalidate = <A>(staleFor: Duration.Duration, capacity: number) => {
    const staleMs = Duration.toMillis(staleFor);
    const held = new Map<string, { readonly at: number; readonly value: A }>();
    const record = (key: string, value: A) =>
      Effect.map(Clock.currentTimeMillis, (at) => {
        held.delete(key);
        if (held.size >= capacity) {
          const oldest = held.keys().next().value;
          if (oldest !== undefined) held.delete(oldest);
        }
        held.set(key, { at, value });
      });
    return <E>(key: string, read: Effect.Effect<A, E>): Effect.Effect<A, E> => {
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
  };

  // Epochs are the invalidation mechanism: a key carries its scope's epoch, so bumping the epoch
  // strands every entry made under the old one — no enumerating a cache whose keys (cursors)
  // nothing holds a list of. The counter is shared and monotonic so a scope re-entering
  // `refEpochs` after eviction can never mint a key an old entry still has.
  let epochCounter = 0;
  let listingsEpoch = 0;
  let allRefsEpoch = 0;
  // Its own epoch rather than the listings': what a repository offers a new issue is changed by a
  // commit to that repository, so every close, comment and label would otherwise throw away an
  // answer nothing had invalidated.
  let templatesEpoch = 0;
  const refEpochs = new Map<string, number>();
  const REF_EPOCH_CAPACITY = 2_048;
  const refScope = (ref: IssueRef) => `${ref.projectId} ${ref.repository} ${ref.number}`;
  const refEpoch = (ref: IssueRef) => refEpochs.get(refScope(ref)) ?? allRefsEpoch;
  const bumpRefEpoch = (ref: IssueRef) => {
    const scope = refScope(ref);
    if (!refEpochs.has(scope) && refEpochs.size >= REF_EPOCH_CAPACITY) {
      const oldest = refEpochs.keys().next().value;
      if (oldest !== undefined) refEpochs.delete(oldest);
    }
    refEpochs.set(scope, ++epochCounter);
  };

  // Keys serialize positionally and parse back in the lookup, so the cache is the only holder of
  // in-flight state: concurrent identical reads coalesce on the key into one host request. The
  // continuation cursors are part of the key, entries sorted so one continuation is one key
  // however its record was assembled — a further slice is its own answer, cached like any.
  const listCache = yield* Cache.makeWith(
    (key: string) => {
      // The parse undoes this module's own serialization, so the shapes are known exactly; the
      // cast restores the branded field types JSON cannot carry.
      const [, state, involvement, projectId, host, limit, query, sort, order, cursorEntries] =
        JSON.parse(key) as [
          number,
          string,
          string | null,
          string | null,
          string | null,
          number | null,
          string | null,
          string | null,
          string | null,
          ReadonlyArray<[string, string]> | null,
        ];
      return listUncached({
        state,
        ...(involvement === null ? {} : { involvement }),
        ...(projectId === null ? {} : { projectId }),
        ...(host === null ? {} : { host }),
        ...(limit === null ? {} : { limit }),
        ...(query === null ? {} : { query }),
        ...(sort === null ? {} : { sort }),
        ...(order === null ? {} : { order }),
        ...(cursorEntries === null ? {} : { cursors: Object.fromEntries(cursorEntries) }),
      } as IssueListInput);
    },
    {
      capacity: LIST_CACHE_CAPACITY,
      timeToLive: (exit) => (Exit.isSuccess(exit) ? LIST_CACHE_TTL : Duration.zero),
    },
  );
  const staleList = staleWhileRevalidate<IssueListResult>(LIST_STALE_WINDOW, LIST_CACHE_CAPACITY);
  const list: IssueService["Service"]["list"] = (input) => {
    const key = JSON.stringify([
      listingsEpoch,
      input.state,
      input.involvement ?? null,
      input.projectId ?? null,
      input.host ?? null,
      input.limit ?? null,
      input.query ?? null,
      input.sort ?? null,
      input.order ?? null,
      input.cursors === undefined
        ? null
        : Object.entries(input.cursors).toSorted(([left], [right]) => left.localeCompare(right)),
    ]);
    return staleList(key, Cache.get(listCache, key));
  };

  const detailCache = yield* Cache.makeWith(
    (key: string) => {
      const [, projectId, provider, repository, number] = JSON.parse(key) as [
        number,
        string,
        string | null,
        string,
        number,
      ];
      return detailUncached({
        projectId,
        ...(provider === null ? {} : { provider }),
        repository,
        number,
      } as IssueRef);
    },
    {
      capacity: DETAIL_CACHE_CAPACITY,
      timeToLive: (exit) => (Exit.isSuccess(exit) ? DETAIL_CACHE_TTL : Duration.zero),
    },
  );
  const staleDetail = staleWhileRevalidate<IssueDetail>(DETAIL_STALE_WINDOW, DETAIL_CACHE_CAPACITY);
  const detail: IssueService["Service"]["detail"] = (input) => {
    const key = JSON.stringify([
      refEpoch(input),
      input.projectId,
      input.provider ?? null,
      input.repository,
      input.number,
    ]);
    return staleDetail(key, Cache.get(detailCache, key));
  };

  const activityCache = yield* Cache.makeWith(
    (key: string) => {
      const [, projectId, provider, repository, number] = JSON.parse(key) as [
        number,
        string,
        string | null,
        string,
        number,
      ];
      return activityUncached({
        projectId,
        ...(provider === null ? {} : { provider }),
        repository,
        number,
      } as IssueRef);
    },
    {
      capacity: DETAIL_CACHE_CAPACITY,
      timeToLive: (exit) => (Exit.isSuccess(exit) ? DETAIL_CACHE_TTL : Duration.zero),
    },
  );
  const staleActivity = staleWhileRevalidate<IssueActivity>(
    DETAIL_STALE_WINDOW,
    DETAIL_CACHE_CAPACITY,
  );
  const activity: IssueService["Service"]["activity"] = (input) => {
    const key = JSON.stringify([
      refEpoch(input),
      input.projectId,
      input.provider ?? null,
      input.repository,
      input.number,
    ]);
    return staleActivity(key, Cache.get(activityCache, key));
  };

  const templateCache = yield* Cache.makeWith(
    (key: string) => {
      const [, projectId, repository] = JSON.parse(key) as [number, string, string];
      return templatesUncached({ projectId, repository } as IssueRepositoryRef);
    },
    {
      capacity: TEMPLATE_CACHE_CAPACITY,
      timeToLive: (exit) => (Exit.isSuccess(exit) ? TEMPLATE_CACHE_TTL : Duration.zero),
    },
  );
  const templates: IssueService["Service"]["templates"] = (input) =>
    Cache.get(templateCache, JSON.stringify([templatesEpoch, input.projectId, input.repository]));

  const invalidate: IssueService["Service"]["invalidate"] = (input) =>
    Effect.sync(() => {
      if (input.reference === undefined) {
        listingsEpoch = ++epochCounter;
        templatesEpoch = ++epochCounter;
        allRefsEpoch = ++epochCounter;
        refEpochs.clear();
        // A whole-workspace refresh is the reader asking to be re-answered from the hosts, and
        // that includes who the hosts say they are.
        viewersBySource.clear();
        return;
      }
      bumpRefEpoch(input.reference);
    });

  // A mutation's own client re-reads right after it, and every other client's next read must see
  // the change too — so a write forgets the issue it touched and the listings its state change
  // reorders, for everyone, without any client asking.
  const invalidatedByMutation =
    <I extends IssueRef>(
      method: (input: I) => Effect.Effect<void, IssueError>,
    ): ((input: I) => Effect.Effect<void, IssueError>) =>
    (input) =>
      method(input).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            bumpRefEpoch(input);
            listingsEpoch = ++epochCounter;
          }),
        ),
      );

  return IssueService.of({
    list,
    detail,
    activity,
    runAction: invalidatedByMutation(runAction),
    commentsPage,
    comment: invalidatedByMutation(comment),
    updateComment: invalidatedByMutation(updateComment),
    setReaction: invalidatedByMutation(setReaction),
    // A new issue belongs on every listing that would hold it, and there is no issue of its own
    // to forget yet.
    create: (input) =>
      create(input).pipe(Effect.tap(() => Effect.sync(() => (listingsEpoch = ++epochCounter)))),
    update: invalidatedByMutation(update),
    setLabels: invalidatedByMutation(setLabels),
    setAssignees: invalidatedByMutation(setAssignees),
    // The candidate lists are deliberately read fresh per menu-open, so they stay uncached.
    labelCandidates,
    assigneeCandidates,
    templates,
    invalidate,
  });
});

export const layer = Layer.effect(IssueService, make);
