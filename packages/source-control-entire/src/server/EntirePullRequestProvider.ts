import {
  SourceControlProviderKind,
  type PullRequestCapabilities,
  type PullRequestMergeability,
} from "@t3tools/contracts";
import * as Cache from "effect/Cache";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Hash from "effect/Hash";
import * as Schema from "effect/Schema";
import {
  PullRequestProviderError,
  type ProviderChangeRequest,
  type ProviderRepositoryRef,
  type PullRequestProviderApi,
} from "@t3tools/source-control-core/server/PullRequestProvider";
import * as SourceControlHost from "@t3tools/source-control-core/server/SourceControlHost";
import { parseDiffFileRevisions } from "@t3tools/source-control-core/server/diffFileRevisions";

import * as EntireApi from "./EntireApi.ts";
import * as EntireCli from "./EntireCli.ts";
import * as EntireTrailBody from "./entireTrailBody.ts";
import * as Json from "./entireTrailJson.ts";
import { definition } from "../shared/definition.ts";
import { ENTIRE_WEB_HOST } from "../shared/entireUrls.ts";

const KIND = SourceControlProviderKind.make("entire");

const CAPABILITIES: PullRequestCapabilities = {
  // Read from the checkout: Entire's only trail diff route belongs to a code review, and starting
  // one is a visible write.
  diff: true,
  comment: true,
  actions: [...definition.changeRequestActions],
  mergeMethods: ["merge"],
  updateMethods: ["merge"],
  search: true,
  viewedFiles: "environment",
  reactions: false,
  labels: false,
  stacks: false,
  stackActions: false,
  review: {
    inlineComment: true,
    reply: true,
    resolve: true,
    verdicts: ["comment", "approve"],
  },
  reviewers: { request: false, listCandidates: false },
  edit: { changeRequest: true, comment: true },
};

const PAGE_SIZE = 100;
const MAX_PAGES = 5;
const MAX_DISCUSSIONS = 50;

const Id = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]+$/u));
const isId = Schema.is(Id);
const isEntireApiError = Schema.is(EntireApi.EntireApiError);
const MergeOutcome = Schema.Struct({ ok: Schema.Boolean });
const ReviewStarted = Schema.Struct({ review_id: Id });
const MAX_REVIEW_COMMENTS = 100;
const Ignored = Schema.Unknown;

type TrailRef = ProviderRepositoryRef & { readonly number: number };

const hashText = (text: string) => (Hash.string(text) >>> 0).toString(36);

const LIST_STATUS = {
  all: null,
  open: "draft,open",
  closed: "closed",
  merged: "merged",
} as const;

const PROJECT_LIST_PAGES = 3;
const PROJECT_LIST_TIMEOUT = Duration.seconds(2);
const GATES_TTL = Duration.minutes(5);

/** A public `repo_` id names no placement, so the project trail list takes only ULIDs. */
const ULID = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/u;

const DIFF_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const REVISIONS_TTL = Duration.seconds(30);
const COMMIT = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u;
// The reader's git config (`diff.noprefix`, an external driver) would change the parsed patch.
const PATCH_OPTIONS = [
  "--no-color",
  "--no-ext-diff",
  "--no-textconv",
  "--no-relative",
  "--src-prefix=a/",
  "--dst-prefix=b/",
  "--find-renames",
];

interface TrailRevisions {
  readonly base: string;
  readonly head: string;
}

/** @public */
export const make = Effect.gen(function* () {
  const api = yield* EntireApi.EntireApi;
  const cli = yield* EntireCli.EntireCli;
  const { git } = yield* SourceControlHost.SourceControlHost;

  const failure = (operation: string, detail: string, cause?: unknown) =>
    new PullRequestProviderError({
      provider: KIND,
      operation,
      reason: "failed",
      detail,
      ...(cause === undefined ? {} : { cause }),
    });

  const readVersioned = <S extends Schema.Codec<unknown, unknown, never, never>>(
    operation: string,
    input: ProviderRepositoryRef,
    request: Pick<
      EntireApi.EntireApiRequest,
      "method" | "path" | "body" | "headers" | "scope" | "cell"
    >,
    schema: S,
  ) =>
    api
      .requestJson({ ...request, cwd: input.cwd, repository: input.repository, operation }, schema)
      .pipe(
        Effect.mapError(
          (error) =>
            new PullRequestProviderError({
              provider: KIND,
              operation,
              reason: error.reason,
              detail: error.detail,
              cause: error,
            }),
        ),
      );

  const read = <S extends Schema.Codec<unknown, unknown, never, never>>(
    operation: string,
    input: ProviderRepositoryRef,
    request: Parameters<typeof readVersioned>[2],
    schema: S,
  ) => readVersioned(operation, input, request, schema).pipe(Effect.map(({ body }) => body));

  const trailPath = (input: TrailRef) => `/trails/${input.number}`;

  const readProjectTrail = (
    operation: string,
    input: TrailRef,
    route: NonNullable<ReturnType<typeof Json.projectTrailRoute>>,
  ) =>
    readVersioned(
      operation,
      input,
      { scope: "collection", path: route.path, cell: route.cell },
      Json.EntireProjectTrail,
    );

  /** The change's description, which is its project trail's wherever that can be read. */
  const description = Effect.fn("EntirePullRequestProvider.description")(function* (
    input: TrailRef,
    trail: Json.EntireTrailDetail,
  ) {
    const route = Json.projectTrailRoute(trail);
    if (route === null) return Json.changeBody(trail);
    return yield* readProjectTrail("getChangeRequest", input, route).pipe(
      Effect.map(({ body }) => Json.changeBody(trail, body.bodyDocument ?? null)),
      // The change keeps a copy from when it was linked, which beats no description.
      Effect.catch((error) =>
        Effect.logDebug("Entire project trail unreadable; showing the change's copy", {
          detail: error.detail,
        }).pipe(Effect.as(Json.changeBody(trail))),
      ),
    );
  });

  const readTrail = (operation: string, input: TrailRef) =>
    read(operation, input, { path: trailPath(input) }, Json.EntireTrailDetail);

  const runGit = (operation: string, cwd: string, args: ReadonlyArray<string>, detail: string) =>
    git
      .execute({
        operation: `EntirePullRequestProvider.${operation}`,
        cwd,
        args,
        maxOutputBytes: DIFF_MAX_OUTPUT_BYTES,
      })
      .pipe(Effect.mapError((cause) => failure(operation, detail, cause)));

  const hasCommit = (cwd: string, sha: string) =>
    git.resolveCommit({ cwd, revision: sha }).pipe(
      Effect.map(({ commitSha }) => commitSha.toLowerCase() === sha),
      Effect.orElseSucceed(() => false),
    );

  /** Trail commits are fetched from the checkout's own Entire remote, never from elsewhere. */
  const entireRemote = Effect.fn("EntirePullRequestProvider.entireRemote")(function* (
    input: ProviderRepositoryRef,
  ) {
    const remote = yield* EntireApi.checkoutEntireRemote(git, input.cwd).pipe(
      Effect.orElseSucceed(() => null),
    );
    if (remote?.repository.toLowerCase() !== input.repository.toLowerCase())
      return yield* failure(
        "getDiff",
        `This checkout has no entire:// remote for ${input.repository} to fetch the trail from.`,
      );
    return remote.name;
  });

  const fetchBranch = (cwd: string, remoteName: string, branch: string) =>
    runGit(
      "getDiff",
      cwd,
      ["check-ref-format", `refs/heads/${branch}`],
      `Entire named a branch git cannot fetch: ${branch}.`,
    ).pipe(
      Effect.andThen(
        git
          .fetchRemoteTrackingBranch({ cwd, remoteName, remoteBranch: branch })
          .pipe(
            Effect.mapError((cause) =>
              failure("getDiff", `Could not fetch ${branch} from Entire.`, cause),
            ),
          ),
      ),
    );

  const isAncestor = (cwd: string, ancestor: string, descendant: string) =>
    git
      .execute({
        operation: "EntirePullRequestProvider.isAncestor",
        cwd,
        args: ["merge-base", "--is-ancestor", ancestor, descendant],
      })
      .pipe(
        Effect.as(true),
        Effect.orElseSucceed(() => false),
      );

  // A merged head is in its base and may have been fast-forwarded, so the diff starts at the
  // parent of the first timeline commit still under the head.
  const landedBase = Effect.fn("EntirePullRequestProvider.landedBase")(function* (
    input: TrailRef,
    head: string,
  ) {
    // A fork point read from part of the timeline would silently drop the trail's earlier commits.
    const items: Array<Json.EntireTimeline["items"][number]> = [];
    const query = new URLSearchParams({ pageSize: "100" });
    for (let page = 0; ; page++) {
      const timeline: Json.EntireTimeline = yield* read(
        "getDiff",
        input,
        { path: `${trailPath(input)}/timeline?${query}` },
        Json.EntireTimeline,
      );
      items.push(...timeline.items);
      const next = timeline.nextPageToken;
      if (!next) break;
      if (page + 1 >= MAX_PAGES || next === query.get("pageToken"))
        return yield* failure(
          "getDiff",
          "Entire's timeline for this trail is too long to tell where it began.",
        );
      query.set("pageToken", next);
    }
    const commits = new Set(
      items.flatMap((item) => {
        const sha = item.commitSha?.toLowerCase();
        return item.kind === "commit" && sha !== undefined && COMMIT.test(sha) ? [sha] : [];
      }),
    );
    const forkPoints: Array<string> = [];
    for (const commit of commits) {
      if (!(yield* isAncestor(input.cwd, commit, head))) continue;
      const parent = yield* git.resolveCommit({ cwd: input.cwd, revision: `${commit}^1` }).pipe(
        Effect.map(({ commitSha }) => commitSha.toLowerCase()),
        Effect.orElseSucceed(() => null),
      );
      if (parent !== null && !commits.has(parent)) forkPoints.push(parent);
    }
    const [first] = forkPoints;
    if (first === undefined)
      return yield* failure(
        "getDiff",
        "Entire did not list the trail's commits, so its diff is unknown.",
      );
    if (forkPoints.length === 1) return first;
    // A commit the timeline left out makes its child look like a starting point too.
    const oldest = yield* runGit(
      "getDiff",
      input.cwd,
      ["merge-base", "--octopus", ...forkPoints],
      "Could not tell where the trail began.",
    );
    return oldest.stdout.trim() || first;
  });

  /** A detail read polls, so it fetches the base only when the checkout cannot answer without it. */
  const openBase = Effect.fn("EntirePullRequestProvider.openBase")(function* (
    cwd: string,
    remoteName: string,
    base: string,
    head: string,
    refresh: boolean,
  ) {
    const mergeBase = runGit(
      "getDiff",
      cwd,
      ["merge-base", `refs/remotes/${remoteName}/${base}`, head],
      `${base} and the trail share no history.`,
    ).pipe(Effect.map((result) => result.stdout.trim()));
    if (!refresh) {
      const known = yield* Effect.option(mergeBase);
      if (Option.isSome(known)) return known.value;
    }
    yield* fetchBranch(cwd, remoteName, base);
    return yield* mergeBase;
  });

  const resolveRevisions = Effect.fn("EntirePullRequestProvider.resolveRevisions")(function* (
    input: TrailRef,
    trail: Json.EntireTrailDetail,
    refreshBase: boolean,
  ) {
    const head = Json.headSha(trail)?.toLowerCase() ?? null;
    if (head === null || !COMMIT.test(head))
      return yield* failure(
        "getDiff",
        "Entire has not reported the trail's head yet. Refresh and try again.",
      );
    const remoteName = yield* entireRemote(input);
    if (!(yield* hasCommit(input.cwd, head))) {
      const branch = Json.trailHeadBranch(trail);
      // A merged trail's branch can be gone; asking for the commit itself still reaches it.
      if (branch) yield* fetchBranch(input.cwd, remoteName, branch).pipe(Effect.ignore);
      if (!(yield* hasCommit(input.cwd, head)))
        yield* git
          .execute({
            operation: "EntirePullRequestProvider.fetchHead",
            cwd: input.cwd,
            args: [
              "fetch",
              "--quiet",
              "--no-tags",
              "--no-write-fetch-head",
              "--",
              remoteName,
              head,
            ],
          })
          .pipe(Effect.ignore);
      if (!(yield* hasCommit(input.cwd, head)))
        return yield* failure(
          "getDiff",
          "Could not fetch the trail's head from Entire. Refresh and try again.",
        );
    }
    const recorded = trail.merge_base_sha?.toLowerCase() ?? null;
    const base =
      recorded !== null && COMMIT.test(recorded) && (yield* isAncestor(input.cwd, recorded, head))
        ? recorded
        : Json.trailState(trail.status) === "merged"
          ? yield* landedBase(input, head)
          : yield* openBase(input.cwd, remoteName, trail.base, head, refreshBase);
    return { base, head } satisfies TrailRevisions;
  });

  const lookupRevisions = (input: TrailRef) =>
    readTrail("getDiff", input).pipe(
      Effect.flatMap((trail) => resolveRevisions(input, trail, true)),
    );

  const revisions = yield* Cache.makeWith(lookupRevisions, {
    capacity: 32,
    timeToLive: (exit) => (Exit.isSuccess(exit) ? REVISIONS_TTL : Duration.zero),
  });
  const revisionsKey = (input: TrailRef): TrailRef => ({
    cwd: input.cwd,
    host: input.host,
    repository: input.repository,
    number: input.number,
  });
  const trailRevisions = (input: TrailRef) => Cache.get(revisions, revisionsKey(input));
  /** Heads a detail read could not fetch, so polling offline does not refetch each time. */
  const unresolved = yield* Cache.make({
    capacity: 32,
    lookup: (_: string) => Effect.void,
    timeToLive: REVISIONS_TTL,
  });

  const detailRevisions = Effect.fn("EntirePullRequestProvider.detailRevisions")(function* (
    input: TrailRef,
    trail: Json.EntireTrailDetail,
  ) {
    const cached = yield* Cache.getOption(revisions, revisionsKey(input)).pipe(
      Effect.orElseSucceed(() => Option.none<TrailRevisions>()),
    );
    if (Option.isSome(cached)) return cached.value;
    const head = [input.cwd, input.repository, input.number, Json.headSha(trail)].join("\0");
    if (yield* Cache.has(unresolved, head))
      return yield* failure("getDiff", "Could not fetch the trail's head from Entire just now.");
    return yield* resolveRevisions(input, trail, false).pipe(
      Effect.tapError(() => Cache.set(unresolved, head, undefined)),
    );
  });

  const changedFiles = Effect.fn("EntirePullRequestProvider.changedFiles")(function* (
    input: TrailRef,
    trail: Json.EntireTrailDetail,
  ) {
    const found = yield* detailRevisions(input, trail).pipe(Effect.option);
    if (Option.isNone(found)) return 0;
    const range = found.value;
    const listed = yield* git
      .execute({
        operation: "EntirePullRequestProvider.changedFiles",
        cwd: input.cwd,
        args: [
          "diff",
          "--name-only",
          "-z",
          "--no-ext-diff",
          "--find-renames",
          range.base,
          range.head,
        ],
        maxOutputBytes: DIFF_MAX_OUTPUT_BYTES,
      })
      .pipe(Effect.option);
    return Option.isSome(listed)
      ? listed.value.stdout.split("\0").filter((path) => path.length > 0).length
      : 0;
  });

  const trailCommit = Effect.fn("EntirePullRequestProvider.trailCommit")(function* (
    input: TrailRef,
    commit: string,
  ) {
    const sha = commit.toLowerCase();
    if (!COMMIT.test(sha)) return yield* failure("getDiff", "Not a commit hash.");
    if (!(yield* hasCommit(input.cwd, sha))) yield* trailRevisions(input);
    if (!(yield* hasCommit(input.cwd, sha)))
      return yield* failure("getDiff", "That commit is not on the trail.");
    return sha;
  });

  const diffRange = (input: TrailRef & { readonly commit?: string | undefined }) =>
    input.commit === undefined
      ? trailRevisions(input).pipe(Effect.map(({ base, head }) => ({ from: base, to: head })))
      : trailCommit(input, input.commit).pipe(Effect.map((sha) => ({ from: `${sha}^`, to: sha })));

  const write = (
    operation: string,
    input: TrailRef,
    method: NonNullable<EntireApi.EntireApiRequest["method"]>,
    path: string,
    body: unknown,
  ) =>
    read(operation, input, { method, path: `${trailPath(input)}${path}`, body }, Ignored).pipe(
      Effect.asVoid,
    );

  const explained =
    (sentences: Readonly<Record<number, string>>) => (error: PullRequestProviderError) => {
      const status = isEntireApiError(error.cause) ? error.cause.status : null;
      const detail = status === null ? undefined : sentences[status];
      return detail === undefined ? error : new PullRequestProviderError({ ...error, detail });
    };

  // Entire anchors a comment by the head's line and its non-blank text.
  const lineComments = Effect.fn("EntirePullRequestProvider.lineComments")(function* (
    input: TrailRef,
    head: string,
    comments: Parameters<PullRequestProviderApi["submitReview"]>[0]["comments"],
  ) {
    const files = new Map<string, ReadonlyArray<string>>();
    const lines = Effect.fn("EntirePullRequestProvider.headLines")(function* (path: string) {
      const cached = files.get(path);
      if (cached !== undefined) return cached;
      const blob = yield* runGit(
        "submitReview",
        input.cwd,
        ["cat-file", "blob", `${head}:${path}`],
        `Could not read ${path} at the trail's head.`,
      );
      const split = blob.stdout.split("\n");
      files.set(path, split);
      return split;
    });
    return yield* Effect.forEach(comments, (comment, index) =>
      Effect.gen(function* () {
        const position = comment.position;
        const line =
          position.kind === "added"
            ? position.newLine
            : position.kind === "context" && position.side === "right"
              ? position.newLine
              : null;
        if (line === null)
          return yield* failure(
            "submitReview",
            `Entire comments on the trail's new lines only; ${comment.path} has a comment on a removed one.`,
          );
        const text = (yield* lines(comment.path))[line - 1]?.replace(/\r$/u, "");
        if (!text?.trim())
          return yield* failure(
            "submitReview",
            `Entire cannot anchor a comment to a blank line (${comment.path}:${line}).`,
          );
        return {
          client_id: `t3code-${index}-${hashText(`${comment.path}\0${line}\0${comment.body}`)}`,
          body: comment.body,
          location: {
            granularity: "line",
            file_path: comment.path,
            start_line: line,
            end_line: line,
            selected_text: text,
          },
        };
      }),
    );
  });

  const publishReview = Effect.fn("EntirePullRequestProvider.publishReview")(function* (
    input: Parameters<PullRequestProviderApi["submitReview"]>[0],
  ) {
    if (input.comments.length > MAX_REVIEW_COMMENTS)
      return yield* failure(
        "submitReview",
        `Entire publishes at most ${MAX_REVIEW_COMMENTS} comments in one review.`,
      );
    const { base, head } = yield* trailRevisions(input);
    const comments = yield* lineComments(input, head, input.comments);
    const body = input.body.trim();
    const key = `t3code-${hashText(
      [
        input.repository,
        input.number,
        base,
        head,
        input.verdict,
        body,
        ...comments.map((comment) => comment.client_id),
      ].join("\0"),
    )}`;
    const headers = { "idempotency-key": key };
    const started = yield* read(
      "submitReview",
      input,
      {
        method: "POST",
        path: `${trailPath(input)}/reviews`,
        headers,
        body: { head_sha: head, base_sha: base },
      },
      ReviewStarted,
    );
    yield* read(
      "submitReview",
      input,
      {
        method: "POST",
        path: `${trailPath(input)}/reviews/${started.review_id}/comments`,
        headers,
        body: { comments, summary: body.length === 0 ? null : body },
      },
      Ignored,
    ).pipe(
      Effect.mapError(
        (error) =>
          new PullRequestProviderError({
            ...error,
            detail: `${error.detail} Entire kept the empty review it started for them.`,
          }),
      ),
    );
  });

  const merge = Effect.fn("EntirePullRequestProvider.merge")(function* (
    input: Parameters<PullRequestProviderApi["runAction"]>[0],
  ) {
    if (input.mergeMethod !== undefined && input.mergeMethod !== "merge")
      return yield* failure("merge", "Entire merges trails with a merge commit only.");
    // Read fresh: the merge is fenced on the head Entire reports now, not the one a page saw.
    const trail = yield* readTrail("merge", input);
    if (trail.status === "merged") return;
    // A writer is offered Merge before the gates pass, so the gate is checked on this fresh read.
    if (trail.actions?.merge.state !== "enabled") {
      const waiting = Json.blockingGates(trail)
        .filter((gate) => gate.status !== "passed")
        .map((gate) => gate.gate_key);
      const last = waiting.pop();
      const reason = trail.actions?.merge.reason;
      return yield* failure(
        "merge",
        last === undefined
          ? `Entire cannot merge this trail yet${reason ? ` (${reason})` : ""}. Try again once its gates pass.`
          : waiting.length === 0
            ? `Entire cannot merge this trail until its ${last} gate passes.`
            : `Entire cannot merge this trail until its ${waiting.join(", ")} and ${last} gates pass.`,
      );
    }
    const head = Json.headSha(trail);
    if (head === null)
      return yield* failure(
        "merge",
        "Entire has not reported the trail's head yet. Refresh and try again.",
      );
    const outcome = yield* read(
      "merge",
      input,
      { method: "POST", path: `${trailPath(input)}/merge`, body: { expectedHeadSha: head } },
      MergeOutcome,
    );
    if (!outcome.ok) return yield* failure("merge", "Entire could not merge the trail.");
  });

  const updateBranch = Effect.fn("EntirePullRequestProvider.updateBranch")(function* (
    input: Parameters<PullRequestProviderApi["runAction"]>[0],
  ) {
    if (input.updateMethod !== undefined && input.updateMethod !== "merge")
      return yield* failure(
        "update-branch",
        "Entire updates a trail's branch by merging its base in.",
      );
    yield* read(
      "update-branch",
      input,
      { method: "POST", path: `${trailPath(input)}/update-branch` },
      Ignored,
    ).pipe(
      Effect.mapError(
        explained({
          409: "Entire could not update the branch: it or its base moved, or merging the base conflicts and has to be resolved by hand.",
        }),
      ),
    );
    yield* Cache.invalidate(revisions, revisionsKey(input));
  });

  const refreshSentences = {
    409: "The description changed elsewhere. Refresh and try again.",
    412: "The description changed elsewhere. Refresh and try again.",
  };

  // The description lives on the change's project trail, as on entire.com; a change without
  // one keeps its own. Either write is conditional on the version just read.
  const bodyRewrite = Effect.fn("EntirePullRequestProvider.bodyRewrite")(function* (
    input: TrailRef,
    body: string,
  ) {
    const trail = yield* readTrail("updateChangeRequest", input);
    const markdown = Json.ownBody(trail, body);
    const route = Json.projectTrailRoute(trail);
    const projectTrail = route
      ? yield* readProjectTrail("updateChangeRequest", input, route)
      : null;
    const document = projectTrail ? (projectTrail.body.bodyDocument ?? null) : trail.body_document;
    const current = Json.changeBody(trail, document);
    // Entire converts the markdown back to rich text; refuse what the round trip would drop,
    // and what the markdown read from Entire's document had already left out.
    const lost =
      (document ? EntireTrailBody.unrenderedContent(document) : null) ??
      EntireTrailBody.unpreservedMarkdown(Json.ownBody(trail, current)) ??
      EntireTrailBody.unpreservedMarkdown(markdown);
    if (lost !== null)
      return yield* failure(
        "updateChangeRequest",
        `This description has formatting T3 Code can't preserve; edit it on ${ENTIRE_WEB_HOST} (${lost}).`,
      );
    if (route && projectTrail) {
      if (projectTrail.etag === null)
        return yield* failure(
          "updateChangeRequest",
          `Entire sent no version to save the description against; edit it on ${ENTIRE_WEB_HOST}.`,
        );
      return yield* readVersioned(
        "updateChangeRequest",
        input,
        {
          method: "PATCH",
          scope: "collection",
          path: route.path,
          cell: route.cell,
          headers: { "if-match": projectTrail.etag },
          body: { body: markdown },
        },
        Ignored,
      ).pipe(Effect.asVoid, Effect.mapError(explained(refreshSentences)));
    }
    // Entire keeps a change's description only on its project trail.
    return yield* failure(
      "updateChangeRequest",
      `T3 Code couldn't reach this change's project trail to save the description. Try again, or edit it on ${ENTIRE_WEB_HOST}.`,
    );
  });

  const readDiscussions = Effect.fn("EntirePullRequestProvider.readDiscussions")(function* (
    input: TrailRef,
  ) {
    const operation = "getChangeRequestActivity";
    const list = yield* read(
      operation,
      input,
      { path: `${trailPath(input)}/discussions?per_page=${PAGE_SIZE}` },
      Json.EntireDiscussions,
    );
    const items = list.items.filter((item) => isId(item.id)).slice(0, MAX_DISCUSSIONS);
    const discussions = yield* Effect.forEach(
      items,
      (item) =>
        read(
          operation,
          input,
          { path: `${trailPath(input)}/discussions/${item.id}` },
          Json.EntireDiscussion,
        ),
      { concurrency: 4 },
    );
    return {
      discussions,
      truncated: Boolean(list.next_cursor) || list.items.length > items.length,
    };
  });

  // Conflict verdicts live only on the owning project's trail list.
  const listMergeability = Effect.fn("EntirePullRequestProvider.listMergeability")(function* (
    input: ProviderRepositoryRef,
    rowsProject: string | null,
    wanted: ReadonlySet<number>,
  ) {
    const coordinates = yield* api.repository({ ...input, operation: "listChangeRequests" });
    const repoId = coordinates.repoId;
    const projectId = rowsProject ?? coordinates.projectId;
    if (projectId === null || !ULID.test(projectId) || !ULID.test(repoId))
      return new Map<number, PullRequestMergeability>();
    // Entire stores verdicts only for building trails.
    const query = new URLSearchParams({
      projectId,
      repoId,
      status: "open",
      phase: "building",
      pageSize: "100",
    });
    const verdicts = new Map<number, PullRequestMergeability>();
    // Each page has its own time limit; a slow or failed page keeps what earlier ones found.
    for (let pages = 0; pages < PROJECT_LIST_PAGES; pages++) {
      const page = yield* read(
        "listChangeRequests",
        input,
        { path: `/trails?${query}`, scope: "collection" },
        Json.EntireProjectTrails,
      ).pipe(
        Effect.timeout(PROJECT_LIST_TIMEOUT),
        Effect.tapError((cause) =>
          Effect.logDebug("Entire project trail list unavailable for conflict verdicts", cause),
        ),
        Effect.option,
      );
      if (Option.isNone(page)) break;
      for (const [number, verdict] of Json.projectListMergeability(page.value.items, repoId))
        verdicts.set(number, verdict);
      if (!page.value.nextPageToken || [...wanted].every((number) => verdicts.has(number))) break;
      query.set("pageToken", page.value.nextPageToken);
    }
    return verdicts;
  });

  const gateSettings = yield* Cache.makeWith(
    (input: ProviderRepositoryRef) =>
      read("listChangeRequests", input, { path: "/trails/gates" }, Json.EntireGateSettings).pipe(
        Effect.timeout(PROJECT_LIST_TIMEOUT),
      ),
    {
      capacity: 64,
      timeToLive: (exit) => (Exit.isSuccess(exit) ? GATES_TTL : Duration.zero),
    },
  );

  /** Unreadable gates count as an approvals gate. */
  const readinessCounts = (input: ProviderRepositoryRef) =>
    Cache.get(gateSettings, {
      cwd: input.cwd,
      host: input.host,
      repository: input.repository,
    }).pipe(
      Effect.map(Json.approvalsGateOn),
      Effect.tapError((cause) =>
        Effect.logDebug("Entire gate settings unavailable for list drafts", cause),
      ),
      Effect.orElseSucceed(() => true),
    );

  const listChangeRequests: PullRequestProviderApi["listChangeRequests"] = Effect.fn(
    "EntirePullRequestProvider.listChangeRequests",
  )(function* (input) {
    const limit = Math.max(1, input.limit);
    const viewer = input.viewer.toLowerCase();
    const involved = (item: ProviderChangeRequest) =>
      input.involvement === "authored"
        ? item.author?.login.toLowerCase() === viewer
        : input.involvement === "reviewing"
          ? item.reviewRequestLogins.some((login) => login.toLowerCase() === viewer)
          : true;
    const items: Array<ProviderChangeRequest> = [];
    let project: string | null = null;
    let cursor: string | null = null;
    for (let page = 0; page < MAX_PAGES; page++) {
      const query = new URLSearchParams({ per_page: String(PAGE_SIZE) });
      const status = LIST_STATUS[input.state];
      if (status !== null) query.set("status", status);
      if (input.query?.trim()) query.set("q", input.query.trim());
      if (cursor !== null) query.set("cursor", cursor);
      const batch: typeof Json.EntireTrails.Type = yield* read(
        "listChangeRequests",
        input,
        { path: `/trails?${query}` },
        Json.EntireTrails,
      );
      project ??= batch.items.find((trail) => trail.parent?.project_id)?.parent?.project_id ?? null;
      const readiness = batch.items.some(
        (trail) => Json.trailState(trail.status) === "open" && trail.ready_for_review === false,
      )
        ? yield* readinessCounts(input)
        : true;
      items.push(
        ...batch.items
          .map((trail) => Json.toListChangeRequest(trail, input.repository, readiness))
          .filter(involved),
      );
      const previous: string | null = cursor;
      cursor = batch.next_cursor ?? null;
      if (cursor === null || cursor === previous || items.length >= limit) break;
    }
    const rows = items.slice(0, limit);
    const open = new Set(rows.filter((row) => row.state === "open").map((row) => row.number));
    const verdicts =
      open.size === 0
        ? new Map<number, PullRequestMergeability>()
        : yield* listMergeability(input, project, open).pipe(
            Effect.orElseSucceed(() => new Map<number, PullRequestMergeability>()),
          );
    return {
      items: rows.map((row) => {
        const verdict = open.has(row.number) ? verdicts.get(row.number) : undefined;
        return verdict === undefined ? row : { ...row, mergeability: verdict };
      }),
      truncated: cursor !== null || items.length > limit,
      continues: false,
    };
  });

  const provider: PullRequestProviderApi = {
    kind: KIND,
    capabilities: CAPABILITIES,
    getViewer: () =>
      cli.viewer.pipe(
        Effect.mapError(
          (error) =>
            new PullRequestProviderError({
              provider: KIND,
              operation: "getViewer",
              reason: EntireApi.cliFailure(error),
              detail: error.message,
              cause: error,
            }),
        ),
      ),
    listChangeRequests,
    getChangeRequestSummary: (input) =>
      readTrail("getChangeRequestSummary", input).pipe(
        Effect.map((trail) => {
          const checksState = Json.toSummaryChecksState(trail, input.repository);
          return {
            ...Json.toDetailChangeRequest(trail, input.repository),
            closedAt: null,
            mergedAt: trail.merged_at ?? null,
            mergeability: Json.toMergeability(trail),
            ...(checksState === undefined ? {} : { checksState }),
          };
        }),
      ),
    getChangeRequestChecks: (input) =>
      readTrail("getChangeRequestChecks", input).pipe(
        Effect.map((trail) => ({
          state: Json.trailState(trail.status),
          checks: Json.toChecks(trail, input.repository),
        })),
      ),
    getChangeRequest: Effect.fn("EntirePullRequestProvider.getChangeRequest")(function* (input) {
      const trail = yield* readTrail("getChangeRequest", input);
      const checks = Json.toChecks(trail, input.repository);
      const checksState = Json.toChecksState(checks);
      const mergeability = trail.mergeability;
      const open = Json.trailState(trail.status) === "open";
      return {
        ...Json.toDetailChangeRequest(trail, input.repository),
        headSha: Json.headSha(trail),
        body: yield* description(input, trail),
        changedFiles: yield* changedFiles(input, trail),
        closedAt: null,
        mergedAt: trail.merged_at ?? null,
        reviewers: Json.toReviewers(trail),
        checks,
        ...(checksState === undefined ? {} : { checksState }),
        mergeability: Json.toMergeability(trail),
        ...(mergeability?.comparison_status === "available"
          ? {
              baseComparison:
                (mergeability.behind_by ?? 0) > 0 ? ("behind" as const) : ("up-to-date" as const),
              behindBy: mergeability.behind_by ?? 0,
            }
          : { baseComparison: "unknown" as const }),
        mergeCapabilities: {
          merge: open,
          squash: false,
          rebase: false,
        },
        viewerPermissions: Json.toViewerPermissions(trail, input.repository),
      };
    }),
    getChangeRequestActivity: Effect.fn("EntirePullRequestProvider.getChangeRequestActivity")(
      function* (input) {
        const [timeline, conversation] = yield* Effect.all(
          [
            read(
              "getChangeRequestActivity",
              input,
              { path: `${trailPath(input)}/timeline?pageSize=100` },
              Json.EntireTimeline,
            ),
            readDiscussions(input),
          ],
          { concurrency: 2 },
        );
        return Json.toActivity({
          timeline,
          discussions: conversation.discussions,
          discussionsTruncated: conversation.truncated,
        });
      },
    ),
    getViewerPermissions: (input) =>
      readTrail("getViewerPermissions", input).pipe(
        Effect.map((trail) => Json.toViewerPermissions(trail, input.repository)),
      ),
    getDiff: Effect.fn("EntirePullRequestProvider.getDiff")(function* (input) {
      const { from, to } = yield* diffRange(input);
      const result = yield* runGit(
        "getDiff",
        input.cwd,
        ["diff", ...PATCH_OPTIONS, from, to],
        "Could not diff the trail.",
      );
      return { patch: result.stdout, truncated: result.stdoutTruncated, nextCursor: null };
    }),
    getDiffFileContents: Effect.fn("EntirePullRequestProvider.getDiffFileContents")(
      function* (input) {
        const { from, to } = yield* diffRange(input);
        const blob = (revision: string, path: string) =>
          runGit(
            "getDiffFileContents",
            input.cwd,
            ["cat-file", "blob", `${revision}:${path}`],
            `Could not read ${path}.`,
          ).pipe(
            Effect.flatMap((result) =>
              result.stdoutTruncated
                ? Effect.fail(failure("getDiffFileContents", `${path} is too large to show.`))
                : Effect.succeed(result.stdout),
            ),
          );
        const [oldContents, newContents] = yield* Effect.all(
          [
            input.changeType === "new" ? Effect.succeed("") : blob(from, input.oldPath),
            input.changeType === "deleted" ? Effect.succeed("") : blob(to, input.newPath),
          ],
          { concurrency: 2 },
        );
        return { oldContents, newContents };
      },
    ),
    getFileRevisions: Effect.fn("EntirePullRequestProvider.getFileRevisions")(function* (input) {
      // The range the diff was shown at, so a mark matches what the reader saw.
      const { base, head } = yield* trailRevisions(input);
      const result = yield* runGit(
        "getFileRevisions",
        input.cwd,
        ["diff", ...PATCH_OPTIONS, "--full-index", base, head],
        "Could not read the trail's files.",
      );
      if (result.stdoutTruncated)
        return yield* failure("getFileRevisions", "The trail's diff exceeded the output limit.");
      const revisions = new Map(parseDiffFileRevisions(result.stdout));
      for (const path of input.paths) if (!revisions.has(path)) revisions.set(path, "");
      return { revisions, complete: true };
    }),
    runAction: Effect.fn("EntirePullRequestProvider.runAction")(function* (input) {
      if (input.stackNumber !== undefined)
        return yield* failure(input.action, "Entire trails have no stack actions.");
      switch (input.action) {
        case "merge":
          return yield* merge(input);
        case "ready":
          return yield* write("ready", input, "PATCH", "", {
            status: "open",
            ready_for_review: true,
          });
        case "draft":
          return yield* write("draft", input, "PATCH", "", { ready_for_review: false });
        case "update-branch":
          return yield* updateBranch(input);
        case "close":
          return yield* write("close", input, "PATCH", "", { status: "closed" });
        case "reopen":
          return yield* write("reopen", input, "PATCH", "", { status: "open" });
        default:
          return yield* failure(input.action, `Entire cannot ${input.action} from T3 Code.`);
      }
    }),
    updateChangeRequest: Effect.fn("EntirePullRequestProvider.updateChangeRequest")(
      function* (input) {
        // The body first: a conditional write refused there must not leave a renamed trail.
        if (input.body !== undefined) yield* bodyRewrite(input, input.body);
        if (input.title !== undefined)
          yield* write("updateChangeRequest", input, "PATCH", "", { title: input.title });
      },
    ),
    // Entire lets a message's author rewrite it, and answers anyone else that it is not found.
    // Last write wins: the repository-scoped message route takes no If-Match to check a version.
    updateComment: Effect.fn("EntirePullRequestProvider.updateComment")(function* (input) {
      const ref = Json.messageRef(input.commentId);
      if (ref === null)
        return yield* failure(
          "updateComment",
          `Entire edits a discussion's messages only; a finding's text is edited on ${ENTIRE_WEB_HOST}.`,
        );
      yield* read(
        "updateComment",
        input,
        {
          method: "PATCH",
          path: `${trailPath(input)}/discussions/${ref.discussion}/messages/${ref.message}`,
          body: { body: input.body },
        },
        Ignored,
      ).pipe(
        Effect.mapError(
          explained({
            404: "Entire lets you edit only your own messages, and not replies to them.",
          }),
        ),
      );
    }),
    comment: (input) => write("comment", input, "POST", "/discussions", { body: input.body }),
    submitReview: Effect.fn("EntirePullRequestProvider.submitReview")(function* (input) {
      if (input.verdict === "request-changes")
        return yield* failure(
          "submitReview",
          `Entire reviews from T3 Code comment or approve; request changes on ${ENTIRE_WEB_HOST}.`,
        );
      const body = input.body.trim();
      if (input.comments.length > 0) yield* publishReview(input);
      // Entire keeps a review's summary out of the trail's activity, so the body also goes on the
      // approval, or else the conversation.
      if (input.verdict === "approve")
        return yield* write("submitReview", input, "POST", "/approvals", {
          event: "approve",
          ...(body.length > 0 ? { body } : {}),
        });
      if (body.length > 0) yield* write("submitReview", input, "POST", "/discussions", { body });
    }),
    listReviewerCandidates: () =>
      Effect.fail(failure("listReviewerCandidates", "Entire reviewer requests are not supported.")),
    setReviewerRequest: () =>
      Effect.fail(failure("setReviewerRequest", "Entire reviewer requests are not supported.")),
    replyToThread: Effect.fn("EntirePullRequestProvider.replyToThread")(function* (input) {
      if (!isId(input.threadId))
        return yield* failure("replyToThread", "Entire discussion ids are opaque slugs.");
      yield* write("replyToThread", input, "POST", `/discussions/${input.threadId}/messages`, {
        body: input.body,
      });
    }),
    setReaction: () => Effect.fail(failure("setReaction", "Entire trails have no reactions.")),
    setThreadResolution: Effect.fn("EntirePullRequestProvider.setThreadResolution")(
      function* (input) {
        if (!isId(input.threadId))
          return yield* failure("setThreadResolution", "Entire discussion ids are opaque slugs.");
        yield* write("setThreadResolution", input, "PATCH", `/discussions/${input.threadId}`, {
          resolved: input.resolved,
        });
      },
    ),
  };
  return provider;
});
