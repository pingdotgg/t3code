import * as Cache from "effect/Cache";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Hash from "effect/Hash";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import type {
  PullRequestCapabilities,
  PullRequestComment,
  PullRequestMergeability,
  PullRequestReviewThread,
  PullRequestViewerPermissions,
} from "@t3tools/contracts";
import { SourceControlProviderKind } from "@t3tools/contracts";
import {
  PullRequestProviderError,
  type ProviderChangeRequest,
  type ProviderChangeRequestActivity,
  type ProviderChangeRequestDetail,
  type ProviderRepositoryRef,
  type PullRequestProviderApi,
} from "@t3tools/source-control-core/server/PullRequestProvider";

import * as OriginCli from "./OriginCli.ts";
import {
  checksState,
  originActor,
  originActorId,
  originAvatars,
  originCheck,
  OriginGitRefSchema,
  OriginMergeabilitySchema,
  preparedMergeability,
  OriginCheckRunListSchema,
  OriginCommentListSchema,
  OriginCommitListSchema,
  OriginFileListSchema,
  originFilesPatch,
  OriginPullRequestListSchema,
  OriginPullRequestSchema,
  OriginRepositorySchema,
  OriginReviewListSchema,
  originState,
  originUpdatedAt,
  type OriginAvatars,
  type OriginComment,
  type OriginPullRequest,
  UNKNOWN_TIME,
} from "./originPullRequests.ts";

const CAPABILITIES: PullRequestCapabilities = {
  diff: true,
  comment: true,
  actions: ["merge", "ready", "draft", "close", "reopen"],
  // Origin merges with a merge commit or a squash; it has no rebase merge.
  mergeMethods: ["merge", "squash"],
  search: false,
  reactions: false,
  review: {
    inlineComment: true,
    reply: true,
    resolve: true,
    verdicts: ["comment", "approve", "request-changes"],
  },
  // Origin can request reviewers, but lists no candidates to pick from.
  reviewers: { request: false, listCandidates: false },
  edit: { changeRequest: true, comment: true },
};

/**
 * Origin reports no per-viewer permission on a pull request, so everything the host can do is
 * offered and Origin explains any refusal itself.
 */
const VIEWER_PERMISSIONS: PullRequestViewerPermissions = {
  actions: CAPABILITIES.actions,
  comment: true,
  resolve: true,
  verdicts: CAPABILITIES.review.verdicts,
  requestReviewers: false,
};

const PAGE_SIZE = 100;
/** Bounds each paged read, so one very long pull request cannot stall its detail. */
const MAX_PAGES = 10;

const unsupported = (operation: string, detail: string) =>
  Effect.fail(
    new PullRequestProviderError({
      provider: SourceControlProviderKind.make("cursor-origin"),
      operation,
      reason: "failed",
      detail,
    }),
  );

function toProviderChangeRequest(pullRequest: OriginPullRequest, avatars?: OriginAvatars) {
  return {
    number: pullRequest.number,
    title: pullRequest.title,
    url: pullRequest.webUrl,
    author: originActor(pullRequest.author, avatars),
    headBranch: pullRequest.head.ref,
    baseBranch: pullRequest.base.ref,
    state: originState(pullRequest),
    isDraft: pullRequest.draft === true,
    // A listing cannot afford the base comparison the detail makes, so it does not guess.
    mergeability: "unknown",
    additions: pullRequest.additions ?? 0,
    deletions: pullRequest.deletions ?? 0,
    createdAt: pullRequest.createdAt?.trim() || originUpdatedAt(pullRequest),
    closedAt: pullRequest.closedAt?.trim() || null,
    mergedAt: pullRequest.mergedAt?.trim() || null,
    updatedAt: originUpdatedAt(pullRequest),
    reviewRequestLogins: [],
    labels: (pullRequest.labels ?? []).map((label) => ({
      name: label.name,
      color: label.color?.replace(/^#/u, "") || "888888",
      description: label.description ?? null,
    })),
  } satisfies ProviderChangeRequest;
}

const isThreadComment = (comment: OriginComment) => Boolean(comment.thread?.path);
const editedAt = (comment: OriginComment) =>
  comment.updatedAt && comment.updatedAt !== comment.createdAt ? comment.updatedAt : null;

function toThreads(
  comments: ReadonlyArray<OriginComment>,
  avatars: OriginAvatars,
  headSha: string | null,
): PullRequestReviewThread[] {
  const threads = new Map<string, PullRequestReviewThread>();
  for (const comment of comments) {
    const thread = comment.thread;
    if (!thread?.path) continue;
    const line = thread.endLine ?? thread.startLine ?? null;
    const existing = threads.get(thread.id) ?? {
      id: thread.id,
      path: thread.path,
      line: line !== null && line > 0 ? line : null,
      side: thread.side === "left" ? ("left" as const) : ("right" as const),
      isResolved: Boolean(thread.resolvedAt),
      // Origin anchors a thread to the version it was left on and does not move it forward.
      isOutdated: Boolean(headSha && thread.version?.headSha && thread.version.headSha !== headSha),
      comments: [],
    };
    threads.set(thread.id, {
      ...existing,
      comments: [
        ...existing.comments,
        {
          id: comment.id,
          author: originActor(comment.author, avatars),
          body: comment.body ?? "",
          createdAt: comment.createdAt,
          editedAt: editedAt(comment),
          url: null,
        },
      ],
    });
  }
  return [...threads.values()];
}

export const make = Effect.gen(function* () {
  const cli = yield* OriginCli.OriginCli;
  const scope = yield* Effect.scope;

  const fail = (operation: string) => (error: OriginCli.OriginCliError) =>
    new PullRequestProviderError({
      provider: SourceControlProviderKind.make("cursor-origin"),
      operation,
      reason: error.reason === "invalid-response" ? "failed" : error.reason,
      ...(error.retryAt === undefined ? {} : { retryAt: error.retryAt }),
      detail: error.detail,
      cause: error,
    });

  // A repository's merge settings change rarely, and every detail read asks for them.
  const repositorySettings = yield* Cache.makeWith(
    (key: string) => {
      const [cwd = "", repository = ""] = key.split("\n");
      return recover(
        cli.api(
          { cwd, operation: "getRepository", path: OriginCli.originRepositoryPath(repository) },
          OriginRepositorySchema,
        ),
        null,
      );
    },
    {
      capacity: 64,
      timeToLive: (exit) => (Exit.isSuccess(exit) && exit.value !== null ? "5 minutes" : 0),
    },
  );
  const getRepositorySettings = (cwd: string, repository: string) =>
    Cache.get(repositorySettings, `${cwd}\n${repository}`);

  const pullPath = (repository: string, number: number, suffix = "") =>
    `${OriginCli.originRepositoryPath(repository)}/pulls/${number}${suffix}`;

  // The last version of each pull request a listing or a read returned, most recent last. Reads
  // that hang off its head and base start from it alongside the fresh read of the pull request,
  // and are redone only when it has moved since.
  const lastSeen = new Map<string, OriginPullRequest>();
  const remember = (key: string, pullRequest: OriginPullRequest) => {
    lastSeen.delete(key);
    lastSeen.set(key, pullRequest);
    if (lastSeen.size > 1024) lastSeen.delete(lastSeen.keys().next().value ?? "");
  };
  const sameBasis = (seen: OriginPullRequest, current: OriginPullRequest) =>
    seen.head.sha === current.head.sha &&
    seen.base.ref === current.base.ref &&
    seen.base.sha === current.base.sha &&
    seen.version?.headSha === current.version?.headSha &&
    seen.version?.baseSha === current.version?.baseSha &&
    seen.version?.potentialMergeCommit?.baseSha ===
      current.version?.potentialMergeCommit?.baseSha &&
    seen.version?.potentialMergeCommit?.state === current.version?.potentialMergeCommit?.state &&
    seen.draft === current.draft &&
    originState(seen) === originState(current);

  // Opening a pull request reads its detail and its checks at once, and both start from the pull
  // request itself. Reads within a second share one request; this package's own writes drop it.
  const pullKey = (input: ProviderRepositoryRef & { readonly number: number }) =>
    `${input.cwd}\n${input.repository}\n${input.number}`;
  const pulls = yield* Cache.makeWith(
    (key: string) => {
      const [cwd = "", repository = "", number = ""] = key.split("\n");
      return cli
        .api(
          { cwd, operation: "getPullRequest", path: pullPath(repository, Number(number)) },
          OriginPullRequestSchema,
        )
        .pipe(Effect.tap((pullRequest) => Effect.sync(() => remember(key, pullRequest))));
    },
    { capacity: 256, timeToLive: (exit) => (Exit.isSuccess(exit) ? "1 second" : 0) },
  );
  const getPull = (input: ProviderRepositoryRef & { readonly number: number }) =>
    Cache.get(pulls, pullKey(input));
  const forgetPull = (input: ProviderRepositoryRef & { readonly number: number }) =>
    Cache.invalidate(pulls, pullKey(input)).pipe(
      Effect.andThen(Effect.sync(() => lastSeen.delete(pullKey(input)))),
    );

  /** `dependents` of the fresh pull request, started early from the last-seen version. */
  const withPull = Effect.fn("OriginPullRequestProvider.withPull")(function* <A>(
    input: ProviderRepositoryRef & { readonly number: number },
    dependents: (pullRequest: OriginPullRequest) => Effect.Effect<A, OriginCli.OriginCliError>,
  ) {
    const seen = lastSeen.get(pullKey(input));
    const [pullRequest, early] = yield* Effect.all(
      [
        getPull(input),
        seen === undefined ? Effect.succeedNone : Effect.asSome(Effect.result(dependents(seen))),
      ],
      { concurrency: "unbounded" },
    );
    if (seen !== undefined && Option.isSome(early)) {
      const guess = early.value;
      // A refused or rate-limited account fails the fresh read too; asking again spends quota.
      if (
        Result.isFailure(guess) &&
        (guess.failure.reason === "rate-limited" || guess.failure.reason === "unauthenticated")
      )
        return yield* guess.failure;
      // A guess that fails, say for a head since force-pushed away, is only a missed head start.
      if (sameBasis(seen, pullRequest))
        return [pullRequest, yield* Effect.fromResult(guess)] as const;
    }
    return [pullRequest, yield* dependents(pullRequest)] as const;
  });

  /** Reads every page of a list endpoint, up to `MAX_PAGES`. */
  const readPages = Effect.fn("OriginPullRequestProvider.readPages")(function* <
    S extends Schema.Codec<
      { readonly nextPageToken?: string | null | undefined },
      unknown,
      never,
      never
    >,
    A,
  >(
    input: { readonly cwd: string; readonly operation: string; readonly path: string },
    schema: S,
    items: (page: S["Type"]) => ReadonlyArray<A> | null | undefined,
  ) {
    const all: A[] = [];
    const tokens = new Set<string>();
    let token: string | null | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      const query = new URLSearchParams({
        pageSize: String(PAGE_SIZE),
        ...(token ? { pageToken: token } : {}),
      });
      const result = yield* cli.api({ ...input, path: `${input.path}?${query}` }, schema);
      all.push(...(items(result) ?? []));
      token = result.nextPageToken;
      if (!token) return { items: all, truncated: false };
      // A page token seen before would only read the same pages again.
      if (tokens.has(token)) return { items: all, truncated: true };
      tokens.add(token);
    }
    return { items: all, truncated: true };
  });

  // The detail and the checks tab both list the head commit's check runs, usually together.
  const checkRuns = yield* Cache.makeWith(
    (key: string) => {
      const [cwd = "", repository = "", sha = ""] = key.split("\n");
      return readPages(
        {
          cwd,
          operation: "listChecks",
          path: `${OriginCli.originRepositoryPath(repository)}/commits/${encodeURIComponent(sha)}/check-runs`,
        },
        OriginCheckRunListSchema,
        (page) => page.checkRuns,
      ).pipe(Effect.map((page) => page.items.map(originCheck)));
    },
    { capacity: 256, timeToLive: (exit) => (Exit.isSuccess(exit) ? "1 second" : 0) },
  );
  const listChecks = (
    input: ProviderRepositoryRef & { readonly sha: string | null | undefined },
  ) =>
    input.sha
      ? Cache.get(checkRuns, `${input.cwd}\n${input.repository}\n${input.sha}`)
      : Effect.succeed([]);

  const readPatch = (cwd: string, path: string) =>
    readPages({ cwd, operation: "getDiff", path }, OriginFileListSchema, (page) => page.files).pipe(
      Effect.map((page) => ({
        patch: originFilesPatch(page.items),
        // Origin leaves out the hunks of files too large to show.
        truncated: page.truncated || page.items.some((file) => file.patch == null),
        nextCursor: null,
      })),
    );
  const versionKey = (pullRequest: OriginPullRequest) => {
    const head = pullRequest.version?.headSha ?? pullRequest.head.sha;
    const base = pullRequest.version?.baseSha ?? pullRequest.base.sha;
    return head && base ? `${base}...${head}` : null;
  };
  // Keyed by `cwd, repository, number, base...head` for a pull request's patch, or by
  // `cwd, repository, , commit` for one commit's.
  const patches = yield* Cache.makeWith(
    (key: string) => {
      const [cwd = "", repository = "", number = "", commits = ""] = key.split("\n");
      if (number === "")
        return readPatch(
          cwd,
          `${OriginCli.originRepositoryPath(repository)}/commits/${encodeURIComponent(commits)}/files`,
        ).pipe(Effect.map((patch) => ({ ...patch, pinned: true })));
      // `/files` always answers for the newest version, so a push during the read must not be
      // kept under the version the key names.
      return readPatch(cwd, pullPath(repository, Number(number), "/files")).pipe(
        Effect.flatMap((patch) =>
          recover(
            cli
              .api(
                { cwd, operation: "getPullRequest", path: pullPath(repository, Number(number)) },
                OriginPullRequestSchema,
              )
              .pipe(Effect.map(versionKey)),
            null,
          ).pipe(Effect.map((version) => ({ ...patch, pinned: version === commits }))),
        ),
      );
    },
    {
      capacity: 64,
      timeToLive: (exit) => (Exit.isSuccess(exit) && exit.value.pinned ? "1 hour" : 0),
    },
  );

  // Every pull request into a branch compares against the same tip, so it is read once a moment.
  const baseTips = yield* Cache.makeWith(
    (key: string) => {
      const [cwd = "", repository = "", branch = ""] = key.split("\n");
      return cli
        .api(
          {
            cwd,
            operation: "getBaseTip",
            path: `${OriginCli.originRepositoryPath(repository)}/git/ref/${encodeURIComponent(`heads/${branch}`)}`,
          },
          OriginGitRefSchema,
        )
        .pipe(Effect.map((ref) => ref.object?.sha ?? null));
    },
    { capacity: 64, timeToLive: (exit) => (Exit.isSuccess(exit) ? "2 seconds" : 0) },
  );

  // Whether a head merges cleanly into a base never changes, and `/mergeability` counts ten times
  // against the rate limit, so a definite answer is kept for that pair of commits.
  const mergeabilities = yield* Cache.makeWith(
    (key: string) => {
      const [cwd = "", repository = "", number = "", head = ""] = key.split("\n");
      return cli
        .api(
          {
            cwd,
            operation: "getMergeability",
            path: pullPath(
              repository,
              Number(number),
              `/mergeability?${new URLSearchParams({ expectedHeadSha: head })}`,
            ),
          },
          OriginMergeabilitySchema,
        )
        .pipe(
          Effect.map((answer): PullRequestMergeability =>
            // A head pushed since the key was made answers for other commits.
            answer.headSha && answer.headSha !== head
              ? "unknown"
              : (answer.blockers ?? []).some((blocker) => blocker.kind === "merge_conflict")
                ? "conflicting"
                : answer.verdict === "mergeable"
                  ? "mergeable"
                  : "unknown",
          ),
        );
    },
    {
      capacity: 256,
      timeToLive: (exit) => (Exit.isSuccess(exit) && exit.value !== "unknown" ? "1 hour" : 0),
    },
  );

  /**
   * Origin prepares a merge for every version, against the base as it stood then. While that is
   * still the base's tip, the prepared merge is the answer, for one ref read; once the base has
   * moved, only `/mergeability` knows.
   */
  const mergeabilityOf = (
    input: ProviderRepositoryRef & { readonly number: number },
    pullRequest: OriginPullRequest,
  ): Effect.Effect<PullRequestMergeability, OriginCli.OriginCliError> => {
    if (originState(pullRequest) !== "open" || !pullRequest.head.sha)
      return Effect.succeed("unknown");
    return recover(
      Cache.get(baseTips, `${input.cwd}\n${input.repository}\n${pullRequest.base.ref}`),
      null,
    ).pipe(
      // Without the base's tip there is nothing to judge a merge against.
      Effect.flatMap((tip) =>
        tip === null
          ? Effect.succeed("unknown" as const)
          : tip ===
              (pullRequest.version?.potentialMergeCommit?.baseSha ?? pullRequest.version?.baseSha)
            ? Effect.succeed(preparedMergeability(pullRequest))
            : recover(
                Cache.get(
                  mergeabilities,
                  `${input.cwd}\n${input.repository}\n${input.number}\n${pullRequest.head.sha}\n${tip}\n${pullRequest.base.ref}`,
                ),
                "unknown",
              ),
      ),
    );
  };

  // Avatars only change when someone replaces their picture, so each actor's is read once per
  // server. An actor the CLI reports without one is cached as "" so it is not asked about again.
  const avatarCache = new Map<string, string>();
  let avatarRead: Fiber.Fiber<OriginAvatars> | null = null;
  const avatarsFor = Effect.fn("OriginPullRequestProvider.avatarsFor")(function* (
    cwd: string,
    actors: ReadonlyArray<Parameters<typeof originActorId>[0]>,
    args: ReadonlyArray<string>,
  ) {
    if (
      actors.every((actor) => {
        const id = originActorId(actor);
        return id === null || avatarCache.has(id);
      })
    )
      return avatarCache;
    if (avatarRead !== null) yield* Fiber.join(avatarRead);
    const missing = actors
      .map(originActorId)
      .filter((id): id is string => id !== null && !avatarCache.has(id));
    return missing.length > 0 ? yield* readAvatars(cwd, args, missing) : avatarCache;
  });
  const readAvatars = (
    cwd: string,
    args: ReadonlyArray<string>,
    ids: ReadonlyArray<string> = [],
  ): Effect.Effect<OriginAvatars> =>
    cli.execute({ cwd, operation: "readAvatars", args }).pipe(
      Effect.flatMap(Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown))),
      Effect.map((json) => {
        for (const [id, url] of originAvatars(json)) avatarCache.set(id, url);
        for (const id of ids) if (!avatarCache.has(id)) avatarCache.set(id, "");
        return avatarCache;
      }),
      // A picture is decoration: a failed read leaves initials rather than failing the page.
      Effect.orElseSucceed(() => avatarCache),
    );
  const initialAvatars = Effect.fnUntraced(function* (cwd: string, args: ReadonlyArray<string>) {
    if (avatarCache.size > 0) return avatarCache;
    if (avatarRead === null)
      avatarRead = yield* Effect.forkIn(
        readAvatars(cwd, args).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              avatarRead = null;
            }),
          ),
        ),
        scope,
      );
    return yield* Fiber.join(avatarRead);
  });

  /** `origin pr view` arguments that print `fields` for one pull request, avatars included. */
  const viewArgs = (
    input: { readonly repository: string; readonly number: number },
    fields: string,
  ) => ["pr", "view", String(input.number), "-R", input.repository, "--json", fields];

  // Nothing reads a write's answer, so it is not decoded: a body this version cannot read must not
  // turn a write that landed into a failure the user retries.
  const write = (
    input: { readonly cwd: string },
    operation: string,
    method: "POST" | "PATCH",
    path: string,
    body: unknown,
  ) =>
    cli
      .api({ cwd: input.cwd, operation, method, path, body }, Schema.Unknown)
      .pipe(Effect.asVoid, Effect.mapError(fail(operation)));

  const recover = <A>(
    read: Effect.Effect<A, OriginCli.OriginCliError>,
    fallback: A,
    keepNotFound = false,
  ) =>
    read.pipe(
      Effect.catchIf(
        (error) =>
          error.reason !== "rate-limited" &&
          error.reason !== "unauthenticated" &&
          !(keepNotFound && error.reason === "not-found"),
        () => Effect.succeed(fallback),
      ),
    );

  // Origin pages by a token longer than the service's cursor can carry, so the cursor names it by
  // hash. A cursor from before a restart finds nothing and ends the list there.
  const pageTokens = new Map<string, string>();
  const pageTokenKey = (token: string) => {
    const key = `${(Hash.string(token) >>> 0).toString(36)}-${token.length}`;
    pageTokens.delete(key);
    pageTokens.set(key, token);
    if (pageTokens.size > 256) pageTokens.delete(pageTokens.keys().next().value ?? "");
    return key;
  };

  // Origin merges a stacked pull request together with every open one below it, which the panel
  // does not show, so those merges are left to Origin.
  const refuseStackedMerge = Effect.fn("OriginPullRequestProvider.refuseStackedMerge")(function* (
    input: ProviderRepositoryRef & { readonly number: number },
  ) {
    const read = (number: number) =>
      getPull({ ...input, number }).pipe(Effect.mapError(fail("runAction")));
    const parent = (yield* read(input.number)).stack?.parentPullRequest?.number;
    if (parent == null) return;
    if (originState(yield* read(Number(parent))) !== "open") return;
    return yield* unsupported(
      "runAction",
      `This pull request is stacked on #${parent}. Merge #${parent} first, or merge the stack on Cursor Origin.`,
    );
  });

  const provider: PullRequestProviderApi = {
    kind: SourceControlProviderKind.make("cursor-origin"),
    capabilities: CAPABILITIES,

    getViewer: Effect.fn("OriginPullRequestProvider.getViewer")(
      function* (input) {
        if (avatarCache.size === 0 && avatarRead === null) {
          // The first list follows sign-in, so its pictures can be read while sign-in is checked.
          yield* Effect.forkIn(
            cli.resolveRepository({ cwd: input.cwd }).pipe(
              Effect.flatMap((repository) =>
                initialAvatars(input.cwd, [
                  "pr",
                  "list",
                  "-R",
                  repository,
                  "-s",
                  "all",
                  "-L",
                  String(PAGE_SIZE),
                  "--json",
                  "author",
                ]),
              ),
              Effect.ignore,
            ),
            scope,
          );
        }
        return yield* cli.viewer(input.cwd);
      },
      Effect.mapError(fail("getViewer")),
    ),

    listChangeRequests: Effect.fn("OriginPullRequestProvider.listChangeRequests")(
      function* (input) {
        const limit = Math.min(Math.max(input.limit, 1), PAGE_SIZE);
        const resume = input.cursor?.resumeAfter;
        const pageToken = resume === undefined ? undefined : pageTokens.get(resume);
        if (resume !== undefined && pageToken === undefined)
          return { items: [], truncated: false, continues: false };
        const query = new URLSearchParams({
          state: input.state,
          pageSize: String(limit),
          sortBy: "updated",
          ...(input.involvement === "authored" ? { author: input.viewer } : {}),
          ...(pageToken === undefined ? {} : { pageToken }),
        });
        const avatarArgs = [
          "pr",
          "list",
          "-R",
          input.repository,
          "-s",
          input.state,
          "-L",
          String(limit),
          "--json",
          "author",
        ];
        // Share a sign-in's read, or start the pictures alongside the first list.
        const [page] = yield* Effect.all(
          [
            cli.api(
              {
                cwd: input.cwd,
                operation: "listChangeRequests",
                path: `${OriginCli.originRepositoryPath(input.repository)}/pulls?${query}`,
              },
              OriginPullRequestListSchema,
            ),
            initialAvatars(input.cwd, avatarArgs),
          ],
          { concurrency: "unbounded" },
        );
        const pullRequests = page.pullRequests ?? [];
        for (const pullRequest of pullRequests)
          remember(pullKey({ ...input, number: pullRequest.number }), pullRequest);
        // `origin pr list` only reads the first page, so later pages use the pictures already read.
        const avatars =
          input.cursor === undefined
            ? yield* avatarsFor(
                input.cwd,
                pullRequests.map((pullRequest) => pullRequest.author),
                avatarArgs,
              )
            : avatarCache;
        const next = page.nextPageToken || null;
        return {
          items: pullRequests.map((pullRequest) => toProviderChangeRequest(pullRequest, avatars)),
          truncated: next !== null,
          continues: next !== null,
          ...(next === null ? {} : { resumeAfter: pageTokenKey(next) }),
        };
      },
      Effect.mapError(fail("listChangeRequests")),
    ),

    // One read: linked threads poll this, and the full detail costs four.
    getChangeRequestSummary: (input) =>
      getPull(input).pipe(
        Effect.map((pullRequest) => {
          const summary = toProviderChangeRequest(pullRequest, avatarCache);
          return {
            number: summary.number,
            title: summary.title,
            url: summary.url,
            headBranch: summary.headBranch,
            baseBranch: summary.baseBranch,
            state: summary.state,
            isDraft: summary.isDraft,
            closedAt: summary.closedAt ?? null,
            mergedAt: summary.mergedAt ?? null,
            updatedAt: summary.updatedAt,
            author: summary.author,
            additions: summary.additions,
            deletions: summary.deletions,
            changedFiles: pullRequest.changedFiles ?? 0,
          };
        }),
        Effect.mapError(fail("getChangeRequestSummary")),
      ),

    getChangeRequestChecks: (input) =>
      withPull(input, (pullRequest) => listChecks({ ...input, sha: pullRequest.head.sha })).pipe(
        Effect.map(([pullRequest, checks]) => ({ state: originState(pullRequest), checks })),
        Effect.mapError(fail("getChangeRequestChecks")),
      ),

    getChangeRequest: Effect.fn("OriginPullRequestProvider.getChangeRequest")(
      function* (input) {
        const [[pullRequest, [checks, avatars, mergeability]], repository] = yield* Effect.all(
          [
            withPull(input, (pullRequest) =>
              Effect.all(
                [
                  recover(listChecks({ ...input, sha: pullRequest.head.sha }), []),
                  avatarsFor(input.cwd, [pullRequest.author], viewArgs(input, "author")),
                  mergeabilityOf(input, pullRequest),
                ],
                { concurrency: "unbounded" },
              ),
            ),
            getRepositorySettings(input.cwd, input.repository),
          ],
          { concurrency: "unbounded" },
        );
        const detail: ProviderChangeRequestDetail = {
          ...toProviderChangeRequest(pullRequest, avatars),
          mergeability,
          checksState: checksState(checks),
          headSha: pullRequest.head.sha ?? null,
          body: pullRequest.body ?? "",
          changedFiles: pullRequest.changedFiles ?? 0,
          reviewers: [],
          checks,
          mergeCapabilities: {
            merge: repository?.allowMergeCommit ?? true,
            squash: repository?.allowSquashMerge ?? true,
            rebase: false,
          },
          viewerPermissions: VIEWER_PERMISSIONS,
        };
        return detail;
      },
      Effect.mapError(fail("getChangeRequest")),
    ),

    getChangeRequestActivity: (input) => {
      // A part that cannot be read shows as empty and truncated rather than failing the rest.
      const part = (operation: string, suffix: string) => ({
        cwd: input.cwd,
        operation,
        path: pullPath(input.repository, input.number, suffix),
      });
      const unread = { items: [], truncated: true };
      return Effect.all(
        [
          recover(
            readPages(
              part("listComments", "/comments"),
              OriginCommentListSchema,
              (page) => page.comments,
            ),
            unread,
            true,
          ),
          recover(
            readPages(
              part("listReviews", "/reviews"),
              OriginReviewListSchema,
              (page) => page.reviews,
            ),
            unread,
            true,
          ),
          recover(
            readPages(
              part("listCommits", "/commits"),
              OriginCommitListSchema,
              (page) => page.commits,
            ),
            unread,
            true,
          ),
          // The detail is read alongside, so this is usually its cached answer.
          recover(getPull(input), null),
        ],
        { concurrency: 4 },
      ).pipe(
        Effect.flatMap(([comments, reviews, commits, pullRequest]) =>
          avatarsFor(
            input.cwd,
            [
              ...comments.items.map((comment) => comment.author),
              ...reviews.items.map((review) => review.author),
            ],
            viewArgs(input, "author,reviews,comments"),
          ).pipe(
            Effect.map(
              (avatars) =>
                [comments, reviews, commits, avatars, pullRequest?.head.sha ?? null] as const,
            ),
          ),
        ),
        Effect.mapError(fail("getChangeRequestActivity")),
        Effect.map(
          ([comments, reviews, commits, avatars, headSha]): ProviderChangeRequestActivity => {
            const discussion: PullRequestComment[] = comments.items
              .filter((comment) => !isThreadComment(comment))
              .map((comment) => ({
                id: comment.id,
                kind: "issue-comment",
                author: originActor(comment.author, avatars),
                body: comment.body ?? "",
                createdAt: comment.createdAt,
                editedAt: editedAt(comment),
                url: null,
                path: null,
                reviewState: null,
              }));
            const reviewComments: PullRequestComment[] = reviews.items.map((review) => ({
              id: review.id,
              kind: "review",
              author: originActor(review.author, avatars),
              body: review.body ?? "",
              createdAt: review.submittedAt,
              url: null,
              path: null,
              reviewState: review.dismissal?.dismissedAt
                ? "DISMISSED"
                : review.verdict === "approve"
                  ? "APPROVED"
                  : review.verdict === "request_changes"
                    ? "CHANGES_REQUESTED"
                    : "COMMENTED",
            }));
            const all = [...discussion, ...reviewComments].toSorted((left, right) =>
              left.createdAt.localeCompare(right.createdAt),
            );
            return {
              comments: all,
              commentCount: all.length,
              commentsTruncated: comments.truncated || reviews.truncated,
              reviewThreadsTruncated: comments.truncated,
              reviewThreads: toThreads(comments.items, avatars, headSha),
              commits: commits.items.map((commit) => ({
                oid: commit.sha,
                messageHeadline: commit.commit.message.split("\n")[0] ?? "",
                committedDate:
                  commit.commit.committer?.date ?? commit.commit.author?.date ?? UNKNOWN_TIME,
                ...(commit.stats?.additions == null ? {} : { additions: commit.stats.additions }),
                ...(commit.stats?.deletions == null ? {} : { deletions: commit.stats.deletions }),
              })),
            };
          },
        ),
      );
    },

    getViewerPermissions: () => Effect.succeed(VIEWER_PERMISSIONS),

    // A version's patch never changes, and the files read counts five times against the rate limit, so
    // a patch is kept by the commits it compares; the pull request read that names them is the
    // one the detail is already making.
    getDiff: (input) =>
      (input.commit === undefined
        ? getPull(input).pipe(
            Effect.flatMap((pullRequest) => {
              const version = versionKey(pullRequest);
              return version
                ? Cache.get(
                    patches,
                    `${input.cwd}\n${input.repository}\n${input.number}\n${version}`,
                  )
                : readPatch(input.cwd, pullPath(input.repository, input.number, "/files"));
            }),
          )
        : Cache.get(patches, `${input.cwd}\n${input.repository}\n\n${input.commit}`)
      ).pipe(
        Effect.map(({ patch, truncated, nextCursor }) => ({ patch, truncated, nextCursor })),
        Effect.mapError(fail("getDiff")),
      ),

    listReviewerCandidates: () =>
      unsupported("listReviewerCandidates", "Cursor Origin does not list reviewer candidates."),
    setReviewerRequest: () =>
      unsupported(
        "setReviewerRequest",
        "Requesting reviewers is not supported for Cursor Origin yet.",
      ),
    setReaction: () =>
      unsupported("setReaction", "Reactions are not supported for Cursor Origin yet."),

    runAction: (input) => {
      const path = pullPath(input.repository, input.number);
      const action = (() => {
        switch (input.action) {
          case "merge":
            return refuseStackedMerge(input).pipe(
              Effect.andThen(
                write(input, "runAction", "POST", `${path}/merge`, {
                  mergeMethod: input.mergeMethod === "squash" ? "squash" : "merge",
                }),
              ),
            );
          case "close":
            return write(input, "runAction", "PATCH", path, { state: "closed" });
          case "reopen":
            return write(input, "runAction", "PATCH", path, { state: "open" });
          case "ready":
            return write(input, "runAction", "PATCH", path, { draft: false });
          case "draft":
            return write(input, "runAction", "PATCH", path, { draft: true });
          default:
            return null;
        }
      })();
      return action === null
        ? unsupported("runAction", `Cursor Origin does not support ${input.action}.`)
        : action.pipe(
            Effect.ensuring(forgetPull(input)),
            // A merge moves its base, which every other pull request into it compares against.
            Effect.ensuring(input.action === "merge" ? Cache.invalidateAll(baseTips) : Effect.void),
          );
    },

    updateChangeRequest: (input) =>
      write(input, "updateChangeRequest", "PATCH", pullPath(input.repository, input.number), {
        ...(input.title === undefined ? {} : { title: input.title }),
        ...(input.body === undefined ? {} : { body: input.body }),
      }).pipe(Effect.ensuring(forgetPull(input))),

    comment: (input) =>
      write(input, "comment", "POST", pullPath(input.repository, input.number, "/comments"), {
        body: input.body,
      }).pipe(Effect.ensuring(forgetPull(input))),

    updateComment: (input) =>
      write(
        input,
        "updateComment",
        "PATCH",
        `${OriginCli.originRepositoryPath(input.repository)}/pulls/comments/${encodeURIComponent(input.commentId)}`,
        { body: input.body },
      ).pipe(Effect.ensuring(forgetPull(input))),

    submitReview: (input) =>
      write(input, "submitReview", "POST", pullPath(input.repository, input.number, "/reviews"), {
        verdict: input.verdict === "request-changes" ? "request_changes" : input.verdict,
        body: input.body,
        comments: input.comments.map((comment) => {
          const side =
            comment.position.kind === "deleted"
              ? "left"
              : comment.position.kind === "added"
                ? "right"
                : comment.position.side;
          const line =
            comment.position.kind === "deleted"
              ? comment.position.oldLine
              : comment.position.kind === "added"
                ? comment.position.newLine
                : side === "left"
                  ? comment.position.oldLine
                  : comment.position.newLine;
          return {
            body: comment.body,
            inline: { path: comment.path, side, startLine: line, endLine: line },
          };
        }),
      }).pipe(Effect.ensuring(forgetPull(input))),

    replyToThread: (input) =>
      write(input, "replyToThread", "POST", pullPath(input.repository, input.number, "/comments"), {
        body: input.body,
        threadId: input.threadId,
      }).pipe(Effect.ensuring(forgetPull(input))),

    setThreadResolution: (input) =>
      write(
        input,
        "setThreadResolution",
        "PATCH",
        `${OriginCli.originRepositoryPath(input.repository)}/pulls/threads/${encodeURIComponent(input.threadId)}`,
        { resolved: input.resolved },
      ).pipe(Effect.ensuring(forgetPull(input))),
  };

  return provider;
});
