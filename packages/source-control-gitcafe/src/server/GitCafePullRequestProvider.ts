import { SourceControlProviderKind } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { randomUuidV4 } from "@t3tools/provider-core/server/randomUuid";
import {
  NonNegativeInt,
  TrimmedNonEmptyString,
  type PullRequestCapabilities,
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
import { definition } from "../client/definition.ts";

const CAPABILITIES: PullRequestCapabilities = {
  diff: true,
  comment: true,
  actions: [...definition.changeRequestActions],
  mergeMethods: ["merge", "squash", "rebase"],
  // Only through a stack: GitCafe's one branch update restacks every layer above it.
  updateMethods: ["rebase"],
  search: true,
  stacks: true,
  stackActions: true,
  reactions: true,
  labels: false,
  // Line comments go through GitCafe's review drafts, which arrive with revision fencing.
  review: {
    inlineComment: false,
    reply: true,
    resolve: true,
    verdicts: ["approve", "request-changes", "comment"],
  },
  reviewers: { request: false, listCandidates: false },
  edit: { changeRequest: true, comment: true },
};

const PAGE_SIZE = 100;
/** Conversation pages read before the list is reported as truncated. */
const MAX_PAGES = 10;
/** GitCafe's cap on paths per `/diff-files` read, and so one diff page. */
const DIFF_FILES_BATCH = 64;
/**
 * Line totals cost one hunk read per batch, so a pull request larger than this reports none
 * rather than reading every file.
 */
const LINE_STATS_MAX_FILES = DIFF_FILES_BATCH * 4;
/** Structural `/changes` pages, 500 files each, read to count a pull request's files. */
const MAX_CHANGE_PAGES = 20;

const chunk = <A>(items: ReadonlyArray<A>, size: number): Array<ReadonlyArray<A>> =>
  Array.from({ length: Math.ceil(items.length / size) }, (_, index) =>
    items.slice(index * size, (index + 1) * size),
  );

/** Files whose hunks GitCafe can return; binary and oversized ones are listed as they are. */
const detailablePaths = (files: ReadonlyArray<Json.GitCafeDiffFile>) =>
  files.filter((file) => !file.binary && !file.tooLarge).map((file) => file.path);

/**
 * A strategy GitCafe lists, the viewer may use, and no blocker names. A blocker without
 * strategies (changes requested, a lock) still leaves Merge offered, so pressing it shows
 * GitCafe's own reason.
 */
const mergeStrategyOpen = (status: typeof Status.Type, strategy: string) =>
  status.merge.permitted !== false &&
  status.merge.strategies.includes(strategy) &&
  !(status.merge.blockers ?? []).some((blocker) =>
    (blocker.blockedStrategies ?? []).includes(strategy),
  );

const Id = TrimmedNonEmptyString.check(Schema.isPattern(/^[A-Za-z0-9_-]+$/u));
const isId = Schema.is(Id);
const Principal = Schema.Struct({ handle: TrimmedNonEmptyString });
const Written = Schema.Struct({ id: Id });
const Versioned = Schema.Struct({ version: NonNegativeInt });
const CommentDetail = Schema.Struct({ id: Id, version: NonNegativeInt });
const Status = Schema.Struct({
  merge: Schema.Struct({
    conflicts: Schema.Literals(["unknown", "conflicting"]),
    fastForward: Schema.NullOr(Schema.Boolean),
    strategies: Schema.Array(Schema.String),
    permitted: Schema.optional(Schema.Boolean),
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
const FilterOptions = Schema.Struct({
  actors: Schema.Array(
    Schema.Struct({ actorId: TrimmedNonEmptyString, handle: TrimmedNonEmptyString }),
  ),
});
const encodeActorIds = Schema.encodeSync(Schema.fromJsonString(Schema.Array(Schema.String)));
const BranchCommit = Schema.Struct({ oid: TrimmedNonEmptyString });
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
/** Where a stack operation stopped short; anything else is underway or done. */
const FAILED_STACK_STATES = new Set(["failed", "stopped", "cancelled", "reconciliation_required"]);

type PullRef = ProviderRepositoryRef & { readonly number: number };
type Paged<A> = { readonly items: ReadonlyArray<A>; readonly next: string | null };

/** The heads a reader saw are still every unmerged layer the action moves. */
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

/** Lays the detailed files over the structural page, keeping its order and anything omitted. */
const withDetails = (
  files: ReadonlyArray<Json.GitCafeDiffFile>,
  details: ReadonlyArray<Json.GitCafeDiffFile>,
) => {
  const byPath = new Map(details.map((file) => [file.path, file]));
  return files.map((file) => byPath.get(file.path) ?? file);
};

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const api = yield* GitCafeApi.GitCafeApi;

  const failure = (operation: string, detail: string, cause?: unknown) =>
    new PullRequestProviderError({
      provider: SourceControlProviderKind.make("gitcafe"),
      operation,
      reason: "failed",
      detail,
      ...(cause === undefined ? {} : { cause }),
    });

  /** The repository's API root, refused before anything is sent for a host GitCafe is not on. */
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

  /** Every page of a cursor list, up to `MAX_PAGES`; `next` stays set when more remained. */
  const readPages = <S extends Schema.Codec<Paged<unknown>, unknown, never, never>>(
    operation: string,
    input: Pick<ProviderRepositoryRef, "host">,
    path: string,
    schema: S,
  ) =>
    Effect.gen(function* () {
      const items: Array<S["Type"]["items"][number]> = [];
      let next: string | null = null;
      for (let page = 0; page < MAX_PAGES; page++) {
        const query = new URLSearchParams({ limit: String(PAGE_SIZE) });
        if (next !== null) query.set("after", next);
        const batch: S["Type"] = yield* read(
          operation,
          input,
          { path: `${path}?${query}` },
          schema,
        );
        items.push(...batch.items);
        const previous: string | null = next;
        next = batch.next;
        if (next === null || next === previous || batch.items.length === 0) break;
      }
      return { items, next };
    });

  const readComments = (operation: string, input: PullRef) =>
    pullPath(operation, input).pipe(
      Effect.flatMap((path) =>
        readPages(operation, input, `${path}/comments`, Json.GitCafeComments),
      ),
    );

  /**
   * The stack a pull request belongs to, with each unmerged layer's head. GitCafe's stack lists no
   * heads, and they are what a land or restack is fenced on, so each open layer's pull is read.
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

  /** One `/diff-files` read, refused if GitCafe answers from another revision than the page. */
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

  /**
   * Added and deleted line totals and the file count. `/changes` lists files without counting
   * lines, so the counts come from batched hunk reads, and a pull request past the cap reports
   * none rather than paying for every file.
   */
  const readLineStats = Effect.fn("GitCafePullRequestProvider.readLineStats")(function* (
    input: PullRef,
    version: number,
  ) {
    const path = yield* pullPath("getChangeRequest", input);
    const files: Array<Json.GitCafeDiffFile> = [];
    let revision: { version: number; headOid: string; baseOid: string } | undefined;
    let after: string | null = null;
    for (let page = 0; page < MAX_CHANGE_PAGES; page++) {
      const query = new URLSearchParams({ expectedVersion: String(version), limit: "500" });
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
    // A hunk read that loses a race with a push leaves the counts at zero rather than dropping
    // the file count with them.
    const counted =
      files.some((file) => file.additions !== undefined) ||
      files.length > LINE_STATS_MAX_FILES ||
      revision === undefined
        ? files
        : (yield* Effect.forEach(
            chunk(detailablePaths(files), DIFF_FILES_BATCH),
            (paths) => readDiffFiles(input, revision, paths),
            { concurrency: 4 },
          ).pipe(Effect.orElseSucceed(() => [[]]))).flat();
    return {
      changedFiles: files.length,
      additions: counted.reduce((total, file) => total + (file.additions ?? 0), 0),
      deletions: counted.reduce((total, file) => total + (file.deletions ?? 0), 0),
    };
  });

  const merge = Effect.fn("GitCafePullRequestProvider.merge")(function* (
    input: Parameters<PullRequestProviderApi["runAction"]>[0],
  ) {
    const pull = yield* readPull("merge", input);
    if (pull.state === "merged") return;
    if (pull.mergeRoute === "unsupported")
      return yield* failure("merge", "This GitCafe pull request has no supported merge route.");
    const base = yield* repositoryPath("merge", input);
    // GitCafe observes the base only for merges it routes to the provider; a native merge is
    // fenced on the target branch's current commit.
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
    // An accepted merge is GitCafe's to finish; the pull request's state reports when it has.
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
          // A host narrows as far as it can: when the actor list can't be read, the listing comes
          // back unnarrowed and the page's own involvement filter does the rest. A refused token
          // or a rate limit still fails, since the service acts on those for the whole host.
          const options = yield* read(
            "listChangeRequests",
            input,
            { path: `${base}/filter-options` },
            FilterOptions,
          ).pipe(
            Effect.map(Option.some),
            Effect.catchTags({
              PullRequestProviderError: (error) =>
                error.reason === "unauthenticated" || error.reason === "rate-limited"
                  ? Effect.fail(error)
                  : Effect.succeed(Option.none()),
            }),
          );
          if (Option.isSome(options)) {
            actorId = options.value.actors.find(
              (actor) => actor.handle.toLowerCase() === input.viewer.toLowerCase(),
            )?.actorId;
            // A viewer GitCafe knows no actor for has authored and been asked to review nothing.
            if (actorId === undefined) return { items: [], truncated: false, continues: false };
          }
        }
        const limit = Math.max(1, input.limit);
        const items: Array<Json.GitCafePull> = [];
        let next: string | null = null;
        do {
          const query = new URLSearchParams({
            limit: String(Math.min(PAGE_SIZE, limit - items.length)),
            sort: "newest",
          });
          if (input.state !== "all") query.set("state", input.state);
          if (input.query?.trim()) query.set("q", input.query.trim());
          if (actorId !== undefined)
            query.set(
              input.involvement === "reviewing" ? "reviewers" : "authors",
              encodeActorIds([actorId]),
            );
          if (next !== null) query.set("after", next);
          const page: typeof Json.GitCafePulls.Type = yield* read(
            "listChangeRequests",
            input,
            { path: `${base}/pulls?${query}` },
            Json.GitCafePulls,
          );
          items.push(...page.items);
          next = page.items.length === 0 ? null : page.next;
        } while (next !== null && items.length < limit);
        return {
          items: items.slice(0, limit).map((pull) => {
            const item = Json.toChangeRequest(pull, input);
            // GitCafe filtered by reviewer, so the viewer is one even where the pull omits it. An
            // unnarrowed listing (no actor to filter by) says nothing about who was asked.
            return input.involvement === "reviewing" && actorId !== undefined
              ? {
                  ...item,
                  reviewRequestLogins: [...new Set([...item.reviewRequestLogins, input.viewer])],
                }
              : item;
          }),
          truncated: next !== null,
          continues: false,
        };
      },
    ),
    getChangeRequestSummary: (input) =>
      readPull("getChangeRequestSummary", input).pipe(
        Effect.map((pull) => ({
          ...Json.toChangeRequest(pull, input),
          closedAt: pull.closedAt,
          mergedAt: pull.mergedAt,
        })),
      ),
    getChangeRequest: Effect.fn("GitCafePullRequestProvider.getChangeRequest")(function* (input) {
      const pull = yield* readPull("getChangeRequest", input);
      const path = yield* pullPath("getChangeRequest", input);
      const base = yield* repositoryPath("getChangeRequest", input);
      const [status, checks, changes] = yield* Effect.all(
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
        ],
        { concurrency: 3 },
      );
      const permissions = Json.toViewerPermissions(pull);
      return {
        ...Json.toChangeRequest(pull, input),
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
        reviewers: Json.toReviewers(pull, input.host),
        checks: checks === null ? [] : Json.toChecks(checks),
        ...(status.checks.total === 0
          ? {}
          : {
              checksState:
                status.checks.failing > 0
                  ? ("failing" as const)
                  : status.checks.pending > 0
                    ? ("pending" as const)
                    : ("passing" as const),
            }),
        mergeability:
          status.merge.conflicts === "conflicting"
            ? ("conflicting" as const)
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
          status.merge.permitted === false
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
              : readPages(operation, input, `${path}/commits`, Json.GitCafeCommits),
            // Reactions decorate the conversation; a failed read leaves them out, not it.
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
      if (input.commit !== undefined)
        return yield* failure("getDiff", "GitCafe commit diffs are not supported yet.");
      const cursor =
        input.cursor === undefined
          ? null
          : yield* decodeDiffCursor(input.cursor).pipe(
              Effect.mapError((cause) => failure("getDiff", "Invalid GitCafe diff cursor.", cause)),
            );
      const version = cursor?.version ?? (yield* readPull("getDiff", input)).version;
      const path = yield* pullPath("getDiff", input);
      const query = new URLSearchParams({
        expectedVersion: String(version),
        limit: String(DIFF_FILES_BATCH),
      });
      if (cursor !== null) query.set("after", cursor.after);
      const page = yield* read("getDiff", input, { path: `${path}/changes?${query}` }, Changes);
      if (
        page.version !== version ||
        (cursor !== null &&
          (cursor.headOid !== page.headOid || cursor.baseOid !== page.comparisonBaseOid))
      )
        return yield* failure(
          "getDiff",
          "GitCafe answered from a different revision of the pull request. Refresh the diff.",
        );
      const revision = { version, headOid: page.headOid, baseOid: page.comparisonBaseOid };
      const details = yield* readDiffFiles(input, revision, detailablePaths(page.items));
      return {
        ...Json.toDiff({ items: withDetails(page.items, details) }),
        nextCursor: page.next === null ? null : encodeDiffCursor({ ...revision, after: page.next }),
      };
    }),
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
    listReviewerCandidates: () =>
      Effect.fail(
        failure("listReviewerCandidates", "GitCafe reviewer requests are not supported."),
      ),
    setReviewerRequest: () =>
      Effect.fail(failure("setReviewerRequest", "GitCafe reviewer requests are not supported.")),
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
