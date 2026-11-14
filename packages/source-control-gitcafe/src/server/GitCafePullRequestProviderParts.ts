import { SourceControlProviderKind } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { randomUuidV4 } from "@t3tools/provider-core/server/randomUuid";
import { type PullRequestProviderApi } from "@t3tools/source-control-core/server/PullRequestProvider";

import * as Json from "./gitCafePullRequestJson.ts";

import {
  CAPABILITIES,
  PAGE_SIZE,
  AUTHOR_DISCOVERY_PAGES,
  DIFF_FILES_BATCH,
  CHANGES_PAGE_LIMIT,
  detailablePaths,
  mergeStrategyOpen,
  isId,
  Principal,
  Written,
  Versioned,
  CommentDetail,
  Status,
  MERGE_IN_FLIGHT,
  Listed,
  encodeIds,
  isCommitOid,
  SourceSnapshot,
  settledMerge,
  parsePosition,
  withDetails,
} from "./GitCafeProviderModel.ts";
import { type makeGitCafeProviderClient } from "./GitCafeProviderClient.ts";

/** The GitCafe pull-request provider surface. */
export const makeGitCafeProviderApi = (
  client: Effect.Success<typeof makeGitCafeProviderClient>,
): PullRequestProviderApi => {
  const knownAuthors = client.knownAuthors;
  const authorKey = client.authorKey;
  const learnAuthors = client.learnAuthors;
  const failure = client.failure;
  const repositoryPath = client.repositoryPath;
  const send = client.send;
  const read = client.read;
  const pullPath = client.pullPath;
  const readPull = client.readPull;
  const readDiffSource = client.readDiffSource;
  const readPages = client.readPages;
  const listFilterParams = client.listFilterParams;
  const readComments = client.readComments;
  const isForbidden = client.isForbidden;
  const explainReviewerScopes = client.explainReviewerScopes;
  const toggleListed = client.toggleListed;
  const readStack = client.readStack;
  const readDiffPage = client.readDiffPage;
  const readDiffFiles = client.readDiffFiles;
  const runStackAction = client.runStackAction;
  const readLineStats = client.readLineStats;
  const merge = client.merge;

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
        const readPage = Effect.fn("readPage")(function (rows: number, after: string | null) {
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
        });
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
        Effect.map((pull) => ({ ...Json.toChangeRequest(pull, input), ...settledMerge(pull) })),
      ),
    getChangeRequestSummary: Effect.fn("GitCafePullRequestProvider.getChangeRequestSummary")(
      function* (input) {
        const pull = yield* readPull("getChangeRequestSummary", input);
        const changes =
          pull.headOid === null
            ? null
            : yield* readLineStats(input, pull).pipe(Effect.orElseSucceed(() => null));
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
            : readLineStats(input, pull).pipe(Effect.orElseSucceed(() => null)),
          // Reviewers need `pr:review:read`, which a contents-only token lacks.
          readPages("getChangeRequest", input, `${path}/reviewers`, Json.GitCafeActorEntries).pipe(
            // @effect-diagnostics-next-line catchConditionalRefailToCatchIf:off - catchIf widens this paginated result to any in tsc-rs.
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
                  // @effect-diagnostics-next-line catchConditionalRefailToCatchIf:off - catchIf widens this paginated result to any in tsc-rs.
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
};
