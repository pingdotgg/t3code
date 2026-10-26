import { SourceControlProviderKind } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { randomUuidV4 } from "@t3tools/provider-core/server/randomUuid";
import {
  NonNegativeInt,
  resolvePullRequestAuthorFilter,
  TrimmedNonEmptyString,
  type PullRequestCapabilities,
  type PullRequestListFilters,
  type PullRequestStackHead,
} from "@t3tools/contracts";
import {
  PullRequestProviderError,
  type ProviderRepositoryRef,
  type PullRequestProviderApi,
} from "@t3tools/source-control-core/server/PullRequestProvider";

import * as GitCafeApi from "./GitCafeApi.ts";
import * as GitCafeHosts from "./gitCafeHosts.ts";
import * as Json from "./gitCafePullRequestJson.ts";
import { definition } from "../shared/definition.ts";

const CAPABILITIES: PullRequestCapabilities = {
  diff: true,
  comment: true,
  actions: [...definition.changeRequestActions],
  mergeMethods: ["merge", "squash", "rebase"],
  // Branch updates restack every layer above the target.
  updateMethods: ["rebase"],
  search: true,
  stacks: true,
  stackActions: true,
  reactions: true,
  labels: true,
  // Line comments go through GitCafe's review drafts, which arrive with revision fencing.
  review: {
    inlineComment: false,
    reply: true,
    resolve: true,
    verdicts: ["approve", "request-changes", "comment"],
  },
  reviewers: { request: true, listCandidates: true },
  edit: { changeRequest: true, comment: true },
};

const PAGE_SIZE = 100;
const MAX_PAGES = 10;
/**
 * Pages read looking for a GitHub-synced author before a listing filtered by them gives up. The
 * login only appears on their pull requests, so one older than this many is out of reach.
 */
const AUTHOR_DISCOVERY_PAGES = 5;
/** Bounds the logins remembered from listings; a repository's authors fit many times over. */
const KNOWN_AUTHORS_LIMIT = 10_000;
/** GitCafe's cap on paths per `/diff-files` read, and so one diff page. */
const DIFF_FILES_BATCH = 64;
/** Changed-path pages carry no hunks, so they can be read in larger pages. */
const CHANGES_PAGE_LIMIT = 500;
/** Line totals require hunk reads; omit them for large PRs. */
const LINE_STATS_MAX_FILES = DIFF_FILES_BATCH * 4;
const MAX_CHANGE_PAGES = 20;
const LINE_STATS_CACHE_SIZE = 256;

const chunk = <A>(items: ReadonlyArray<A>, size: number): Array<ReadonlyArray<A>> =>
  Array.from({ length: Math.ceil(items.length / size) }, (_, index) =>
    items.slice(index * size, (index + 1) * size),
  );

const detailablePaths = (files: ReadonlyArray<Json.GitCafeDiffFile>) =>
  files.filter((file) => !file.binary && !file.tooLarge).map((file) => file.path);

const mergeStrategyOpen = (status: typeof Status.Type, strategy: string) =>
  status.merge.permitted !== false &&
  status.merge.strategies.includes(strategy) &&
  !(status.merge.blockers ?? []).some((blocker) =>
    (blocker.blockedStrategies ?? []).includes(strategy),
  );

const Id = TrimmedNonEmptyString.check(Schema.isPattern(/^[A-Za-z0-9_-]+$/u));
const isId = Schema.is(Id);
const isApiError = Schema.is(GitCafeApi.GitCafeApiError);
const Principal = Schema.Struct({ actorId: TrimmedNonEmptyString, handle: TrimmedNonEmptyString });
const User = Schema.Struct({ actorId: TrimmedNonEmptyString });
const Written = Schema.Struct({ id: Id });
const Versioned = Schema.Struct({ version: NonNegativeInt });
const CommentDetail = Schema.Struct({ id: Id, version: NonNegativeInt });
const Status = Schema.Struct({
  merge: Schema.Struct({
    // The API reference lists "unknown" and "conflicting", but git.cafe also sends "none" and
    // "pending", so any state is read and only the known ones are mapped.
    conflicts: Schema.String,
    fastForward: Schema.NullOr(Schema.Boolean),
    strategies: Schema.Array(Schema.String),
    permitted: Schema.optional(Schema.Boolean),
    reasons: Schema.optional(Schema.Array(Schema.String)),
    blockers: Schema.optional(
      Schema.Array(
        Schema.Struct({ blockedStrategies: Schema.optional(Schema.Array(Schema.String)) }),
      ),
    ),
  }),
  checks: Schema.Struct({
    pending: NonNegativeInt,
    failing: NonNegativeInt,
    total: NonNegativeInt,
  }),
});
/** A merge GitCafe accepted runs on afterwards: on GitHub for a synced pull request, or natively. */
const MERGE_IN_FLIGHT = new Set(["provider-merge-pending", "native-operation-pending"]);
const Listed = Schema.Struct({
  items: Schema.Array(Schema.Struct({ id: TrimmedNonEmptyString })),
  next: Schema.NullOr(Schema.String),
});
const encodeIds = Schema.encodeSync(Schema.fromJsonString(Schema.Array(Schema.String)));
const BranchCommit = Schema.Struct({ oid: TrimmedNonEmptyString });
const CommitOid = Schema.String.check(Schema.isPattern(/^[0-9a-f]{40}$/u));
const isCommitOid = Schema.is(CommitOid);
const SourceSnapshot = Schema.Struct({
  version: NonNegativeInt,
  headOid: CommitOid,
  comparisonBaseOid: CommitOid,
});
const SourceBlob = Schema.Struct({
  commit: CommitOid,
  path: Schema.String,
  size: NonNegativeInt,
  binary: Schema.Boolean,
  content: Schema.NullOr(Schema.String),
});
const MAX_DIFF_FILE_BYTES = 1024 * 1024;

class GitCafeDiffSourceUnavailableError extends Schema.TaggedError<GitCafeDiffSourceUnavailableError>()(
  "GitCafeDiffSourceUnavailableError",
  {
    path: Schema.String,
    reason: Schema.Literals(["oversized", "binary", "unavailable"]),
    cause: Schema.optional(Schema.Defect()),
  },
) {}
const Snapshot = {
  version: NonNegativeInt,
  headOid: TrimmedNonEmptyString,
  comparisonBaseOid: TrimmedNonEmptyString,
};
const Changes = Schema.Struct({
  ...Snapshot,
  items: Json.GitCafeDiffFiles,
  next: Schema.NullOr(TrimmedNonEmptyString),
});
const DiffFiles = Schema.Struct({ ...Snapshot, items: Json.GitCafeDiffFiles });
const DiffCursor = Schema.Struct({
  version: NonNegativeInt,
  headOid: TrimmedNonEmptyString,
  baseOid: TrimmedNonEmptyString,
  after: TrimmedNonEmptyString,
});
const encodeDiffCursor = Schema.encodeSync(Schema.fromJsonString(DiffCursor));
const decodeDiffCursor = Schema.decodeEffect(Schema.fromJsonString(DiffCursor));
const MergeOutcome = Schema.Struct({
  id: Schema.String,
  state: Schema.Literals(["accepted", "completed", "failed"]),
  reason: Schema.optional(Schema.String),
});
const StackOutcome = Schema.Struct({ id: Schema.String, state: Schema.String });
const FAILED_STACK_STATES = new Set(["failed", "stopped", "cancelled", "reconciliation_required"]);

type PullRef = ProviderRepositoryRef & { readonly number: number };

/** GitHub's merge counts as soon as GitCafe records it, ahead of the sync that reports it. */
const settledMerge = (pull: Json.GitCafePullDetail) =>
  pull.state === "open" && pull.providerMerge != null
    ? { state: "merged" as const, mergedAt: pull.providerMerge.mergedAt }
    : {};
type Paged<A> = { readonly items: ReadonlyArray<A>; readonly next: string | null };

function stackHeadsCurrent(
  stack: Json.GitCafeStack,
  input: { readonly number: number; readonly merge: boolean },
  expected: ReadonlyArray<PullRequestStackHead>,
): boolean {
  const members = stack.members.toSorted((a, b) => a.position - b.position);
  const index = members.findIndex((member) => member.pullRequestNumber === input.number);
  if (index === -1) return false;
  const moved = (input.merge ? members.slice(0, index + 1) : members).filter(
    (member) => member.state !== "merged",
  );
  return (
    moved.length === expected.length &&
    moved.every(
      (member) =>
        member.headOid !== undefined &&
        expected.some(
          (head) => head.number === member.pullRequestNumber && head.headSha === member.headOid,
        ),
    )
  );
}

const POSITION = /^(.+)~(\d+)$/u;
const parsePosition = (raw: string | undefined) => {
  const match = raw === undefined ? null : POSITION.exec(raw);
  const created = match === null ? Number.NaN : Date.parse(match[1]!);
  return match === null || Number.isNaN(created) ? null : { created, number: Number(match[2]) };
};

const withDetails = (
  files: ReadonlyArray<Json.GitCafeDiffFile>,
  details: ReadonlyArray<Json.GitCafeDiffFile>,
) => {
  const byPath = new Map(details.map((file) => [file.path, file]));
  return files.map((file) => byPath.get(file.path) ?? file);
};

/** @public */
export const make = Effect.gen(function* () {
  const api = yield* GitCafeApi.GitCafeApi;
  // GitCafe filters by actor id and has no lookup from a GitHub login to the actor sync made for
  // it, so the pairs are learned from the pull requests every listing reads.
  const knownAuthors = new Map<string, string>();
  const authorKey = (host: string, login: string) =>
    `${host.toLowerCase()}\n${login.toLowerCase()}`;
  const learnAuthors = (host: string, pulls: ReadonlyArray<Json.GitCafePull>) => {
    for (const { author } of pulls) {
      if (author.kind !== "github") continue;
      if (knownAuthors.size >= KNOWN_AUTHORS_LIMIT) knownAuthors.clear();
      knownAuthors.set(authorKey(host, author.login), author.actorId);
    }
  };

  const failure = (operation: string, detail: string, cause?: unknown) =>
    new PullRequestProviderError({
      provider: SourceControlProviderKind.make("gitcafe"),
      operation,
      reason: "failed",
      detail,
      ...(cause === undefined ? {} : { cause }),
    });

  const repositoryPath = (
    operation: string,
    input: ProviderRepositoryRef,
  ): Effect.Effect<string, PullRequestProviderError> =>
    GitCafeHosts.isGitCafeHost(input.host) &&
    GitCafeHosts.gitCafeRepositoryPath(input.repository) === input.repository
      ? Effect.succeed(`/repos/${input.repository}`)
      : Effect.fail(
          failure(
            operation,
            `GitCafe serves owner/name repositories on ${GitCafeHosts.GITCAFE_HOSTS.join(" and ")}.`,
          ),
        );

  const send = (
    operation: string,
    input: Pick<ProviderRepositoryRef, "host">,
    request: Omit<GitCafeApi.GitCafeApiRequest, "operation" | "host">,
  ) =>
    api.request({ ...request, host: input.host, operation }).pipe(
      Effect.mapError(
        (error) =>
          new PullRequestProviderError({
            provider: SourceControlProviderKind.make("gitcafe"),
            operation,
            reason: error.reason,
            detail: error.detail,
            cause: error,
          }),
      ),
    );

  const read = <S extends Schema.Codec<unknown, unknown, never, never>>(
    operation: string,
    input: Pick<ProviderRepositoryRef, "host">,
    request: Omit<GitCafeApi.GitCafeApiRequest, "operation" | "host">,
    schema: S,
  ) =>
    send(operation, input, request).pipe(
      Effect.flatMap((raw) =>
        Schema.decodeEffect(Schema.fromJsonString(schema))(raw).pipe(
          Effect.mapError((cause) =>
            failure(operation, "GitCafe returned an unreadable response.", cause),
          ),
        ),
      ),
    );

  const pullPath = (operation: string, input: PullRef) =>
    repositoryPath(operation, input).pipe(Effect.map((base) => `${base}/pulls/${input.number}`));

  const readPull = (operation: string, input: PullRef) =>
    pullPath(operation, input).pipe(
      Effect.flatMap((path) => read(operation, input, { path }, Json.GitCafePullDetail)),
    );

  const readDiffSource = Effect.fn("GitCafePullRequestProvider.readDiffSource")(function* (
    input: ProviderRepositoryRef,
    revision: string,
    filePath: string,
  ) {
    const operation = "getDiffFileContents";
    const base = yield* repositoryPath(operation, input);
    const query = new URLSearchParams({ oid: revision, path: filePath });
    const blob = yield* read(operation, input, { path: `${base}/blob?${query}` }, SourceBlob).pipe(
      Effect.catchIf(
        (error) =>
          isApiError(error.cause) && (error.cause.status === 413 || error.cause.status === 501),
        (error) =>
          Effect.fail(
            failure(
              operation,
              "GitCafe cannot provide this source file as bounded text.",
              new GitCafeDiffSourceUnavailableError({
                path: filePath,
                reason:
                  isApiError(error.cause) && error.cause.status === 413
                    ? "oversized"
                    : "unavailable",
                cause: error,
              }),
            ),
          ),
      ),
    );
    if (blob.commit !== revision || blob.path !== filePath)
      return yield* failure(
        operation,
        "GitCafe answered with a different source revision or path.",
      );
    const reason =
      blob.size > MAX_DIFF_FILE_BYTES ||
      (blob.content !== null && Buffer.byteLength(blob.content, "utf8") > MAX_DIFF_FILE_BYTES)
        ? "oversized"
        : blob.binary || blob.content?.includes("\0")
          ? "binary"
          : blob.content === null
            ? "unavailable"
            : null;
    if (reason !== null)
      return yield* failure(
        operation,
        "GitCafe cannot provide this source file as bounded text.",
        new GitCafeDiffSourceUnavailableError({ path: filePath, reason }),
      );
    return blob.content!;
  });

  const readPages = Effect.fn("GitCafePullRequestProvider.readPages")(function* <
    S extends Schema.Codec<Paged<unknown>, unknown, never, never>,
  >(operation: string, input: Pick<ProviderRepositoryRef, "host">, path: string, schema: S) {
    const items: Array<S["Type"]["items"][number]> = [];
    let next: string | null = null;
    for (let page = 0; page < MAX_PAGES; page++) {
      const query = new URLSearchParams({ limit: String(PAGE_SIZE) });
      if (next !== null) query.set("after", next);
      const batch: S["Type"] = yield* read(operation, input, { path: `${path}?${query}` }, schema);
      items.push(...batch.items);
      const previous: string | null = next;
      next = batch.next;
      if (next === null || next === previous || batch.items.length === 0) break;
    }
    return { items, next };
  });

  /**
   * GitCafe filters by ids, so label names and the author's handle are looked up first. A label it
   * cannot resolve is left out, and the service narrows the rows by name instead. An author it
   * cannot resolve comes back as `unresolvedAuthor` for the listing to find.
   */
  const listFilterParams = Effect.fn("GitCafePullRequestProvider.listFilterParams")(function* (
    input: ProviderRepositoryRef & {
      readonly filters?: PullRequestListFilters | undefined;
      readonly authorNarrowed: boolean;
      readonly viewer: string;
    },
    base: string,
  ) {
    const filters = input.filters;
    const params: Array<readonly [string, string]> = [];
    if (filters === undefined) return { params, unresolvedAuthor: null };
    if (filters.draft !== undefined)
      params.push([filters.draft === "only" ? "states" : "stateNots", encodeIds(["draft"])]);
    const groups = filters.labels ?? [];
    const excluded = filters.excludedLabels ?? [];
    if (groups.length > 0 || excluded.length > 0) {
      const labels = yield* readPages(
        "listChangeRequests",
        input,
        `${base}/labels`,
        Json.GitCafeLabels,
      );
      const ids = new Map(labels.items.map((label) => [label.name.toLowerCase(), label.id]));
      const idsOf = (names: ReadonlyArray<string>) =>
        names.flatMap((name) => {
          const id = ids.get(name.trim().toLowerCase());
          return id === undefined ? [] : [id];
        });
      // Several ids in `labels` match a pull request holding any one of them, which is exactly
      // one group; the remaining groups are the service's to narrow.
      const group = groups.find((names) => idsOf(names).length === names.length);
      if (group !== undefined) params.push(["labels", encodeIds(idsOf(group))]);
      const excludedIds = idsOf(excluded);
      if (excludedIds.length > 0) params.push(["labelNots", encodeIds(excludedIds)]);
    }
    if (filters.author !== undefined && !input.authorNarrowed) {
      const handle = resolvePullRequestAuthorFilter(filters.author, input.viewer);
      // A profile matches what GitHub sync authored for it too. A GitHub-synced author with no
      // profile is known only by the actor on their pull requests.
      const user = yield* read(
        "listChangeRequests",
        input,
        { path: `/users/${encodeURIComponent(handle)}` },
        User,
      ).pipe(
        Effect.asSome,
        Effect.catchTags({
          PullRequestProviderError: (error) =>
            error.reason === "unauthenticated" || error.reason === "rate-limited"
              ? Effect.fail(error)
              : Effect.succeedNone,
        }),
      );
      const actorId = Option.isSome(user)
        ? user.value.actorId
        : knownAuthors.get(authorKey(input.host, handle));
      if (actorId === undefined) return { params, unresolvedAuthor: handle };
      params.push(["authors", encodeIds([actorId])]);
    }
    return { params, unresolvedAuthor: null };
  });

  const readComments = (operation: string, input: PullRef) =>
    pullPath(operation, input).pipe(
      Effect.flatMap((path) =>
        readPages(operation, input, `${path}/comments`, Json.GitCafeComments),
      ),
    );

  const isForbidden = (error: PullRequestProviderError) =>
    isApiError(error.cause) && error.cause.status === 403;

  /**
   * GitCafe offers no way to read a token's scopes, so reviewer controls show
   * for anyone who may edit the pull request; a token without the reviewer
   * scopes learns which ones it lacks when it uses them.
   */
  const explainReviewerScopes =
    (operation: string) =>
    <A, R>(effect: Effect.Effect<A, PullRequestProviderError, R>) =>
      effect.pipe(
        Effect.catchIf(isForbidden, (error) =>
          Effect.fail(
            failure(
              operation,
              "This GitCafe token cannot request reviewers. It needs the pr:review:read and pr:reviewers:write scopes.",
              error,
            ),
          ),
        ),
      );

  /**
   * GitCafe replaces a pull request's whole reviewer or label list, so one toggle reads the
   * list, changes it, and writes it back fenced on the pull request's version. The version is
   * read first: a change landing between the two reads then fails the fence instead of being
   * overwritten.
   */
  const toggleListed = Effect.fn("GitCafePullRequestProvider.toggleListed")(function* (
    operation: string,
    input: PullRef,
    list: { readonly name: "reviewers" | "labels"; readonly key: "actorIds" | "labelIds" },
    ids: ReadonlyArray<string>,
    on: boolean,
  ) {
    const path = yield* pullPath(operation, input);
    const pull = yield* readPull(operation, input);
    const listed = yield* readPages(operation, input, `${path}/${list.name}`, Listed);
    const current = listed.items.map((item) => item.id);
    const next = on
      ? [...new Set([...current, ...ids])]
      : current.filter((id) => !ids.includes(id));
    if (next.length === current.length) return;
    yield* read(
      operation,
      input,
      {
        method: "PUT",
        path: `${path}/${list.name}`,
        body: { expectedVersion: pull.version, [list.key]: next },
      },
      Versioned,
    );
  });

  /**
   * GitCafe's stack lists no heads, and they are what a land or restack is fenced on, so each
   * open layer's pull is read.
   */
  const readStack = Effect.fn("GitCafePullRequestProvider.readStack")(function* (
    operation: string,
    input: PullRef,
  ) {
    const path = yield* pullPath(operation, input);
    const { stack } = yield* read(
      operation,
      input,
      { path: `${path}/stack` },
      Json.GitCafeStackEnvelope,
    );
    if (stack === null) return null;
    const members = yield* Effect.forEach(
      stack.members,
      (member) =>
        member.state === "merged"
          ? Effect.succeed(member)
          : readPull(operation, { ...input, number: member.pullRequestNumber }).pipe(
              Effect.map((pull) =>
                pull.headOid == null ? member : { ...member, headOid: pull.headOid },
              ),
            ),
      { concurrency: 4 },
    );
    return { ...stack, members };
  });

  const readDiffPage = Effect.fn("GitCafePullRequestProvider.readDiffPage")(function* (
    operation: string,
    input: Parameters<PullRequestProviderApi["getDiff"]>[0],
    limit: number,
  ) {
    if (input.commit !== undefined)
      return yield* failure(operation, "GitCafe commit diffs are not supported yet.");
    const cursor =
      input.cursor === undefined
        ? null
        : yield* decodeDiffCursor(input.cursor).pipe(
            Effect.mapError((cause) => failure(operation, "Invalid GitCafe diff cursor.", cause)),
          );
    // A pull without a head yet has nothing to pin; its version still is.
    const expected = cursor ?? (yield* readPull(operation, input));
    const version = expected.version;
    const path = yield* pullPath(operation, input);
    const query = new URLSearchParams({ expectedVersion: String(version), limit: String(limit) });
    if (cursor !== null) query.set("after", cursor.after);
    const page = yield* read(operation, input, { path: `${path}/changes?${query}` }, Changes);
    if (
      page.version !== version ||
      (expected.headOid !== null && page.headOid !== expected.headOid) ||
      (cursor !== null && cursor.baseOid !== page.comparisonBaseOid)
    )
      return yield* failure(
        operation,
        "GitCafe answered from a different revision of the pull request. Refresh the diff.",
      );
    if (cursor !== null && page.next !== null && page.next === cursor.after)
      return yield* failure(operation, "GitCafe returned a repeated diff page cursor.");
    const revision = { version, headOid: page.headOid, baseOid: page.comparisonBaseOid };
    return {
      items: page.items,
      revision,
      nextCursor: page.next === null ? null : encodeDiffCursor({ ...revision, after: page.next }),
    };
  });

  const readDiffFiles = Effect.fn("GitCafePullRequestProvider.readDiffFiles")(function* (
    input: PullRef,
    revision: { readonly version: number; readonly headOid: string; readonly baseOid: string },
    paths: ReadonlyArray<string>,
  ) {
    if (paths.length === 0) return [];
    const path = yield* pullPath("getDiff", input);
    const files = yield* read(
      "getDiff",
      input,
      {
        method: "POST",
        path: `${path}/diff-files`,
        body: { paths, expectedVersion: revision.version },
      },
      DiffFiles,
    );
    if (
      files.version !== revision.version ||
      files.headOid !== revision.headOid ||
      files.comparisonBaseOid !== revision.baseOid
    )
      return yield* failure(
        "getDiff",
        "GitCafe answered from a different revision of the pull request. Refresh the diff.",
      );
    return files.items;
  });

  const runStackAction = Effect.fn("GitCafePullRequestProvider.runStackAction")(function* (
    input: Parameters<PullRequestProviderApi["runAction"]>[0] & { readonly stackNumber: number },
  ) {
    const land = input.action === "merge";
    const operation = land ? "landStackThrough" : "restackStack";
    if (!land && input.action !== "update-branch")
      return yield* failure(operation, `GitCafe cannot ${input.action} a stack.`);
    const stack = yield* readStack(operation, input);
    if (
      stack === null ||
      stack.number !== input.stackNumber ||
      input.expectedStackHeads === undefined ||
      !stackHeadsCurrent(stack, { number: input.number, merge: land }, input.expectedStackHeads)
    )
      return yield* failure(
        operation,
        "The stack changed since it was read. Refresh it and try again.",
      );
    const base = yield* repositoryPath(operation, input);
    const outcome = yield* read(
      operation,
      input,
      {
        method: "POST",
        path: `${base}/pulls/stacks/${stack.number}/${land ? "land-through" : "restack"}`,
        body: land
          ? {
              expectedRevision: stack.revision,
              requestId: yield* randomUuidV4,
              throughPullRequestNumber: input.number,
              strategy: input.mergeMethod ?? "merge",
            }
          : { expectedRevision: stack.revision, requestId: yield* randomUuidV4 },
      },
      StackOutcome,
    );
    if (FAILED_STACK_STATES.has(outcome.state))
      return yield* failure(operation, `GitCafe's stack operation ${outcome.state}.`);
  });

  // GitCafe's pulls carry no line totals, and linked pull requests are summarized every minute,
  // so hunk totals are held per compared pair of commits. The file list that names the pair is
  // cheap; a retarget or a landed parent layer moves the base without moving the head.
  const lineTotals = new Map<string, { readonly additions: number; readonly deletions: number }>();

  const readLineStats = Effect.fn("GitCafePullRequestProvider.readLineStats")(function* (
    input: PullRef,
    version: number,
  ) {
    const path = yield* pullPath("getChangeRequest", input);
    const files: Array<Json.GitCafeDiffFile> = [];
    let revision: { version: number; headOid: string; baseOid: string } | undefined;
    let after: string | null = null;
    for (let page = 0; page < MAX_CHANGE_PAGES; page++) {
      const query = new URLSearchParams({
        expectedVersion: String(version),
        limit: String(CHANGES_PAGE_LIMIT),
      });
      if (after !== null) query.set("after", after);
      const batch: typeof Changes.Type = yield* read(
        "getChangeRequest",
        input,
        { path: `${path}/changes?${query}` },
        Changes,
      );
      revision ??= {
        version: batch.version,
        headOid: batch.headOid,
        baseOid: batch.comparisonBaseOid,
      };
      files.push(...batch.items);
      const previous: string | null = after;
      after = batch.next;
      if (after === null || after === previous || batch.items.length === 0) break;
    }
    if (revision === undefined) return { changedFiles: 0, additions: 0, deletions: 0 };
    const key = `${input.host} ${input.repository.toLowerCase()} ${input.number} ${revision.baseOid} ${revision.headOid}`;
    const held = lineTotals.get(key);
    if (held !== undefined) return { changedFiles: files.length, ...held };
    const details = files.some((file) => file.additions !== undefined)
      ? Option.some(files)
      : files.length > LINE_STATS_MAX_FILES
        ? Option.none()
        : yield* Effect.forEach(
            chunk(detailablePaths(files), DIFF_FILES_BATCH),
            (paths) => readDiffFiles(input, revision, paths),
            { concurrency: 4 },
          ).pipe(
            Effect.map((batches) => batches.flat()),
            Effect.option,
          );
    // Unread hunks leave the lines unknown rather than zero; the file count still stands.
    if (Option.isNone(details)) return { changedFiles: files.length };
    const counted = details.value;
    const totals = {
      additions: counted.reduce((total, file) => total + (file.additions ?? 0), 0),
      deletions: counted.reduce((total, file) => total + (file.deletions ?? 0), 0),
    };
    if (lineTotals.size >= LINE_STATS_CACHE_SIZE)
      lineTotals.delete(lineTotals.keys().next().value!);
    lineTotals.set(key, totals);
    return { changedFiles: files.length, ...totals };
  });

  const merge = Effect.fn("GitCafePullRequestProvider.merge")(function* (
    input: Parameters<PullRequestProviderApi["runAction"]>[0],
  ) {
    const pull = yield* readPull("merge", input);
    if (pull.state === "merged") return;
    if (pull.mergeRoute === "unsupported")
      return yield* failure("merge", "This GitCafe pull request has no supported merge route.");
    const base = yield* repositoryPath("merge", input);
    // Native merges fence on the current target commit; provider-routed merges supply the base.
    const baseOid =
      pull.mergeRoute === "provider"
        ? pull.observedBaseOid
        : (yield* read(
            "merge",
            input,
            {
              path: `${base}/commit?ref=${encodeURIComponent(`refs/heads/${pull.targetBranch}`)}`,
            },
            BranchCommit,
          )).oid;
    if (pull.headOid === null || baseOid == null)
      return yield* failure(
        "merge",
        "GitCafe has not reported the pull request's head and base yet. Refresh and try again.",
      );
    const path = yield* pullPath("merge", input);
    const outcome = yield* read(
      "merge",
      input,
      {
        method: "POST",
        path: `${path}/merge`,
        body: {
          requestId: yield* randomUuidV4,
          expectedVersion: pull.version,
          headOid: pull.headOid,
          baseOid,
          strategy: input.mergeMethod ?? "merge",
        },
      },
      MergeOutcome,
    );
    if (outcome.state === "failed")
      return yield* failure("merge", outcome.reason ?? "GitCafe could not merge the pull request.");
  });

  const provider: PullRequestProviderApi = {
    kind: SourceControlProviderKind.make("gitcafe"),
    capabilities: CAPABILITIES,
    getViewer: (input) =>
      read(
        "getViewer",
        { host: input.host ?? "git.cafe" },
        { path: "/auth/principal" },
        Principal,
      ).pipe(Effect.map((principal) => principal.handle)),
    listChangeRequests: Effect.fn("GitCafePullRequestProvider.listChangeRequests")(
      function* (input) {
        const base = yield* repositoryPath("listChangeRequests", input);
        const involved = input.involvement === "authored" || input.involvement === "reviewing";
        let actorId: string | undefined;
        if (involved) {
          // The viewer is the token's principal, whose actor also matches the pull requests GitHub
          // sync authored for its linked profile. When it can't be read, the listing comes back
          // unnarrowed and the page's own involvement filter does the rest. A refused token or a
          // rate limit still fails, since the service acts on those for the whole host.
          const principal = yield* read(
            "listChangeRequests",
            input,
            { path: "/auth/principal" },
            Principal,
          ).pipe(
            Effect.asSome,
            Effect.catchTags({
              PullRequestProviderError: (error) =>
                error.reason === "unauthenticated" || error.reason === "rate-limited"
                  ? Effect.fail(error)
                  : Effect.succeedNone,
            }),
          );
          if (Option.isSome(principal)) {
            if (principal.value.handle.toLowerCase() !== input.viewer.toLowerCase())
              return { items: [], truncated: false, continues: false };
            actorId = principal.value.actorId;
          }
        }
        const { params: filterParams, unresolvedAuthor } = yield* listFilterParams(
          { ...input, authorNarrowed: actorId !== undefined && input.involvement === "authored" },
          base,
        );
        const readPage = (rows: number, after: string | null) => {
          const query = new URLSearchParams({ limit: String(rows), sort: "newest" });
          if (input.state !== "all") query.set("state", input.state);
          if (input.query?.trim()) query.set("q", input.query.trim());
          for (const [key, value] of filterParams) query.set(key, value);
          if (actorId !== undefined)
            query.set(
              input.involvement === "reviewing" ? "reviewers" : "authors",
              encodeIds([actorId]),
            );
          if (after !== null) query.set("after", after);
          return read(
            "listChangeRequests",
            input,
            { path: `${base}/pulls?${query}` },
            Json.GitCafePulls,
          ).pipe(Effect.tap((page) => Effect.sync(() => learnAuthors(input.host, page.items))));
        };
        if (unresolvedAuthor !== null) {
          // Rows are only ever handed out narrowed by actor, so a continuation always carries on
          // the same narrowed listing.
          const key = authorKey(input.host, unresolvedAuthor);
          let after: string | null = null;
          let pages = 0;
          do {
            const page: typeof Json.GitCafePulls.Type = yield* readPage(PAGE_SIZE, after);
            pages += 1;
            after = page.items.length === 0 ? null : page.next;
          } while (!knownAuthors.has(key) && after !== null && pages < AUTHOR_DISCOVERY_PAGES);
          const found = knownAuthors.get(key);
          if (found === undefined)
            return { items: [], truncated: after !== null, continues: false };
          filterParams.push(["authors", encodeIds([found])]);
        }
        const limit = Math.max(1, input.limit);
        const items: Array<Json.GitCafePull> = [];
        // GitCafe pages by an opaque token and orders by creation, so a continuation reads from the
        // top and keeps only the rows created after the last one delivered. A count of rows would
        // skip one for every row above it that closed in between.
        const resume = parsePosition(input.cursor?.resumeAfter);
        const isNew = (pull: Json.GitCafePull) => {
          if (resume === null) return true;
          const created = Date.parse(pull.createdAt);
          return (
            created < resume.created || (created === resume.created && pull.number < resume.number)
          );
        };
        let next: string | null = null;
        do {
          const page: typeof Json.GitCafePulls.Type = yield* readPage(
            resume === null ? Math.min(PAGE_SIZE, limit - items.length) : PAGE_SIZE,
            next,
          );
          items.push(...page.items.filter(isNew));
          next = page.items.length === 0 ? null : page.next;
        } while (next !== null && items.length < limit);
        const delivered = items.slice(0, limit);
        const last = delivered.at(-1);
        return {
          ...(last === undefined ? {} : { resumeAfter: `${last.createdAt}~${last.number}` }),
          items: delivered.map((pull) => {
            const item = Json.toChangeRequest(pull, input);
            return input.involvement === "reviewing" && actorId !== undefined
              ? {
                  ...item,
                  reviewRequestLogins: [...new Set([...item.reviewRequestLogins, input.viewer])],
                }
              : item;
          }),
          truncated: next !== null || items.length > limit,
          continues: true,
        };
      },
    ),
    getChangeRequestPreview: (input) =>
      readPull("getChangeRequestPreview", input).pipe(
        Effect.map((pull) => Json.toChangeRequest(pull, input)),
      ),
    getChangeRequestSummary: Effect.fn("GitCafePullRequestProvider.getChangeRequestSummary")(
      function* (input) {
        const pull = yield* readPull("getChangeRequestSummary", input);
        const changes =
          pull.headOid === null
            ? null
            : yield* readLineStats(input, pull.version).pipe(Effect.orElseSucceed(() => null));
        // A count that could not be read is absent rather than zero.
        const {
          additions: _additions,
          deletions: _deletions,
          ...summary
        } = Json.toChangeRequest(pull, input);
        return {
          ...summary,
          ...(changes === null ? {} : changes),
          closedAt: pull.closedAt,
          mergedAt: pull.mergedAt,
          ...settledMerge(pull),
        };
      },
    ),
    getChangeRequest: Effect.fn("GitCafePullRequestProvider.getChangeRequest")(function* (input) {
      const pull = yield* readPull("getChangeRequest", input);
      const path = yield* pullPath("getChangeRequest", input);
      const base = yield* repositoryPath("getChangeRequest", input);
      // A single pull request read carries neither its reviewers nor its labels.
      const [status, checks, changes, reviewers, labels] = yield* Effect.all(
        [
          read("getChangeRequest", input, { path: `${path}/status` }, Status),
          pull.headOid === null
            ? Effect.succeed(null)
            : readPages(
                "getChangeRequest",
                input,
                `${base}/commits/${encodeURIComponent(pull.headOid)}/checks`,
                Json.GitCafeChecks,
              ),
          pull.headOid === null
            ? Effect.succeed(null)
            : readLineStats(input, pull.version).pipe(Effect.orElseSucceed(() => null)),
          // Reviewers need `pr:review:read`, which a contents-only token lacks.
          readPages("getChangeRequest", input, `${path}/reviewers`, Json.GitCafeActorEntries).pipe(
            Effect.catch((error) =>
              isForbidden(error) ? Effect.succeed({ items: [], next: null }) : Effect.fail(error),
            ),
          ),
          readPages("getChangeRequest", input, `${path}/labels`, Json.GitCafeLabels),
        ],
        { concurrency: 5 },
      );
      const listed = { ...pull, reviewers: reviewers.items, labels: labels.items };
      const checkList = checks === null ? [] : Json.toChecks(checks);
      // GitCafe's own counts include runs a re-run replaced, so the newest runs are the state. A
      // truncated listing may be missing a failure; the counts never call failing checks passing.
      const checksState =
        checks !== null && checks.next === null
          ? Json.checksStateOf(checkList)
          : status.checks.total === 0
            ? null
            : status.checks.failing > 0
              ? ("failing" as const)
              : status.checks.pending > 0
                ? ("pending" as const)
                : ("passing" as const);
      const permissions = Json.toViewerPermissions(pull);
      const merging = status.merge.reasons?.some((reason) => MERGE_IN_FLIGHT.has(reason)) ?? false;
      return {
        ...Json.toChangeRequest(listed, input),
        autoMergeEnabled: merging,
        headSha: pull.headOid,
        body: pull.description ?? "",
        ...(pull.sourceRepo === null
          ? {}
          : { headRepositoryNameWithOwner: `${pull.sourceRepo.owner}/${pull.sourceRepo.name}` }),
        additions: changes?.additions ?? 0,
        deletions: changes?.deletions ?? 0,
        changedFiles: changes?.changedFiles ?? 0,
        closedAt: pull.closedAt,
        mergedAt: pull.mergedAt,
        ...settledMerge(pull),
        reviewers: Json.toReviewers(listed, input.host),
        checks: checkList,
        ...(checksState === null ? {} : { checksState }),
        mergeability:
          status.merge.conflicts === "conflicting"
            ? ("conflicting" as const)
            : status.merge.conflicts === "none"
              ? ("mergeable" as const)
              : ("unknown" as const),
        baseComparison:
          status.merge.fastForward === null
            ? ("unknown" as const)
            : status.merge.fastForward
              ? ("up-to-date" as const)
              : ("behind" as const),
        mergeCapabilities: {
          merge: mergeStrategyOpen(status, "merge"),
          squash: mergeStrategyOpen(status, "squash"),
          rebase: mergeStrategyOpen(status, "rebase"),
        },
        viewerPermissions:
          status.merge.permitted === false || merging
            ? { ...permissions, actions: permissions.actions.filter((a) => a !== "merge") }
            : permissions,
      };
    }),
    getChangeRequestStack: (input) =>
      readStack("getChangeRequestStack", input).pipe(
        Effect.map((stack) => (stack === null ? null : Json.toStack(stack, input))),
      ),
    getChangeRequestActivity: Effect.fn("GitCafePullRequestProvider.getChangeRequestActivity")(
      function* (input) {
        const pull = yield* readPull("getChangeRequestActivity", input);
        const path = yield* pullPath("getChangeRequestActivity", input);
        const operation = "getChangeRequestActivity";
        const [comments, reviews, commits, reactions] = yield* Effect.all(
          [
            readComments(operation, input),
            readPages(operation, input, `${path}/reviews`, Json.GitCafeReviews),
            pull.headOid === null
              ? Effect.succeed({ items: [], next: null })
              : // A closed pull request whose branch is gone keeps its head, but git.cafe answers
                // 404 for commits it no longer has; the conversation still stands without them.
                readPages(operation, input, `${path}/commits`, Json.GitCafeCommits).pipe(
                  Effect.catch((error) =>
                    error.reason === "not-found"
                      ? Effect.succeed({ items: [], next: null })
                      : Effect.fail(error),
                  ),
                ),
            readPages(operation, input, `${path}/reactions/`, Json.GitCafeReactions).pipe(
              Effect.orElseSucceed(() => undefined),
            ),
          ],
          { concurrency: 4 },
        );
        return Json.toActivity({
          comments,
          reviews,
          commits: { ...commits, truncated: commits.next !== null, headOid: pull.headOid ?? "" },
          host: input.host,
          ...(pull.headOid === null ? {} : { headOid: pull.headOid }),
          ...(reactions === undefined ? {} : { reactions }),
        });
      },
    ),
    getViewerPermissions: (input) =>
      readPull("getViewerPermissions", input).pipe(Effect.map(Json.toViewerPermissions)),
    getDiff: Effect.fn("GitCafePullRequestProvider.getDiff")(function* (input) {
      const page = yield* readDiffPage("getDiff", input, DIFF_FILES_BATCH);
      const details = yield* readDiffFiles(input, page.revision, detailablePaths(page.items));
      return {
        ...Json.toDiff({ items: withDetails(page.items, details) }),
        nextCursor: page.nextCursor,
      };
    }),
    getDiffFilePaths: Effect.fn("GitCafePullRequestProvider.getDiffFilePaths")(function* (input) {
      const page = yield* readDiffPage("getDiffFilePaths", input, CHANGES_PAGE_LIMIT);
      return {
        files: page.items.map((file) => ({
          oldPath: file.oldPath ?? file.path,
          newPath: file.path,
        })),
        nextCursor: page.nextCursor,
      };
    }),
    getDiffFileContents: Effect.fn("GitCafePullRequestProvider.getDiffFileContents")(
      function* (input) {
        const operation = "getDiffFileContents";
        if (input.commit !== undefined)
          return yield* failure(operation, "GitCafe commit diff contents are not supported yet.");
        const pull = yield* readPull(operation, input);
        if (!isCommitOid(pull.headOid))
          return yield* failure(
            operation,
            "GitCafe has not reported an immutable pull request head.",
          );
        const path = yield* pullPath(operation, input);
        const query = new URLSearchParams({ expectedVersion: String(pull.version), limit: "1" });
        // observedBaseOid is the target tip, not necessarily the diff's merge base.
        const snapshot = yield* read(
          operation,
          input,
          { path: `${path}/changes?${query}` },
          SourceSnapshot,
        );
        if (snapshot.version !== pull.version || snapshot.headOid !== pull.headOid)
          return yield* failure(
            operation,
            "GitCafe changed the pull request revision. Refresh the diff.",
          );
        const sourceRepository =
          pull.sourceRepo === null
            ? input.repository
            : `${pull.sourceRepo.owner}/${pull.sourceRepo.name}`;
        const [oldContents, newContents] = yield* Effect.all(
          [
            input.changeType === "new"
              ? Effect.succeed("")
              : readDiffSource(input, snapshot.comparisonBaseOid, input.oldPath),
            input.changeType === "deleted"
              ? Effect.succeed("")
              : readDiffSource(
                  { ...input, repository: sourceRepository },
                  snapshot.headOid,
                  input.newPath,
                ),
          ],
          { concurrency: 2 },
        );
        return { oldContents, newContents };
      },
    ),
    runAction: Effect.fn("GitCafePullRequestProvider.runAction")(function* (input) {
      if (input.stackNumber !== undefined)
        return yield* runStackAction({ ...input, stackNumber: input.stackNumber });
      switch (input.action) {
        case "merge":
          return yield* merge(input);
        case "ready":
        case "draft":
        case "close":
        case "reopen": {
          const pull = yield* readPull(input.action, input);
          const path = yield* pullPath(input.action, input);
          yield* send(input.action, input, {
            method: "POST",
            path: `${path}/${input.action}`,
            body: { expectedVersion: pull.version },
          });
          return;
        }
        default:
          return yield* failure(input.action, `GitCafe cannot ${input.action} from T3 Code.`);
      }
    }),
    updateChangeRequest: Effect.fn("GitCafePullRequestProvider.updateChangeRequest")(
      function* (input) {
        const pull = yield* readPull("updateChangeRequest", input);
        const path = yield* pullPath("updateChangeRequest", input);
        yield* read(
          "updateChangeRequest",
          input,
          {
            method: "PATCH",
            path,
            body: {
              expectedVersion: pull.version,
              ...(input.title === undefined ? {} : { title: input.title }),
              ...(input.body === undefined ? {} : { description: input.body }),
            },
          },
          Versioned,
        );
      },
    ),
    comment: (input) =>
      pullPath("comment", input).pipe(
        Effect.flatMap((path) =>
          read(
            "comment",
            input,
            { method: "POST", path: `${path}/comments/`, body: { body: input.body } },
            Written,
          ),
        ),
        Effect.asVoid,
      ),
    updateComment: Effect.fn("GitCafePullRequestProvider.updateComment")(function* (input) {
      if (!isId(input.commentId))
        return yield* failure("updateComment", "GitCafe comment ids are opaque slugs.");
      const path = `${yield* pullPath("updateComment", input)}/comments/${input.commentId}`;
      const detail = yield* read("updateComment", input, { path: `${path}/detail` }, CommentDetail);
      yield* read(
        "updateComment",
        input,
        { method: "PATCH", path, body: { body: input.body, expectedVersion: detail.version } },
        Written,
      );
    }),
    submitReview: Effect.fn("GitCafePullRequestProvider.submitReview")(function* (input) {
      if (input.comments.length > 0)
        return yield* failure("submitReview", "GitCafe line comments are not supported yet.");
      const pull = yield* readPull("submitReview", input);
      if (pull.headOid === null)
        return yield* failure("submitReview", "GitCafe has not reported the pull request's head.");
      const path = yield* pullPath("submitReview", input);
      yield* read(
        "submitReview",
        input,
        {
          method: "POST",
          path: `${path}/reviews`,
          body: {
            verdict: input.verdict === "request-changes" ? "request_changes" : input.verdict,
            ...(input.body.length === 0 ? {} : { body: input.body }),
            commitOid: pull.headOid,
            expectedVersion: pull.version,
            requestId: yield* randomUuidV4,
          },
        },
        Written,
      );
    }),
    listReviewerCandidates: Effect.fn("GitCafePullRequestProvider.listReviewerCandidates")(
      function* (input) {
        const operation = "listReviewerCandidates";
        const path = yield* pullPath(operation, input);
        const [pull, candidates, reviewers] = yield* Effect.all(
          [
            readPull(operation, input),
            readPages(
              operation,
              input,
              `${path}/reviewer-candidates`,
              Json.GitCafeActorEntries,
            ).pipe(explainReviewerScopes(operation)),
            readPages(operation, input, `${path}/reviewers`, Listed).pipe(
              explainReviewerScopes(operation),
            ),
          ],
          { concurrency: 3 },
        );
        return {
          candidates: Json.toReviewerCandidates(candidates, {
            requested: new Set(reviewers.items.map((reviewer) => reviewer.id)),
            authorActorId: pull.author.actorId,
            host: input.host,
          }),
          truncated: candidates.next !== null,
        };
      },
    ),
    setReviewerRequest: (input) =>
      toggleListed(
        "setReviewerRequest",
        input,
        { name: "reviewers", key: "actorIds" },
        input.reviewers.map((reviewer) => reviewer.id),
        input.requested,
      ).pipe(explainReviewerScopes("setReviewerRequest")),
    listLabelCandidates: Effect.fn("GitCafePullRequestProvider.listLabelCandidates")(
      function* (input) {
        const operation = "listLabelCandidates";
        const base = yield* repositoryPath(operation, input);
        const [labels, applied] = yield* Effect.all(
          [
            readPages(operation, input, `${base}/labels`, Json.GitCafeLabels),
            readPages(operation, input, `${base}/pulls/${input.number}/labels`, Listed),
          ],
          { concurrency: 2 },
        );
        const appliedIds = new Set(applied.items.map((label) => label.id));
        return {
          candidates: labels.items.map((label) => ({
            name: label.name,
            color: label.color,
            description: label.description ?? null,
            isApplied: appliedIds.has(label.id),
          })),
          truncated: labels.next !== null,
        };
      },
    ),
    listRepositoryLabels: Effect.fn("GitCafePullRequestProvider.listRepositoryLabels")(
      function* (input) {
        const operation = "listRepositoryLabels";
        const base = yield* repositoryPath(operation, input);
        const labels = yield* readPages(operation, input, `${base}/labels`, Json.GitCafeLabels);
        return {
          items: labels.items.map((label) => ({ name: label.name, color: label.color })),
          truncated: labels.next !== null,
        };
      },
    ),
    searchRepositoryAuthors: Effect.fn("GitCafePullRequestProvider.searchRepositoryAuthors")(
      function* (input) {
        const operation = "searchRepositoryAuthors";
        const query = input.query?.trim() ?? "";
        // User search needs two characters; before that the repository's own people stand in.
        const path =
          query.length < 2
            ? `${yield* repositoryPath(operation, input)}/collaborators?${new URLSearchParams({ limit: "50" })}`
            : `/users?${new URLSearchParams({ q: query, limit: "50" })}`;
        const people = yield* read(operation, input, { path }, Json.GitCafePeople);
        return { items: Json.toPeople(people, input.host), truncated: people.next !== null };
      },
    ),
    setLabels: Effect.fn("GitCafePullRequestProvider.setLabels")(function* (input) {
      const base = yield* repositoryPath("setLabels", input);
      const labels = yield* readPages("setLabels", input, `${base}/labels`, Json.GitCafeLabels);
      const selected = labels.items.filter((label) => input.labels.includes(label.name));
      if (selected.length !== input.labels.length)
        return yield* failure("setLabels", "One or more requested labels could not be found.");
      yield* toggleListed(
        "setLabels",
        input,
        { name: "labels", key: "labelIds" },
        selected.map((label) => label.id),
        input.applied,
      );
    }),
    replyToThread: Effect.fn("GitCafePullRequestProvider.replyToThread")(function* (input) {
      if (!isId(input.threadId))
        return yield* failure("replyToThread", "GitCafe thread ids are opaque slugs.");
      const path = yield* pullPath("replyToThread", input);
      yield* read(
        "replyToThread",
        input,
        {
          method: "POST",
          path: `${path}/comments/${input.threadId}/replies`,
          body: { body: input.body },
        },
        Written,
      );
    }),
    setReaction: Effect.fn("GitCafePullRequestProvider.setReaction")(function* (input) {
      const path = `${yield* pullPath("setReaction", input)}/reactions/`;
      const subject =
        input.subjectId === undefined
          ? { kind: "pull_request" as const, id: (yield* readPull("setReaction", input)).id }
          : { kind: "pull_request_comment" as const, id: input.subjectId };
      const reactions = yield* readPages("setReaction", input, path, Json.GitCafeReactions);
      const mine = reactions.items.find(
        (item) =>
          item.subject.kind === subject.kind &&
          item.subject.id === subject.id &&
          item.emoji.kind === "unicode" &&
          Json.reactionContent(item.emoji.value) === input.content,
      )?.viewerReactionId;
      if (input.reacted === (mine != null)) return;
      if (input.reacted) {
        yield* send("setReaction", input, {
          method: "POST",
          path,
          body: { subject, emoji: { kind: "unicode", value: Json.REACTION_EMOJI[input.content] } },
        });
        return;
      }
      if (mine == null) return;
      if (!isId(mine))
        return yield* failure("setReaction", "GitCafe returned an unreadable reaction id.");
      yield* send("setReaction", input, { method: "DELETE", path: `${path}${mine}` });
    }),
    setThreadResolution: Effect.fn("GitCafePullRequestProvider.setThreadResolution")(
      function* (input) {
        const comments = yield* readComments("setThreadResolution", input);
        const root = comments.items.find(
          (comment) => comment.id === input.threadId && comment.threadId === input.threadId,
        );
        if (root === undefined || root.version === undefined || !isId(root.id))
          return yield* failure("setThreadResolution", "GitCafe did not return the thread root.");
        if (input.resolved === (root.resolvedAt !== null)) return;
        const path = yield* pullPath("setThreadResolution", input);
        yield* read(
          "setThreadResolution",
          input,
          {
            method: "POST",
            path: `${path}/comments/${root.id}/${input.resolved ? "resolve" : "unresolve"}`,
            body: { expectedVersion: root.version },
          },
          Written,
        );
      },
    ),
  };
  return provider;
});
