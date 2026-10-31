import { resolvePullRequestAuthorFilter, SourceControlProviderKind } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Semaphore from "effect/Semaphore";
import type { PullRequestCapabilities, PullRequestViewerPermissions } from "@t3tools/contracts";

import * as AzureDevOpsPullRequestCli from "./AzureDevOpsPullRequestCli.ts";
import {
  azureDevOpsFileDiffPatch,
  azureDevOpsFilePatch,
  azureDevOpsUnreadableFilePatch,
  formatAzureDevOpsDiffCursor,
  parseAzureDevOpsDiffCursor,
  MAX_DIFF_SLICE_BYTES,
  MAX_DIFF_SLICE_EDITS,
  MAX_DIFF_SLICE_FILES,
  byteLength,
  MAX_FILE_DIFF_EDITS,
  type AzureDevOpsDiffCursor,
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
  AzureDevOpsFileDiff,
  AzureDevOpsItemContent,
  AzureDevOpsIteration,
  AzureDevOpsPullRequest,
  AzureDevOpsRepositoryLocation,
} from "./azureDevOpsPullRequestJson.ts";
import { definition } from "../shared/definition.ts";

/** Each file pays for two Python startups. */
const DIFF_FILE_CONCURRENCY = 4;

/** Readers share a spawn budget across requests. */
export const MAX_DIFF_SPAWNS = 2 * DIFF_FILE_CONCURRENCY;

/** Files asked of the files diff per call; one call is one `az` startup. */
export const FILES_DIFF_PAGE_SIZE = 50;

export const LOCATION_CACHE_CAPACITY = 128;

/** A page of the files diff and where in its list it began. */
interface FilesDiffPage {
  readonly cwd: string;
  readonly number: number;
  readonly iteration: AzureDevOpsIteration;
  readonly start: number;
  readonly files: ReadonlyArray<AzureDevOpsFileDiff>;
}

/** What a diff request reads: nothing to go on, or the files from its cursor's position on. */
type OpenedDiff =
  | { readonly _tag: "closed"; readonly slice: ProviderDiffSlice }
  | {
      readonly _tag: "open";
      readonly source: AzureDevOpsDiffCursor["source"];
      readonly iteration: AzureDevOpsIteration;
      /** A file without blocks has to be read to be diffed. */
      readonly files: ReadonlyArray<AzureDevOpsFileDiff>;
      /** The files diff comes a page at a time; the iteration changes come whole. */
      readonly hasMore: boolean;
      readonly truncated: boolean;
    };

const CAPABILITIES: PullRequestCapabilities = {
  diff: true,
  comment: false,
  actions: [...definition.changeRequestActions],
  // Azure has no rebase strategy.
  mergeMethods: ["merge", "squash"],
  // `az repos pr list` has no text filter.
  search: false,
  reactions: false,
  review: { inlineComment: false, reply: false, resolve: false, verdicts: [] },
  // Reviewer candidates require separate identity/graph APIs and permissions.
  reviewers: { request: true, listCandidates: false },
  edit: { changeRequest: true, comment: false },
  // Azure's viewed marks use an undocumented endpoint and are invalidated by each push.
  viewedFiles: "environment",
};

const UNAVAILABLE_REQUIREMENT = {
  missing:
    "Azure CLI (`az`) with the Azure DevOps extension is required. Install `az`, then run `az extension add --name azure-devops`.",
  unauthenticated: "Azure CLI is not signed in. Run `az login` and retry.",
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
    // Azure omits line counts; computing them requires both sides of every file.
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

  // PR locations are immutable; caching avoids full PR reads for viewed-file checks.
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

  /** Azure fails reads of absent files. */
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
        // Encoded bytes cannot identify binaries; trust Azure's metadata.
        binary: oldItem.isBinary || newItem.isBinary,
      })),
    );

  /** A file's patch from Azure's blocks when they stand for it, otherwise from reading the file. */
  const patchFile = Effect.fn("AzureDevOpsPullRequestProvider.patchFile")(function* (input: {
    readonly cwd: string;
    readonly location: AzureDevOpsRepositoryLocation;
    readonly iteration: AzureDevOpsIteration;
    readonly file: AzureDevOpsFileDiff;
  }) {
    const { change, blocks } = input.file;
    // Synchronous diffs need yields to let other server work run.
    yield* Effect.yieldNow;
    const fromBlocks = blocks === null ? null : azureDevOpsFileDiffPatch({ change, blocks });
    if (fromBlocks !== null) return fromBlocks;
    const texts = yield* readTexts({
      cwd: input.cwd,
      location: input.location,
      iteration: input.iteration,
      change,
    }).pipe(
      // Auth, rate-limit and CLI failures must reach the caller.
      Effect.catchTags({
        AzureDevOpsPullRequestNotFoundError: () => Effect.succeed(null),
        AzureDevOpsCommandFailedError: () => Effect.succeed(null),
        AzureDevOpsPullRequestReadError: () => Effect.succeed(null),
      }),
    );
    return texts === null
      ? azureDevOpsUnreadableFilePatch(change)
      : azureDevOpsFilePatch({ change, texts });
  });

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

  /** The last page the files diff gave, for the next slice of a walk that stopped inside it. */
  let heldPage: FilesDiffPage | undefined;

  /**
   * Where a diff walk reads from. It begins on the files diff, one `az` call for a page of files
   * and their blocks, and reads each file instead when Azure cannot give one. A cursor names the
   * source it was written for, because the two list files in different orders.
   */
  const openDiff = Effect.fn("AzureDevOpsPullRequestProvider.openDiff")(function* (input: {
    readonly cwd: string;
    readonly location: AzureDevOpsRepositoryLocation;
    readonly number: number;
    readonly cursor: AzureDevOpsDiffCursor | null;
  }): Effect.fn.Return<OpenedDiff, AzureDevOpsPullRequestCli.AzureDevOpsPullRequestCliError> {
    const { cursor, ...scope } = input;
    const start = cursor?.fileIndex ?? 0;
    // Azure orders each page by itself, so a file index only means something in the page it was
    // counted in, and a walk always asks for pages from a multiple of the page size.
    const pageStart = start - (start % FILES_DIFF_PAGE_SIZE);

    const openChanges = (iteration: AzureDevOpsIteration) =>
      cli.listIterationChanges({ ...scope, iterationId: iteration.id }).pipe(
        Effect.map((listed): OpenedDiff => ({
          _tag: "open",
          source: "changes",
          iteration,
          files: listed.changes.slice(start).map((change) => ({ change, blocks: null })),
          hasMore: false,
          truncated: listed.truncated,
        })),
      );

    const openPage = (page: FilesDiffPage): OpenedDiff => ({
      _tag: "open",
      source: "filesdiff",
      iteration: page.iteration,
      files: page.files.slice(start - page.start),
      hasMore: page.files.length === FILES_DIFF_PAGE_SIZE,
      truncated: false,
    });

    // A walk that began on the iteration changes carries on there.
    if (cursor?.source === "changes") {
      const iteration = (yield* cli.listIterations(scope)).find(
        (candidate) => candidate.id === cursor.iterationId,
      );
      return iteration === undefined
        ? { _tag: "closed", slice: EMPTY_DIFF_SLICE }
        : yield* openChanges(iteration);
    }

    const held = heldPage;
    if (
      cursor !== null &&
      held !== undefined &&
      held.cwd === scope.cwd &&
      held.number === scope.number &&
      held.iteration.id === cursor.iterationId &&
      held.start <= start &&
      start < held.start + held.files.length
    ) {
      return openPage(held);
    }

    // The latest iteration pins the walk, so it is read alongside the page. A push between the
    // two reads can still mix iterations in one page, which nothing later catches.
    const [iterations, listed] = yield* Effect.all(
      [
        cli.listIterations(scope),
        cli
          .listFilesDiff({ ...scope, top: FILES_DIFF_PAGE_SIZE, skip: pageStart })
          .pipe(Effect.result),
      ],
      { concurrency: 2 },
    );
    const iteration = iterations.at(-1);
    if (iteration === undefined) return { _tag: "closed", slice: EMPTY_DIFF_SLICE };
    if (cursor !== null && iteration.id !== cursor.iterationId) {
      // A push since the walk began; the files diff now lists another change.
      return { _tag: "closed", slice: { ...EMPTY_DIFF_SLICE, truncated: true } };
    }
    if (Result.isFailure(listed)) {
      if (cursor === null) return yield* openChanges(iteration);
      // A walk under way has no other order to carry on in. A page that cannot be read, being
      // too large, will not read on a retry, so it is skipped rather than ending the walk.
      if (listed.failure._tag !== "AzureDevOpsPullRequestReadError") return yield* listed.failure;
      return {
        _tag: "closed",
        slice: {
          patch: "",
          truncated: true,
          nextCursor: formatAzureDevOpsDiffCursor({
            iterationId: iteration.id,
            fileIndex: pageStart + FILES_DIFF_PAGE_SIZE,
            source: "filesdiff",
          }),
        },
      };
    }
    // An empty first page cannot be told from one Azure failed to fill.
    if (cursor === null && listed.success.length === 0) return yield* openChanges(iteration);
    // A page that has shrunk under a walk part-way through it has lost the walk's place.
    if (start > pageStart && listed.success.length <= start - pageStart) {
      return { _tag: "closed", slice: { ...EMPTY_DIFF_SLICE, truncated: true } };
    }
    heldPage = { ...scope, iteration, start: pageStart, files: listed.success };
    return openPage(heldPage);
  });

  const provider: PullRequestProviderApi = {
    kind: SourceControlProviderKind.make("azure-devops"),
    capabilities: CAPABILITIES,
    unavailableRequirement: UNAVAILABLE_REQUIREMENT,
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
            // Azure's ordering is stable across offset-based pages.
            continues: true,
          })),
        ),

    getChangeRequestPreview: (input) =>
      cli.getPullRequest({ cwd: input.cwd, number: input.number }).pipe(
        Effect.mapError(fail("getChangeRequestPreview")),
        Effect.map((pullRequest) => ({
          number: pullRequest.number,
          title: pullRequest.title,
          url: pullRequest.url,
          author: pullRequest.author,
          state: pullRequest.state,
          isDraft: pullRequest.isDraft,
          createdAt: pullRequest.createdAt,
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
        const location = yield* locationOf(input);
        if (location === null) return EMPTY_DIFF_SLICE;
        const cursor = parseAzureDevOpsDiffCursor(input.cursor);

        const opened = yield* openDiff({
          cwd: input.cwd,
          location,
          number: input.number,
          cursor,
        });
        if (opened._tag === "closed") return opened.slice;
        const { iteration, source, files } = opened;

        const sections: string[] = [];
        let truncated = opened.truncated;
        let bytes = 0;
        let edits = 0;
        // Files of this request patched so far; the rest wait for the next slice.
        let patched = 0;
        let full = false;
        // Prefetched files beyond the slice must be read again.
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
        while (!full && patched < files.length) {
          const batch = files.slice(patched, patched + batchWidth());
          const patches = yield* Effect.forEach(
            batch,
            (file) => patchFile({ cwd: input.cwd, location, iteration, file }),
            { concurrency: DIFF_FILE_CONCURRENCY },
          );
          for (const file of patches) {
            sections.push(file.section);
            bytes += byteLength(file.section);
            edits += file.edits;
            truncated = truncated || file.truncated;
            patched += 1;
            // Add a file before checking budgets so oversized files cannot stall the cursor.
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

        // A page read to its end is not asked for again, so it need not stay in memory.
        if (source === "filesdiff" && patched >= files.length) heldPage = undefined;

        const slice: ProviderDiffSlice = {
          patch: sections.join(""),
          truncated,
          nextCursor:
            patched >= files.length && !opened.hasMore
              ? null
              : formatAzureDevOpsDiffCursor({
                  iterationId: iteration.id,
                  fileIndex: (cursor?.fileIndex ?? 0) + patched,
                  source,
                }),
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
