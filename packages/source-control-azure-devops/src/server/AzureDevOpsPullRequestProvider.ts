import { SourceControlProviderKind } from "@t3tools/contracts";
import * as Cache from "effect/Cache";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import type { PullRequestCapabilities, PullRequestViewerPermissions } from "@t3tools/contracts";

import * as AzureDevOpsCli from "./AzureDevOpsCli.ts";
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

/**
 * How long one permission read answers for. The service checks a write and the guard here checks
 * it again, and each read is a Python process and seven host requests. An explicit refresh drops
 * it at once through `invalidate`.
 */
const ACCESS_TTL = "30 seconds";

const CAPABILITIES: PullRequestCapabilities = {
  diff: true,
  comment: true,
  actions: [...definition.changeRequestActions],
  // The shared merge action exposes merge and squash; native completion also offers both rebase strategies.
  mergeMethods: ["merge", "squash"],
  // `az repos pr list` filters by status, creator, reviewer and branch, and by no text at all.
  search: false,
  reactions: false,
  commentLikes: true,
  hostActions: true,
  labels: true,
  review: {
    inlineComment: true,
    reply: true,
    resolve: true,
    threadStatuses: ["active", "pending", "fixed", "wontFix", "closed", "byDesign"],
    verdicts: ["comment", "approve", "request-changes"],
  },
  // Candidates are the organization's users and the project's groups. Reading them needs more
  // access than a code-scoped token has, so the list then falls back to the current reviewers.
  reviewers: { request: true, listCandidates: true },
  // A new title and description travel on the same `az repos pr update` that moves a pull request.
  edit: { changeRequest: true, comment: true, deleteComment: true },
  viewedFiles: "host",
};

const AZURE_DEVOPS_VIEWER_PERMISSIONS: PullRequestViewerPermissions = {
  actions: CAPABILITIES.actions,
  comment: CAPABILITIES.comment || CAPABILITIES.review.reply,
  resolve: CAPABILITIES.review.resolve,
  verdicts: CAPABILITIES.review.verdicts,
  requestReviewers: CAPABILITIES.reviewers.request,
  labels: true,
};

const isNativeRequestError = Schema.is(AzureDevOpsCli.AzureDevOpsNativeRequestError);
const isReadError = Schema.is(AzureDevOpsPullRequestCli.AzureDevOpsPullRequestReadError);

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
    labels: pullRequest.labels ?? [],
  };
}

export const make = Effect.gen(function* () {
  const cli = yield* AzureDevOpsPullRequestCli.AzureDevOpsPullRequestCli;
  const diffSpawns = yield* Semaphore.make(MAX_DIFF_SPAWNS);
  const readItemContent = (input: Parameters<typeof cli.readItemContent>[0]) =>
    diffSpawns.withPermits(1)(cli.readItemContent(input));

  const fail =
    (operation: string) =>
    (error: AzureDevOpsPullRequestCli.AzureDevOpsPullRequestCliError | PullRequestProviderError) =>
      error._tag === "PullRequestProviderError"
        ? error
        : new PullRequestProviderError({
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
        detail: `Azure DevOps cannot perform ${operation} with this selection.`,
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
    return cli
      .getPullRequest({ cwd: input.cwd, number: input.number })
      .pipe(Effect.map((pullRequest) => rememberLocation(input, pullRequest.location)));
  };
  const rememberLocation = (
    input: { readonly cwd: string; readonly number: number },
    location: AzureDevOpsRepositoryLocation | null,
  ) => {
    if (location === null) return null;
    const key = `${input.cwd} ${input.number}`;
    locations.delete(key);
    if (locations.size >= LOCATION_CACHE_CAPACITY) {
      const oldest = locations.keys().next().value;
      if (oldest !== undefined) locations.delete(oldest);
    }
    locations.set(key, location);
    return location;
  };

  /**
   * Everything a diff read needs before it can ask for a file: where the repository lives, and
   * which pushes the pull request has had. A client names neither, and the iterations are read
   * afresh every time because the newest one is what a push adds.
   */
  const diffScope = Effect.fn("AzureDevOpsPullRequestProvider.diffScope")(function* (input: {
    readonly cwd: string;
    readonly number: number;
    readonly iterationRange?: { readonly from: number; readonly to: number };
    readonly commit?: string | undefined;
  }) {
    const location = yield* locationOf(input);
    if (location === null) return null;
    if (input.iterationRange && input.commit) return yield* unsupported("combined diff selections");
    if (input.commit !== undefined) {
      const commits = yield* cli.listCommits({ ...input, location });
      if (!commits.some((commit) => commit.oid === input.commit)) return null;
      const scoped = yield* cli.getCommitScope({
        cwd: input.cwd,
        location,
        commit: input.commit,
      });
      return { location, iterations: [scoped.iteration], commitChanges: scoped.changes };
    }
    const iterations = yield* cli.listIterations({
      cwd: input.cwd,
      location,
      number: input.number,
    });
    if (input.iterationRange) {
      const { from, to } = input.iterationRange;
      const target = iterations.find((iteration) => iteration.id === to);
      const base = from === 0 ? undefined : iterations.find((iteration) => iteration.id === from);
      if (!target || (from !== 0 && !base) || from >= to)
        return yield* unsupported("invalid update comparison");
      const changes = yield* cli.listIterationChanges({
        ...input,
        location,
        iterationId: to,
        compareTo: from,
      });
      return {
        location,
        iterations: [{ ...target, mergeBaseCommit: base?.headCommit ?? target.mergeBaseCommit }],
        commitChanges: changes,
      };
    }
    return { location, iterations, commitChanges: null };
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

  const invalidDiscussion = (operation: string) =>
    Effect.fail(
      new PullRequestProviderError({
        provider: SourceControlProviderKind.make("azure-devops"),
        operation,
        reason: "failed",
        detail: "Azure DevOps discussion and comment ids must be positive integers.",
      }),
    );
  const commentIds = (id: string, operation: string) => {
    const match = /^([1-9]\d*):([1-9]\d*)$/.exec(id);
    return match
      ? Effect.succeed({ threadId: match[1]!, commentId: match[2]! })
      : invalidDiscussion(operation);
  };
  const discussionLocation = Effect.fn(function* (
    input: Parameters<typeof locationOf>[0],
    operation: string,
  ) {
    const location = yield* locationOf(input).pipe(Effect.mapError(fail(operation)));
    if (location === null)
      return yield* new PullRequestProviderError({
        provider: SourceControlProviderKind.make("azure-devops"),
        operation,
        reason: "failed",
        detail: "Azure DevOps did not report this pull request’s repository.",
      });
    return location;
  });

  const accessKey = (input: { readonly cwd: string; readonly number: number }) =>
    JSON.stringify([input.cwd, input.number]);
  const accessReads = yield* Cache.makeWith(
    (key: string) => {
      const [cwd, number] = JSON.parse(key) as [string, number];
      return discussionLocation({ cwd, number }, "permissions").pipe(
        Effect.flatMap((location) =>
          cli.readAccess({ cwd, number, location }).pipe(Effect.mapError(fail("permissions"))),
        ),
      );
    },
    {
      capacity: LOCATION_CACHE_CAPACITY,
      timeToLive: (exit) => (Exit.isSuccess(exit) ? ACCESS_TTL : 0),
    },
  );
  /**
   * What Azure refused this pull request's writes under one credential, so the action stays
   * disabled with its reason. A different credential starts over. A token's scopes can change
   * without the token changing, so an explicit refresh clears them too.
   */
  const learned = new Map<
    string,
    { credentialKey: string | undefined; denied: Record<string, string> }
  >();
  const accessFor = Effect.fn(function* (input: { cwd: string; number: number }) {
    const key = accessKey(input);
    // An unreadable permission check leaves only what Azure already refused; Azure still
    // enforces the write itself.
    const current = yield* Cache.get(accessReads, key).pipe(Effect.orElseSucceed(() => undefined));
    let entry = learned.get(key);
    if (
      !entry ||
      (current && entry.credentialKey && entry.credentialKey !== current.credentialKey)
    ) {
      entry = { credentialKey: undefined, denied: {} };
      if (learned.size >= LOCATION_CACHE_CAPACITY) learned.delete(learned.keys().next().value!);
      learned.set(key, entry);
    }
    if (current) entry.credentialKey = current.credentialKey;
    const denied = { ...entry.denied };
    const requires: Record<string, readonly string[]> = {
      comment: ["contribute"],
      "edit-comment": ["contribute"],
      "delete-comment": ["contribute"],
      "like-comment": ["contribute"],
      resolve: ["contribute"],
      vote: ["contribute"],
      reviewers: ["contribute"],
      labels: ["contribute"],
      edit: ["contribute"],
      close: ["contribute"],
      reopen: ["contribute"],
      draft: ["contribute"],
      ready: ["contribute"],
      "disable-auto-merge": ["contribute"],
      merge: ["contribute", "complete"],
      "enable-auto-merge": ["contribute", "complete"],
      complete: ["contribute", "complete"],
      "reviewer-required": ["contribute"],
      "reviewer-flag": ["contribute"],
      "decline-review": ["contribute"],
      retarget: ["contribute"],
      "restart-merge": ["contribute"],
      "attachment-upload": ["contribute"],
      "attachment-delete": ["contribute"],
      share: ["contribute"],
      "work-items": ["contribute"],
      "apply-suggestion": ["contribute", "push"],
      // Create Branch is often denied at the repository root and allowed only under folders,
      // and the new branch's name is not known until the action runs, so Azure decides.
      "cherry-pick": ["contribute"],
      revert: ["contribute"],
      "delete-source": ["deleteBranch", "push"],
      "bypass-policy": ["bypass"],
    };
    for (const [action, permissions] of Object.entries(requires)) {
      if (permissions.some((permission) => current?.permissions[permission] === false))
        denied[action] = "Your Azure account does not have permission for this action.";
    }
    return { entry, denied };
  });
  const guard =
    <I extends { cwd: string; number: number }, A>(
      operation: (input: I) => Effect.Effect<A, PullRequestProviderError>,
      action: string | ((input: I) => string),
    ) =>
    (input: I) =>
      Effect.gen(function* () {
        const name = typeof action === "string" ? action : action(input);
        if (
          "threadId" in input &&
          (typeof input.threadId !== "string" || !/^[1-9]\d*$/.test(input.threadId))
        )
          return yield* invalidDiscussion(name);
        if ("commentId" in input && typeof input.commentId === "string")
          yield* commentIds(input.commentId, name);
        const { entry, denied } = yield* accessFor(input);
        const options =
          "action" in input && typeof input.action === "object" && input.action !== null
            ? input.action
            : null;
        const reason =
          denied[name] ??
          (options && "deleteSourceBranch" in options && options.deleteSourceBranch
            ? denied["delete-source"]
            : undefined) ??
          (options && "bypassPolicy" in options && options.bypassPolicy
            ? denied["bypass-policy"]
            : undefined);
        if (reason)
          return yield* new PullRequestProviderError({
            provider: SourceControlProviderKind.make("azure-devops"),
            operation: name,
            reason: "failed",
            detail: reason,
          });
        // The strategy each completion will use, as `az repos pr update` is told it: a merge
        // without a method is a merge commit, and arming auto-complete without one keeps its own.
        const method = "mergeMethod" in input ? input.mergeMethod : undefined;
        const strategy =
          options && "strategy" in options
            ? options.strategy
            : name === "merge" || (name === "enable-auto-merge" && method !== undefined)
              ? method === "squash"
                ? "squash"
                : "noFastForward"
              : undefined;
        if (strategy && !(options && "bypassPolicy" in options && options.bypassPolicy)) {
          const location = yield* discussionLocation(input, name);
          const allowed = yield* cli
            .listMergeStrategies({ cwd: input.cwd, location, number: input.number })
            .pipe(Effect.mapError(fail(name)));
          if (!allowed.some((candidate) => candidate === strategy))
            return yield* new PullRequestProviderError({
              provider: SourceControlProviderKind.make("azure-devops"),
              operation: name,
              reason: "failed",
              detail: "Branch policy does not allow this merge strategy.",
            });
        }
        return yield* operation(input).pipe(
          Effect.mapError((error) => {
            if (
              (isNativeRequestError(error.cause) || isReadError(error.cause)) &&
              error.cause.reason === "permission-denied"
            ) {
              entry.denied[name] =
                "Your token does not allow this action. Update its access and refresh the PR.";
              return new PullRequestProviderError({
                provider: error.provider,
                operation: error.operation,
                reason: "failed",
                detail: entry.denied[name],
                cause: error,
              });
            }
            return error;
          }),
        );
      });
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
        const location = rememberLocation(input, pullRequest.location);
        const target =
          location === null ? null : { cwd: input.cwd, location, number: input.number };
        const iterations = yield* Effect.cached(
          target === null
            ? Effect.succeed([])
            : cli.listIterations(target).pipe(Effect.orElseSucceed(() => [])),
        );
        // Read side by side. Only the checks are the detail's own: a failed file count, label
        // or permission read leaves that part unknown rather than losing the whole detail.
        const [changedFiles, labels, policy, deniedActions] = yield* Effect.all(
          [
            target === null
              ? Effect.succeed(0)
              : iterations.pipe(
                  Effect.flatMap((iterations) => listLatestChanges({ ...target, iterations })),
                  Effect.map((listed) => listed.changes.length),
                  Effect.orElseSucceed(() => 0),
                ),
            target === null
              ? Effect.succeed(pullRequest.labels ?? [])
              : cli.listLabelCandidates(target).pipe(
                  Effect.map((list) =>
                    list.candidates
                      .filter((label) => label.isApplied)
                      .map((label) => ({ name: label.name, color: label.color })),
                  ),
                  Effect.orElseSucceed(() => pullRequest.labels ?? []),
                ),
            target === null
              ? Effect.succeed(null)
              : iterations.pipe(
                  Effect.flatMap((items) => {
                    const latest = items.at(-1);
                    return cli.listChecks({
                      ...target,
                      iterationId:
                        latest && latest.headCommit === pullRequest.headSha ? latest.id : null,
                    });
                  }),
                ),
            target === null
              ? Effect.succeed({})
              : accessFor(input).pipe(Effect.map(({ denied }) => denied)),
          ],
          { concurrency: "unbounded" },
        );
        // The trial merge's lastMergeSourceCommit can lag behind a new source push.
        const headSha = target === null ? undefined : (yield* iterations).at(-1)?.headCommit;
        // The shared merge control offers a merge commit and a squash, so each is offered only
        // where the target branch's merge-type policy allows it.
        const allowed = policy?.allowedMergeStrategies;
        const detail: ProviderChangeRequestDetail = {
          ...toChangeRequest(pullRequest),
          labels,
          body: pullRequest.body,
          ...(headSha === undefined ? {} : { headSha }),
          changedFiles,
          mergedAt: pullRequest.state === "merged" ? pullRequest.closedAt : null,
          closedAt: pullRequest.state === "closed" ? pullRequest.closedAt : null,
          reviewers: pullRequest.reviewers,
          checks: policy?.checks ?? [],
          mergeCapabilities: {
            merge: allowed?.includes("noFastForward") ?? true,
            squash: allowed?.includes("squash") ?? true,
            rebase: false,
          },
          viewerPermissions: {
            ...AZURE_DEVOPS_VIEWER_PERMISSIONS,
            verdicts: pullRequest.isDraft ? ["comment"] : AZURE_DEVOPS_VIEWER_PERMISSIONS.verdicts,
            deniedActions,
          },
          autoMergeEnabled: pullRequest.autoMergeEnabled,
          ...(pullRequest.autoMergeMethod === undefined
            ? {}
            : { autoMergeMethod: pullRequest.autoMergeMethod }),
        };
        return detail;
      },
      Effect.mapError(fail("getChangeRequest")),
    ),

    getChangeRequestActivity: Effect.fn("AzureDevOpsPullRequestProvider.getChangeRequestActivity")(
      function* (input) {
        const pullRequest = yield* cli.getPullRequest({ cwd: input.cwd, number: input.number });
        if (pullRequest.location === null)
          return {
            comments: [],
            commentCount: 0,
            commentsTruncated: true,
            reviewThreads: [],
            commits: [],
          };
        const iterations = yield* cli.listIterations({
          cwd: input.cwd,
          location: pullRequest.location,
          number: input.number,
        });
        const [discussion, commits] = yield* Effect.all(
          [
            cli
              .readDiscussion({
                ...(iterations.at(-1) ? { iterationId: iterations.at(-1)!.id } : {}),
                cwd: input.cwd,
                location: pullRequest.location,
                number: input.number,
                ...(input.viewer === undefined ? {} : { viewer: input.viewer }),
              })
              .pipe(
                Effect.map((value) => ({ ...value, truncated: false })),
                Effect.orElseSucceed(() => ({ comments: [], reviewThreads: [], truncated: true })),
              ),
            cli.listCommits({
              cwd: input.cwd,
              location: pullRequest.location,
              number: input.number,
            }),
          ],
          { concurrency: 2 },
        );
        const latest = iterations.at(-1);
        const untracked = new Set(
          "untrackedThreadIds" in discussion ? discussion.untrackedThreadIds : [],
        );
        const anchors = discussion.reviewThreads.flatMap((thread) => {
          const original = iterations.find((iteration) => iteration.id === thread.originalUpdate);
          if (!latest || !original || thread.line === null || !untracked.has(thread.id)) return [];
          const before = {
            path: thread.originalPath ?? thread.path,
            commit: thread.side === "right" ? original.headCommit : original.mergeBaseCommit,
          };
          const after = {
            path: thread.path,
            commit: thread.side === "right" ? latest.headCommit : latest.mergeBaseCommit,
          };
          return [{ thread, before, after }];
        });
        // Azure omits tracking criteria for both unchanged and deleted anchors. Compare only
        // those ambiguous ranges, sharing file reads across discussions on the same revision.
        const files = new Map(
          anchors
            .flatMap(({ before, after }) => [before, after])
            .map((file) => [JSON.stringify(file), file]),
        );
        const lines = new Map(
          yield* Effect.forEach(
            [...files],
            ([key, file]) =>
              readItemContent({ ...file, cwd: input.cwd, location: pullRequest.location! }).pipe(
                Effect.map(
                  (item) => [key, item.isBinary ? null : item.contents.split(/\r?\n/)] as const,
                ),
                Effect.orElseSucceed(() => [key, null] as const),
              ),
            { concurrency: MAX_DIFF_SPAWNS },
          ),
        );
        const outdated = new Set(
          anchors
            .filter(({ thread, before, after }) => {
              const oldLines = lines.get(JSON.stringify(before));
              const newLines = lines.get(JSON.stringify(after));
              const start = (thread.originalLine ?? thread.line!) - 1;
              const end =
                thread.originalEndLine ?? thread.endLine ?? thread.originalLine ?? thread.line!;
              return (
                !oldLines ||
                !newLines ||
                oldLines.length < end ||
                newLines.length < end ||
                oldLines.slice(start, end).join("\n") !== newLines.slice(start, end).join("\n")
              );
            })
            .map(({ thread }) => thread.id),
        );
        const discussionUrl = (id: string, createdAt: string) => {
          const url = new URL(pullRequest.url);
          url.searchParams.set("discussionId", id);
          const timestamp = Date.parse(createdAt) / 1000;
          if (Number.isFinite(timestamp)) url.hash = String(timestamp);
          return url.href;
        };
        return {
          comments: discussion.comments.map((comment) => ({
            ...comment,
            url: discussionUrl(comment.threadId!, comment.createdAt),
          })),
          commentCount: discussion.comments.length,
          commentsTruncated: discussion.truncated,
          reviewThreads: discussion.reviewThreads.map((thread) => ({
            ...thread,
            isOutdated: thread.isOutdated || outdated.has(thread.id),
            comments: thread.comments.map((comment) => ({
              ...comment,
              url: discussionUrl(thread.id, comment.createdAt),
            })),
          })),
          commits,
          identities: {
            ...pullRequest.identities,
            ...("identities" in discussion ? (discussion.identities ?? {}) : {}),
          },
          events: [
            {
              id: "azure-created",
              kind: "opened",
              actor: pullRequest.author,
              createdAt: pullRequest.createdAt,
              body: `${pullRequest.author?.name ?? pullRequest.author?.login ?? "Someone"} created the pull request`,
            },
            ...("events" in discussion ? (discussion.events ?? []) : []),
          ],
          updates: iterations.flatMap((iteration) => (iteration.update ? [iteration.update] : [])),
        } satisfies ProviderChangeRequestActivity;
      },
      Effect.mapError(fail("getChangeRequestActivity")),
    ),

    getViewerPermissions: (input) =>
      accessFor(input).pipe(
        Effect.map(({ denied }) => ({ ...AZURE_DEVOPS_VIEWER_PERMISSIONS, deniedActions: denied })),
      ),

    invalidate: (input) =>
      Effect.suspend(() => {
        const key = accessKey(input);
        learned.delete(key);
        return Cache.invalidate(accessReads, key);
      }),

    getFilesViewed: Effect.fn("AzureDevOpsPullRequestProvider.getFilesViewed")(
      function* (input) {
        const scope = yield* diffScope(input);
        if (!scope) return { files: [], truncated: false };
        const [visit, changes] = yield* Effect.all(
          [
            cli.readVisit({ ...input, location: scope.location }),
            listLatestChanges({ ...input, location: scope.location, iterations: scope.iterations }),
          ],
          { concurrency: 2 },
        );
        if (visit.denied)
          return {
            files: [],
            truncated: false,
            disabledReason: "Your token does not allow access to Azure review progress.",
          };
        return {
          files: changes.changes.map((change) => {
            const hash = `1@${change.objectId?.slice(0, 8) ?? "00000000"}@/${change.path}`;
            const previouslyViewed = Object.entries(visit.hashes).some(
              ([key, value]) => key.endsWith(`@/${change.path}`) && value === 2,
            );
            return {
              path: change.path,
              state:
                visit.hashes[hash] === 2
                  ? ("viewed" as const)
                  : visit.hashes[hash] === 1 || !previouslyViewed
                    ? ("unviewed" as const)
                    : ("dismissed" as const),
            };
          }),
          truncated: changes.truncated,
        };
      },
      Effect.mapError(fail("getFilesViewed")),
    ),
    setFilesViewed: Effect.fn("AzureDevOpsPullRequestProvider.setFilesViewed")(
      function* (input) {
        const scope = yield* diffScope(input);
        if (!scope) return;
        const changes = yield* listLatestChanges({
          ...input,
          location: scope.location,
          iterations: scope.iterations,
        });
        for (const viewed of [true, false]) {
          const hashes = input.files
            .filter((file) => file.viewed === viewed)
            .flatMap((file) => {
              const change = changes.changes.find((change) => change.path === file.path);
              return change
                ? [`1@${change.objectId?.slice(0, 8) ?? "00000000"}@/${change.path}`]
                : [];
            });
          if (!hashes.length) continue;
          const visit = yield* cli.readVisit({
            ...input,
            location: scope.location,
            hashes,
            viewed,
          });
          if (visit.denied)
            return yield* new PullRequestProviderError({
              provider: SourceControlProviderKind.make("azure-devops"),
              operation: "setFilesViewed",
              reason: "failed",
              detail: "Your token does not allow updating Azure review progress.",
            });
        }
      },
      Effect.mapError(fail("setFilesViewed")),
    ),
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
        const listed =
          scope.commitChanges ??
          (yield* cli.listIterationChanges({
            cwd: input.cwd,
            location: scope.location,
            number: input.number,
            iterationId: iteration.id,
          }));
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

    listReviewerCandidates: Effect.fn("AzureDevOpsPullRequestProvider.listReviewerCandidates")(
      function* (input) {
        const location = yield* discussionLocation(input, "listReviewerCandidates");
        return yield* cli
          .listReviewerCandidates({ ...input, location })
          .pipe(Effect.mapError(fail("listReviewerCandidates")));
      },
    ),

    setReviewerRequest: (input) =>
      cli
        .setPullRequestReviewers({
          cwd: input.cwd,
          number: input.number,
          // Azure addresses both people and groups by their identity GUID.
          reviewers: input.reviewers.map((reviewer) => reviewer.id),
          requested: input.requested,
        })
        .pipe(Effect.mapError(fail("setReviewerRequest"))),

    comment: Effect.fn("AzureDevOpsPullRequestProvider.comment")(function* (input) {
      const location = yield* discussionLocation(input, "comment");
      yield* cli
        .createThreads({
          cwd: input.cwd,
          location,
          number: input.number,
          threads: [{ body: input.body }],
        })
        .pipe(Effect.mapError(fail("comment")));
    }),
    updateComment: Effect.fn("AzureDevOpsPullRequestProvider.updateComment")(function* (input) {
      const ids = yield* commentIds(input.commentId, "updateComment");
      const location = yield* discussionLocation(input, "updateComment");
      yield* cli
        .updateComment({ ...input, ...ids, location })
        .pipe(Effect.mapError(fail("updateComment")));
    }),
    deleteComment: Effect.fn("AzureDevOpsPullRequestProvider.deleteComment")(function* (input) {
      const ids = yield* commentIds(input.commentId, "deleteComment");
      const location = yield* discussionLocation(input, "deleteComment");
      yield* cli
        .deleteComment({ ...input, ...ids, location })
        .pipe(Effect.mapError(fail("deleteComment")));
    }),

    submitReview: Effect.fn("AzureDevOpsPullRequestProvider.submitReview")(function* (input) {
      const location = yield* discussionLocation(input, "submitReview");
      const target = { cwd: input.cwd, location, number: input.number };
      // Azure refuses a vote on a draft or a closed pull request. Asked before anything is
      // posted, so retrying a refused verdict does not post its comments twice.
      if (input.verdict !== "comment") {
        const pullRequest = yield* cli
          .getPullRequest(target)
          .pipe(Effect.mapError(fail("submitReview")));
        if (pullRequest.isDraft || pullRequest.state !== "open")
          return yield* new PullRequestProviderError({
            provider: SourceControlProviderKind.make("azure-devops"),
            operation: "submitReview",
            reason: "failed",
            detail: pullRequest.isDraft
              ? "Publish this draft before voting."
              : "This pull request is no longer active.",
          });
      }
      yield* cli
        .createThreads({
          ...target,
          threads: [
            ...input.comments.map((comment) => ({ body: comment.body, comment })),
            ...(input.body.trim() ? [{ body: input.body }] : []),
          ],
        })
        .pipe(Effect.mapError(fail("submitReview")));
      if (input.verdict !== "comment")
        yield* cli
          .runHostAction({
            ...target,
            action: {
              type: "vote",
              vote: input.verdict === "approve" ? "approve" : "wait-for-author",
            },
          })
          .pipe(Effect.mapError(fail("submitReview")));
    }),

    replyToThread: Effect.fn("AzureDevOpsPullRequestProvider.replyToThread")(function* (input) {
      if (!/^[1-9]\d*$/.test(input.threadId)) {
        return yield* new PullRequestProviderError({
          provider: SourceControlProviderKind.make("azure-devops"),
          operation: "replyToThread",
          reason: "failed",
          detail: "Azure DevOps discussion ids must be positive integers.",
        });
      }
      const location = yield* locationOf(input).pipe(Effect.mapError(fail("replyToThread")));
      if (location === null) {
        return yield* new PullRequestProviderError({
          provider: SourceControlProviderKind.make("azure-devops"),
          operation: "replyToThread",
          reason: "failed",
          detail: "Azure DevOps did not report this pull request’s repository.",
        });
      }
      yield* cli
        .replyToThread({
          cwd: input.cwd,
          location,
          number: input.number,
          threadId: input.threadId,
          body: input.body,
        })
        .pipe(Effect.mapError(fail("replyToThread")));
    }),

    setThreadResolution: Effect.fn("AzureDevOpsPullRequestProvider.setThreadResolution")(
      function* (input) {
        if (!/^[1-9]\d*$/.test(input.threadId))
          return yield* invalidDiscussion("setThreadResolution");
        const location = yield* discussionLocation(input, "setThreadResolution");
        yield* cli
          .setThreadStatus({
            ...input,
            location,
            status: input.status ?? (input.resolved ? "fixed" : "active"),
          })
          .pipe(Effect.mapError(fail("setThreadResolution")));
      },
    ),

    listLabelCandidates: Effect.fn("AzureDevOpsPullRequestProvider.listLabelCandidates")(
      function* (input) {
        const location = yield* discussionLocation(input, "listLabelCandidates");
        return yield* cli
          .listLabelCandidates({ ...input, location })
          .pipe(Effect.mapError(fail("listLabelCandidates")));
      },
    ),
    setLabels: Effect.fn("AzureDevOpsPullRequestProvider.setLabels")(function* (input) {
      const location = yield* discussionLocation(input, "setLabels");
      return yield* cli.setLabels({ ...input, location }).pipe(Effect.mapError(fail("setLabels")));
    }),
    getHostDetails: Effect.fn("AzureDevOpsPullRequestProvider.getHostDetails")(function* (input) {
      const location = yield* discussionLocation(input, "getHostDetails");
      return yield* cli.getHostDetails({ ...input, location }).pipe(
        Effect.mapError(fail("getHostDetails")),
        Effect.flatMap((details) =>
          accessFor(input).pipe(
            Effect.map(({ denied }) => ({
              ...details,
              deniedActions: { ...details.deniedActions, ...denied },
            })),
          ),
        ),
      );
    }),
    runHostAction: Effect.fn("AzureDevOpsPullRequestProvider.runHostAction")(function* (input) {
      const location = yield* discussionLocation(input, "runHostAction");
      return yield* cli
        .runHostAction({ ...input, location })
        .pipe(Effect.mapError(fail("runHostAction")));
    }),
    setReaction: Effect.fn("AzureDevOpsPullRequestProvider.setReaction")(function* (input) {
      if (input.subjectId === undefined || input.content !== "thumbs-up")
        return yield* unsupported("setReaction");
      const ids = yield* commentIds(input.subjectId, "setReaction");
      const location = yield* discussionLocation(input, "setReaction");
      yield* cli
        .setCommentLike({ ...input, ...ids, location, liked: input.reacted })
        .pipe(Effect.mapError(fail("setReaction")));
    }),
  };

  return {
    ...provider,
    runAction: guard(provider.runAction, (input) => input.action),
    comment: guard(provider.comment, "comment"),
    ...(provider.updateChangeRequest
      ? { updateChangeRequest: guard(provider.updateChangeRequest, "edit") }
      : {}),
    ...(provider.updateComment
      ? { updateComment: guard(provider.updateComment, "edit-comment") }
      : {}),
    ...(provider.deleteComment
      ? { deleteComment: guard(provider.deleteComment, "delete-comment") }
      : {}),
    ...(provider.submitReview ? { submitReview: guard(provider.submitReview, "vote") } : {}),
    ...(provider.replyToThread ? { replyToThread: guard(provider.replyToThread, "comment") } : {}),
    ...(provider.setThreadResolution
      ? { setThreadResolution: guard(provider.setThreadResolution, "resolve") }
      : {}),
    ...(provider.setReviewerRequest
      ? { setReviewerRequest: guard(provider.setReviewerRequest, "reviewers") }
      : {}),
    ...(provider.setLabels ? { setLabels: guard(provider.setLabels, "labels") } : {}),
    ...(provider.setReaction ? { setReaction: guard(provider.setReaction, "like-comment") } : {}),
    ...(provider.runHostAction
      ? { runHostAction: guard(provider.runHostAction, (input) => input.action.type) }
      : {}),
  } satisfies PullRequestProviderApi;
});
