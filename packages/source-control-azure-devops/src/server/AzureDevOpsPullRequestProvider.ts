import { resolvePullRequestAuthorFilter, SourceControlProviderKind } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Semaphore from "effect/Semaphore";
import type { PullRequestCapabilities, PullRequestViewerPermissions } from "@t3tools/contracts";

import * as AzureDevOpsPullRequestCli from "./AzureDevOpsPullRequestCli.ts";
import {
  azureDevOpsFilePatch,
  azureDevOpsUnreadableFilePatch,
  formatAzureDevOpsDiffCursor,
  parseAzureDevOpsDiffCursor,
  MAX_DIFF_SLICE_BYTES,
  MAX_DIFF_SLICE_EDITS,
  MAX_DIFF_SLICE_FILES,
  byteLength,
  MAX_FILE_DIFF_EDITS,
  type AzureDevOpsFileTexts,
} from "./azureDevOpsDiff.ts";
import {
  PullRequestProviderError,
  type PullRequestProviderFailure,
  type ProviderChangeRequest,
  type ProviderChangeRequestActivity,
  type ProviderChangeRequestDetail,
  type ProviderChangeRequestSummary,
  type ProviderDiffSlice,
  type PullRequestProviderApi,
} from "@t3tools/source-control-core/server/PullRequestProvider";
import type {
  AzureDevOpsChangeEntry,
  AzureDevOpsItemContent,
  AzureDevOpsIteration,
  AzureDevOpsPullRequest,
  AzureDevOpsRepositoryLocation,
} from "./azureDevOpsPullRequestJson.ts";
import { definition } from "../client/definition.ts";

/**
 * Every file is two `az` invocations, each paying a Python interpreter's start-up, so reading them
 * one after another is most of what the Code tab waits for.
 */
const DIFF_FILE_CONCURRENCY = 4;

/**
 * How many `az` processes this build will have out at once, counted across every reader rather than
 * per request. Held at what one request at full width spends, so a second reader waits behind the
 * first instead of adding to it.
 */
export const MAX_DIFF_SPAWNS = 2 * DIFF_FILE_CONCURRENCY;

export const LOCATION_CACHE_CAPACITY = 128;

const CAPABILITIES: PullRequestCapabilities = {
  diff: true,
  comment: false,
  actions: [...definition.changeRequestActions],
  // Azure squashes as a completion option; it has no rebase strategy of its own.
  mergeMethods: ["merge", "squash"],
  // `az repos pr list` filters by status, creator, reviewer and branch, and by no text at all.
  search: false,
  reactions: false,
  review: { inlineComment: false, reply: false, resolve: false, verdicts: [] },
  // `az repos pr reviewer add` and `remove` name identities, and nothing anywhere in `az repos`
  // lists the ones this repository could name — that lives behind the identity and graph APIs, a
  // different service with its own permissions.
  reviewers: { request: true, listCandidates: false },
  edit: { changeRequest: true, comment: false },
  // Azure does keep a viewed record of its own, but only behind the undocumented contribution
  // endpoint its web UI talks to, keyed on an iteration so a push would drop every mark anyway.
  viewedFiles: "environment",
};

/**
 * Azure DevOps states no permission anywhere `az repos pr show` or `az repos pr list` reach: the
 * answer lives in the security namespaces, behind identity descriptors and token paths that would
 * be several calls per pull request to resolve.
 */
const AZURE_DEVOPS_VIEWER_PERMISSIONS: PullRequestViewerPermissions = {
  actions: CAPABILITIES.actions,
  comment: CAPABILITIES.comment,
  resolve: CAPABILITIES.review.resolve,
  verdicts: CAPABILITIES.review.verdicts,
  requestReviewers: CAPABILITIES.reviewers.request,
};

function azureDevOpsProviderFailure(
  error: AzureDevOpsPullRequestCli.AzureDevOpsPullRequestCliError,
): PullRequestProviderFailure {
  if (error._tag === "AzureDevOpsCliUnavailableError") return { reason: "missing-tool" };
  if (error._tag === "AzureDevOpsCliAuthenticationError") return { reason: "unauthenticated" };
  if (error._tag === "AzureDevOpsCliRateLimitError") return { reason: "rate-limited" };
  if (error._tag === "AzureDevOpsPullRequestNotFoundError") return { reason: "not-found" };
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
    closedAt: pullRequest.state === "closed" ? pullRequest.closedAt : null,
    mergedAt: pullRequest.state === "merged" ? pullRequest.closedAt : null,
    updatedAt: pullRequest.updatedAt,
    reviewRequestLogins: pullRequest.reviewRequestLogins,
    // Azure keeps labels on work items rather than on the pull request.
    labels: [],
  };
}

export const make = Effect.gen(function* () {
  const cli = yield* AzureDevOpsPullRequestCli.AzureDevOpsPullRequestCli;
  const diffSpawns = yield* Semaphore.make(MAX_DIFF_SPAWNS);
  const readItemContent = (input: Parameters<typeof cli.readItemContent>[0]) =>
    diffSpawns.withPermits(1)(cli.readItemContent(input));

  const fail =
    (operation: string) => (error: AzureDevOpsPullRequestCli.AzureDevOpsPullRequestCliError) =>
      new PullRequestProviderError({
        provider: SourceControlProviderKind.make("azure-devops"),
        operation,
        ...azureDevOpsProviderFailure(error),
        detail: error.detail,
        cause: error,
      });

  const unsupported = (operation: string) =>
    Effect.fail(
      new PullRequestProviderError({
        provider: SourceControlProviderKind.make("azure-devops"),
        operation,
        reason: "failed",
        detail: "Azure DevOps reviews cannot be written from here yet.",
      }),
    );

  const EMPTY_DIFF_SLICE: ProviderDiffSlice = { patch: "", truncated: false, nextCursor: null };

  /**
   * A pull request cannot move between repositories, so it is remembered rather than re-read: the
   * marks alone would otherwise pay for a whole pull request read every time they checked whether a
   * file had been pushed to. Least recently used, so a listing walking cold pull requests cannot
   * evict the one being read.
   */
  const locations = new Map<string, AzureDevOpsRepositoryLocation>();

  const locationOf = (input: { readonly cwd: string; readonly number: number }) => {
    const key = `${input.cwd} ${input.number}`;
    const held = locations.get(key);
    if (held !== undefined) {
      locations.delete(key);
      locations.set(key, held);
      return Effect.succeed(held);
    }
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

  const diffScope = Effect.fn("AzureDevOpsPullRequestProvider.diffScope")(function* (input: {
    readonly cwd: string;
    readonly number: number;
  }) {
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
   * Only the sides a change actually has are asked for: Azure answers for a file that is not at a
   * commit with a failure rather than with nothing.
   */
  const readTexts = (input: {
    readonly cwd: string;
    readonly location: AzureDevOpsRepositoryLocation;
    readonly iteration: AzureDevOpsIteration;
    readonly change: Pick<AzureDevOpsChangeEntry, "changeKind" | "path" | "oldPath">;
  }) =>
    Effect.all(
      [
        input.change.changeKind === "new"
          ? Effect.succeed(EMPTY_ITEM)
          : readItemContent({
              cwd: input.cwd,
              location: input.location,
              path: input.change.oldPath,
              commit: input.iteration.mergeBaseCommit,
            }),
        input.change.changeKind === "deleted"
          ? Effect.succeed(EMPTY_ITEM)
          : readItemContent({
              cwd: input.cwd,
              location: input.location,
              path: input.change.path,
              commit: input.iteration.headCommit,
            }),
      ],
      { concurrency: 2 },
    ).pipe(
      Effect.map(([oldItem, newItem]): AzureDevOpsFileTexts => ({
        oldContents: oldItem.contents,
        newContents: newItem.contents,
        // Azure hands a file it calls binary over in an encoding of its own, so its own word on
        // that is taken rather than looked for in bytes it may never have sent verbatim.
        binary: oldItem.isBinary || newItem.isBinary,
      })),
    );

  /**
   * An iteration's changes are reported against the merge base rather than against the push before
   * it, so the newest one is the whole of the change rather than the last slice of it.
   */
  const listLatestChanges = (input: {
    readonly cwd: string;
    readonly location: AzureDevOpsRepositoryLocation;
    readonly number: number;
    readonly iterations: ReadonlyArray<AzureDevOpsIteration>;
  }) => {
    const latest = input.iterations.at(-1);
    return latest === undefined
      ? Effect.succeed({
          changes: [],
          truncated: false,
        } as AzureDevOpsPullRequestCli.AzureDevOpsIterationChanges)
      : cli.listIterationChanges({
          cwd: input.cwd,
          location: input.location,
          number: input.number,
          iterationId: latest.id,
        });
  };

  const provider: PullRequestProviderApi = {
    kind: SourceControlProviderKind.make("azure-devops"),
    capabilities: CAPABILITIES,
    // The bare repository name repeats across an organization; the project path does not.
    repositoryKey: ({ canonicalKey }) => canonicalKey,

    getViewer: (input) =>
      cli.getViewer({ cwd: input.cwd }).pipe(Effect.mapError(fail("getViewer"))),

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
          author:
            input.filters?.author === undefined
              ? undefined
              : resolvePullRequestAuthorFilter(input.filters.author, input.viewer),
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

    getChangeRequestSummary: (input) =>
      cli.getPullRequest({ cwd: input.cwd, number: input.number }).pipe(
        Effect.mapError(fail("getChangeRequestSummary")),
        Effect.map((pullRequest): ProviderChangeRequestSummary => ({
          number: pullRequest.number,
          title: pullRequest.title,
          url: pullRequest.url,
          author: pullRequest.author,
          headBranch: pullRequest.headBranch,
          baseBranch: pullRequest.baseBranch,
          state: pullRequest.state,
          isDraft: pullRequest.isDraft,
          mergeability: pullRequest.mergeability,
          closedAt: pullRequest.state === "closed" ? pullRequest.closedAt : null,
          mergedAt: pullRequest.state === "merged" ? pullRequest.closedAt : null,
          updatedAt: pullRequest.updatedAt,
        })),
      ),

    getChangeRequest: Effect.fn("AzureDevOpsPullRequestProvider.getChangeRequest")(
      function* (input) {
        const pullRequest = yield* cli.getPullRequest({ cwd: input.cwd, number: input.number });
        const location = pullRequest.location;
        const iterations =
          location === null
            ? []
            : yield* cli
                .listIterations({ cwd: input.cwd, location, number: input.number })
                .pipe(Effect.orElseSucceed(() => []));
        // The trial merge's lastMergeSourceCommit can lag behind a new source push.
        const headSha = iterations.at(-1)?.headCommit;
        const changedFiles =
          location === null
            ? 0
            : yield* listLatestChanges({
                cwd: input.cwd,
                location,
                number: input.number,
                iterations,
              }).pipe(
                Effect.map((listed) => listed.changes.length),
                Effect.orElseSucceed(() => 0),
              );
        const detail: ProviderChangeRequestDetail = {
          ...toChangeRequest(pullRequest),
          body: pullRequest.body,
          ...(headSha === undefined ? {} : { headSha }),
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
      },
      Effect.mapError(fail("getChangeRequest")),
    ),

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

    getViewerPermissions: () => Effect.succeed(AZURE_DEVOPS_VIEWER_PERMISSIONS),

    // `input.commit` is deliberately dropped: Azure states no commit list on a pull request, so
    // the Code tab has nothing to scope itself to and always asks for the whole change.
    getDiff: Effect.fn("AzureDevOpsPullRequestProvider.getDiff")(
      function* (input) {
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
        let edits = 0;
        let index = cursor?.fileIndex ?? 0;
        let full = false;
        // Every file costs a request a side, and everything read past the point the slice fills is
        // thrown away and read again by the next slice, so the batch narrows as the budgets do:
        // what is left of each, over what a file has spent of it on average so far, which is the
        // only estimate there is before a file is read.
        const batchWidth = () => {
          if (sections.length === 0) return DIFF_FILE_CONCURRENCY;
          const admits = (left: number, spent: number) =>
            Math.ceil(left / Math.max(1, spent / sections.length));
          return Math.max(
            1,
            Math.min(
              DIFF_FILE_CONCURRENCY,
              MAX_DIFF_SLICE_FILES - sections.length,
              admits(MAX_DIFF_SLICE_BYTES - bytes, bytes),
              admits(MAX_DIFF_SLICE_EDITS - MAX_FILE_DIFF_EDITS - edits, edits),
            ),
          );
        };
        while (!full && index < changes.length) {
          const batch = changes.slice(index, index + batchWidth());
          const read = yield* Effect.forEach(
            batch,
            (change) =>
              readTexts({ cwd: input.cwd, location: scope.location, iteration, change }).pipe(
                // Only what is this one file's problem. A signed-out CLI, a rate limit or no `az`
                // at all is the read failing rather than the file, and belongs to the caller,
                // which pauses the host rather than showing every file as unreadable.
                Effect.catchTags({
                  AzureDevOpsPullRequestNotFoundError: () => Effect.succeed(null),
                  AzureDevOpsCommandFailedError: () => Effect.succeed(null),
                  AzureDevOpsPullRequestReadError: () => Effect.succeed(null),
                }),
                Effect.map((texts) => ({ change, texts })),
              ),
            { concurrency: DIFF_FILE_CONCURRENCY },
          );
          for (const { change, texts } of read) {
            // The diff is synchronous and the reads no longer stand between one file and the next
            // to let anything else on the server run, so the thread is handed back here.
            yield* Effect.yieldNow;
            const file =
              texts === null
                ? azureDevOpsUnreadableFilePatch(change)
                : azureDevOpsFilePatch({ change, texts });
            sections.push(file.section);
            bytes += byteLength(file.section);
            edits += file.edits;
            truncated = truncated || file.truncated;
            index += 1;
            // Checked after the file is added rather than before it, so every slice carries at
            // least one: a section heavier than the whole budget would otherwise never be added,
            // and the read would answer the same slice forever without moving the cursor.
            if (
              bytes >= MAX_DIFF_SLICE_BYTES ||
              edits + MAX_FILE_DIFF_EDITS > MAX_DIFF_SLICE_EDITS ||
              sections.length >= MAX_DIFF_SLICE_FILES ||
              file.abandoned
            ) {
              full = true;
              break;
            }
          }
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
      },
      Effect.mapError(fail("getDiff")),
    ),

    getDiffFileContents: Effect.fn("AzureDevOpsPullRequestProvider.getDiffFileContents")(
      function* (input) {
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
      },
      Effect.mapError(fail("getDiffFileContents")),
    ),

    /**
     * A path the change does not carry is at the empty revision, which is where a file the pull
     * request deletes sits. When the change was too long to follow to its end, those paths are left
     * out instead: reporting them as deleted would clear a file nobody has read.
     */
    getFileRevisions: Effect.fn("AzureDevOpsPullRequestProvider.getFileRevisions")(
      function* (input) {
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
      },
      Effect.mapError(fail("getFileRevisions")),
    ),

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

    listReviewerCandidates: () =>
      Effect.fail(
        new PullRequestProviderError({
          provider: SourceControlProviderKind.make("azure-devops"),
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
          reviewers: input.reviewers.map((reviewer) => reviewer.id),
          requested: input.requested,
        })
        .pipe(Effect.mapError(fail("setReviewerRequest"))),

    comment: () => unsupported("comment"),

    submitReview: () => unsupported("submitReview"),

    replyToThread: () => unsupported("replyToThread"),

    setThreadResolution: () => unsupported("setThreadResolution"),

    setReaction: () => unsupported("setReaction"),
  };

  return provider;
});
