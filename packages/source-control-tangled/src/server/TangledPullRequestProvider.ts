import {
  SourceControlProviderKind,
  type PullRequestCapabilities,
  type PullRequestState,
} from "@t3tools/contracts";
import * as Cache from "effect/Cache";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import { HttpClient, HttpClientRequest } from "effect/http";
import { collectUint8StreamText } from "@t3tools/provider-core/server/collectStreamText";

import {
  PullRequestProviderError,
  type ProviderChangeRequest,
  type ProviderChangeRequestDetail,
  type ProviderChangeRequestPage,
  type ProviderChangeRequestSummary,
  type PullRequestProviderApi,
} from "@t3tools/source-control-core/server/PullRequestProvider";

import { TangledAuthStatusSchema, TangledCli, type TangledCliError } from "./TangledCli.ts";
import {
  numberPulls,
  offsetFromRows,
  parsePullPageRows,
  type NumberedPull,
  TangledPullListSchema,
  TangledPullViewSchema,
} from "./tangledPulls.ts";

const KIND = SourceControlProviderKind.make("tangled");

/**
 * What this build offers once a Tangled pull request can be named. Reading the list, its detail,
 * its summary and who wrote it all work; nothing that writes does, so every capability that would
 * reach the host is off and the panels that would offer it stay hidden.
 */
const CAPABILITIES: PullRequestCapabilities = {
  diff: false,
  comment: false,
  actions: [],
  mergeMethods: [],
  // Every pull request is listed at once and narrowed here, so a text filter is honoured.
  search: true,
  stacks: false,
  reactions: false,
  labels: false,
  review: { inlineComment: false, reply: false, resolve: false, verdicts: [] },
  reviewers: { request: false, listCandidates: false },
  edit: { changeRequest: false, comment: false },
};

/** One reader of tangled.org's numbering, per repository, for as long as it is likely to hold. */
const OFFSET_TTL = Duration.minutes(30);
const OFFSET_CACHE_CAPACITY = 32;

const pullState = (state: string): PullRequestState =>
  state === "merged" ? "merged" : state === "closed" ? "closed" : "open";

export const make = Effect.gen(function* () {
  const cli = yield* TangledCli;
  const httpClient = yield* HttpClient.HttpClient;

  const failure = (
    operation: string,
    detail: string,
    reason: PullRequestProviderError["reason"] = "failed",
  ) => new PullRequestProviderError({ provider: KIND, operation, reason, detail });

  const cliFailure = (operation: string, cause: TangledCliError) =>
    failure(
      operation,
      cause.detail,
      cause.reason === "authentication"
        ? "unauthenticated"
        : cause.reason === "missing-cli"
          ? "missing-tool"
          : "failed",
    );

  const unsupported = (operation: string, detail: string) => () =>
    Effect.fail(failure(operation, detail));

  /** Every pull request `tg` reports, ordered and placed the way tangled.org numbered them. */
  const listed = Effect.fn("TangledPullRequestProvider.listed")(function* (input: {
    readonly operation: string;
    readonly cwd: string;
    readonly repository: string;
  }) {
    return yield* cli
      .runJson({
        cwd: input.cwd,
        args: ["pr", "list", input.repository],
        schema: TangledPullListSchema,
      })
      .pipe(
        Effect.map((answer) => numberPulls(answer.items)),
        Effect.mapError((cause) => cliFailure(input.operation, cause)),
      );
  });

  /**
   * The offset tangled.org's numbering carries past the records `tg pr list` returns. It is not
   * something `tg` reports, so it is read once from the repository's own page and cached; a
   * repository whose page cannot be read, or whose rows imply different offsets, reads as
   * unknown and its pull requests are left unnumbered rather than numbered wrongly.
   */
  const offsets = yield* Cache.make({
    lookup: (repository: string) =>
      Effect.gen(function* () {
        const pulls = yield* listed({
          operation: "listChangeRequests",
          cwd: ".",
          repository,
        });
        if (pulls.length === 0) return 0;
        const html = yield* Effect.gen(function* () {
          const response = yield* httpClient.execute(
            HttpClientRequest.get(`https://tangled.org/${repository}/pulls?q=state%3Aall`).pipe(
              HttpClientRequest.setHeader("accept", "text/html"),
            ),
          );
          if (response.status < 200 || response.status >= 300) return null;
          return (yield* collectUint8StreamText({
            stream: response.stream,
            maxBytes: 4 * 1024 * 1024,
          })).text;
        }).pipe(
          // A page that cannot be read leaves the numbering unknown, which reads as a repository
          // whose pull requests are not listed rather than as a failure to report.
          Effect.orElseSucceed(() => null),
        );
        return html === null ? null : offsetFromRows(parsePullPageRows(html, repository), pulls);
      }),
    capacity: OFFSET_CACHE_CAPACITY,
    timeToLive: OFFSET_TTL,
  });

  const toChangeRequest = (
    entry: NumberedPull,
    number: number,
    repository: string,
  ): ProviderChangeRequest => {
    const pull = entry.pull;
    return {
      number,
      title: pull.title,
      url: `https://tangled.org/${repository}/pulls/${number}`,
      author:
        pull.author === undefined
          ? null
          : { login: pull.author.handle, name: null, avatarUrl: null },
      headBranch: pull.sourceBranch ?? "",
      baseBranch: pull.targetBranch ?? "",
      state: pullState(pull.state),
      isDraft: false,
      mergeability: "unknown",
      additions: 0,
      deletions: 0,
      createdAt: pull.createdAt,
      updatedAt: pull.updatedAt ?? pull.createdAt,
      reviewRequestLogins: [],
      labels: [],
    };
  };

  /** Every pull request in a repository, numbered. Refuses rather than inventing a number. */
  const numbered = Effect.fn("TangledPullRequestProvider.numbered")(function* (input: {
    readonly operation: string;
    readonly cwd: string;
    readonly repository: string;
  }) {
    const pulls = yield* listed(input);
    if (pulls.length === 0) return [];
    const offset = yield* offsets.lookup(input.repository);
    if (offset === null) {
      // A repository may gain enough rows to resolve its numbering on the next attempt.
      yield* Cache.invalidate(offsets, input.repository);
      return yield* failure(
        input.operation,
        `Tangled did not report how ${input.repository} numbers its pull requests, so they cannot be listed by number. Open the repository on tangled.org once, or read them with \`tg pr list\`.`,
      );
    }
    return pulls.map((entry) => ({
      entry,
      changeRequest: toChangeRequest(entry, entry.index + offset, input.repository),
    }));
  });

  const byNumber = Effect.fn("TangledPullRequestProvider.byNumber")(function* (input: {
    readonly operation: string;
    readonly cwd: string;
    readonly number: number;
    readonly repository: string;
  }) {
    const items = yield* numbered(input);
    const found = items.find((item) => item.changeRequest.number === input.number);
    if (found === undefined) {
      return yield* failure(
        input.operation,
        `Pull request #${input.number} was not found in ${input.repository}.`,
        "not-found",
      );
    }
    return found;
  });

  const readByNumber = Effect.fn("TangledPullRequestProvider.readByNumber")(function* (input: {
    readonly operation: string;
    readonly cwd: string;
    readonly number: number;
    readonly repository: string;
  }) {
    const { entry, changeRequest } = yield* byNumber(input);
    const detail = yield* cli
      .runJson({
        cwd: input.cwd,
        args: ["pr", "view", entry.pull.rkey, "--repo", input.repository],
        schema: TangledPullViewSchema,
      })
      .pipe(Effect.mapError((cause) => cliFailure(input.operation, cause)));
    return {
      pull: toChangeRequest(
        { ...entry, pull: { ...entry.pull, ...detail } },
        changeRequest.number,
        input.repository,
      ),
      body: detail.body ?? "",
      commentCount: entry.pull.commentCount ?? 0,
    };
  });

  const provider: PullRequestProviderApi = {
    kind: KIND,
    capabilities: CAPABILITIES,

    getViewer: (input) =>
      cli
        .runJson({
          cwd: input.cwd,
          args: ["auth", "status"],
          schema: TangledAuthStatusSchema,
        })
        .pipe(
          Effect.map((status) => status.handle ?? status.did ?? ""),
          Effect.mapError((cause) => cliFailure("getViewer", cause)),
        ),

    listChangeRequests: (input) =>
      numbered({
        operation: "listChangeRequests",
        cwd: input.cwd,
        repository: input.repository,
      }).pipe(
        Effect.map((items) => {
          const matches = items
            .map((item) => item.changeRequest)
            .filter((item) => {
              if (input.state !== "all" && item.state !== input.state) return false;
              const authored = item.author !== null && item.author.login === input.viewer;
              if (input.involvement === "authored") return authored;
              // Tangled reports no review requests, so a reviewer's pull request is one it does not
              // name; `reviewing` therefore keeps every row rather than dropping all of them.
              return true;
            });
          const searched = input.query
            ? matches.filter((item) =>
                item.title.toLowerCase().includes(input.query!.toLowerCase()),
              )
            : matches;
          const page = searched.slice(0, input.limit);
          return {
            items: page,
            truncated: searched.length > page.length,
            continues: false,
          } satisfies ProviderChangeRequestPage;
        }),
      ),

    getChangeRequest: (input) =>
      readByNumber({
        operation: "getChangeRequest",
        cwd: input.cwd,
        number: input.number,
        repository: input.repository,
      }).pipe(
        Effect.map(({ pull, body }): ProviderChangeRequestDetail => ({
          ...pull,
          body,
          changedFiles: 0,
          mergedAt: pull.mergedAt ?? null,
          closedAt: pull.closedAt ?? null,
          reviewers: [],
          checks: [],
          mergeCapabilities: { merge: false, squash: false, rebase: false },
          viewerPermissions: {
            actions: [],
            comment: false,
            resolve: false,
            verdicts: [],
            requestReviewers: false,
          },
        })),
      ),

    getChangeRequestSummary: (input) =>
      byNumber({
        operation: "getChangeRequestSummary",
        cwd: input.cwd,
        number: input.number,
        repository: input.repository,
      }).pipe(
        Effect.map(({ changeRequest: pull }): ProviderChangeRequestSummary => ({
          number: pull.number,
          title: pull.title,
          url: pull.url,
          headBranch: pull.headBranch,
          baseBranch: pull.baseBranch,
          state: pull.state,
          closedAt: pull.closedAt ?? null,
          mergedAt: pull.mergedAt ?? null,
          updatedAt: pull.updatedAt,
          author: pull.author,
        })),
      ),

    getChangeRequestActivity: (input) =>
      readByNumber({
        operation: "getChangeRequestActivity",
        cwd: input.cwd,
        number: input.number,
        repository: input.repository,
      }).pipe(
        Effect.map(({ pull, commentCount }) => ({
          author: pull.author,
          reviewers: [],
          comments: [],
          commentCount,
          // tg reports the count but exposes no comment bodies in pr view.
          commentsTruncated: commentCount > 0,
          reviewThreads: [],
          commits: [],
        })),
      ),

    getViewerPermissions: (input) =>
      byNumber({
        operation: "getViewerPermissions",
        cwd: input.cwd,
        number: input.number,
        repository: input.repository,
      }).pipe(
        Effect.map(() => ({
          actions: [],
          comment: false,
          resolve: false,
          verdicts: [],
          requestReviewers: false,
        })),
      ),

    getDiff: unsupported("getDiff", "Tangled pull request diffs are not read by this build."),
    runAction: unsupported("runAction", "Tangled pull requests are not acted on by this build."),
    comment: unsupported("comment", "Tangled pull requests are not commented on by this build."),
    submitReview: unsupported(
      "submitReview",
      "Tangled pull request reviews are not submitted by this build.",
    ),
    listReviewerCandidates: unsupported(
      "listReviewerCandidates",
      "Tangled reviewer requests are not supported.",
    ),
    setReviewerRequest: unsupported(
      "setReviewerRequest",
      "Tangled reviewer requests are not supported.",
    ),
    replyToThread: unsupported("replyToThread", "Tangled review threads are not supported."),
    setReaction: unsupported("setReaction", "Tangled reactions are not supported."),
    setThreadResolution: unsupported(
      "setThreadResolution",
      "Tangled review threads are not supported.",
    ),
  };

  return provider;
});
