import * as Effect from "effect/Effect";
import type { PullRequestCapabilities, PullRequestViewerPermissions } from "@t3tools/contracts";

import * as AzureDevOpsPullRequestCli from "./AzureDevOpsPullRequestCli.ts";
import {
  azureDevOpsFilePatch,
  azureDevOpsUnreadableFilePatch,
  formatAzureDevOpsDiffCursor,
  parseAzureDevOpsDiffCursor,
  MAX_DIFF_SLICE_BYTES,
  byteLength,
  MAX_FILE_DIFF_MILLIS,
  type AzureDevOpsFileTexts,
} from "./azureDevOpsDiff.ts";
import {
  PullRequestProviderError,
  type PullRequestProviderFailure,
  type ProviderChangeRequest,
  type ProviderChangeRequestActivity,
  type ProviderChangeRequestDetail,
  type ProviderDiffSlice,
  type PullRequestProviderApi,
} from "./PullRequestProvider.ts";
import type { AzureDevOpsIterationChanges } from "./AzureDevOpsPullRequestCli.ts";
import type {
  AzureDevOpsChangeEntry,
  AzureDevOpsItemContent,
  AzureDevOpsIteration,
  AzureDevOpsPullRequest,
  AzureDevOpsRepositoryLocation,
} from "./azureDevOpsPullRequestJson.ts";

const CAPABILITIES: PullRequestCapabilities = {
  // Azure serves no patch of its own, so the one the Code tab reads is built here out of the
  // files an iteration changed and both sides of each of them.
  diff: true,
  // Reading a conversation is a plain REST read, but posting one is not something this can
  // claim without having run it, so the composer stays hidden.
  comment: false,
  actions: [
    "merge",
    "ready",
    "draft",
    "close",
    "reopen",
    "enable-auto-merge",
    "disable-auto-merge",
  ],
  // Azure squashes as a completion option; it has no rebase strategy of its own.
  mergeMethods: ["merge", "squash"],
  // `az repos pr list` filters by status, creator, reviewer and branch, and by no text at all.
  search: false,
  reactions: false,
  // The patch has lines to write against, but writing a remark at all is what Azure is not
  // offered for here, so nothing in a review is either.
  review: { inlineComment: false, reply: false, resolve: false, verdicts: [] },
  // `az repos pr reviewer add` and `remove` name identities, and nothing anywhere in `az repos`
  // lists the ones this repository could name — that lives behind the identity and graph APIs, a
  // different service with its own permissions. So the page takes a name here rather than being
  // handed a menu built out of a guess.
  reviewers: { request: true, listCandidates: false },
  // A new title and description travel on the same `az repos pr update` that moves a pull request.
  // Rewriting a remark is false for the same reason posting one is: this cannot put a remark on
  // Azure DevOps at all, so there is nothing here it could rewrite either.
  edit: { changeRequest: true, comment: false },
  // Azure does keep a viewed record of its own, but only behind the undocumented contribution
  // endpoint its web UI talks to, keyed on an iteration so a push would drop every mark anyway.
  // So they are kept here instead, and the client says whose they are rather than implying the
  // Azure DevOps page will show them.
  viewedFiles: "environment",
};

/**
 * Everything this host offers, granted to whoever is signed in. Azure DevOps states no permission
 * anywhere `az repos pr show` or `az repos pr list` reach: the answer lives in the security
 * namespaces, behind identity descriptors and token paths that would be several calls per pull
 * request to resolve.
 *
 * So the actions stay live and a viewer who may not take one is told so by Azure, at the moment
 * they try. That is the safer half of an unknown: hiding a control from someone entitled to it
 * leaves them no way through and no reason given.
 */
export const AZURE_DEVOPS_VIEWER_PERMISSIONS: PullRequestViewerPermissions = {
  actions: CAPABILITIES.actions,
  comment: CAPABILITIES.comment,
  resolve: CAPABILITIES.review.resolve,
  verdicts: CAPABILITIES.review.verdicts,
  requestReviewers: CAPABILITIES.reviewers.request,
};

/** The CLI tags that mean the tool itself is unusable, rather than one request failing. */
export function azureDevOpsProviderFailure(
  error: AzureDevOpsPullRequestCli.AzureDevOpsPullRequestCliError,
): PullRequestProviderFailure {
  if (error._tag === "AzureDevOpsCliUnavailableError") return { reason: "missing-tool" };
  if (error._tag === "AzureDevOpsCliAuthenticationError") return { reason: "unauthenticated" };
  if (error._tag === "AzureDevOpsCliRateLimitError") return { reason: "rate-limited" };
  return { reason: "failed" };
}

function toChangeRequest(pullRequest: AzureDevOpsPullRequest): ProviderChangeRequest {
  return {
    number: pullRequest.number,
    title: pullRequest.title,
    url: pullRequest.url,
    author: pullRequest.author,
    headBranch: pullRequest.headBranch,
    baseBranch: pullRequest.baseBranch,
    state: pullRequest.state,
    isDraft: pullRequest.isDraft,
    mergeability: pullRequest.mergeability,
    // Azure counts a pull request's files but never its lines, and counting them here would mean
    // reading every file on both sides of every row of a listing.
    additions: 0,
    deletions: 0,
    createdAt: pullRequest.createdAt,
    updatedAt: pullRequest.updatedAt,
    reviewRequestLogins: pullRequest.reviewRequestLogins,
    // Azure keeps labels on work items rather than on the pull request.
    labels: [],
  };
}

export const make = Effect.gen(function* () {
  const cli = yield* AzureDevOpsPullRequestCli.AzureDevOpsPullRequestCli;

  const fail =
    (operation: string) => (error: AzureDevOpsPullRequestCli.AzureDevOpsPullRequestCliError) =>
      new PullRequestProviderError({
        provider: "azure-devops",
        operation,
        ...azureDevOpsProviderFailure(error),
        detail: error.detail,
        cause: error,
      });

  /** Refuses what the capabilities already say this host cannot do. */
  const unsupported = (operation: string) =>
    Effect.fail(
      new PullRequestProviderError({
        provider: "azure-devops",
        operation,
        reason: "failed",
        detail: "Azure DevOps reviews cannot be written from here yet.",
      }),
    );

  /** A pull request Azure could not place has no diff to read, which reads as an empty one. */
  const EMPTY_DIFF_SLICE: ProviderDiffSlice = { patch: "", truncated: false, nextCursor: null };

  /**
   * Where a pull request's repository lives, which is the route every other read of it needs and
   * the one thing only the pull request itself states. A pull request cannot move between
   * repositories, so it is remembered rather than re-read: the marks alone would otherwise pay for
   * a whole pull request read every time they checked whether a file had been pushed to.
   *
   * Bounded and oldest-first, since a long-lived server sees far more pull requests than a reader
   * ever has open.
   */
  const LOCATION_CACHE_CAPACITY = 128;
  const locations = new Map<string, AzureDevOpsRepositoryLocation>();

  const locationOf = (input: { readonly cwd: string; readonly number: number }) => {
    const key = `${input.cwd} ${input.number}`;
    const held = locations.get(key);
    if (held !== undefined) return Effect.succeed(held);
    return cli.getPullRequest({ cwd: input.cwd, number: input.number }).pipe(
      Effect.map((pullRequest) => {
        const location = pullRequest.location;
        if (location === null) return null;
        if (locations.size >= LOCATION_CACHE_CAPACITY) {
          const oldest = locations.keys().next().value;
          if (oldest !== undefined) locations.delete(oldest);
        }
        locations.set(key, location);
        return location;
      }),
    );
  };

  /**
   * Everything a diff read needs before it can ask for a file: where the repository lives, and
   * which pushes the pull request has had. A client names neither, and the iterations are read
   * afresh every time because the newest one is what a push adds.
   */
  const diffScope = (input: { readonly cwd: string; readonly number: number }) =>
    Effect.gen(function* () {
      const location = yield* locationOf(input);
      if (location === null) return null;
      const iterations = yield* cli.listIterations({
        cwd: input.cwd,
        location,
        number: input.number,
      });
      return { location, iterations };
    });

  const EMPTY_ITEM: AzureDevOpsItemContent = { contents: "", isBinary: false };

  /**
   * Both sides of one changed file. Only the sides a change actually has are asked for: Azure
   * answers for a file that is not at a commit with a failure rather than with nothing.
   */
  const readTexts = (input: {
    readonly cwd: string;
    readonly location: AzureDevOpsRepositoryLocation;
    readonly iteration: AzureDevOpsIteration;
    readonly change: Pick<AzureDevOpsChangeEntry, "changeKind" | "path" | "oldPath">;
  }) =>
    Effect.gen(function* () {
      const oldItem =
        input.change.changeKind === "new"
          ? EMPTY_ITEM
          : yield* cli.readItemContent({
              cwd: input.cwd,
              location: input.location,
              path: input.change.oldPath,
              commit: input.iteration.mergeBaseCommit,
            });
      const newItem =
        input.change.changeKind === "deleted"
          ? EMPTY_ITEM
          : yield* cli.readItemContent({
              cwd: input.cwd,
              location: input.location,
              path: input.change.path,
              commit: input.iteration.headCommit,
            });
      const texts: AzureDevOpsFileTexts = {
        oldContents: oldItem.contents,
        newContents: newItem.contents,
        // Azure hands a file it calls binary over in an encoding of its own, so its own word on
        // that is taken rather than looked for in bytes it may never have sent verbatim.
        binary: oldItem.isBinary || newItem.isBinary,
      };
      return texts;
    });

  /**
   * What the whole pull request changed, taken from its latest push. An iteration's changes are
   * reported against the merge base rather than against the push before it, so the newest one is
   * the whole of the change rather than the last slice of it.
   */
  const listLatestChanges = (input: {
    readonly cwd: string;
    readonly location: AzureDevOpsRepositoryLocation;
    readonly number: number;
    readonly iterations: ReadonlyArray<AzureDevOpsIteration>;
  }) => {
    const latest = input.iterations.at(-1);
    return latest === undefined
      ? Effect.succeed({ changes: [], truncated: false } as AzureDevOpsIterationChanges)
      : cli.listIterationChanges({
          cwd: input.cwd,
          location: input.location,
          number: input.number,
          iterationId: latest.id,
        });
  };

  const provider: PullRequestProviderApi = {
    kind: "azure-devops",
    capabilities: CAPABILITIES,

    getViewer: (input) =>
      cli.getViewer({ cwd: input.cwd }).pipe(Effect.mapError(fail("getViewer"))),

    // `input.query` is deliberately dropped: `az repos pr list` filters by status, creator,
    // reviewer and branch, and has nothing that matches text. Sending it as one of those would
    // narrow by the wrong thing, so the page comes back unnarrowed and the caller filters it.
    listChangeRequests: (input) =>
      cli
        .listPullRequests({
          cwd: input.cwd,
          repository: input.repository,
          state: input.state,
          involvement: input.involvement,
          viewer: input.viewer,
          limit: input.limit,
          cursor: input.cursor,
        })
        .pipe(
          Effect.mapError(fail("listChangeRequests")),
          Effect.map((batch) => ({
            items: batch.items.map(toChangeRequest),
            truncated: batch.truncated,
            cursorAdvance: batch.cursorAdvance,
            // Azure answers in one order whether or not it is being carried on from, so a slice
            // can always be stepped past — by counting, which is all Azure offers.
            continues: true,
          })),
        ),

    getChangeRequest: (input) =>
      Effect.gen(function* () {
        const pullRequest = yield* cli.getPullRequest({ cwd: input.cwd, number: input.number });
        const location = pullRequest.location;
        // The file count is two reads past the pull request itself, and it is the only thing
        // riding on them, so a failure leaves it unknown rather than losing the whole detail.
        const changedFiles =
          location === null
            ? 0
            : yield* cli.listIterations({ cwd: input.cwd, location, number: input.number }).pipe(
                Effect.flatMap((iterations) =>
                  listLatestChanges({
                    cwd: input.cwd,
                    location,
                    number: input.number,
                    iterations,
                  }),
                ),
                Effect.map((listed) => listed.changes.length),
                Effect.orElseSucceed(() => 0),
              );
        const detail: ProviderChangeRequestDetail = {
          ...toChangeRequest(pullRequest),
          body: pullRequest.body,
          changedFiles,
          mergedAt: pullRequest.state === "merged" ? pullRequest.closedAt : null,
          closedAt: pullRequest.state === "closed" ? pullRequest.closedAt : null,
          reviewers: pullRequest.reviewers,
          checks: [],
          mergeCapabilities: { merge: true, squash: true, rebase: false },
          viewerPermissions: AZURE_DEVOPS_VIEWER_PERMISSIONS,
          autoMergeEnabled: pullRequest.autoMergeEnabled,
          ...(pullRequest.autoMergeMethod === undefined
            ? {}
            : { autoMergeMethod: pullRequest.autoMergeMethod }),
        };
        return detail;
      }).pipe(Effect.mapError(fail("getChangeRequest"))),

    getChangeRequestActivity: (input) =>
      cli.getPullRequest({ cwd: input.cwd, number: input.number }).pipe(
        Effect.mapError(fail("getChangeRequestActivity")),
        Effect.flatMap((pullRequest) =>
          (pullRequest.location === null
            ? Effect.succeed({ comments: [], truncated: true })
            : cli
                .listThreads({
                  cwd: input.cwd,
                  location: pullRequest.location,
                  number: input.number,
                })
                .pipe(
                  Effect.map((comments) => ({ comments, truncated: false })),
                  Effect.orElseSucceed(() => ({ comments: [], truncated: true })),
                )
          ).pipe(
            Effect.map((conversation): ProviderChangeRequestActivity => ({
              comments: conversation.comments,
              commentCount: conversation.comments.length,
              commentsTruncated: conversation.truncated,
              reviewThreads: [],
              commits: [],
            })),
          ),
        ),
      ),

    // No request at all: Azure has nothing to say about the viewer that a pull request read can
    // reach, so the answer is the same constant the detail carries.
    getViewerPermissions: () => Effect.succeed(AZURE_DEVOPS_VIEWER_PERMISSIONS),

    // `input.commit` is deliberately dropped: Azure states no commit list on a pull request, so
    // the Code tab has nothing to scope itself to and always asks for the whole change.
    getDiff: (input) =>
      Effect.gen(function* () {
        const scope = yield* diffScope(input);
        if (scope === null) return EMPTY_DIFF_SLICE;
        const cursor = parseAzureDevOpsDiffCursor(input.cursor);
        // Reading on stays with the push the first slice was taken against. A push landing
        // mid-read would otherwise renumber the files and hand the reader one twice, or none.
        const iteration =
          cursor === null
            ? scope.iterations.at(-1)
            : scope.iterations.find((candidate) => candidate.id === cursor.iterationId);
        if (iteration === undefined) return EMPTY_DIFF_SLICE;
        const listed = yield* cli.listIterationChanges({
          cwd: input.cwd,
          location: scope.location,
          number: input.number,
          iterationId: iteration.id,
        });
        const changes = listed.changes;

        const sections: string[] = [];
        let truncated = listed.truncated;
        let bytes = 0;
        let index = cursor?.fileIndex ?? 0;
        while (index < changes.length) {
          const change = changes.at(index);
          if (change === undefined) break;
          // One file per pair of reads, and a pair Azure refuses is one file rather than the
          // whole slice: an oversize blob or a path `az` will not carry through leaves that file
          // listed without its hunks, and everything around it still renders.
          const texts = yield* readTexts({
            cwd: input.cwd,
            location: scope.location,
            iteration,
            change,
          }).pipe(
            // Only what is this one file's problem. A signed-out CLI, a rate limit or no `az` at
            // all is the read failing rather than the file, and belongs to the caller, which
            // pauses the host rather than showing every file in the change as unreadable.
            Effect.catchTags({
              AzureDevOpsPullRequestNotFoundError: () => Effect.succeed(null),
              AzureDevOpsCommandFailedError: () => Effect.succeed(null),
              AzureDevOpsPullRequestReadError: () => Effect.succeed(null),
            }),
          );
          const file =
            texts === null
              ? azureDevOpsUnreadableFilePatch(change)
              : azureDevOpsFilePatch({ change, texts, timeoutMillis: MAX_FILE_DIFF_MILLIS });
          sections.push(file.section);
          bytes += byteLength(file.section);
          truncated = truncated || file.truncated;
          index += 1;
          // A file whose diff was given up on spent the whole of what one file is allowed and has
          // a header to show for it, so the byte budget would let a change full of them spend that
          // over and over in the one request. The slice ends there instead, and reading on picks
          // up at the file behind it.
          if (bytes >= MAX_DIFF_SLICE_BYTES || file.abandoned) break;
        }

        const slice: ProviderDiffSlice = {
          patch: sections.join(""),
          truncated,
          nextCursor:
            index >= changes.length
              ? null
              : formatAzureDevOpsDiffCursor({ iterationId: iteration.id, fileIndex: index }),
        };
        return slice;
      }).pipe(Effect.mapError(fail("getDiff"))),

    // The patch is built from whole files, so opening the lines around a hunk is the same two
    // reads over again rather than a wider request.
    //
    // Read against the latest iteration, which is the one the patch was taken against unless a
    // push landed in between. Nothing in the request says which push the reader is looking at, so
    // there is no older iteration to go back to: expansion is stale after a mid-review push on
    // every host here, and the diff it belongs to is stale with it.
    getDiffFileContents: (input) =>
      Effect.gen(function* () {
        const scope = yield* diffScope(input);
        const iteration = scope?.iterations.at(-1);
        if (scope === null || iteration === undefined) return { oldContents: "", newContents: "" };
        return yield* readTexts({
          cwd: input.cwd,
          location: scope.location,
          iteration,
          change: {
            changeKind: input.changeType,
            path: input.newPath,
            oldPath: input.oldPath,
          },
        });
      }).pipe(Effect.mapError(fail("getDiffFileContents"))),

    /**
     * What the head has of each marked file, which is the blob Azure already names on the change
     * it reports. One read covers every path: the latest iteration lists the whole change, so
     * asking per file would be the same answer fetched over and over.
     *
     * A path the change does not carry is at the empty revision, which is what a file the pull
     * request deletes is at and leaves it cleared once and cleared for good. When the change was
     * too long to follow to its end, those paths are left out instead: they were not looked at,
     * and reporting them as deleted would clear a file nobody has read.
     */
    getFileRevisions: (input) =>
      Effect.gen(function* () {
        const revisions = new Map<string, string>();
        if (input.paths.length === 0) return { revisions };
        const scope = yield* diffScope(input);
        if (scope === null) return { revisions };
        const listed = yield* listLatestChanges({
          ...scope,
          cwd: input.cwd,
          number: input.number,
        });
        const marked = new Set(input.paths);
        for (const change of listed.changes) {
          if (!marked.has(change.path) || change.objectId === null) continue;
          revisions.set(change.path, change.objectId);
        }
        if (!listed.truncated) {
          for (const path of input.paths) {
            if (!revisions.has(path)) revisions.set(path, "");
          }
        }
        return { revisions };
      }).pipe(Effect.mapError(fail("getFileRevisions"))),

    runAction: (input) =>
      cli
        .runPullRequestAction({
          cwd: input.cwd,
          number: input.number,
          action: input.action,
          ...(input.mergeMethod === undefined ? {} : { mergeMethod: input.mergeMethod }),
        })
        .pipe(Effect.mapError(fail("runAction"))),

    updateChangeRequest: (input) =>
      cli
        .updatePullRequest({
          cwd: input.cwd,
          number: input.number,
          title: input.title,
          body: input.body,
        })
        .pipe(Effect.mapError(fail("updateChangeRequest"))),

    // Never called: `capabilities.reviewers.listCandidates` is false, and the service refuses the
    // list without it.
    listReviewerCandidates: () =>
      Effect.fail(
        new PullRequestProviderError({
          provider: "azure-devops",
          operation: "listReviewerCandidates",
          reason: "failed",
          detail: "Azure DevOps cannot say who may review a pull request.",
        }),
      ),

    setReviewerRequest: (input) =>
      cli
        .setPullRequestReviewers({
          cwd: input.cwd,
          number: input.number,
          // Azure names an identity by an email address or a guid, and has no team to ask, so a
          // candidate's id is the whole of what it takes.
          reviewers: input.reviewers.map((reviewer) => reviewer.id),
          requested: input.requested,
        })
        .pipe(Effect.mapError(fail("setReviewerRequest"))),

    // Never called: `capabilities.comment` is false, and the service refuses a comment without it.
    comment: () => unsupported("comment"),

    // Declared unsupported above, so the service refuses these before a provider is reached.
    // They exist because every provider answers the whole port.
    submitReview: () => unsupported("submitReview"),

    replyToThread: () => unsupported("replyToThread"),

    setThreadResolution: () => unsupported("setThreadResolution"),

    setReaction: () => unsupported("setReaction"),
  };

  return provider;
});
