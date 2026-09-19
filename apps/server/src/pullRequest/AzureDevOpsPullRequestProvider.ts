import * as Effect from "effect/Effect";
import * as Config from "effect/Config";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
} from "effect/unstable/http";
import * as Semaphore from "effect/Semaphore";
import type { PullRequestCapabilities, PullRequestViewerPermissions } from "@t3tools/contracts";

import * as AzureDevOpsPullRequestCli from "./AzureDevOpsPullRequestCli.ts";
import { attachmentMarkdown } from "./PullRequestAttachments.ts";
import { createPendingAttachmentId } from "../attachmentStore.ts";
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
} from "./PullRequestProvider.ts";
import type { AzureDevOpsIterationChanges } from "./AzureDevOpsPullRequestCli.ts";
import type {
  AzureDevOpsChangeEntry,
  AzureDevOpsItemContent,
  AzureDevOpsIteration,
  AzureDevOpsPullRequest,
  AzureDevOpsRepositoryLocation,
} from "./azureDevOpsPullRequestJson.ts";

/**
 * How many of a slice's files are read at once. Every file is two `az` invocations, each paying a
 * Python interpreter's start-up, so reading them one after another is most of what the Code tab
 * waits for. Four files means eight processes at once: the fan-out the GitHub CLI reads its
 * per-file stats with here, and low enough not to swamp the host's throttling or the machine.
 */
const DIFF_FILE_CONCURRENCY = 4;

/**
 * How many `az` processes this build will have out at once, counted across every reader rather
 * than per request. The fan-out above bounds one Code tab, so two people opening two Azure reviews
 * had sixteen Python interpreters starting at once and nothing above them. Held at what one
 * request at full width spends, so a second reader waits behind the first instead of adding to it.
 */
export const MAX_DIFF_SPAWNS = 2 * DIFF_FILE_CONCURRENCY;

/** How many pull requests' repository locations one provider remembers at once. */
export const LOCATION_CACHE_CAPACITY = 128;

const CAPABILITIES: PullRequestCapabilities = {
  // Azure serves no patch of its own, so the one the Code tab reads is built here out of the
  // files an iteration changed and both sides of each of them.
  diff: true,
  comment: true,
  attachments: {
    supported: true,
    maxBytes: 25 * 1024 * 1024,
    destination: "pull-request",
    reason: "Requires az login or AZURE_DEVOPS_EXT_PAT on the server.",
  },
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
  review: {
    inlineComment: true,
    reply: true,
    resolve: true,
    verdicts: ["comment", "approve", "request-changes"],
  },
  // `az repos pr reviewer add` and `remove` name identities, and nothing anywhere in `az repos`
  // lists the ones this repository could name — that lives behind the identity and graph APIs, a
  // different service with its own permissions. So the page takes a name here rather than being
  // handed a menu built out of a guess.
  reviewers: { request: true, listCandidates: false },
  // A new title and description travel on the same `az repos pr update` that moves a pull request.
  edit: { changeRequest: true, comment: true },
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
const AZURE_DEVOPS_VIEWER_PERMISSIONS: PullRequestViewerPermissions = {
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
  const httpClient = yield* HttpClient.HttpClient;
  // Made once with the provider, which the registry builds once, so this is the whole build's
  // allowance rather than one request's.
  const diffSpawns = yield* Semaphore.make(MAX_DIFF_SPAWNS);
  const readItemContent = (input: Parameters<typeof cli.readItemContent>[0]) =>
    diffSpawns.withPermits(1)(cli.readItemContent(input));

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
   * a whole pull request read every time they checked whether a file had been pushed to. Least
   * recently used, so a listing walking cold pull requests cannot evict the one being read.
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
   * Both sides of one changed file, read at once because neither answer depends on the other and
   * `az` pays a Python interpreter's start-up for each. Only the sides a change actually has are
   * asked for: Azure answers for a file that is not at a commit with a failure rather than with
   * nothing.
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

  const writeThread = Effect.fn("AzureDevOpsPullRequestProvider.writeThread")(function* (
    input: { readonly cwd: string; readonly number: number },
    update: Omit<Parameters<typeof cli.writeThread>[0], "cwd" | "number" | "location">,
  ) {
    if (
      [update.threadId, update.commentId].some((id) => id !== undefined && !/^[1-9]\d*$/.test(id))
    ) {
      return yield* new PullRequestProviderError({
        provider: "azure-devops",
        operation: "writeThread",
        reason: "failed",
        detail: "Invalid Azure DevOps thread or comment ID.",
      });
    }
    const location = yield* locationOf(input).pipe(Effect.mapError(fail("writeThread")));
    if (location === null) {
      return yield* new PullRequestProviderError({
        provider: "azure-devops",
        operation: "writeThread",
        reason: "failed",
        detail: "Azure DevOps did not return the pull request repository.",
      });
    }
    yield* cli
      .writeThread({ ...input, ...update, location })
      .pipe(Effect.mapError(fail("writeThread")));
  });

  const attachmentScope = Effect.fn("AzureDevOpsPullRequestProvider.attachmentScope")(function* (
    input: { readonly cwd: string; readonly number: number },
    operation: "uploadAttachment" | "readAttachment",
  ) {
    const pullRequest = yield* cli.getPullRequest(input).pipe(Effect.mapError(fail(operation)));
    const url = URL.canParse(pullRequest.url) ? new URL(pullRequest.url) : null;
    const projectPath = url?.pathname.split("/_git/")[0];
    if (
      !url ||
      url.protocol !== "https:" ||
      (url.hostname !== "dev.azure.com" && !url.hostname.endsWith(".visualstudio.com")) ||
      !projectPath ||
      !pullRequest.location
    ) {
      return yield* new PullRequestProviderError({
        provider: "azure-devops",
        operation,
        reason: "failed",
        detail: "Azure DevOps did not return a supported pull request URL.",
      });
    }
    const location = pullRequest.location;
    return {
      url,
      projectPath,
      location,
      endpoint: `${url.origin}${projectPath}/_apis/git/repositories/${encodeURIComponent(location.repository)}/pullRequests/${input.number}/attachments/`,
    };
  });

  const attachmentRequest = Effect.fn("AzureDevOpsPullRequestProvider.attachmentRequest")(
    function* (
      input: { readonly cwd: string },
      request: HttpClientRequest.HttpClientRequest,
      operation: "uploadAttachment" | "readAttachment",
    ) {
      const pat = yield* Config.String("AZURE_DEVOPS_EXT_PAT").pipe(
        Config.option,
        Effect.mapError(
          (cause) =>
            new PullRequestProviderError({
              provider: "azure-devops",
              operation,
              reason: "failed",
              detail: "Could not read Azure DevOps attachment credentials.",
              cause,
            }),
        ),
      );
      if (Option.isSome(pat) && pat.value.trim()) {
        request = request.pipe(HttpClientRequest.basicAuth("", pat.value));
      } else {
        const token = yield* cli.getAttachmentAccessToken(input).pipe(
          Effect.mapError(
            (cause) =>
              new PullRequestProviderError({
                provider: "azure-devops",
                operation,
                reason: "failed",
                detail: "Attachments require az login or AZURE_DEVOPS_EXT_PAT on the server.",
                cause,
              }),
          ),
        );
        request = request.pipe(HttpClientRequest.bearerToken(token));
      }
      return yield* httpClient.execute(request).pipe(
        Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
        Effect.mapError(
          (cause) =>
            new PullRequestProviderError({
              provider: "azure-devops",
              operation,
              reason: "failed",
              detail: "Could not access the Azure DevOps attachment.",
              cause,
            }),
        ),
      );
    },
  );

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

    // The polled path a linked thread's row stays live on: one `az` read, no iterations or
    // changes behind it, since the file count that would cost is not shown here.
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
            ? Effect.succeed({ comments: [], reviewThreads: [], truncated: true })
            : cli
                .listThreads({
                  cwd: input.cwd,
                  pullRequestUrl: pullRequest.url,
                  location: pullRequest.location,
                  number: input.number,
                })
                .pipe(
                  Effect.map((conversation) => ({ ...conversation, truncated: false })),
                  Effect.orElseSucceed(() => ({
                    comments: [],
                    reviewThreads: [],
                    truncated: true,
                  })),
                )
          ).pipe(
            Effect.map((conversation): ProviderChangeRequestActivity => ({
              comments: conversation.comments,
              commentCount: conversation.comments.length,
              commentsTruncated: conversation.truncated,
              reviewThreads: conversation.reviewThreads,
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
        let edits = 0;
        let index = cursor?.fileIndex ?? 0;
        let full = false;
        // How many files to read at once. Every file costs a request a side, and everything read
        // past the point the slice fills is thrown away and read again by the next slice, so the
        // batch narrows as the budgets do: what is left of each, over what a file has spent of it
        // on average so far, which is the only estimate there is before a file is read. At least
        // one, so a file heavier than the whole budget still moves the cursor.
        const batchWidth = () => {
          if (sections.length === 0) return DIFF_FILE_CONCURRENCY;
          const admits = (left: number, spent: number) =>
            Math.ceil(left / Math.max(1, spent / sections.length));
          return Math.max(
            1,
            Math.min(
              DIFF_FILE_CONCURRENCY,
              // The file budget needs no estimate: a file spends exactly one of it.
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
              // A pair Azure refuses is one file rather than the whole slice: an oversize blob or
              // a path `az` will not carry through leaves that file listed without its hunks, and
              // everything around it still renders.
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
            // A file whose diff was given up on spent the whole of what one file is allowed and
            // has only a header to show for it, and a file the diff never ran on at all weighs
            // almost nothing in either budget and still costs its two reads. So the file count
            // bounds the request alongside the bytes.
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
      }).pipe(Effect.mapError(fail("getDiff"))),

    // The patch is built from whole files, so opening the lines around a hunk is the same two
    // reads over again rather than a wider request. Read against the latest iteration: nothing in
    // the request says which push the reader is looking at, and expansion is stale after a
    // mid-review push on every host here anyway.
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
     * it reports. One read covers every path, since the latest iteration lists the whole change.
     *
     * A path the change does not carry is at the empty revision, which is where a file the pull
     * request deletes sits. When the change was too long to follow to its end, those paths are
     * left out instead: reporting them as deleted would clear a file nobody has read.
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

    uploadAttachment: Effect.fn("AzureDevOpsPullRequestProvider.uploadAttachment")(
      function* (input) {
        const scope = yield* attachmentScope(input, "uploadAttachment");
        const name = `${createPendingAttachmentId()}-${input.name}`;
        const response = yield* attachmentRequest(
          input,
          HttpClientRequest.post(
            `${scope.endpoint}${encodeURIComponent(name)}?api-version=7.1`,
          ).pipe(
            HttpClientRequest.bodyUint8Array(input.data, "application/octet-stream"),
            HttpClientRequest.acceptJson,
          ),
          "uploadAttachment",
        );
        if (response.status < 200 || response.status >= 300)
          return yield* new PullRequestProviderError({
            provider: "azure-devops",
            operation: "uploadAttachment",
            reason: "failed",
            detail: `Azure DevOps rejected the attachment (HTTP ${response.status}).`,
          });
        const attachment = yield* HttpClientResponse.schemaBodyJson(
          Schema.Struct({ url: Schema.String }),
        )(response).pipe(
          Effect.mapError(
            (cause) =>
              new PullRequestProviderError({
                provider: "azure-devops",
                operation: "uploadAttachment",
                reason: "failed",
                detail: "Azure DevOps returned an invalid attachment URL.",
                cause,
              }),
          ),
        );
        if (!URL.canParse(attachment.url) || new URL(attachment.url).protocol !== "https:")
          return yield* new PullRequestProviderError({
            provider: "azure-devops",
            operation: "uploadAttachment",
            reason: "failed",
            detail: "Azure DevOps returned an invalid attachment URL.",
          });
        return {
          url: attachment.url,
          markdown: attachmentMarkdown(attachment.url, input.name, input.mimeType),
        };
      },
    ),

    readAttachment: Effect.fn("AzureDevOpsPullRequestProvider.readAttachment")(function* (input) {
      const scope = yield* attachmentScope(input, "readAttachment");
      const url = URL.canParse(input.url) ? new URL(input.url) : null;
      if (!url || url.origin !== scope.url.origin || url.username || url.password) {
        return yield* new PullRequestProviderError({
          provider: "azure-devops",
          operation: "readAttachment",
          reason: "failed",
          detail: "The attachment URL does not belong to this pull request.",
        });
      }
      const [path, projectPath] = yield* Effect.try({
        try: () =>
          [decodeURIComponent(url.pathname), decodeURIComponent(scope.projectPath)] as const,
        catch: (cause) =>
          new PullRequestProviderError({
            provider: "azure-devops",
            operation: "readAttachment",
            reason: "failed",
            detail: "Invalid attachment path.",
            cause,
          }),
      });
      const match =
        /^(.*)\/_apis\/git\/repositories\/([^/]+)\/pullRequests\/(\d+)\/attachments\/([^/]+)$/i.exec(
          path,
        );
      const projectRoot = projectPath.slice(0, projectPath.lastIndexOf("/"));
      const projects = [
        projectPath,
        ...(scope.location.projectId ? [`${projectRoot}/${scope.location.projectId}`] : []),
      ];
      const repository = match?.[2];
      const isRepositoryId =
        scope.location.repositoryId !== undefined &&
        repository?.toLowerCase() === scope.location.repositoryId.toLowerCase();
      if (
        !match ||
        (repository?.toLowerCase() !== scope.location.repository.toLowerCase() &&
          !isRepositoryId) ||
        Number(match[3]) !== input.number ||
        (!projects.some((project) => project.toLowerCase() === match[1]!.toLowerCase()) &&
          !(isRepositoryId && match[1]!.toLowerCase() === projectRoot.toLowerCase())) ||
        /[\\\p{Cc}]/u.test(match[4]!) ||
        match[4] === "." ||
        match[4] === ".."
      ) {
        return yield* new PullRequestProviderError({
          provider: "azure-devops",
          operation: "readAttachment",
          reason: "failed",
          detail: "The attachment URL does not belong to this pull request.",
        });
      }
      const headers = Object.fromEntries(
        Object.entries(input.headers).filter(([name]) =>
          ["range", "if-range", "if-none-match", "if-modified-since", "accept"].includes(
            name.toLowerCase(),
          ),
        ),
      );
      return yield* attachmentRequest(
        input,
        HttpClientRequest.get(
          `${scope.endpoint}${encodeURIComponent(match[4]!)}?api-version=7.1`,
        ).pipe(HttpClientRequest.setHeaders(headers)),
        "readAttachment",
      );
    }),

    comment: (input) =>
      writeThread(input, {
        resource: "pullRequestThreads",
        method: "POST",
        body: {
          status: "active",
          comments: [{ parentCommentId: 0, content: input.body, commentType: "text" }],
        },
      }),

    updateComment: (input) => {
      const ids = /^([1-9]\d*):([1-9]\d*)$/.exec(input.commentId);
      if (!ids)
        return Effect.fail(
          new PullRequestProviderError({
            provider: "azure-devops",
            operation: "updateComment",
            reason: "failed",
            detail: "Invalid Azure DevOps comment ID.",
          }),
        );
      return writeThread(input, {
        resource: "pullRequestThreadComments",
        method: "PATCH",
        threadId: ids[1]!,
        commentId: ids[2]!,
        body: { content: input.body },
      });
    },

    submitReview: Effect.fn("AzureDevOpsPullRequestProvider.submitReview")(function* (input) {
      const threads: Array<Parameters<typeof cli.writeThread>[0]> = [];
      if (input.comments.length > 0) {
        const scope = yield* diffScope(input).pipe(Effect.mapError(fail("submitReview")));
        const latest = scope?.iterations.at(-1);
        if (!scope || !latest)
          return yield* new PullRequestProviderError({
            provider: "azure-devops",
            operation: "submitReview",
            reason: "failed",
            detail:
              "Azure DevOps did not return the review iteration. Refresh the pull request before submitting.",
          });
        const changes = yield* listLatestChanges({ ...input, ...scope }).pipe(
          Effect.mapError(fail("submitReview")),
        );
        for (const comment of input.comments) {
          const change = changes.changes.find(
            (entry) =>
              entry.path === comment.path &&
              (comment.oldPath === undefined || entry.oldPath === comment.oldPath),
          );
          if (!change?.changeTrackingId || change.changeTrackingId < 1)
            return yield* new PullRequestProviderError({
              provider: "azure-devops",
              operation: "submitReview",
              reason: "failed",
              detail: `Azure DevOps did not return the review position for ${comment.path}. Refresh the pull request before submitting.`,
            });
          const position = comment.position;
          const left =
            position.kind === "deleted" ||
            (position.kind === "context" && position.side === "left");
          const anchor = { line: left ? position.oldLine : position.newLine, offset: 1 };
          threads.push({
            ...input,
            location: scope.location,
            resource: "pullRequestThreads",
            method: "POST",
            body: {
              status: "active",
              comments: [{ parentCommentId: 0, content: comment.body, commentType: "text" }],
              threadContext: {
                filePath: `/${change.path}`,
                ...(left
                  ? { leftFileStart: anchor, leftFileEnd: anchor }
                  : { rightFileStart: anchor, rightFileEnd: anchor }),
              },
              pullRequestThreadContext: {
                changeTrackingId: change.changeTrackingId,
                iterationContext: {
                  firstComparingIteration: latest.id,
                  secondComparingIteration: latest.id,
                },
              },
            },
          });
        }
      }
      for (const thread of threads)
        yield* cli.writeThread(thread).pipe(Effect.mapError(fail("submitReview")));
      if (input.body.trim()) yield* provider.comment(input);
      if (input.verdict !== "comment")
        yield* cli
          .setReviewVote({
            ...input,
            vote: input.verdict === "approve" ? "approve" : "wait-for-author",
          })
          .pipe(Effect.mapError(fail("submitReview")));
    }),

    replyToThread: (input) =>
      writeThread(input, {
        resource: "pullRequestThreadComments",
        method: "POST",
        threadId: input.threadId,
        body: { parentCommentId: 1, content: input.body, commentType: "text" },
      }),

    setThreadResolution: (input) =>
      writeThread(input, {
        resource: "pullRequestThreads",
        method: "PATCH",
        threadId: input.threadId,
        body: { status: input.resolved ? "fixed" : "active" },
      }),

    setReaction: () => unsupported("setReaction"),
  };

  return provider;
});
