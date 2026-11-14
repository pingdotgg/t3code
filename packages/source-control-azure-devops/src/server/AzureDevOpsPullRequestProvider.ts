import { resolvePullRequestAuthorFilter, SourceControlProviderKind } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Semaphore from "effect/Semaphore";
import { rollupCheckStatuses } from "@t3tools/source-control-core/server/pullRequestChecks";
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
import { definition } from "../shared/definition.ts";

/** A file the blob batch missed pays for two Python startups. */
const DIFF_FILE_CONCURRENCY = 4;

/** Readers share a spawn budget across requests. */
export const MAX_DIFF_SPAWNS = 2 * DIFF_FILE_CONCURRENCY;

export const LOCATION_CACHE_CAPACITY = 128;

/** A version's change list can run to thousands of paths. */
const CHANGES_CACHE_CAPACITY = 32;

/**
 * Files whose contents one `az` run fetches. The run costs about the same for 10 blobs as for
 * 100, and a slice rarely spends this many before its budgets close it.
 */
export const BLOB_BATCH_FILES = 100;

/** Least recently used goes first. */
function remember<V>(cache: Map<string, V>, capacity: number, key: string, value: V): V {
  cache.delete(key);
  if (cache.size >= capacity) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, value);
  return value;
}

function recall<V>(cache: Map<string, V>, key: string): V | undefined {
  const held = cache.get(key);
  if (held !== undefined) remember(cache, Number.POSITIVE_INFINITY, key, held);
  return held;
}

/** The blobs a file's two sides need, as the change list names them. */
function blobIdsOf(change: AzureDevOpsChangeEntry): ReadonlyArray<string> {
  const ids: string[] = [];
  if (change.changeKind !== "new" && change.originalObjectId !== null) {
    ids.push(change.originalObjectId);
  }
  if (change.changeKind !== "deleted" && change.objectId !== null) ids.push(change.objectId);
  return ids;
}

const CAPABILITIES: PullRequestCapabilities = {
  diff: true,
  comment: false,
  actions: [...definition.changeRequestActions],
  // Azure has no rebase strategy.
  mergeMethods: ["merge", "squash"],
  // `az repos pr list` has no text filter.
  search: false,
  reactions: false,
  mentions: false,
  referenceSigils: [],
  review: { inlineComment: false, reply: false, resolve: false, verdicts: [] },
  // Reviewer candidates require separate identity/graph APIs and permissions.
  reviewers: { request: true, listCandidates: false, searchCandidates: false },
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

function toSummary(pullRequest: AzureDevOpsPullRequest): ProviderChangeRequestSummary {
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
    closedAt: pullRequest.state === "closed" ? pullRequest.closedAt : null,
    mergedAt: pullRequest.state === "merged" ? pullRequest.closedAt : null,
    updatedAt: pullRequest.updatedAt,
  };
}

export const make = Effect.gen(function* () {
  const cli = yield* AzureDevOpsPullRequestCli.AzureDevOpsPullRequestCli;
  const diffSpawns = yield* Semaphore.make(MAX_DIFF_SPAWNS);
  const readItemContent = (input: Parameters<typeof cli.readItemContent>[0]) =>
    diffSpawns.withPermits(1)(cli.readItemContent(input));
  const readBlobs = (input: Parameters<typeof cli.readBlobs>[0]) =>
    diffSpawns.withPermits(1)(cli.readBlobs(input));

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
  // A pushed iteration never changes, so neither do its commits nor its change list.
  const knownIterations = new Map<string, ReadonlyArray<AzureDevOpsIteration>>();
  const iterationChanges = new Map<string, AzureDevOpsPullRequestCli.AzureDevOpsIterationChanges>();

  const locationOf = (input: { readonly cwd: string; readonly number: number }) => {
    const key = `${input.cwd} ${input.number}`;
    const held = recall(locations, key);
    if (held !== undefined) return Effect.succeed(held);
    return cli
      .getPullRequest({ cwd: input.cwd, number: input.number })
      .pipe(
        Effect.map((pullRequest) =>
          pullRequest.location === null
            ? null
            : remember(locations, LOCATION_CACHE_CAPACITY, key, pullRequest.location),
        ),
      );
  };

  const readChecks = (input: { readonly cwd: string }, pullRequest: AzureDevOpsPullRequest) =>
    cli.listPolicyChecks({
      cwd: input.cwd,
      number: pullRequest.number,
      isDraft: pullRequest.isDraft,
    });

  /** A later slice names its iteration, which the list it was cut from already holds. */
  const diffScope = Effect.fn("AzureDevOpsPullRequestProvider.diffScope")(function* (input: {
    readonly cwd: string;
    readonly number: number;
    readonly iterationId?: number;
  }) {
    const location = yield* locationOf(input);
    if (location === null) return null;
    const key = `${input.cwd} ${input.number}`;
    const held = recall(knownIterations, key);
    if (
      input.iterationId !== undefined &&
      held?.some((iteration) => iteration.id === input.iterationId)
    ) {
      return { location, iterations: held };
    }
    const iterations = yield* cli.listIterations({
      cwd: input.cwd,
      location,
      number: input.number,
    });
    remember(knownIterations, LOCATION_CACHE_CAPACITY, key, iterations);
    return { location, iterations };
  });

  const changesOf = (input: {
    readonly cwd: string;
    readonly location: AzureDevOpsRepositoryLocation;
    readonly number: number;
    readonly iterationId: number;
  }) => {
    const key = `${input.cwd} ${input.number} ${input.iterationId}`;
    const held = recall(iterationChanges, key);
    return held !== undefined
      ? Effect.succeed(held)
      : cli
          .listIterationChanges(input)
          .pipe(
            Effect.map((listed) => remember(iterationChanges, CHANGES_CACHE_CAPACITY, key, listed)),
          );
  };

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
      : changesOf({
          cwd: input.cwd,
          location: input.location,
          number: input.number,
          iterationId: latest.id,
        });
  };

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

    getChangeRequestChecks: Effect.fn("AzureDevOpsPullRequestProvider.getChangeRequestChecks")(
      function* (input) {
        const pullRequest = yield* cli.getPullRequest({ cwd: input.cwd, number: input.number });
        const checks = yield* readChecks(input, pullRequest);
        return { state: pullRequest.state, checks };
      },
      Effect.mapError(fail("getChangeRequestChecks")),
    ),

    getChangeRequestSummary: Effect.fn("AzureDevOpsPullRequestProvider.getChangeRequestSummary")(
      function* (input) {
        const pullRequest = yield* cli.getPullRequest({ cwd: input.cwd, number: input.number });
        // Undefined keeps the last known state; null would claim no checks exist.
        const checksState = yield* readChecks(input, pullRequest).pipe(
          Effect.map((checks) => rollupCheckStatuses(checks.map((check) => check.status))),
          Effect.orElseSucceed(() => undefined),
        );
        return {
          ...toSummary(pullRequest),
          ...(checksState === undefined ? {} : { checksState }),
        };
      },
      Effect.mapError(fail("getChangeRequestSummary")),
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
        const checks = yield* readChecks(input, pullRequest).pipe(Effect.orElseSucceed(() => []));
        const detail: ProviderChangeRequestDetail = {
          ...toChangeRequest(pullRequest),
          body: pullRequest.body,
          ...(headSha === undefined ? {} : { headSha }),
          changedFiles,
          mergedAt: pullRequest.state === "merged" ? pullRequest.closedAt : null,
          closedAt: pullRequest.state === "closed" ? pullRequest.closedAt : null,
          reviewers: pullRequest.reviewers,
          checks,
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
        const cursor = parseAzureDevOpsDiffCursor(input.cursor);
        const scope = yield* diffScope({
          cwd: input.cwd,
          number: input.number,
          ...(cursor === null ? {} : { iterationId: cursor.iterationId }),
        });
        if (scope === null) return EMPTY_DIFF_SLICE;
        const iteration =
          cursor === null
            ? scope.iterations.at(-1)
            : scope.iterations.find((candidate) => candidate.id === cursor.iterationId);
        if (iteration === undefined) return EMPTY_DIFF_SLICE;
        const listed = yield* changesOf({
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
        let blobs: ReadonlyMap<string, AzureDevOpsItemContent> = new Map();
        let blobsUntil = index;
        const fromBlobs = (change: AzureDevOpsChangeEntry): AzureDevOpsFileTexts | null => {
          const side = (id: string | null) =>
            id === null ? undefined : blobs.get(id.toLowerCase());
          const oldItem = change.changeKind === "new" ? EMPTY_ITEM : side(change.originalObjectId);
          const newItem = change.changeKind === "deleted" ? EMPTY_ITEM : side(change.objectId);
          return oldItem === undefined || newItem === undefined
            ? null
            : {
                oldContents: oldItem.contents,
                newContents: newItem.contents,
                binary: oldItem.isBinary || newItem.isBinary,
              };
        };
        while (!full && index < changes.length) {
          if (index >= blobsUntil) {
            blobsUntil = index + BLOB_BATCH_FILES;
            blobs = yield* readBlobs({
              cwd: input.cwd,
              location: scope.location,
              objectIds: changes.slice(index, blobsUntil).flatMap(blobIdsOf),
            }).pipe(
              // Per-file reads then answer, or fail, for each file.
              Effect.catchTags({
                AzureDevOpsPullRequestNotFoundError: () => Effect.succeed(new Map()),
                AzureDevOpsCommandFailedError: () => Effect.succeed(new Map()),
                AzureDevOpsPullRequestReadError: () => Effect.succeed(new Map()),
              }),
            );
          }
          const batch = changes.slice(index, Math.min(index + batchWidth(), blobsUntil));
          const read = yield* Effect.forEach(
            batch,
            (change) =>
              Effect.suspend(() => {
                const held = fromBlobs(change);
                return held === null
                  ? readTexts({ cwd: input.cwd, location: scope.location, iteration, change })
                  : Effect.succeed(held);
              }).pipe(
                // Auth, rate-limit and CLI failures must reach the caller.
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
            // Synchronous diffs need yields to let other server work run.
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
        .pipe(
          Effect.mapError(fail("runAction")),
          Effect.map(
            (pullRequest) =>
              pullRequest && {
                ...toSummary(pullRequest),
                autoMergeEnabled: pullRequest.autoMergeEnabled,
                ...(pullRequest.autoMergeMethod === undefined
                  ? {}
                  : { autoMergeMethod: pullRequest.autoMergeMethod }),
              },
          ),
        ),

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
