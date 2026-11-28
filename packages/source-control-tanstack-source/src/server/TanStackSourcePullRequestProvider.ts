import {
  resolvePullRequestAuthorFilter,
  type PullRequestCapabilities,
  type PullRequestListState,
  type PullRequestViewerPermissions,
} from "@t3tools/contracts";
import {
  diffFileSection,
  parseDiffFilePaths,
} from "@t3tools/source-control-core/server/diffFileRevisions";
import {
  PullRequestProviderError,
  tailLogLines,
  type ProviderChangeRequestDetail,
  type ProviderCheckLog,
  type ProviderCheckRerun,
  type ProviderRepositoryRef,
  type PullRequestProviderApi,
} from "@t3tools/source-control-core/server/PullRequestProvider";
import * as Cache from "effect/Cache";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";

import { definition } from "../shared/definition.ts";
import * as TanStackSourceApi from "./TanStackSourceApi.ts";
import * as Events from "./tanStackSourceEvents.ts";
import * as Hosts from "./tanStackSourceHosts.ts";
import * as Json from "./tanStackSourceJson.ts";
import * as Listing from "./tanStackSourceListing.ts";

const KIND = definition.kind;

const CAPABILITIES: PullRequestCapabilities = {
  diff: true,
  comment: true,
  actions: [...definition.changeRequestActions],
  mergeMethods: ["merge", "squash"],
  updateMethods: ["merge", "rebase"],
  search: true,
  stacks: true,
  // A merge lands every layer below it on its own; there is no separate stack action.
  stackActions: false,
  reactions: false,
  labels: true,
  review: {
    inlineComment: true,
    rangeComment: true,
    reply: true,
    resolve: true,
    verdicts: ["approve", "request-changes", "comment"],
  },
  // Source lists no collaborators to pick from; reviewers are requested by username.
  reviewers: { request: true, listCandidates: false },
  edit: { changeRequest: true, comment: true },
};

const PAGE_LIMIT = 5;
const VIEWER_TTL = Duration.minutes(5);
/** Runs of a pull request are listed newest first, a page at a time. */
const CI_RUNS_LIMIT = 30;
const CI_RUN_PAGES = 3;
/** Runs at one head whose jobs are read, re-runs included. */
const MAX_CI_RUNS = 12;
/** Strips the terminal colour codes CI logs keep. */
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/gu;

const LogSteps = Schema.Array(Schema.Struct({ lines: Schema.Int }));
const decodeLogSteps = Schema.decodeUnknownOption(Schema.fromJsonString(LogSteps));

type PullRef = ProviderRepositoryRef & { readonly number: number };

export const make = Effect.gen(function* () {
  const api = yield* TanStackSourceApi.TanStackSourceApi;
  const events = yield* Events.make;

  const failure = (operation: string, detail: string, cause?: unknown) =>
    new PullRequestProviderError({
      provider: KIND,
      operation,
      reason: "failed",
      detail,
      ...(cause === undefined ? {} : { cause }),
    });

  const repositoryPath = (
    operation: string,
    input: ProviderRepositoryRef,
  ): Effect.Effect<string, PullRequestProviderError> => {
    const repository = Hosts.tanStackSourceRepositoryPath(input.repository);
    return Hosts.tanStackSourceHost(input.host) !== null && repository !== null
      ? Effect.succeed(`/repos/${repository}`)
      : Effect.fail(
          failure(
            operation,
            `TanStack Source serves owner/name repositories on ${Hosts.TANSTACK_SOURCE_HOSTS.join(" and ")}.`,
          ),
        );
  };

  const toProviderError =
    (operation: string) => (error: TanStackSourceApi.TanStackSourceApiError) =>
      new PullRequestProviderError({
        provider: KIND,
        operation,
        reason: error.reason,
        detail: error.detail,
        ...(error.retryAt === undefined ? {} : { retryAt: error.retryAt }),
        cause: error,
      });

  const send = (
    operation: string,
    input: Pick<ProviderRepositoryRef, "host">,
    request: Omit<TanStackSourceApi.TanStackSourceApiRequest, "operation" | "host">,
  ) =>
    api
      .request({ ...request, host: input.host, operation })
      .pipe(Effect.mapError(toProviderError(operation)));

  const decode =
    <S extends Schema.Codec<unknown, unknown, never, never>>(operation: string, schema: S) =>
    (raw: string) =>
      Schema.decodeEffect(Schema.fromJsonString(schema))(raw).pipe(
        Effect.mapError((cause) =>
          failure(operation, "TanStack Source returned an unreadable response.", cause),
        ),
      );

  const read = <S extends Schema.Codec<unknown, unknown, never, never>>(
    operation: string,
    input: Pick<ProviderRepositoryRef, "host">,
    request: Omit<TanStackSourceApi.TanStackSourceApiRequest, "operation" | "host">,
    schema: S,
  ) => send(operation, input, request).pipe(Effect.flatMap(decode(operation, schema)));

  const pullPath = (operation: string, input: PullRef) =>
    repositoryPath(operation, input).pipe(Effect.map((base) => `${base}/pulls/${input.number}`));

  const readPull = (operation: string, input: PullRef) =>
    pullPath(operation, input).pipe(
      Effect.flatMap((path) => read(operation, input, { path }, Json.SourcePullDetail)),
    );

  const viewers = yield* Cache.makeWith(
    (host: string) =>
      read("getViewer", { host }, { path: "/user" }, Json.SourceUser).pipe(
        Effect.map((user) => user.username),
      ),
    {
      capacity: 4,
      timeToLive: (exit) => (Exit.isSuccess(exit) ? VIEWER_TTL : Duration.zero),
    },
  );
  const viewerOf = (host: string) => Cache.get(viewers, host.toLowerCase());

  const permissionsOf = (
    pull: Json.SourcePullDetail,
    viewer: string | null,
  ): PullRequestViewerPermissions => {
    const open = pull.state === "open";
    const authored = viewer !== null && pull.author?.toLowerCase() === viewer.toLowerCase();
    return {
      actions: open
        ? [
            pull.draft ? "ready" : "draft",
            "close",
            ...(pull.draft ? [] : (["merge"] as const)),
            "update-branch",
            pull.autoMerge == null ? "enable-auto-merge" : "disable-auto-merge",
          ]
        : pull.state === "closed"
          ? ["reopen"]
          : [],
      comment: pull.locked !== true,
      resolve: true,
      // Source refuses an author's approval and request for changes, as GitHub does.
      verdicts: authored ? ["comment"] : ["approve", "request-changes", "comment"],
      requestReviewers: open,
      labels: true,
      editChangeRequest: true,
      updateMethods: open ? ["merge", "rebase"] : [],
    };
  };

  /**
   * The Source CI jobs of every run at `headSha`, by job id, so each check links to its run and
   * log and a re-run's jobs group with the ones they replace. Runs come newest first.
   */
  const readCiJobs = Effect.fn("TanStackSourcePullRequestProvider.readCiJobs")(function* (
    operation: string,
    input: PullRef,
    headSha: string,
  ) {
    const base = yield* repositoryPath(operation, input);
    const runs: Array<Json.SourceCiRun> = [];
    let cursor: string | null = null;
    for (let page = 0; page < CI_RUN_PAGES; page++) {
      const query = new URLSearchParams({
        pull: String(input.number),
        limit: String(CI_RUNS_LIMIT),
      });
      if (cursor !== null) query.set("cursor", cursor);
      const listed: typeof Json.SourceCiRuns.Type = yield* read(
        operation,
        input,
        { path: `${base}/ci/runs?${query}` },
        Json.SourceCiRuns,
      );
      const atHead = listed.items.filter((run) => run.headSha === headSha);
      runs.push(...atHead);
      // Runs of older heads follow the head's own, so a page past them ends the search.
      if (listed.next === null || (atHead.length === 0 && runs.length > 0)) break;
      cursor = listed.next;
    }
    const details = yield* Effect.forEach(
      runs.slice(0, MAX_CI_RUNS),
      (run) =>
        read(operation, input, { path: `${base}/ci/runs/${run.id}` }, Json.SourceCiRunDetail).pipe(
          Effect.map((detail) => ({ run, detail })),
        ),
      { concurrency: 4 },
    );
    const jobs = new Map<string, Json.SourceCiJob>();
    for (const { run, detail } of details)
      for (const job of detail.jobs)
        if (job.jobId !== null)
          jobs.set(job.jobId, {
            runId: run.id,
            workflow: run.workflow,
            key: job.key,
            runUrl: run.htmlUrl,
          });
    return jobs;
  });

  const readChecks = Effect.fn("TanStackSourcePullRequestProvider.readChecks")(function* (
    operation: string,
    input: PullRef,
    headSha: string | null,
  ) {
    if (headSha === null) return { checks: [], merge: null };
    const base = yield* repositoryPath(operation, input);
    const path = yield* pullPath(operation, input);
    const [runs, jobs, merge] = yield* Effect.all(
      [
        read(
          operation,
          input,
          { path: `${base}/check-runs?${new URLSearchParams({ sha: headSha })}` },
          Json.SourceCheckRuns,
        ),
        // Without its run a job still shows; it just links to no log.
        readCiJobs(operation, input, headSha).pipe(
          Effect.orElseSucceed(() => new Map<string, Json.SourceCiJob>()),
        ),
        read(operation, input, { path: `${path}/checks` }, Json.SourceMergeChecks),
      ],
      { concurrency: 3 },
    );
    const required = new Set(merge.checks.map((check) => check.name));
    return { checks: Json.toChecks({ runs, jobs, required }), merge };
  });

  const toSummary = (pull: Json.SourcePullDetail, input: ProviderRepositoryRef) => ({
    ...Json.toChangeRequest(pull, input),
    ...(pull.headSha === null ? {} : { headSha: pull.headSha }),
    mergedAt: pull.mergedAt === null ? null : Json.iso(pull.mergedAt),
    mergeability:
      pull.mergeable === true
        ? ("mergeable" as const)
        : pull.mergeable === false
          ? ("conflicting" as const)
          : ("unknown" as const),
    autoMergeEnabled: pull.autoMerge != null,
    ...(pull.autoMerge?.method === "merge" || pull.autoMerge?.method === "squash"
      ? { autoMergeMethod: pull.autoMerge.method }
      : {}),
  });

  const readStack = Effect.fn("TanStackSourcePullRequestProvider.readStack")(function* (
    operation: string,
    input: PullRef,
  ) {
    const path = yield* pullPath(operation, input);
    return yield* read(operation, input, { path: `${path}/stack` }, Json.SourceStack);
  });

  const listState = (state: PullRequestListState) =>
    // Source lists open or closed rows; closed ones include the merged.
    state === "all"
      ? (["open", "closed"] as const)
      : state === "open"
        ? (["open"] as const)
        : (["closed"] as const);

  const merge = Effect.fn("TanStackSourcePullRequestProvider.merge")(function* (
    input: Parameters<PullRequestProviderApi["runAction"]>[0],
  ) {
    const pull = yield* readPull("merge", input);
    if (pull.state === "merged") return;
    const sha = input.expectedHeadSha ?? pull.headSha;
    if (sha === null)
      return yield* failure(
        "merge",
        "TanStack Source has not reported the pull request's head yet.",
      );
    const path = yield* pullPath("merge", input);
    yield* send("merge", input, {
      method: "PUT",
      path: `${path}/merge`,
      body: { merge_method: input.mergeMethod === "squash" ? "squash" : "merge", sha },
    });
  });

  const provider: PullRequestProviderApi = {
    kind: KIND,
    capabilities: CAPABILITIES,
    unavailableRequirement: {
      missing:
        "Install the src CLI and run `src auth login --web`, save a TanStack Source token in Settings, or set SRC_TOKEN on the server.",
      unauthenticated:
        "TanStack Source refused the server's credential. Run `src auth login --web` again, or replace the token saved in Settings.",
    },
    readsPublicHostWithoutCheckout: true,
    servesHost: (host) => Hosts.tanStackSourceHost(host) !== null,
    getViewer: (input) => viewerOf(input.host ?? definition.publicHost ?? ""),

    listChangeRequests: Effect.fn("TanStackSourcePullRequestProvider.listChangeRequests")(
      function* (input) {
        const base = yield* repositoryPath("listChangeRequests", input);
        const filters = new URLSearchParams();
        if (input.query?.trim()) filters.set("query", input.query.trim());
        if (input.involvement === "authored") filters.set("author", "@me");
        if (input.involvement === "reviewing") filters.set("reviewRequested", "@me");
        if (input.filters?.author !== undefined && input.involvement !== "authored")
          filters.set("author", resolvePullRequestAuthorFilter(input.filters.author, input.viewer));
        const label = input.filters?.labels?.[0];
        if (label?.length === 1) filters.set("label", label[0]!);
        if (input.filters?.draft !== undefined)
          filters.set("draft", input.filters.draft === "only" ? "true" : "false");
        const limit = Math.max(1, input.limit);
        const readListing = (cursor: string | undefined) =>
          Listing.readMerged({
            states: listState(input.state),
            cursor,
            limit,
            maxPages: PAGE_LIMIT,
            readPage: (state, page) => {
              const query = new URLSearchParams(filters);
              query.set("state", state);
              if (page !== null) query.set("cursor", page);
              return read(
                "listChangeRequests",
                input,
                { path: `${base}/pulls?${query}` },
                Json.SourcePulls,
              );
            },
            keep: (pull) => input.state !== "merged" || pull.state === "merged",
          });
        // The service ends a listing at a page without rows, so a page a filter emptied reads on.
        let listing = yield* readListing(input.cursor?.resumeAfter);
        for (let scans = 1; listing.items.length === 0 && listing.next !== null; scans++) {
          if (scans >= PAGE_LIMIT) break;
          listing = yield* readListing(listing.next);
        }
        // List rows name no base, which the list shows, so each delivered row is read in full.
        const details = yield* Effect.forEach(
          listing.items,
          (pull) => readPull("listChangeRequests", { ...input, number: pull.number }),
          { concurrency: 8 },
        );
        return {
          ...(listing.next === null ? {} : { resumeAfter: listing.next }),
          items: details.map((pull) => toSummary(pull, input)),
          truncated: listing.next !== null,
          continues: listing.next !== null,
        };
      },
    ),

    getChangeRequestSummary: Effect.fn("TanStackSourcePullRequestProvider.getChangeRequestSummary")(
      function* (input) {
        const pull = yield* readPull("getChangeRequestSummary", input);
        const { checks } = yield* readChecks("getChangeRequestSummary", input, pull.headSha).pipe(
          Effect.orElseSucceed(() => ({ checks: [] })),
        );
        const { additions: _additions, deletions: _deletions, ...summary } = toSummary(pull, input);
        const checksState = Json.checksStateOf(checks);
        return {
          ...summary,
          ...(pull.changedFiles === null ? {} : { changedFiles: pull.changedFiles }),
          ...(checksState === null ? {} : { checksState }),
        };
      },
    ),

    getChangeRequest: Effect.fn("TanStackSourcePullRequestProvider.getChangeRequest")(
      function* (input) {
        const operation = "getChangeRequest";
        const pull = yield* readPull(operation, input);
        const path = yield* pullPath(operation, input);
        const [{ checks, merge: mergeChecks }, files, viewer, stack] = yield* Effect.all(
          [
            readChecks(operation, input, pull.headSha),
            read(operation, input, { path: `${path}/files` }, Json.SourceFiles).pipe(
              Effect.orElseSucceed(() => null),
            ),
            viewerOf(input.host).pipe(Effect.orElseSucceed(() => null)),
            readStack(operation, input).pipe(Effect.orElseSucceed(() => null)),
          ],
          { concurrency: 4 },
        );
        const counted = files?.files ?? null;
        const permissions = permissionsOf(pull, viewer);
        const mayMerge = mergeChecks?.mayMerge !== false;
        const checksState = Json.checksStateOf(checks);
        const index = stack?.members.findIndex((member) => member.number === pull.number) ?? -1;
        const detail: ProviderChangeRequestDetail = {
          ...toSummary(pull, input),
          ...(stack !== null && stack.members.length > 1 && index >= 0
            ? {
                stack: {
                  number: stack.members[0]!.number,
                  position: index + 1,
                  size: stack.members.length,
                  base: stack.members[0]!.baseRef,
                },
              }
            : {}),
          baseBranch: pull.base,
          headRepositoryNameWithOwner: pull.headRepo,
          reviewRequestLogins: pull.reviewRequests ?? [],
          body: pull.body ?? "",
          additions: counted?.reduce((total, file) => total + (file.additions ?? 0), 0) ?? 0,
          deletions: counted?.reduce((total, file) => total + (file.deletions ?? 0), 0) ?? 0,
          changedFiles: pull.changedFiles ?? counted?.length ?? 0,
          mergedAt: pull.mergedAt === null ? null : Json.iso(pull.mergedAt),
          mergeCommitSha: pull.mergeCommitSha,
          mergedBy: Json.toActor(pull.mergedBy, input.host),
          closedAt: null,
          reviewers: [],
          checks,
          ...(checksState === null ? {} : { checksState }),
          mergeCapabilities: { merge: mayMerge, squash: mayMerge, rebase: false },
          baseComparison:
            mergeChecks?.upToDate === true
              ? "up-to-date"
              : mergeChecks?.upToDate === false
                ? "behind"
                : "unknown",
          viewerPermissions: mayMerge
            ? permissions
            : {
                ...permissions,
                actions: permissions.actions.filter((action) => action !== "merge"),
              },
        };
        return detail;
      },
    ),

    getChangeRequestChecks: Effect.fn("TanStackSourcePullRequestProvider.getChangeRequestChecks")(
      function* (input) {
        const pull = yield* readPull("getChangeRequestChecks", input);
        const { checks } = yield* readChecks("getChangeRequestChecks", input, pull.headSha);
        return { checks, state: pull.state };
      },
    ),

    changeRequestEvents: (input) => events(input),

    getChangeRequestStack: Effect.fn("TanStackSourcePullRequestProvider.getChangeRequestStack")(
      function* (input) {
        const stack = yield* readStack("getChangeRequestStack", input);
        if (stack.members.length < 2) return null;
        // The stack names no states; a merged layer leaves it, so the rest are open.
        return Json.toStack(stack, input, new Map());
      },
    ),

    getChangeRequestActivity: Effect.fn(
      "TanStackSourcePullRequestProvider.getChangeRequestActivity",
    )(function* (input) {
      const operation = "getChangeRequestActivity";
      const base = yield* repositoryPath(operation, input);
      const path = yield* pullPath(operation, input);
      const [timeline, threads, commits] = yield* Effect.all(
        [
          read(operation, input, { path: `${base}/issues/${input.number}` }, Json.SourceTimeline),
          read(operation, input, { path: `${path}/comments` }, Json.SourceThreads),
          read(operation, input, { path: `${path}/commits` }, Json.SourceCommits).pipe(
            Effect.orElseSucceed(() => ({
              baseSha: null,
              headSha: null,
              mergeBaseSha: null,
              available: false,
              commitsTruncated: null,
              commits: null,
            })),
          ),
        ],
        { concurrency: 3 },
      );
      return Json.toActivity({
        timeline,
        threads,
        commits,
        host: input.host,
        repository: input.repository,
        number: input.number,
      });
    }),

    getViewerPermissions: Effect.fn("TanStackSourcePullRequestProvider.getViewerPermissions")(
      function* (input) {
        const [pull, viewer] = yield* Effect.all(
          [readPull("getViewerPermissions", input), viewerOf(input.host)],
          { concurrency: 2 },
        );
        return permissionsOf(pull, viewer);
      },
    ),

    getDiff: Effect.fn("TanStackSourcePullRequestProvider.getDiff")(function* (input) {
      if (input.commit !== undefined)
        return yield* failure("getDiff", "TanStack Source cannot show one commit's diff here yet.");
      const path = yield* pullPath("getDiff", input);
      const [diff, files] = yield* Effect.all(
        [
          read("getDiff", input, { path: `${path}/diff` }, Json.SourceDiff),
          read("getDiff", input, { path: `${path}/files` }, Json.SourceFiles).pipe(
            Effect.orElseSucceed(() => null),
          ),
        ],
        { concurrency: 2 },
      );
      if (!diff.available || diff.patch === null)
        return yield* failure(
          "getDiff",
          "TanStack Source has no diff for this pull request right now.",
        );
      if (input.path !== undefined) {
        const section = diffFileSection(diff.patch, input.path);
        return {
          patch: section === null ? "" : section.endsWith("\n") ? section : `${section}\n`,
          truncated: section === null && diff.truncated === true,
          nextCursor: null,
        };
      }
      const presentPaths = new Set(
        parseDiffFilePaths(diff.patch).map((file) => file.newPath ?? file.oldPath),
      );
      // Files the cut-off patch leaves out still show, as counts.
      const omittedFileStats = (files?.files ?? [])
        .filter((file) => !presentPaths.has(file.path))
        .map((file) => ({
          path: file.path,
          additions: file.additions ?? 0,
          deletions: file.deletions ?? 0,
        }));
      return {
        patch: diff.patch,
        truncated: diff.truncated === true || omittedFileStats.length > 0,
        nextCursor: null,
        ...(omittedFileStats.length === 0 ? {} : { omittedFileStats }),
      };
    }),

    getDiffFilePaths: Effect.fn("TanStackSourcePullRequestProvider.getDiffFilePaths")(
      function* (input) {
        if (input.commit !== undefined)
          return yield* failure(
            "getDiffFilePaths",
            "TanStack Source cannot list one commit's files here yet.",
          );
        const path = yield* pullPath("getDiffFilePaths", input);
        const files = yield* read(
          "getDiffFilePaths",
          input,
          { path: `${path}/files` },
          Json.SourceFiles,
        );
        return {
          files: (files.files ?? []).map((file) => ({
            oldPath: file.oldPath ?? file.path,
            newPath: file.path,
          })),
          nextCursor: null,
        };
      },
    ),

    getFileStats: Effect.fn("TanStackSourcePullRequestProvider.getFileStats")(function* (input) {
      const path = yield* pullPath("getFileStats", input);
      const files = yield* read("getFileStats", input, { path: `${path}/files` }, Json.SourceFiles);
      return {
        files: (files.files ?? []).map((file) => ({
          path: file.path,
          additions: file.additions ?? 0,
          deletions: file.deletions ?? 0,
        })),
        truncated: files.truncated === true,
      };
    }),

    getDiffFileContents: Effect.fn("TanStackSourcePullRequestProvider.getDiffFileContents")(
      function* (input) {
        const operation = "getDiffFileContents";
        if (input.commit !== undefined)
          return yield* failure(
            operation,
            "TanStack Source cannot read one commit's files here yet.",
          );
        const path = yield* pullPath(operation, input);
        const [pull, files] = yield* Effect.all(
          [
            readPull(operation, input),
            read(operation, input, { path: `${path}/files` }, Json.SourceFiles),
          ],
          { concurrency: 2 },
        );
        const oldRevision = files.mergeBaseSha;
        const newRevision = files.headSha;
        if (oldRevision === null || newRevision === null)
          return yield* failure(operation, "TanStack Source has not reported the diff's commits.");
        const readFile = (repository: string, revision: string, filePath: string) =>
          repositoryPath(operation, { ...input, repository }).pipe(
            Effect.flatMap((base) =>
              read(
                operation,
                input,
                {
                  path: `${base}/contents/${filePath.split("/").map(encodeURIComponent).join("/")}?${new URLSearchParams({ ref: revision })}`,
                },
                Json.SourceContents,
              ),
            ),
            Effect.flatMap((file) =>
              file.binary || file.truncated || file.content === null
                ? Effect.fail(failure(operation, `${filePath} is too large or binary to show.`))
                : Effect.succeed(file.content),
            ),
          );
        const [oldContents, newContents] = yield* Effect.all(
          [
            input.changeType === "new"
              ? Effect.succeed("")
              : readFile(input.repository, oldRevision, input.oldPath),
            input.changeType === "deleted"
              ? Effect.succeed("")
              : readFile(pull.headRepo ?? input.repository, newRevision, input.newPath),
          ],
          { concurrency: 2 },
        );
        return { oldContents, newContents };
      },
    ),

    getCheckLogs: Effect.fn("TanStackSourcePullRequestProvider.getCheckLogs")(function* (input) {
      const base = yield* repositoryPath("getCheckLogs", input);
      return yield* Effect.forEach(
        input.checks,
        (check): Effect.Effect<ProviderCheckLog, PullRequestProviderError> => {
          const job = Json.parseCiJobUrl(check.url, input.host);
          if (job === null)
            return Effect.succeed({
              ...check,
              log: null,
              truncated: false,
              detail:
                "This check did not run on TanStack Source CI, which holds no log for it. Open its url.",
            });
          const logs = `${base}/ci/runs/${encodeURIComponent(job.runId)}/jobs/${encodeURIComponent(job.job)}/logs`;
          return Effect.gen(function* () {
            // The first line's answer names every step's line count, so the tail is one more read.
            const head = yield* api
              .response({
                host: input.host,
                operation: "getCheckLogs",
                path: `${logs}?from=1&to=1`,
                accept: "text/plain",
              })
              .pipe(Effect.mapError(toProviderError("getCheckLogs")));
            const steps = decodeLogSteps(head.headers["x-log-steps"] ?? "");
            const total =
              steps._tag === "Some" ? steps.value.reduce((sum, step) => sum + step.lines, 0) : 0;
            const from = Math.max(1, total - input.tailLines + 1);
            const text =
              total <= 1
                ? head.text
                : yield* send("getCheckLogs", input, {
                    path: `${logs}?from=${from}&to=${total}`,
                    accept: "text/plain",
                  });
            const tail = tailLogLines(text.replace(ANSI, ""), input.tailLines);
            return { ...check, log: tail.log, truncated: tail.truncated || from > 1, detail: null };
          }).pipe(
            // Sign-in and rate-limit failures fail the call; the rest are this check's.
            Effect.catchIf(
              (error) => error.reason !== "unauthenticated" && error.reason !== "rate-limited",
              (error) =>
                Effect.succeed({ ...check, log: null, truncated: false, detail: error.detail }),
            ),
          );
        },
        { concurrency: 4 },
      );
    }),

    rerunChecks: Effect.fn("TanStackSourcePullRequestProvider.rerunChecks")(function* (input) {
      const base = yield* repositoryPath("rerunChecks", input);
      const located = input.checks.map((check) => ({
        check,
        runId: Json.parseCiJobUrl(check.url, input.host)?.runId ?? null,
      }));
      const runIds = new Set(located.flatMap(({ runId }) => (runId === null ? [] : [runId])));
      const outcomes = new Map<string, string | null>();
      yield* Effect.forEach(
        runIds,
        (runId) =>
          send("rerunChecks", input, {
            method: "POST",
            path: `${base}/ci/runs/${encodeURIComponent(runId)}/rerun`,
            body: { failedOnly: true },
          }).pipe(
            Effect.as<string | null>(null),
            Effect.catchIf(
              (error) => error.reason !== "unauthenticated" && error.reason !== "rate-limited",
              (error) => Effect.succeed(error.detail),
            ),
            Effect.map((detail) => outcomes.set(runId, detail)),
          ),
        { concurrency: 2, discard: true },
      );
      return located.map(({ check, runId }): ProviderCheckRerun => {
        if (runId === null)
          return {
            name: check.name,
            rerun: false,
            detail: "This check did not run on TanStack Source CI, so it cannot be re-run here.",
          };
        const detail = outcomes.get(runId) ?? null;
        return { name: check.name, rerun: detail === null, detail };
      });
    }),

    runAction: Effect.fn("TanStackSourcePullRequestProvider.runAction")(function* (input) {
      const path = yield* pullPath(input.action, input);
      switch (input.action) {
        case "merge":
          return yield* merge(input);
        case "ready":
        case "draft":
          yield* send(input.action, input, {
            method: input.action === "ready" ? "PUT" : "DELETE",
            path: `${path}/ready`,
          });
          return;
        case "close":
        case "reopen":
          yield* send(input.action, input, {
            method: "PATCH",
            path,
            body: { state: input.action === "close" ? "closed" : "open" },
          });
          return;
        case "update-branch": {
          const pull = yield* readPull(input.action, input);
          yield* send(input.action, input, {
            method: "POST",
            path: `${path}/update-branch`,
            body: {
              rebase: input.updateMethod === "rebase",
              ...(pull.headSha === null ? {} : { sha: input.expectedHeadSha ?? pull.headSha }),
            },
          });
          return;
        }
        case "enable-auto-merge":
          yield* send(input.action, input, {
            method: "PUT",
            path: `${path}/auto-merge`,
            body: { merge_method: input.mergeMethod === "squash" ? "squash" : "merge" },
          });
          return;
        case "disable-auto-merge":
          yield* send(input.action, input, { method: "DELETE", path: `${path}/auto-merge` });
          return;
        default:
          return yield* failure(
            input.action,
            `TanStack Source cannot ${input.action} from T3 Code.`,
          );
      }
    }),

    updateChangeRequest: Effect.fn("TanStackSourcePullRequestProvider.updateChangeRequest")(
      function* (input) {
        const path = yield* pullPath("updateChangeRequest", input);
        yield* send("updateChangeRequest", input, {
          method: "PATCH",
          path,
          body: {
            ...(input.title === undefined ? {} : { title: input.title }),
            ...(input.body === undefined ? {} : { body: input.body }),
          },
        });
      },
    ),

    comment: Effect.fn("TanStackSourcePullRequestProvider.comment")(function* (input) {
      const base = yield* repositoryPath("comment", input);
      yield* send("comment", input, {
        method: "POST",
        path: `${base}/issues/${input.number}/comments`,
        body: { body: input.body },
      });
    }),

    updateComment: Effect.fn("TanStackSourcePullRequestProvider.updateComment")(function* (input) {
      if (!/^\d+$/u.test(input.commentId))
        return yield* failure("updateComment", "TanStack Source comment ids are numbers.");
      const base = yield* repositoryPath("updateComment", input);
      yield* send("updateComment", input, {
        method: "PATCH",
        path: `${base}/issues/comments/${input.commentId}`,
        body: { body: input.body },
      });
    }),

    submitReview: Effect.fn("TanStackSourcePullRequestProvider.submitReview")(function* (input) {
      const pull = yield* readPull("submitReview", input);
      if (input.comments.length > 0 && pull.headSha === null)
        return yield* failure(
          "submitReview",
          "TanStack Source has not reported the pull request's head, which line comments pin to.",
        );
      const path = yield* pullPath("submitReview", input);
      yield* send("submitReview", input, {
        method: "POST",
        path: `${path}/reviews`,
        body: {
          verdict:
            input.verdict === "approve"
              ? "approved"
              : input.verdict === "request-changes"
                ? "changes_requested"
                : "commented",
          ...(input.body.length === 0 ? {} : { body: input.body }),
          ...(input.comments.length === 0
            ? {}
            : {
                comments: input.comments.map((comment) =>
                  Json.toReviewComment(comment, pull.headSha!),
                ),
              }),
        },
      });
    }),

    listReviewerCandidates: () => Effect.succeed({ candidates: [], truncated: false }),

    setReviewerRequest: Effect.fn("TanStackSourcePullRequestProvider.setReviewerRequest")(
      function* (input) {
        const path = yield* pullPath("setReviewerRequest", input);
        const usernames = input.reviewers.map((reviewer) => reviewer.id);
        yield* send("setReviewerRequest", input, {
          method: "POST",
          path: `${path}/reviewers`,
          body: input.requested ? { add: usernames } : { remove: usernames },
        });
      },
    ),

    listLabelCandidates: Effect.fn("TanStackSourcePullRequestProvider.listLabelCandidates")(
      function* (input) {
        const base = yield* repositoryPath("listLabelCandidates", input);
        const [labels, pull] = yield* Effect.all(
          [
            read("listLabelCandidates", input, { path: `${base}/labels` }, Json.SourceLabels),
            readPull("listLabelCandidates", input),
          ],
          { concurrency: 2 },
        );
        const applied = new Set(pull.labels ?? []);
        return {
          candidates: labels.map((label) => ({
            name: label.name,
            color: label.color,
            description: label.description ?? null,
            isApplied: applied.has(label.name),
          })),
          truncated: false,
        };
      },
    ),

    listRepositoryLabels: Effect.fn("TanStackSourcePullRequestProvider.listRepositoryLabels")(
      function* (input) {
        const base = yield* repositoryPath("listRepositoryLabels", input);
        const labels = yield* read(
          "listRepositoryLabels",
          input,
          { path: `${base}/labels` },
          Json.SourceLabels,
        );
        return {
          items: labels.map((label) => ({ name: label.name, color: label.color })),
          truncated: false,
        };
      },
    ),

    setLabels: Effect.fn("TanStackSourcePullRequestProvider.setLabels")(function* (input) {
      const base = yield* repositoryPath("setLabels", input);
      const path = `${base}/issues/${input.number}/labels`;
      if (input.applied) {
        yield* send("setLabels", input, { method: "POST", path, body: { labels: input.labels } });
        return;
      }
      yield* Effect.forEach(
        input.labels,
        (label) =>
          send("setLabels", input, {
            method: "DELETE",
            path: `${path}/${encodeURIComponent(label)}`,
          }),
        { concurrency: 2, discard: true },
      );
    }),

    replyToThread: Effect.fn("TanStackSourcePullRequestProvider.replyToThread")(function* (input) {
      if (!/^\d+$/u.test(input.threadId))
        return yield* failure("replyToThread", "TanStack Source thread ids are numbers.");
      const path = yield* pullPath("replyToThread", input);
      yield* send("replyToThread", input, {
        method: "POST",
        path: `${path}/comments`,
        body: { replyTo: Number(input.threadId), body: input.body },
      });
    }),

    setReaction: () =>
      Effect.fail(failure("setReaction", "TanStack Source reactions are not supported here yet.")),

    setThreadResolution: Effect.fn("TanStackSourcePullRequestProvider.setThreadResolution")(
      function* (input) {
        if (!/^\d+$/u.test(input.threadId))
          return yield* failure("setThreadResolution", "TanStack Source thread ids are numbers.");
        const path = yield* pullPath("setThreadResolution", input);
        yield* send("setThreadResolution", input, {
          method: "PUT",
          path: `${path}/threads/${input.threadId}`,
          body: { resolved: input.resolved },
        });
      },
    ),
  };
  return provider;
});
