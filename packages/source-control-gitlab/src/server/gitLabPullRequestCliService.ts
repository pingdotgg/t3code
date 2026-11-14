import { isCommitSha } from "@t3tools/source-control-core/server/pullRequestUtils";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";

import {
  decodeCommitsJson,
  decodeMergeRequestFileStatsJson,
  decodeOwnAwardIdJson,
  decodeProjectMergeCapabilitiesJson,
  decodeProjectLabelsJson,
  gitLabAwardName,
  MERGE_REQUEST_FILE_STATS_GRAPHQL_QUERY,
} from "./gitLabMergeRequestJson.ts";

import {
  GitLabMergeRequestReadError,
  GitLabDiffCursorError,
  GitLabDiffCommitError,
  GitLabDiffFileContentsUnavailableError,
  MAX_PAGE_SIZE,
  COMMIT_PAGE_SIZE,
  DIFF_TIMEOUT_MS,
  DIFF_FILE_MAX_OUTPUT_BYTES,
  projectPath,
  gitLabReviewPositionLines,
  diffCursorPage,
  searchParams,
  query,
  actionArgs,
} from "./gitLabPullRequestCliSupport.ts";
import { type makeGitLabCliStats } from "./gitLabPullRequestCliStats.ts";
import { GitLabPullRequestCli } from "./GitLabPullRequestCli.ts";

/** The GitLab pull-request service surface. */
export const makeGitLabPullRequestCliService = (client: ReturnType<typeof makeGitLabCliStats>) => {
  const gitlab = client.gitlab;
  const api = client.api;
  const listPage = client.listPage;
  const diffPage = client.diffPage;
  const notesPage = client.notesPage;
  const discussionsPage = client.discussionsPage;
  const getDiffRefs = client.getDiffRefs;
  const getCommitDiffRefs = client.getCommitDiffRefs;
  const mergeRequestDetail = client.mergeRequestDetail;
  const triggerJobChecks = client.triggerJobChecks;
  const projectUsers = client.projectUsers;
  const awardSubjectPath = client.awardSubjectPath;
  const awardsPage = client.awardsPage;
  const graphqlRead = client.graphqlRead;
  const listMergeRequestStats = client.listMergeRequestStats;
  const fileRevisions = client.fileRevisions;
  const reviewDecisionsOf = client.reviewDecisionsOf;
  const viewerUsername = client.viewerUsername;

  return GitLabPullRequestCli.of({
    getViewerUsername: viewerUsername,

    listMergeRequests: Effect.fn("GitLabPullRequestCli.listMergeRequests")(function (input) {
      const perPage = Math.min(input.limit + 1, MAX_PAGE_SIZE);
      const page = Math.floor((input.cursor?.delivered ?? 0) / perPage) + 1;
      return listPage({ ...input, page, collected: [], cursorAdvance: 0 });
    }),

    getMergeRequestDetail: Effect.fn("GitLabPullRequestCli.getMergeRequestDetail")(
      function* (input) {
        const detail = yield* mergeRequestDetail(input);
        if (input.downstreamChecks === false || detail.headPipeline === undefined) return detail;
        const downstream = yield* triggerJobChecks({
          cwd: input.cwd,
          pipeline: detail.headPipeline,
        });
        return downstream.length === 0
          ? detail
          : { ...detail, checks: [...detail.checks, ...downstream] };
      },
    ),

    getReviewDecisions: Effect.fn("GitLabPullRequestCli.getReviewDecisions")(function (input) {
      const batches: Array<ReadonlyArray<number>> = [];
      for (let at = 0; at < input.numbers.length; at += MAX_PAGE_SIZE) {
        batches.push(input.numbers.slice(at, at + MAX_PAGE_SIZE));
      }
      return Effect.forEach(batches, (numbers) => reviewDecisionsOf({ ...input, numbers }), {
        concurrency: 2,
      }).pipe(Effect.map((pages) => new Map(pages.flatMap((page) => [...page]))));
    }),

    listMergeRequestStats,

    getMergeRequestFileStats: Effect.fn("GitLabPullRequestCli.getMergeRequestFileStats")((input) =>
      graphqlRead({
        cwd: input.cwd,
        host: input.host,
        operation: "getMergeRequestFileStats",
        query: MERGE_REQUEST_FILE_STATS_GRAPHQL_QUERY,
        variables: { fullPath: input.repository, iid: String(input.number) },
        decode: decodeMergeRequestFileStatsJson,
      }),
    ),

    listNotes: Effect.fn("GitLabPullRequestCli.listNotes")(function (input) {
      return notesPage({ ...input, page: 1, collected: [] });
    }),

    listReactions: Effect.fn("GitLabPullRequestCli.listReactions")(function (input) {
      return awardsPage({ ...input, cursor: null, page: 1, collected: null });
    }),

    getFileRevisions: fileRevisions,

    setReaction: Effect.fn("GitLabPullRequestCli.setReaction")(function* (input) {
      const subject = awardSubjectPath(input);
      if (input.reacted) {
        yield* api({
          cwd: input.cwd,
          host: input.host,
          path: `${subject}?${query([["name", gitLabAwardName(input.content)]])}`,
          method: "POST",
        });
        return;
      }
      // GitLab deletes an award by its id and takes no emoji name there, so the reader's own
      // award of that name is looked up first.
      const viewer = yield* viewerUsername(input);
      const listed = yield* api({ cwd: input.cwd, host: input.host, path: subject });
      const own = decodeOwnAwardIdJson(listed.stdout.trim(), {
        content: input.content,
        viewer,
      });
      if (!Result.isSuccess(own)) {
        return yield* new GitLabMergeRequestReadError({
          command: "glab",
          cwd: input.cwd,
          operation: "setReaction",
          cause: own.failure,
        });
      }
      if (own.success === null) return;
      yield* api({
        cwd: input.cwd,
        host: input.host,
        path: `${subject}/${own.success}`,
        method: "DELETE",
      });
    }),

    listCommits: Effect.fn("GitLabPullRequestCli.listCommits")(function (input) {
      return api({
        cwd: input.cwd,
        host: input.host,
        path: `projects/${projectPath(input.repository)}/merge_requests/${input.number}/commits?${query(
          [
            ["per_page", String(COMMIT_PAGE_SIZE)],
            ["with_stats", "true"],
          ],
        )}`,
      }).pipe(
        Effect.flatMap((result) => {
          const decoded = decodeCommitsJson(result.stdout.trim());
          return Result.isSuccess(decoded)
            ? Effect.succeed(decoded.success)
            : Effect.fail(
                new GitLabMergeRequestReadError({
                  command: "glab",
                  cwd: input.cwd,
                  operation: "listCommits",
                  cause: decoded.failure,
                }),
              );
        }),
      );
    }),

    getMergeRequestDiff: Effect.fn("GitLabPullRequestCli.getMergeRequestDiff")(function* (input) {
      if (input.commit !== undefined && !isCommitSha(input.commit)) {
        return yield* new GitLabDiffCommitError({ command: "glab", cwd: input.cwd });
      }
      const target = {
        cwd: input.cwd,
        host: input.host,
        repository: input.repository,
        number: input.number,
        ...(input.commit === undefined ? {} : { commit: input.commit }),
      };
      if (input.cursor === undefined) {
        return yield* diffPage({ ...target, page: 1 });
      }
      const page = diffCursorPage(input.cursor);
      if (page === null)
        return yield* new GitLabDiffCursorError({ command: "glab", cwd: input.cwd });
      return yield* diffPage({ ...target, page });
    }),

    getMergeRequestDiffFileContents: Effect.fn(
      "GitLabPullRequestCli.getMergeRequestDiffFileContents",
    )(function* (input) {
      if (input.commit !== undefined && !isCommitSha(input.commit)) {
        return yield* new GitLabDiffCommitError({ command: "glab", cwd: input.cwd });
      }
      const refs = yield* input.commit === undefined
        ? getDiffRefs(input)
        : getCommitDiffRefs({
            cwd: input.cwd,
            host: input.host,
            repository: input.repository,
            commit: input.commit,
            allowRoot: input.changeType === "new",
          });

      const readFile = (revision: string, filePath: string) =>
        api({
          cwd: input.cwd,
          host: input.host,
          path: `projects/${projectPath(input.repository)}/repository/files/${encodeURIComponent(
            filePath,
          )}/raw?ref=${encodeURIComponent(revision)}`,
          maxOutputBytes: DIFF_FILE_MAX_OUTPUT_BYTES,
          timeoutMs: DIFF_TIMEOUT_MS,
        }).pipe(
          Effect.flatMap((result) =>
            result.stdoutTruncated ||
            result.stdout.includes("\0") ||
            result.stdoutInvalidUtf8 === true
              ? Effect.fail(
                  new GitLabDiffFileContentsUnavailableError({
                    command: "glab",
                    cwd: input.cwd,
                    path: filePath,
                    reason: result.stdoutTruncated ? "oversized" : "binary",
                  }),
                )
              : Effect.succeed(result.stdout),
          ),
        );

      const [oldContents, newContents] = yield* Effect.all(
        [
          input.changeType === "new" ? Effect.succeed("") : readFile(refs.baseSha, input.oldPath),
          input.changeType === "deleted"
            ? Effect.succeed("")
            : readFile(refs.headSha, input.newPath),
        ],
        { concurrency: 2 },
      );
      return { oldContents, newContents };
    }),

    getProjectMergeCapabilities: Effect.fn("GitLabPullRequestCli.getProjectMergeCapabilities")(
      function (input) {
        return api({
          cwd: input.cwd,
          host: input.host,
          path: `projects/${projectPath(input.repository)}?license=false`,
        }).pipe(
          Effect.flatMap((result) => {
            const decoded = decodeProjectMergeCapabilitiesJson(result.stdout.trim());
            return Result.isSuccess(decoded)
              ? Effect.succeed(decoded.success)
              : Effect.fail(
                  new GitLabMergeRequestReadError({
                    command: "glab",
                    cwd: input.cwd,
                    operation: "getProjectMergeCapabilities",
                    cause: decoded.failure,
                  }),
                );
          }),
        );
      },
    ),

    listProjectLabels: Effect.fn("GitLabPullRequestCli.listProjectLabels")(function (input) {
      return api({
        cwd: input.cwd,
        host: input.host,
        path: `projects/${projectPath(input.repository)}/labels?${query([
          ["per_page", String(MAX_PAGE_SIZE)],
          ...searchParams(input.search),
        ])}`,
      }).pipe(
        Effect.flatMap((result) => {
          const decoded = decodeProjectLabelsJson(result.stdout.trim());
          return Result.isSuccess(decoded)
            ? Effect.succeed({
                items: decoded.success.labels,
                truncated: decoded.success.rawCount >= MAX_PAGE_SIZE,
              })
            : Effect.fail(
                new GitLabMergeRequestReadError({
                  command: "glab",
                  cwd: input.cwd,
                  operation: "listProjectLabels",
                  cause: decoded.failure,
                }),
              );
        }),
      );
    }),

    listProjectUsers: Effect.fn("GitLabPullRequestCli.listProjectUsers")(function (input) {
      return projectUsers(input).pipe(
        Effect.map(({ candidates, rawCount }) => ({
          items: candidates.map(({ login, name, avatarUrl }) => ({ login, name, avatarUrl })),
          truncated: rawCount >= MAX_PAGE_SIZE,
        })),
      );
    }),

    listReviewerCandidates: Effect.fn("GitLabPullRequestCli.listReviewerCandidates")(
      function (input) {
        return Effect.all([mergeRequestDetail(input), projectUsers(input)], {
          concurrency: 2,
        }).pipe(
          Effect.map(([mergeRequest, users]) => {
            const author = mergeRequest.author?.login;
            const requested = new Set(mergeRequest.reviewRequestLogins);
            return {
              // GitLab forbids requesting a review from the MR author.
              candidates: users.candidates.flatMap((candidate) =>
                candidate.login === author
                  ? []
                  : [{ ...candidate, isRequested: requested.has(candidate.login) }],
              ),
              truncated: users.rawCount >= MAX_PAGE_SIZE,
            };
          }),
        );
      },
    ),

    setReviewerRequest: Effect.fn("GitLabPullRequestCli.setReviewerRequest")(function (input) {
      return mergeRequestDetail(input).pipe(
        Effect.flatMap((mergeRequest) => {
          // GitLab replaces reviewer_ids wholesale.
          const ids = new Set(mergeRequest.reviewerIds);
          for (const reviewer of input.reviewers) {
            const id = Number(reviewer.id);
            if (!Number.isSafeInteger(id) || id <= 0) continue;
            if (input.requested) ids.add(id);
            else ids.delete(id);
          }
          return api({
            cwd: input.cwd,
            host: input.host,
            path: `projects/${projectPath(input.repository)}/merge_requests/${input.number}`,
            method: "PUT",
            stdin: JSON.stringify({ reviewer_ids: [...ids] }),
          });
        }),
        Effect.asVoid,
      );
    }),

    runMergeRequestAction: Effect.fn("GitLabPullRequestCli.runMergeRequestAction")(
      function* (input) {
        // `glab mr merge` arms auto-merge and never disarms it, so the one direction the CLI has
        // no flag for is asked of GitLab directly through the same `api` passthrough the rest of
        // this module writes with.
        if (input.action === "disable-auto-merge") {
          return yield* api({
            cwd: input.cwd,
            host: input.host,
            path: `projects/${projectPath(input.repository)}/merge_requests/${input.number}/cancel_merge_when_pipeline_succeeds`,
            method: "POST",
          }).pipe(Effect.asVoid);
        }
        const executeMr = (subcommand: string, ...flags: ReadonlyArray<string>) =>
          gitlab.execute({
            cwd: input.cwd,
            host: input.host,
            args: ["mr", subcommand, String(input.number), "--repo", input.repository, ...flags],
          });
        const [subcommand, ...flags] = actionArgs(input.action, input.mergeMethod);
        if (input.action === "merge" || input.action === "enable-auto-merge") {
          if (input.mergeMethod === "rebase") {
            // A rebase changes the source SHA, so wait for it before reading the merge guard.
            yield* executeMr("rebase");
          }
          const refs = yield* getDiffRefs(input);
          flags.push("--sha", refs.headSha);
        }
        yield* executeMr(subcommand!, ...flags);
      },
    ),

    updateMergeRequest: Effect.fn("GitLabPullRequestCli.updateMergeRequest")(function (input) {
      return api({
        cwd: input.cwd,
        host: input.host,
        path: `projects/${projectPath(input.repository)}/merge_requests/${input.number}`,
        method: "PUT",
        // Omitted fields remain unchanged; empty values clear them.
        stdin: JSON.stringify({
          ...(input.title === undefined ? {} : { title: input.title }),
          ...(input.description === undefined ? {} : { description: input.description }),
        }),
      }).pipe(Effect.asVoid);
    }),

    commentOnMergeRequest: Effect.fn("GitLabPullRequestCli.commentOnMergeRequest")(
      function (input) {
        return api({
          cwd: input.cwd,
          host: input.host,
          path: `projects/${projectPath(input.repository)}/merge_requests/${input.number}/notes`,
          method: "POST",
          // JSON avoids glab's coercion of numeric/boolean comment bodies.
          stdin: JSON.stringify({ body: input.body }),
        }).pipe(Effect.asVoid);
      },
    ),

    updateNote: Effect.fn("GitLabPullRequestCli.updateNote")(function (input) {
      return api({
        cwd: input.cwd,
        host: input.host,
        path: `projects/${projectPath(input.repository)}/merge_requests/${input.number}/notes/${encodeURIComponent(
          input.noteId,
        )}`,
        method: "PUT",
        stdin: JSON.stringify({ body: input.body }),
      }).pipe(Effect.asVoid);
    }),

    listDiscussions: Effect.fn("GitLabPullRequestCli.listDiscussions")(function (input) {
      return discussionsPage({ ...input, page: 1, collected: [] });
    }),

    submitReview: Effect.fn("GitLabPullRequestCli.submitReview")(function* (input) {
      const project = projectPath(input.repository);
      const mergeRequest = `projects/${project}/merge_requests/${input.number}`;
      // GitLab has no pending review to attach comments to, so a review is replayed as the
      // requests it is made of: the line comments, then the summary, then the verdict. A
      // failure part-way therefore leaves what was already posted in place, which is why
      // the verdict goes last — a half-sent review is never an approval.
      if (input.comments.length > 0) {
        const refs = yield* getDiffRefs(input);
        yield* Effect.forEach(
          input.comments,
          (comment) =>
            api({
              cwd: input.cwd,
              host: input.host,
              path: `${mergeRequest}/discussions`,
              method: "POST",
              stdin: JSON.stringify({
                body: comment.body,
                position: {
                  base_sha: refs.baseSha,
                  head_sha: refs.headSha,
                  start_sha: refs.startSha,
                  position_type: "text",
                  // Both paths are sent because GitLab resolves a position against both
                  // sides of the diff. They differ only for a renamed file, which is why the
                  // draft carries the name the file had before the change.
                  old_path: comment.oldPath ?? comment.path,
                  new_path: comment.path,
                  ...gitLabReviewPositionLines(comment.position),
                },
              }),
            }),
          { discard: true },
        );
      }
      if (input.body.trim().length > 0) {
        yield* api({
          cwd: input.cwd,
          host: input.host,
          path: `${mergeRequest}/notes`,
          method: "POST",
          // @effect-diagnostics-next-line preferSchemaOverJson:off
          stdin: JSON.stringify({ body: input.body }),
        });
      }
      if (input.verdict === "approve") {
        yield* api({
          cwd: input.cwd,
          host: input.host,
          path: `${mergeRequest}/approve`,
          method: "POST",
        });
      }
    }),

    replyToDiscussion: Effect.fn("GitLabPullRequestCli.replyToDiscussion")(function (input) {
      return api({
        cwd: input.cwd,
        host: input.host,
        path: `projects/${projectPath(input.repository)}/merge_requests/${input.number}/discussions/${encodeURIComponent(
          input.discussionId,
        )}/notes`,
        method: "POST",
        stdin: JSON.stringify({ body: input.body }),
      }).pipe(Effect.asVoid);
    }),

    setDiscussionResolution: Effect.fn("GitLabPullRequestCli.setDiscussionResolution")(
      function (input) {
        return api({
          cwd: input.cwd,
          host: input.host,
          path: `projects/${projectPath(input.repository)}/merge_requests/${input.number}/discussions/${encodeURIComponent(
            input.discussionId,
          )}`,
          method: "PUT",
          stdin: JSON.stringify({ resolved: input.resolved }),
        }).pipe(Effect.asVoid);
      },
    ),
  });
};
