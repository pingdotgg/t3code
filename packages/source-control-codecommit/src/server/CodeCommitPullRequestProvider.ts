import {
  SourceControlProviderKind,
  type PullRequestCapabilities,
  type PullRequestComment,
  type PullRequestReviewThread,
  type PullRequestOverviewThread,
  type PullRequestViewerPermissions,
} from "@t3tools/contracts";
import {
  PullRequestProviderError,
  type ProviderChangeRequest,
  type ProviderRepositoryRef,
  type PullRequestProviderApi,
} from "@t3tools/source-control-core/server/PullRequestProvider";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as Hash from "effect/Hash";
import {
  codeCommitChangeRequestUrl,
  parseCodeCommitRemote,
  parseCodeCommitHelperRemote,
} from "../shared/definition.ts";
import * as SourceControlHost from "@t3tools/source-control-core/server/SourceControlHost";
import * as CodeCommitCli from "./CodeCommitCli.ts";
import * as CodeCommitDiff from "./CodeCommitDiff.ts";

const kind = SourceControlProviderKind.make("aws-codecommit");
// Each pull request requires a separate AWS CLI process before the page can be returned.
const PAGE_SIZE = 20;
const isCodeCommitError = Schema.is(CodeCommitCli.CodeCommitError);
const isProviderError = Schema.is(PullRequestProviderError);
const capabilities: PullRequestCapabilities = {
  diff: true,
  comment: true,
  actions: ["merge", "close"],
  mergeMethods: ["merge", "squash", "fast-forward"],
  search: false,
  reactions: false,
  review: {
    inlineComment: true,
    reply: true,
    resolve: false,
    verdicts: ["comment", "approve", "revoke-approval"],
  },
  reviewers: { request: false, listCandidates: false },
  edit: { changeRequest: true, comment: true },
  viewedFiles: "environment",
};
const timestamp = Schema.Union([Schema.String, Schema.Number]);
const pullSchema = Schema.Struct({
  pullRequest: Schema.Struct({
    pullRequestId: Schema.String,
    title: Schema.String,
    revisionId: Schema.optional(Schema.String),
    description: Schema.optional(Schema.String),
    authorArn: Schema.String,
    creationDate: timestamp,
    lastActivityDate: timestamp,
    pullRequestStatus: Schema.Literals(["OPEN", "CLOSED"]),
    pullRequestTargets: Schema.Array(
      Schema.Struct({
        repositoryName: Schema.String,
        sourceReference: Schema.String,
        destinationReference: Schema.String,
        sourceCommit: Schema.optional(Schema.String),
        destinationCommit: Schema.optional(Schema.String),
        mergeBase: Schema.optional(Schema.String),
        mergeMetadata: Schema.optional(
          Schema.Struct({ isMerged: Schema.optional(Schema.Boolean) }),
        ),
      }),
    ),
  }),
});
const listSchema = Schema.Struct({
  pullRequestIds: Schema.Array(Schema.String),
  nextToken: Schema.optional(Schema.String),
});
const callerSchema = Schema.Struct({ Account: Schema.String, Arn: Schema.String });
const credentialKey = Schema.encodeSync(Schema.fromJsonString(Schema.Array(Schema.String)));
const encodePayload = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const approvalsSchema = Schema.Struct({
  approvals: Schema.Array(Schema.Struct({ userArn: Schema.String, approvalState: Schema.String })),
});
const evaluationSchema = Schema.Struct({
  evaluation: Schema.Struct({
    approved: Schema.Boolean,
    overridden: Schema.Boolean,
    approvalRulesSatisfied: Schema.Array(Schema.String),
    approvalRulesNotSatisfied: Schema.Array(Schema.String),
  }),
});
const mergeabilitySchema = Schema.Struct({ mergeable: Schema.Boolean });
const eventsSchema = Schema.Struct({
  pullRequestEvents: Schema.Array(
    Schema.Struct({
      eventDate: timestamp,
      actorArn: Schema.optional(Schema.String),
      pullRequestEventType: Schema.String,
      pullRequestStatusChangedEventMetadata: Schema.optional(
        Schema.Struct({ pullRequestStatus: Schema.String }),
      ),
      pullRequestMergedStateChangedEventMetadata: Schema.optional(
        Schema.Struct({
          mergeMetadata: Schema.optional(Schema.Struct({ isMerged: Schema.Boolean })),
        }),
      ),
      approvalStateChangedEventMetadata: Schema.optional(
        Schema.Struct({ approvalStatus: Schema.String, revisionId: Schema.String }),
      ),
    }),
  ),
  nextToken: Schema.optional(Schema.String),
});
const commentsSchema = Schema.Struct({
  commentsForPullRequestData: Schema.Array(
    Schema.Struct({
      repositoryName: Schema.optional(Schema.String),
      beforeCommitId: Schema.optional(Schema.String),
      afterCommitId: Schema.optional(Schema.String),
      location: Schema.optional(
        Schema.Struct({
          filePath: Schema.optional(Schema.String),
          filePosition: Schema.optional(Schema.Number),
          relativeFileVersion: Schema.optional(Schema.String),
        }),
      ),
      comments: Schema.optional(
        Schema.Array(
          Schema.Struct({
            commentId: Schema.String,
            content: Schema.optional(Schema.String),
            creationDate: timestamp,
            lastModifiedDate: Schema.optional(timestamp),
            authorArn: Schema.String,
            deleted: Schema.optional(Schema.Boolean),
            inReplyTo: Schema.optional(Schema.String),
          }),
        ),
      ),
    }),
  ),
  nextToken: Schema.optional(Schema.String),
});
const actor = (arn: string) => ({
  login: arn,
  name: arn.split("/").at(-1) ?? arn,
  avatarUrl: null,
});
const iso = (value: string | number) => {
  const date = DateTime.make(typeof value === "number" ? value * 1000 : value);
  return Option.isSome(date)
    ? Effect.succeed(DateTime.formatIso(date.value))
    : Effect.fail(new CodeCommitCli.CodeCommitError({ reason: "Invalid CodeCommit timestamp" }));
};
const unsupported = (operation: string) =>
  Effect.fail(
    new PullRequestProviderError({
      provider: kind,
      operation,
      reason: "failed",
      detail: "Use the AWS console for this CodeCommit operation.",
    }),
  );

export const make = Effect.gen(function* () {
  const cli = yield* CodeCommitCli.make;
  const host = yield* SourceControlHost.SourceControlHost;
  const diff = yield* CodeCommitDiff.make;
  // AWS tokens exceed the service cursor's size and character limits.
  const pageTokens = new Map<string, { readonly scope: string; readonly token: string }>();
  const pageTokenKey = (scope: string, token: string) => {
    const key = `${(Hash.string(credentialKey([scope, token])) >>> 0).toString(36)}-${token.length}`;
    pageTokens.delete(key);
    pageTokens.set(key, { scope, token });
    if (pageTokens.size > 256) pageTokens.delete(pageTokens.keys().next().value ?? "");
    return key;
  };
  const wrap = <A, E, R>(cwd: string, operation: string, effect: Effect.Effect<A, E, R>) =>
    cli
      .withConfig(
        Effect.gen(function* () {
          const config = yield* cli.configuration;
          const remoteName = yield* host.git
            .resolvePrimaryRemoteName(cwd)
            .pipe(Effect.orElseSucceed(() => "origin"));
          const origin = yield* host.git
            .readConfigValue(cwd, `remote.${remoteName}.url`)
            .pipe(Effect.orElseSucceed(() => null));
          const helper = origin ? parseCodeCommitHelperRemote(origin) : null;
          if (helper?.profile && config.profile && helper.profile !== config.profile)
            return yield* new CodeCommitCli.CodeCommitError({
              reason: "CodeCommit helper profile conflicts with selected AWS profile",
            });
          return yield* cli.provideConfig(effect, {
            ...config,
            profile: helper?.profile ?? config.profile,
          });
        }),
      )
      .pipe(
        Effect.mapError((cause) => {
          if (isProviderError(cause)) return cause;
          const failure =
            typeof cause === "object" && cause !== null && "failureKind" in cause
              ? cause.failureKind
              : null;
          return new PullRequestProviderError({
            provider: kind,
            operation,
            reason:
              failure === "authentication"
                ? "unauthenticated"
                : failure === "forbidden"
                  ? "forbidden"
                  : failure === "rate-limited"
                    ? "rate-limited"
                    : failure === "not-found"
                      ? "not-found"
                      : "failed",
            detail: isCodeCommitError(cause)
              ? cause.reason
              : failure === "authentication"
                ? "AWS credentials are unavailable or expired, or access was denied. Check the AWS profile and repository permissions."
                : `CodeCommit ${operation} failed.`,
            cause,
          });
        }),
      );
  const remoteOf = (input: ProviderRepositoryRef) => {
    const remote = parseCodeCommitRemote(`https://${input.host}/${input.repository}`);
    return remote
      ? Effect.succeed(remote)
      : Effect.fail(new CodeCommitCli.CodeCommitError({ reason: "Invalid CodeCommit repository" }));
  };
  const readPull = Effect.fn("CodeCommitPullRequestProvider.readPull")(function* (
    input: ProviderRepositoryRef & { readonly number: number },
  ) {
    const remote = yield* remoteOf(input);
    const { pullRequest: pull } = yield* cli.request(
      input.cwd,
      ["codecommit", "get-pull-request", "--pull-request-id", String(input.number)],
      pullSchema,
      remote.region,
    );
    const target = pull.pullRequestTargets.find(
      (entry) => entry.repositoryName === remote.repository,
    );
    if (!target || pull.pullRequestId !== String(input.number))
      return yield* new CodeCommitCli.CodeCommitError({
        reason: "Pull request repository mismatch",
      });
    const summary: ProviderChangeRequest = {
      number: input.number,
      title: pull.title,
      url: codeCommitChangeRequestUrl(remote, input.number),
      author: actor(pull.authorArn),
      headBranch: target.sourceReference.replace(/^refs\/heads\//u, ""),
      baseBranch: target.destinationReference.replace(/^refs\/heads\//u, ""),
      state:
        pull.pullRequestStatus === "OPEN"
          ? "open"
          : target.mergeMetadata?.isMerged
            ? "merged"
            : "closed",
      isDraft: false,
      mergeability: "unknown",
      additions: 0,
      deletions: 0,
      createdAt: yield* iso(pull.creationDate),
      updatedAt: yield* iso(pull.lastActivityDate),
      reviewRequestLogins: [],
      labels: [],
    };
    return { pull, target, summary };
  });
  const identity = Effect.fn("CodeCommitPullRequestProvider.identity")(function* (input: {
    readonly cwd: string;
    readonly host?: string;
  }) {
    const remote = input.host
      ? yield* remoteOf({ ...input, host: input.host, repository: "v1/repos/identity" })
      : null;
    return yield* cli.request(
      input.cwd,
      ["sts", "get-caller-identity"],
      callerSchema,
      remote?.region,
    );
  });
  type Pull = Effect.Success<ReturnType<typeof readPull>>;
  type Ref = ProviderRepositoryRef & { readonly number: number };
  const snapshot = (read: Pull): CodeCommitDiff.CodeCommitSnapshot => ({
    sourceCommit: read.target.sourceCommit ?? "",
    destinationCommit: read.target.destinationCommit ?? "",
    mergeBase: read.target.mergeBase ?? read.target.destinationCommit ?? "",
    sourceBranch: read.summary.headBranch,
    destinationBranch: read.summary.baseBranch,
  });
  const withSnapshot = Effect.fn("CodeCommitPullRequestProvider.withSnapshot")(function* <A, E, R>(
    input: Ref,
    use: (
      input: Ref & { readonly snapshot: CodeCommitDiff.CodeCommitSnapshot },
    ) => Effect.Effect<A, E, R>,
  ) {
    const read = yield* readPull(input);
    const basis = snapshot(read);
    if (!basis.sourceCommit || !basis.destinationCommit || !basis.mergeBase)
      return yield* new CodeCommitCli.CodeCommitError({
        reason: "CodeCommit did not report the pull request commits.",
      });
    return yield* use({ ...input, snapshot: basis });
  });
  const freshPull = (input: Ref) => cli.invalidate.pipe(Effect.andThen(readPull(input)));
  const write = Effect.fn("CodeCommitPullRequestProvider.write")(function* (
    input: Ref,
    operation: string,
    payload: unknown,
  ) {
    const remote = yield* remoteOf(input);
    yield* cli.execute(
      input.cwd,
      ["codecommit", operation, "--cli-input-json", encodePayload(payload)],
      remote.region,
    );
  });
  const readApproval = Effect.fn("CodeCommitPullRequestProvider.readApproval")(function* (
    input: Ref,
    read: Pull,
  ) {
    const remote = yield* remoteOf(input);
    if (!read.pull.revisionId) return null;
    const args = ["--pull-request-id", String(input.number), "--revision-id", read.pull.revisionId];
    const [states, evaluation] = yield* Effect.all(
      [
        cli.request(
          input.cwd,
          ["codecommit", "get-pull-request-approval-states", ...args],
          approvalsSchema,
          remote.region,
        ),
        cli.request(
          input.cwd,
          ["codecommit", "evaluate-pull-request-approval-rules", ...args],
          evaluationSchema,
          remote.region,
        ),
      ],
      { concurrency: 2 },
    );
    const approvals = states.approvals.filter((approval) => approval.approvalState === "APPROVE");
    return {
      reviewers: approvals.map((approval) => actor(approval.userArn)),
      reviewDecision:
        !evaluation.evaluation.approved && !evaluation.evaluation.overridden
          ? ("review-required" as const)
          : approvals.length > 0 ||
              evaluation.evaluation.approvalRulesSatisfied.length > 0 ||
              evaluation.evaluation.overridden
            ? ("approved" as const)
            : null,
    };
  });
  const viewerPermissions = Effect.fn("CodeCommitPullRequestProvider.viewerPermissions")(function* (
    input: Ref,
    read: Pull,
  ) {
    const viewer = yield* identity(input);
    const open = read.summary.state === "open";
    return {
      actions: open ? ["merge", "close"] : [],
      comment: true,
      resolve: false,
      verdicts:
        open && viewer.Arn !== read.pull.authorArn
          ? ["comment", "approve", "revoke-approval"]
          : ["comment"],
      requestReviewers: false,
      editChangeRequest: open,
    } satisfies PullRequestViewerPermissions;
  });
  const readEvents = Effect.fn("CodeCommitPullRequestProvider.readEvents")(function* (input: Ref) {
    const remote = yield* remoteOf(input);
    const events: Array<(typeof eventsSchema.Type.pullRequestEvents)[number]> = [];
    const seen = new Set<string>();
    let token: string | undefined;
    for (let page = 0; page < 5; page++) {
      const result = yield* cli.request(
        input.cwd,
        [
          "codecommit",
          "describe-pull-request-events",
          "--pull-request-id",
          String(input.number),
          "--max-results",
          "100",
          "--no-paginate",
          ...(token ? ["--next-token", token] : []),
        ],
        eventsSchema,
        remote.region,
      );
      events.push(...result.pullRequestEvents);
      token = result.nextToken;
      if (!token) break;
      if (seen.has(token))
        return yield* new CodeCommitCli.CodeCommitError({
          reason: "Invalid CodeCommit event pagination token",
        });
      seen.add(token);
    }
    return { events, truncated: Boolean(token) };
  });
  type Group = (typeof commentsSchema.Type.commentsForPullRequestData)[number];
  type LocatedComment = {
    readonly comment: NonNullable<Group["comments"]>[number];
    readonly location: Group["location"];
    readonly before: string | undefined;
    readonly after: string | undefined;
  };
  const readComments = Effect.fn("CodeCommitPullRequestProvider.readComments")(function* (
    input: Ref,
  ) {
    const remote = yield* remoteOf(input);
    const entries = new Map<string, LocatedComment>();
    const seen = new Set<string>();
    let token: string | undefined;
    for (let page = 0; page < 5; page++) {
      const data = yield* cli.request(
        input.cwd,
        // Repository-scoped reads require commit IDs; a PR-only read includes every revision.
        [
          "codecommit",
          "get-comments-for-pull-request",
          "--pull-request-id",
          String(input.number),
          "--no-paginate",
          "--max-results",
          "100",
          ...(token ? ["--next-token", token] : []),
        ],
        commentsSchema,
        remote.region,
      );
      for (const group of data.commentsForPullRequestData) {
        if (group.repositoryName !== undefined && group.repositoryName !== remote.repository)
          return yield* new CodeCommitCli.CodeCommitError({
            reason: "Comment repository mismatch",
          });
        for (const comment of group.comments ?? [])
          entries.set(comment.commentId, {
            comment,
            location: group.location,
            before: group.beforeCommitId,
            after: group.afterCommitId,
          });
      }
      token = data.nextToken;
      if (!token) break;
      if (seen.has(token))
        return yield* new CodeCommitCli.CodeCommitError({
          reason: "Invalid CodeCommit pagination token",
        });
      seen.add(token);
    }
    return { entries, truncated: Boolean(token) };
  });
  const postComment = Effect.fn("CodeCommitPullRequestProvider.postComment")(function* (
    input: Ref,
    read: Pull,
    body: string,
    location?: {
      readonly filePath: string;
      readonly filePosition: number;
      readonly relativeFileVersion: "BEFORE" | "AFTER";
    },
  ) {
    const remote = yield* remoteOf(input);
    const basis = snapshot(read);
    if (!body.trim() || !basis.mergeBase || !basis.sourceCommit)
      return yield* new CodeCommitCli.CodeCommitError({
        reason: "A comment requires content and a valid pull request revision.",
      });
    yield* write(input, "post-comment-for-pull-request", {
      pullRequestId: String(input.number),
      repositoryName: remote.repository,
      beforeCommitId: basis.mergeBase,
      afterCommitId: basis.sourceCommit,
      content: body,
      ...(location === undefined ? {} : { location }),
    });
  });
  const activity = Effect.fn("CodeCommitPullRequestProvider.activity")(function* (input: Ref) {
    const read = yield* readPull(input);
    const [listed, viewer, history, events] = yield* Effect.all(
      [
        readComments(input),
        identity(input),
        withSnapshot(input, diff.getCommits),
        readEvents(input),
      ],
      { concurrency: 4 },
    );
    const comments: PullRequestComment[] = [];
    const inline = new Map<string, PullRequestReviewThread>();
    const overview = new Map<string, PullRequestOverviewThread>();
    for (const row of listed.entries.values()) {
      let root = row;
      const parents = new Set<string>();
      while (root.comment.inReplyTo && listed.entries.has(root.comment.inReplyTo)) {
        if (parents.has(root.comment.commentId)) break;
        parents.add(root.comment.commentId);
        root = listed.entries.get(root.comment.inReplyTo)!;
      }
      const path = root.location?.filePath;
      const threadComment = {
        id: row.comment.commentId,
        author: actor(row.comment.authorArn),
        body: row.comment.deleted ? "Comment deleted" : (row.comment.content ?? ""),
        createdAt: yield* iso(row.comment.creationDate),
        editedAt:
          row.comment.lastModifiedDate === undefined
            ? null
            : yield* iso(row.comment.lastModifiedDate),
        url: null,
        canEdit: row.comment.authorArn === viewer.Arn && !row.comment.deleted,
      };
      if (path) {
        const position = root.location?.filePosition;
        const thread =
          inline.get(root.comment.commentId) ??
          ({
            id: root.comment.commentId,
            path,
            line:
              position !== undefined && Number.isSafeInteger(position) && position > 0
                ? position
                : null,
            side: root.location?.relativeFileVersion === "BEFORE" ? "left" : "right",
            isResolved: false,
            canResolve: false,
            isOutdated: Boolean(root.after && root.after !== read.target.sourceCommit),
            comments: [],
          } satisfies PullRequestReviewThread);
        inline.set(thread.id, { ...thread, comments: [...thread.comments, threadComment] });
      } else {
        comments.push({ ...threadComment, kind: "issue-comment", path: null, reviewState: null });
        const thread =
          overview.get(root.comment.commentId) ??
          ({
            id: root.comment.commentId,
            path: null,
            line: null,
            side: "right",
            isResolved: false,
            isOutdated: false,
            canResolve: false,
            comments: [],
          } satisfies PullRequestOverviewThread);
        overview.set(thread.id, { ...thread, comments: [...thread.comments, threadComment] });
      }
    }
    for (const [index, event] of events.events.entries()) {
      const state = event.approvalStateChangedEventMetadata?.approvalStatus;
      if (!state) continue;
      comments.push({
        id: `approval-${event.eventDate}-${index}`,
        kind: "review",
        author: event.actorArn ? actor(event.actorArn) : null,
        body: state === "APPROVE" ? "Approved" : "Approval revoked",
        createdAt: yield* iso(event.eventDate),
        url: null,
        path: null,
        reviewState: state === "APPROVE" ? "APPROVED" : "DISMISSED",
        canEdit: false,
      });
    }
    return {
      comments,
      commentCount: listed.entries.size,
      commentsTruncated: listed.truncated || events.truncated,
      reviewThreads: [...inline.values()],
      overviewThreads: [...overview.values()],
      commits: history.commits,
      commitsTruncated: history.truncated,
    };
  });
  const provider: PullRequestProviderApi = {
    kind,
    capabilities,
    getViewer: (input) =>
      wrap(input.cwd, "getViewer", identity(input).pipe(Effect.map((caller) => caller.Arn))),
    getRoutingIdentity: (input) =>
      wrap(
        input.cwd,
        "getRoutingIdentity",
        identity(input).pipe(
          Effect.map((caller) => ({ accountId: caller.Account, viewer: caller.Arn })),
        ),
      ),
    withVerifiedCredential: (input, use) =>
      wrap(
        input.cwd,
        "withVerifiedCredential",
        Effect.gen(function* () {
          const caller = yield* identity(input);
          const config = yield* cli.configuration;
          return { caller, config };
        }),
      ).pipe(
        Effect.flatMap(({ caller, config }) =>
          cli.provideConfig(
            use({
              accountId: caller.Account,
              viewer: caller.Arn,
              credentialFingerprint: credentialKey([
                caller.Account,
                caller.Arn,
                config.profile,
                config.region,
              ]),
            }),
            config,
          ),
        ),
      ),
    repositoryKey: ({ canonicalKey }) => canonicalKey,
    listChangeRequests: Effect.fn("CodeCommitPullRequestProvider.listChangeRequests")(
      function (input) {
        return wrap(
          input.cwd,
          "listChangeRequests",
          Effect.gen(function* () {
            if (input.involvement === "reviewing")
              return { items: [], truncated: false, continues: false };
            const remote = yield* remoteOf(input);
            const config = yield* cli.configuration;
            const scope = credentialKey([
              input.cwd,
              input.host,
              input.repository,
              input.state,
              input.involvement,
              input.viewer,
              config.profile,
              config.region,
            ]);
            const resume = input.cursor?.resumeAfter;
            const position = resume === undefined ? undefined : pageTokens.get(resume);
            if (resume !== undefined && (position === undefined || position.scope !== scope))
              return yield* new PullRequestProviderError({
                provider: kind,
                operation: "listChangeRequests",
                reason: "failed",
                detail:
                  "This list position has expired. Refresh the list to load more pull requests.",
                accessHint:
                  "This list position has expired. Refresh the list to load more pull requests.",
              });
            let token = position?.token;
            let cursorAdvance = 0;
            const seen = new Set<string>();
            while (true) {
              if (token && seen.has(token))
                return yield* new CodeCommitCli.CodeCommitError({
                  reason: "Invalid CodeCommit pagination token",
                });
              if (token) seen.add(token);
              const page = yield* cli.request(
                input.cwd,
                [
                  "codecommit",
                  "list-pull-requests",
                  "--repository-name",
                  remote.repository,
                  "--no-paginate",
                  "--max-results",
                  String(Math.max(1, Math.min(input.limit, PAGE_SIZE))),
                  ...(input.state === "all"
                    ? []
                    : ["--pull-request-status", input.state === "open" ? "OPEN" : "CLOSED"]),
                  ...(input.involvement === "authored" ? ["--author-arn", input.viewer] : []),
                  ...(token === undefined ? [] : ["--next-token", token]),
                ],
                listSchema,
                remote.region,
              );
              if (page.nextToken && page.nextToken === token)
                return yield* new CodeCommitCli.CodeCommitError({
                  reason: "Invalid CodeCommit pagination token",
                });
              const items = yield* Effect.forEach(
                page.pullRequestIds,
                (id) => {
                  if (!/^[1-9]\d*$/u.test(id) || !Number.isSafeInteger(Number(id)))
                    return Effect.fail(
                      new CodeCommitCli.CodeCommitError({ reason: "Invalid pull request ID" }),
                    );
                  return readPull({ ...input, number: Number(id) }).pipe(
                    Effect.map(({ summary }) => summary),
                  );
                },
                { concurrency: 5 },
              );
              cursorAdvance += page.pullRequestIds.length;
              const matching = items.filter(
                (item) => input.state === "all" || item.state === input.state,
              );
              if (matching.length > 0 || !page.nextToken)
                return {
                  items: matching.sort(
                    (a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.number - a.number,
                  ),
                  truncated: Boolean(page.nextToken),
                  continues: Boolean(page.nextToken),
                  cursorAdvance,
                  ...(page.nextToken ? { resumeAfter: pageTokenKey(scope, page.nextToken) } : {}),
                };
              token = page.nextToken;
            }
          }),
        );
      },
    ),
    getChangeRequestSummary: (input) =>
      wrap(
        input.cwd,
        "getChangeRequestSummary",
        readPull(input).pipe(Effect.map(({ summary }) => summary)),
      ),
    getChangeRequest: (input) =>
      wrap(
        input.cwd,
        "getChangeRequest",
        Effect.gen(function* () {
          const read = yield* readPull(input);
          const remote = yield* remoteOf(input);
          const [stats, approval, viewer, mergeable, eventRead] = yield* Effect.all(
            [
              withSnapshot(input, diff.getDetailStats),
              readApproval(input, read).pipe(Effect.orElseSucceed(() => null)),
              viewerPermissions(input, read),
              read.summary.state === "open"
                ? cli
                    .request(
                      input.cwd,
                      [
                        "codecommit",
                        "get-merge-conflicts",
                        "--repository-name",
                        remote.repository,
                        "--source-commit-specifier",
                        read.target.sourceCommit ?? read.summary.headBranch,
                        "--destination-commit-specifier",
                        read.target.destinationCommit ?? read.summary.baseBranch,
                        "--merge-option",
                        "THREE_WAY_MERGE",
                        "--max-conflict-files",
                        "1",
                        "--no-paginate",
                      ],
                      mergeabilitySchema,
                      remote.region,
                    )
                    .pipe(
                      Effect.map((result) =>
                        result.mergeable ? ("mergeable" as const) : ("conflicting" as const),
                      ),
                      Effect.orElseSucceed(() => "unknown" as const),
                    )
                : Effect.succeed("unknown" as const),
              read.summary.state === "open"
                ? Effect.succeed({ events: [], truncated: false })
                : readEvents(input),
            ],
            { concurrency: 4 },
          );
          const closedEvents = eventRead.events.filter(
            (event) => event.pullRequestStatusChangedEventMetadata?.pullRequestStatus === "CLOSED",
          );
          const mergedEvents = eventRead.events.filter(
            (event) => event.pullRequestMergedStateChangedEventMetadata?.mergeMetadata?.isMerged,
          );
          const latest = (events: typeof eventRead.events) =>
            Effect.forEach(events, (event) => iso(event.eventDate)).pipe(
              Effect.map((dates) => dates.toSorted().at(-1) ?? null),
            );
          return {
            ...read.summary,
            additions: stats.additions,
            deletions: stats.deletions,
            body: read.pull.description ?? "",
            headSha: read.target.sourceCommit ?? null,
            changedFiles: stats.changedFiles,
            mergedAt: yield* latest(mergedEvents),
            closedAt: yield* latest(closedEvents),
            reviewers: approval?.reviewers ?? [],
            reviewDecision: approval?.reviewDecision ?? null,
            checks: [],
            mergeability: mergeable,
            mergeCapabilities: { merge: true, squash: true, rebase: false, "fast-forward": true },
            viewerPermissions: viewer,
          };
        }),
      ),
    getViewerPermissions: (input) =>
      wrap(
        input.cwd,
        "getViewerPermissions",
        Effect.gen(function* () {
          const read = yield* freshPull(input);
          return yield* viewerPermissions(input, read);
        }),
      ),
    forgetChangeRequestReads: () => cli.invalidate,
    getChangeRequestActivity: (input) =>
      wrap(input.cwd, "getChangeRequestActivity", activity(input)),
    getDiff: (input) => wrap(input.cwd, "getDiff", withSnapshot(input, diff.getDiff)),
    getDiffFilePaths: (input) =>
      wrap(input.cwd, "getDiffFilePaths", withSnapshot(input, diff.getDiffFilePaths)),
    getDiffFileContents: (input) =>
      wrap(
        input.cwd,
        "getDiffFileContents",
        withSnapshot(input, (basis) => diff.getDiffFileContents({ ...basis, ...input })),
      ),
    getFileStats: (input) =>
      wrap(input.cwd, "getFileStats", withSnapshot(input, diff.getFileStats)),
    getFileRevisions: (input) =>
      wrap(
        input.cwd,
        "getFileRevisions",
        withSnapshot(input, (basis) => diff.getFileRevisions({ ...basis, paths: input.paths })),
      ),
    runAction: (input) =>
      wrap(
        input.cwd,
        "runAction",
        Effect.gen(function* () {
          const read = yield* freshPull(input);
          if (input.action === "merge") {
            if (read.summary.state !== "open")
              return yield* new CodeCommitCli.CodeCommitError({
                reason: "Only open pull requests can be merged.",
              });
            const remote = yield* remoteOf(input);
            const operation =
              input.mergeMethod === "squash"
                ? "merge-pull-request-by-squash"
                : input.mergeMethod === "fast-forward"
                  ? "merge-pull-request-by-fast-forward"
                  : input.mergeMethod === "merge" || input.mergeMethod === undefined
                    ? "merge-pull-request-by-three-way"
                    : null;
            if (!operation || !read.target.sourceCommit)
              return yield* new CodeCommitCli.CodeCommitError({
                reason: "CodeCommit does not support the selected merge method.",
              });
            yield* write(input, operation, {
              pullRequestId: String(input.number),
              repositoryName: remote.repository,
              sourceCommitId: read.target.sourceCommit,
            });
          } else if (input.action === "close") {
            if (read.summary.state === "merged")
              return yield* new CodeCommitCli.CodeCommitError({
                reason: "A merged pull request cannot be reopened or closed.",
              });
            yield* write(input, "update-pull-request-status", {
              pullRequestId: String(input.number),
              pullRequestStatus: "CLOSED",
            });
          } else return yield* unsupported("runAction");
          return (yield* readPull(input)).summary;
        }),
      ),
    updateChangeRequest: (input) =>
      wrap(
        input.cwd,
        "updateChangeRequest",
        Effect.gen(function* () {
          const read = yield* freshPull(input);
          if (read.summary.state !== "open")
            return yield* new CodeCommitCli.CodeCommitError({
              reason: "Only open pull requests can be edited.",
            });
          if (input.maintainerCanModify !== undefined)
            return yield* unsupported("updateChangeRequest");
          if (input.title !== undefined)
            yield* write(input, "update-pull-request-title", {
              pullRequestId: String(input.number),
              title: input.title,
            });
          if (input.body !== undefined)
            yield* write(input, "update-pull-request-description", {
              pullRequestId: String(input.number),
              description: input.body,
            });
        }),
      ),
    comment: (input) =>
      wrap(
        input.cwd,
        "comment",
        Effect.gen(function* () {
          yield* postComment(input, yield* freshPull(input), input.body);
        }),
      ),
    updateComment: (input) =>
      wrap(
        input.cwd,
        "updateComment",
        Effect.gen(function* () {
          yield* freshPull(input);
          const [comments, viewer] = yield* Effect.all([readComments(input), identity(input)], {
            concurrency: 2,
          });
          const row = comments.entries.get(input.commentId);
          if (!row || row.comment.deleted || row.comment.authorArn !== viewer.Arn)
            return yield* new CodeCommitCli.CodeCommitError({
              reason: "Only your own comments in this pull request can be edited.",
            });
          if (!input.body.trim())
            return yield* new CodeCommitCli.CodeCommitError({
              reason: "A comment cannot be empty.",
            });
          yield* write(input, "update-comment", {
            commentId: input.commentId,
            content: input.body,
          });
        }),
      ),
    submitReview: (input) =>
      wrap(
        input.cwd,
        "submitReview",
        Effect.gen(function* () {
          const read = yield* freshPull(input);
          if (input.verdict === "request-changes") return yield* unsupported("submitReview");
          if (input.verdict !== "comment") {
            const viewer = yield* identity(input);
            if (read.summary.state !== "open" || !read.pull.revisionId)
              return yield* new CodeCommitCli.CodeCommitError({
                reason: "Only an open pull request with a current revision can be approved.",
              });
            if (viewer.Arn === read.pull.authorArn)
              return yield* new CodeCommitCli.CodeCommitError({
                reason: "CodeCommit does not allow approving your own pull request.",
              });
          }
          if (input.comments.some((comment) => !comment.body.trim()))
            return yield* new CodeCommitCli.CodeCommitError({
              reason: "A review comment cannot be empty.",
            });
          if (input.verdict === "comment" && !input.body.trim() && input.comments.length === 0)
            return yield* new CodeCommitCli.CodeCommitError({
              reason: "A review needs a summary or at least one comment.",
            });
          for (const comment of input.comments) {
            const position = comment.position;
            const left =
              position.kind === "deleted" ||
              (position.kind === "context" && position.side === "left");
            yield* postComment(input, read, comment.body, {
              filePath: left ? (comment.oldPath ?? comment.path) : comment.path,
              filePosition:
                position.kind === "deleted"
                  ? position.oldLine
                  : position.kind === "added"
                    ? position.newLine
                    : left
                      ? position.oldLine
                      : position.newLine,
              relativeFileVersion: left ? "BEFORE" : "AFTER",
            });
          }
          if (input.body.trim()) yield* postComment(input, read, input.body);
          if (input.verdict !== "comment")
            yield* write(input, "update-pull-request-approval-state", {
              pullRequestId: String(input.number),
              revisionId: read.pull.revisionId,
              approvalState: input.verdict === "approve" ? "APPROVE" : "REVOKE",
            });
        }),
      ),
    replyToThread: (input) =>
      wrap(
        input.cwd,
        "replyToThread",
        Effect.gen(function* () {
          yield* freshPull(input);
          const comments = yield* readComments(input);
          if (!comments.entries.has(input.threadId))
            return yield* new CodeCommitCli.CodeCommitError({
              reason: "The comment does not belong to this pull request.",
            });
          if (!input.body.trim())
            return yield* new CodeCommitCli.CodeCommitError({ reason: "A reply cannot be empty." });
          yield* write(input, "post-comment-reply", {
            inReplyTo: input.threadId,
            content: input.body,
          });
        }),
      ),
    listReviewerCandidates: () => unsupported("listReviewerCandidates"),
    setReviewerRequest: () => unsupported("setReviewerRequest"),
    setReaction: () => unsupported("setReaction"),
    setThreadResolution: () => unsupported("setThreadResolution"),
  };
  return provider;
});
