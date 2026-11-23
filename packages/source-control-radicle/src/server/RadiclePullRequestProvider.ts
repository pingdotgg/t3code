import { resolvePullRequestAuthorFilter } from "@t3tools/contracts";
import type {
  PullRequestCapabilities,
  PullRequestCommit,
  PullRequestAction,
  PullRequestMergeability,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import { toIsoUtc } from "@t3tools/source-control-core/server/pullRequestUtils";
import {
  PullRequestProviderError,
  type ProviderChangeRequestDetail,
  type ProviderRepositoryRef,
  type PullRequestProviderApi,
} from "@t3tools/source-control-core/server/PullRequestProvider";

import { definition, KIND } from "../shared/definition.ts";
import * as RadicleCli from "./RadicleCli.ts";
import { latestBody, latestRevision, type RadiclePatch } from "./radiclePatchJson.ts";
import {
  headBranch,
  overviewThreads,
  pullRequestState,
  radicleActor,
  radicleLogin,
  shortNodeId,
  reviewComments,
  revisionOfComment,
  toChangeRequest,
  toSummary,
  viewerPermissions,
  type PatchContext,
} from "./radiclePatches.ts";

const CAPABILITIES: PullRequestCapabilities = {
  diff: true,
  comment: true,
  actions: [...definition.changeRequestActions],
  // A merge must contain the revision's commit for Radicle to mark the patch merged.
  mergeMethods: ["merge", "fast-forward"],
  search: true,
  reactions: false,
  mentions: false,
  referenceSigils: [],
  labels: false,
  review: {
    inlineComment: false,
    reply: true,
    resolve: false,
    verdicts: ["comment", "approve", "request-changes"],
  },
  reviewers: { request: false, listCandidates: false, searchCandidates: false },
  edit: { changeRequest: true, comment: true },
};

const UNAVAILABLE_REQUIREMENT = {
  missing: RadicleCli.INSTALL_HINT,
  unauthenticated: "Run `rad auth` on the T3 Code server to create a Radicle identity.",
};

const REASONS = {
  "missing-cli": "missing-tool",
  unauthenticated: "unauthenticated",
  "not-found": "not-found",
  failed: "failed",
} as const;

const PATCH_ACTIONS: Partial<Record<PullRequestAction, ReadonlyArray<string>>> = {
  ready: ["ready"],
  draft: ["ready", "--undo"],
  close: ["archive"],
  reopen: ["archive", "--undo"],
};

const SHORTSTAT = /(\d+) files? changed(?:, (\d+) insertions?\(\+\))?(?:, (\d+) deletions?\(-\))?/u;

function parseShortStat(stdout: string) {
  const match = SHORTSTAT.exec(stdout);
  return {
    changedFiles: Number(match?.[1] ?? 0),
    additions: Number(match?.[2] ?? 0),
    deletions: Number(match?.[3] ?? 0),
  };
}

const FIELD = "\u001f";

function parseCommitLog(stdout: string): ReadonlyArray<PullRequestCommit> {
  return stdout.split("\n").flatMap((line) => {
    const [oid, messageHeadline, committedDate] = line.split(FIELD);
    return oid && committedDate
      ? [{ oid, messageHeadline: messageHeadline ?? "", committedDate: toIsoUtc(committedDate) }]
      : [];
  });
}

const unsupported = (operation: string, detail: string) =>
  Effect.fail(
    new PullRequestProviderError({ provider: KIND, operation, reason: "failed", detail }),
  );

export const make = Effect.gen(function* () {
  const cli = yield* RadicleCli.RadicleCli;

  const fail = (operation: string) => (error: RadicleCliError) =>
    new PullRequestProviderError({
      provider: KIND,
      operation,
      reason: REASONS[error.reason],
      detail: error.detail,
      cause: error,
    });

  const target = (input: ProviderRepositoryRef) =>
    cli.repository({ cwd: input.cwd, selector: input.repository });

  const patchContext = Effect.fn("RadiclePullRequestProvider.context")(function* (
    input: ProviderRepositoryRef,
  ) {
    const repository = yield* target(input);
    const [project, aliases] = yield* Effect.all(
      [cli.project({ cwd: input.cwd, repository }), cli.aliases({ cwd: input.cwd, repository })],
      { concurrency: 2 },
    );
    const context: PatchContext = {
      rid: repository.rid,
      defaultBranch: project.defaultBranch,
      aliases,
    };
    return { repository, project, context };
  });

  const loadPatch = Effect.fn("RadiclePullRequestProvider.loadPatch")(function* (
    input: ProviderRepositoryRef & { readonly number: number },
  ) {
    const loaded = yield* patchContext(input);
    const patch = yield* cli.getPatch({
      cwd: input.cwd,
      repository: loaded.repository,
      number: input.number,
    });
    return { ...loaded, patch };
  });

  const storageGit = (
    repository: RadicleCli.RadicleRepository,
    operation: string,
    args: ReadonlyArray<string>,
    options?: { readonly allowNonZeroExit?: boolean; readonly maxOutputBytes?: number },
  ) =>
    // The server sets `safe.bareRepository=explicit`, so the bare storage is named, not found.
    cli.git({
      operation,
      cwd: repository.storage,
      args: ["--git-dir", repository.storage, ...args],
      ...options,
    });

  const mergeability = (
    repository: RadicleCli.RadicleRepository,
    defaultBranch: string,
    patch: RadiclePatch,
  ) =>
    storageGit(
      repository,
      "mergeability",
      [
        "merge-tree",
        "--write-tree",
        "--no-messages",
        `refs/heads/${defaultBranch}`,
        latestRevision(patch).oid,
      ],
      { allowNonZeroExit: true },
    ).pipe(
      Effect.map((output): PullRequestMergeability =>
        output.exitCode === 0 ? "mergeable" : output.exitCode === 1 ? "conflicting" : "unknown",
      ),
      Effect.orElseSucceed((): PullRequestMergeability => "unknown"),
    );

  const getChangeRequest: PullRequestProviderApi["getChangeRequest"] = Effect.fn(
    "RadiclePullRequestProvider.getChangeRequest",
  )(
    function* (input) {
      const { repository, project, context, patch } = yield* loadPatch(input);
      const latest = latestRevision(patch);
      const [stat, mergeable, viewer] = yield* Effect.all(
        [
          storageGit(repository, "diffStat", ["diff", "--shortstat", latest.base, latest.oid]).pipe(
            Effect.map((output) => parseShortStat(output.stdout)),
          ),
          mergeability(repository, project.defaultBranch, patch),
          cli.self(input.cwd),
        ],
        { concurrency: 3 },
      );
      const root = patch.revisions[0] ?? latest;
      const merge = patch.merges[0];
      return {
        ...toChangeRequest(patch, context),
        ...stat,
        mergeability: patch.status === "merged" ? "unknown" : mergeable,
        headSha: latest.oid,
        body: latestBody(root.description),
        mergedAt: merge ? DateTime.formatIso(DateTime.makeUnsafe(merge.timestamp)) : null,
        // Radicle records the revision a merge contained, not the merge commit.
        mergeCommitSha: null,
        closedAt: null,
        reviewers: Object.values(latest.reviews).flatMap((review) =>
          review ? [radicleActor(review.author.id, context.aliases)] : [],
        ),
        checks: [],
        mergeCapabilities: { merge: true, squash: false, rebase: false, "fast-forward": true },
        viewerPermissions: viewerPermissions({
          patch,
          viewer: viewer.did,
          delegates: project.delegates,
        }),
      } satisfies ProviderChangeRequestDetail;
    },
    Effect.mapError(fail("getChangeRequest")),
  );

  /**
   * Builds the merge in the checkout, never its work tree, and pushes it as the default branch;
   * the remote helper marks every patch whose revision the pushed commit contains as merged.
   */
  const merge = Effect.fn("RadiclePullRequestProvider.merge")(function* (
    input: ProviderRepositoryRef & {
      readonly number: number;
      readonly method: "merge" | "fast-forward";
      readonly expectedHeadSha?: string | undefined;
    },
  ) {
    const { project, patch } = yield* loadPatch(input);
    const viewer = yield* cli.self(input.cwd);
    const failMerge = (detail: string) =>
      new RadicleCli.RadicleCliError({ operation: "merge", reason: "failed", detail });
    if (!project.delegates.includes(viewer.did)) {
      return yield* failMerge("Only a delegate of this repository can merge its patches.");
    }
    const head = latestRevision(patch).oid;
    if (input.expectedHeadSha !== undefined && input.expectedHeadSha !== head) {
      return yield* failMerge("The patch has a newer revision. Reload it and try again.");
    }
    const branch = project.defaultBranch;
    const git = (operation: string, args: ReadonlyArray<string>, allowNonZeroExit = false) =>
      cli.git({ operation, cwd: input.cwd, args, allowNonZeroExit });
    yield* git("merge.fetch", [
      "fetch",
      "rad",
      `+refs/heads/${branch}:refs/remotes/rad/${branch}`,
      `+refs/heads/${headBranch(patch)}:refs/remotes/rad/${headBranch(patch)}`,
    ]);
    const base = (yield* git("merge.base", [
      "rev-parse",
      `refs/remotes/rad/${branch}`,
    ])).stdout.trim();
    let commit = head;
    if (input.method === "fast-forward") {
      const ancestor = yield* git(
        "merge.ancestor",
        ["merge-base", "--is-ancestor", base, head],
        true,
      );
      if (ancestor.exitCode !== 0) {
        return yield* failMerge(
          `The patch is not based on the latest ${branch}, so it cannot fast-forward. Merge it instead.`,
        );
      }
    } else {
      const tree = yield* git(
        "merge.tree",
        ["merge-tree", "--write-tree", "--no-messages", base, head],
        true,
      );
      if (tree.exitCode !== 0) {
        return yield* failMerge(
          `The patch conflicts with ${branch}. Rebase it and push a new revision.`,
        );
      }
      commit = (yield* git("merge.commit", [
        "commit-tree",
        tree.stdout.split("\n")[0]!.trim(),
        "-p",
        base,
        "-p",
        head,
        "-m",
        `Merge patch '${patch.title}' (${patch.id.slice(0, 7)})`,
      ])).stdout.trim();
    }
    yield* git("merge.push", ["push", "rad", `${commit}:refs/heads/${branch}`]);
  });

  const radPatch = (
    operation: string,
    input: ProviderRepositoryRef,
    args: (repository: RadicleCli.RadicleRepository) => ReadonlyArray<string>,
  ) =>
    target(input).pipe(
      Effect.flatMap((repository) =>
        cli.rad({
          operation,
          cwd: input.cwd,
          args: ["patch", ...args(repository), "--repo", `rad:${repository.rid}`],
          timeoutMs: 60_000,
        }),
      ),
      Effect.asVoid,
    );

  const provider: PullRequestProviderApi = {
    kind: KIND,
    capabilities: CAPABILITIES,
    unavailableRequirement: UNAVAILABLE_REQUIREMENT,

    getViewer: (input) =>
      cli.self(input.cwd).pipe(
        Effect.map((self) => self.alias ?? shortNodeId(self.did)),
        Effect.mapError(fail("getViewer")),
      ),

    listChangeRequests: Effect.fn("RadiclePullRequestProvider.listChangeRequests")(
      function* (input) {
        const { repository, context } = yield* patchContext(input);
        const patches = yield* cli.listPatches({ cwd: input.cwd, repository });
        const author =
          input.filters?.author === undefined
            ? undefined
            : resolvePullRequestAuthorFilter(input.filters.author, input.viewer);
        const query = input.query?.trim().toLowerCase();
        const before = input.cursor ? Date.parse(input.cursor.updatedBefore) : Infinity;
        const seenAtBoundary = new Set(input.cursor?.seenAt ?? []);
        const rows = patches
          .filter((patch) => {
            const state = pullRequestState(patch);
            if (input.state !== "all" && state !== input.state) return false;
            const login = radicleLogin(patch.author, context.aliases);
            if (input.involvement === "authored" && login !== input.viewer) return false;
            if (input.involvement === "reviewing" && login === input.viewer) return false;
            if (input.filters?.draft === "only" && patch.status !== "draft") return false;
            if (input.filters?.draft === "hide" && patch.status === "draft") return false;
            if (author !== undefined && login !== author) return false;
            if (query && !patch.title.toLowerCase().includes(query)) return false;
            if (patch.updatedAt === before && seenAtBoundary.has(patch.number)) return false;
            return patch.updatedAt <= before;
          })
          .toSorted((left, right) => right.updatedAt - left.updatedAt);
        return {
          items: rows.slice(0, input.limit).map((patch) => toChangeRequest(patch, context)),
          truncated: rows.length > input.limit,
          continues: true,
        };
      },
      Effect.mapError(fail("listChangeRequests")),
    ),

    getChangeRequest,

    getChangeRequestSummary: (input) =>
      loadPatch(input).pipe(
        Effect.map(({ patch, context }) => toSummary(patch, context)),
        Effect.mapError(fail("getChangeRequestSummary")),
      ),

    getChangeRequestActivity: Effect.fn("RadiclePullRequestProvider.getChangeRequestActivity")(
      function* (input) {
        const { repository, context, patch } = yield* loadPatch(input);
        const latest = latestRevision(patch);
        const viewer = yield* cli.self(input.cwd);
        const log = yield* storageGit(repository, "commits", [
          "log",
          "--reverse",
          `--format=%H${FIELD}%s${FIELD}%cI`,
          `${latest.base}..${latest.oid}`,
        ]);
        const comments = reviewComments(patch, context.aliases);
        const threads = overviewThreads(patch, context.aliases, viewer.did);
        return {
          author: radicleActor(patch.author, context.aliases),
          comments,
          commentCount:
            comments.length + threads.reduce((total, thread) => total + thread.comments.length, 0),
          commentsTruncated: false,
          reviewThreads: [],
          overviewThreads: threads,
          commits: parseCommitLog(log.stdout),
        };
      },
      Effect.mapError(fail("getChangeRequestActivity")),
    ),

    getViewerPermissions: Effect.fn("RadiclePullRequestProvider.getViewerPermissions")(
      function* (input) {
        const { project, patch } = yield* loadPatch(input);
        const viewer = yield* cli.self(input.cwd);
        return viewerPermissions({ patch, viewer: viewer.did, delegates: project.delegates });
      },
      Effect.mapError(fail("getViewerPermissions")),
    ),

    getDiff: Effect.fn("RadiclePullRequestProvider.getDiff")(
      function* (input) {
        const { repository, patch } = yield* loadPatch(input);
        const latest = latestRevision(patch);
        const commit = input.commit;
        if (commit !== undefined && !/^[0-9a-f]{7,64}$/iu.test(commit)) {
          return yield* new RadicleCli.RadicleCliError({
            operation: "getDiff",
            reason: "not-found",
            detail: "That is not a commit of this patch.",
          });
        }
        const output = yield* storageGit(
          repository,
          "getDiff",
          commit === undefined
            ? ["diff", "--no-color", "--no-ext-diff", latest.base, latest.oid]
            : ["show", "--format=", "--no-color", "--no-ext-diff", commit],
          { maxOutputBytes: 8 * 1024 * 1024 },
        );
        return { patch: output.stdout, truncated: output.stdoutTruncated, nextCursor: null };
      },
      Effect.mapError(fail("getDiff")),
    ),

    runAction: (input) => {
      const command = PATCH_ACTIONS[input.action];
      if (input.action !== "merge" && command === undefined) {
        return unsupported("runAction", `Radicle patches cannot ${input.action}.`);
      }
      const action =
        input.action === "merge"
          ? merge({
              ...input,
              method: input.mergeMethod === "fast-forward" ? "fast-forward" : "merge",
            })
          : loadPatch(input).pipe(
              Effect.flatMap(({ patch }) =>
                radPatch("runAction", input, () => [...(command ?? []), patch.id]),
              ),
            );
      return action.pipe(Effect.mapError(fail("runAction")));
    },

    updateChangeRequest: Effect.fn("RadiclePullRequestProvider.updateChangeRequest")(
      function* (input) {
        const { patch } = yield* loadPatch(input);
        const root = patch.revisions[0] ?? latestRevision(patch);
        const title = input.title ?? patch.title;
        const body = input.body ?? latestBody(root.description);
        yield* radPatch("updateChangeRequest", input, () => [
          "edit",
          patch.id,
          "-m",
          body.trim().length > 0 ? `${title}\n\n${body}` : title,
        ]);
      },
      Effect.mapError(fail("updateChangeRequest")),
    ),

    comment: (input) =>
      loadPatch(input).pipe(
        Effect.flatMap(({ patch }) =>
          radPatch("comment", input, () => ["comment", latestRevision(patch).id, "-m", input.body]),
        ),
        Effect.mapError(fail("comment")),
      ),

    updateComment: Effect.fn("RadiclePullRequestProvider.updateComment")(
      function* (input) {
        const { patch } = yield* loadPatch(input);
        const revision = revisionOfComment(patch, input.commentId);
        if (revision === null) {
          return yield* new RadicleCli.RadicleCliError({
            operation: "updateComment",
            reason: "not-found",
            detail: "Only patch comments can be edited, not reviews.",
          });
        }
        yield* radPatch("updateComment", input, () => [
          "comment",
          revision.id,
          "--edit",
          input.commentId,
          "-m",
          input.body,
        ]);
      },
      Effect.mapError(fail("updateComment")),
    ),

    submitReview: Effect.fn("RadiclePullRequestProvider.submitReview")(
      function* (input) {
        if (input.comments.length > 0) {
          return yield* new RadicleCli.RadicleCliError({
            operation: "submitReview",
            reason: "failed",
            detail: "Radicle reviews cannot carry line comments from T3 Code yet.",
          });
        }
        const { patch } = yield* loadPatch(input);
        const revision = latestRevision(patch).id;
        const message = input.body.trim().length > 0 ? ["-m", input.body] : [];
        yield* radPatch("submitReview", input, () =>
          input.verdict === "comment"
            ? ["comment", revision, "-m", input.body]
            : [
                "review",
                patch.id,
                "--revision",
                revision,
                input.verdict === "approve" ? "--accept" : "--reject",
                ...message,
              ],
        );
      },
      Effect.mapError(fail("submitReview")),
    ),

    replyToThread: Effect.fn("RadiclePullRequestProvider.replyToThread")(
      function* (input) {
        const { patch } = yield* loadPatch(input);
        const revision = revisionOfComment(patch, input.threadId);
        if (revision === null) {
          return yield* new RadicleCli.RadicleCliError({
            operation: "replyToThread",
            reason: "not-found",
            detail: "That conversation is not on this patch.",
          });
        }
        yield* radPatch("replyToThread", input, () => [
          "comment",
          revision.id,
          "--reply-to",
          input.threadId,
          "-m",
          input.body,
        ]);
      },
      Effect.mapError(fail("replyToThread")),
    ),

    listReviewerCandidates: () => Effect.succeed({ candidates: [], truncated: false }),

    setReviewerRequest: () => unsupported("setReviewerRequest", "Radicle has no review requests."),

    setReaction: () =>
      unsupported("setReaction", "Reactions on Radicle patches are not supported yet."),

    setThreadResolution: () =>
      unsupported("setThreadResolution", "Resolving Radicle conversations is not supported yet."),
  };

  return provider;
});

type RadicleCliError = RadicleCli.RadicleCliError;
