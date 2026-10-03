import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import { makeConfiguredOrigin } from "../sourceControl/phabricatorConfig.ts";
import * as Schema from "effect/Schema";
import type {
  PullRequestCapabilities,
  PullRequestViewerPermissions,
  PullRequestActor,
} from "@t3tools/contracts";
import { VcsProcess } from "../vcs/VcsProcess.ts";
import {
  PullRequestProviderError,
  type PullRequestProviderApi,
  type ProviderRepositoryRef,
  type ProviderChangeRequest,
} from "./PullRequestProvider.ts";

const encodeParams = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const decodeEnvelope = Schema.decodeEffect(
  Schema.fromJsonString(
    Schema.Struct({
      error: Schema.NullOr(Schema.String),
      errorMessage: Schema.NullOr(Schema.String),
      response: Schema.Unknown,
    }),
  ),
);

const Revision = Schema.Struct({
  id: Schema.Number,
  phid: Schema.String,
  attachments: Schema.optional(
    Schema.Struct({
      reviewers: Schema.optional(
        Schema.Struct({ reviewers: Schema.Array(Schema.Struct({ reviewerPHID: Schema.String })) }),
      ),
    }),
  ),
  fields: Schema.Struct({
    title: Schema.String,
    uri: Schema.String,
    authorPHID: Schema.String,
    status: Schema.Struct({ value: Schema.String, closed: Schema.Boolean }),
    diffPHID: Schema.NullOr(Schema.String),
    summary: Schema.String,
    testPlan: Schema.String,
    isDraft: Schema.Boolean,
    dateCreated: Schema.Number,
    dateModified: Schema.Number,
  }),
});
const User = Schema.Struct({
  phid: Schema.String,
  fields: Schema.Struct({ username: Schema.String, realName: Schema.String }),
});
const Diff = Schema.Struct({
  id: Schema.Number,
  fields: Schema.Struct({
    refs: Schema.Array(
      Schema.Struct({
        type: Schema.String,
        name: Schema.optional(Schema.String),
      }),
    ),
  }),
});
const searchResult = <A>(item: Schema.Codec<A, unknown, never, never>) =>
  Schema.Struct({
    data: Schema.Array(item),
    cursor: Schema.Struct({ after: Schema.NullOr(Schema.String) }),
  });
const RevisionPage = searchResult(Revision);
const permissions: PullRequestViewerPermissions = {
  actions: [],
  comment: false,
  resolve: false,
  verdicts: [],
  requestReviewers: false,
};
const capabilities: PullRequestCapabilities = {
  diff: true,
  comment: false,
  actions: [],
  mergeMethods: [],
  search: false,
  review: { inlineComment: false, reply: false, resolve: false, verdicts: [] },
  reviewers: { request: false, listCandidates: false },
};

/** Arcanist owns credentials and selects the matching certificate for the requested host. */
export const make = Effect.gen(function* () {
  const process = yield* VcsProcess;
  const configuredOrigin = yield* makeConfiguredOrigin;
  const failure = (
    operation: string,
    detail: string,
    reason: PullRequestProviderError["reason"] = "failed",
  ) => new PullRequestProviderError({ provider: "phabricator", operation, reason, detail });
  const call = Effect.fn("PhabricatorPullRequestProvider.call")(function* <A>(
    input: { readonly cwd: string; readonly host?: string },
    method: string,
    params: object,
    schema: Schema.Codec<A, unknown, never, never>,
  ) {
    const configured = yield* configuredOrigin(input.cwd);
    const origin =
      configured && (!input.host || new URL(configured).host === input.host)
        ? configured
        : input.host
          ? `https://${input.host}`
          : null;
    const stdin = yield* encodeParams(params).pipe(
      Effect.mapError(() => failure(method, "Invalid Conduit parameters.")),
    );
    const output = yield* process
      .run({
        cwd: input.cwd,
        command: "arc",
        operation: method,
        args: [...(origin ? ["--conduit-uri", `${origin}/`] : []), "call-conduit", "--", method],
        stdin,
        timeoutMs: 30_000,
        maxOutputBytes: 5_000_000,
      })
      .pipe(
        Effect.mapError((error) =>
          failure(
            method,
            "Arcanist could not call Conduit. Check the server's arc installation and authentication.",
            error._tag === "VcsProcessSpawnError"
              ? "missing-tool"
              : error._tag === "VcsProcessExitError" && error.failureKind === "authentication"
                ? "unauthenticated"
                : "failed",
          ),
        ),
      );
    if (output.stdoutTruncated)
      return yield* failure(method, "Conduit response exceeded the output limit.");
    const envelope = yield* decodeEnvelope(output.stdout).pipe(
      Effect.mapError(() => failure(method, "Arcanist returned an invalid response.")),
    );
    if (envelope.error !== null) {
      return yield* failure(
        method,
        envelope.errorMessage ?? envelope.error,
        /ERR-(?:INVALID-AUTH|NOT-AUTHENTICATED|INVALID-SESSION|NO-CERTIFICATE)/u.test(
          envelope.error,
        )
          ? "unauthenticated"
          : "failed",
      );
    }
    return yield* Schema.decodeEffect(schema)(envelope.response).pipe(
      Effect.mapError(() => failure(method, "Conduit returned an invalid response.")),
    );
  });
  const whoami = (input: { readonly cwd: string; readonly host?: string }) =>
    call(input, "user.whoami", {}, Schema.Struct({ userName: Schema.String, phid: Schema.String }));
  const getRevision = Effect.fn("PhabricatorPullRequestProvider.getRevision")(function* (
    input: ProviderRepositoryRef & { readonly number: number },
  ) {
    const result = yield* call(
      input,
      "differential.revision.search",
      { constraints: { ids: [input.number] }, attachments: { reviewers: true } },
      searchResult(Revision),
    );
    const revision = result.data[0];
    if (!revision)
      return yield* failure(
        "getRevision",
        "The Differential revision was not found or is not visible to this account.",
      );
    return revision;
  });
  const actors = Effect.fn("PhabricatorPullRequestProvider.actors")(function* (
    input: { readonly cwd: string; readonly host?: string },
    phids: readonly string[],
  ) {
    const ids = [...new Set(phids)];
    const result = new Map<string, PullRequestActor>();
    for (let offset = 0; offset < ids.length; offset += 100) {
      const users = yield* call(
        input,
        "user.search",
        { constraints: { phids: ids.slice(offset, offset + 100) }, limit: 100 },
        searchResult(User),
      );
      for (const user of users.data)
        result.set(user.phid, {
          login: user.fields.username,
          name: user.fields.realName || null,
          avatarUrl: null,
        });
    }
    return result;
  });
  const normalize = (
    revision: typeof Revision.Type,
    authors: ReadonlyMap<string, PullRequestActor>,
  ): ProviderChangeRequest => ({
    number: revision.id,
    title: revision.fields.title,
    url: revision.fields.uri,
    author: authors.get(revision.fields.authorPHID) ?? null,
    // Revisions need not have branches. Unique placeholders avoid inventing branch-based stacks.
    headBranch: `D${revision.id}`,
    baseBranch: "unknown",
    state:
      revision.fields.status.value === "published"
        ? "merged"
        : revision.fields.status.closed
          ? "closed"
          : "open",
    isDraft: revision.fields.isDraft,
    mergeability: "unknown",
    additions: 0,
    deletions: 0,
    createdAt: DateTime.formatIso(DateTime.makeUnsafe(revision.fields.dateCreated * 1000)),
    updatedAt: DateTime.formatIso(DateTime.makeUnsafe(revision.fields.dateModified * 1000)),
    reviewRequestLogins: (revision.attachments?.reviewers?.reviewers ?? []).flatMap((reviewer) => {
      const actor = authors.get(reviewer.reviewerPHID);
      return actor ? [actor.login] : [];
    }),
    labels: [],
    reviewDecision:
      revision.fields.status.value === "accepted"
        ? "approved"
        : revision.fields.status.value === "needs-revision"
          ? "changes-requested"
          : revision.fields.status.value === "needs-review"
            ? "review-required"
            : null,
  });
  const unsupported = (operation: string) =>
    Effect.fail(failure(operation, "This operation is not supported for Differential revisions."));
  const provider: PullRequestProviderApi = {
    kind: "phabricator",
    capabilities,
    getViewer: (input) => whoami(input).pipe(Effect.map((user) => user.userName)),
    listChangeRequests: Effect.fn("PhabricatorPullRequestProvider.list")(function* (input) {
      const viewer = input.involvement === "all" ? null : yield* whoami(input);
      const constraints = {
        ...(input.state === "all"
          ? {}
          : {
              statuses: [
                input.state === "open"
                  ? "open()"
                  : input.state === "merged"
                    ? "published"
                    : "abandoned",
              ],
            }),
        ...(input.involvement === "authored" && viewer ? { authorPHIDs: [viewer.phid] } : {}),
        ...(input.involvement === "reviewing" && viewer ? { reviewerPHIDs: [viewer.phid] } : {}),
      };
      const revisions: Array<typeof Revision.Type> = [];
      let after: string | null = null;
      do {
        const page: typeof RevisionPage.Type = yield* call(
          input,
          "differential.revision.search",
          {
            constraints,
            attachments: { reviewers: true },
            order: "updated",
            limit: Math.min(100, input.limit - revisions.length),
            ...(after === null ? {} : { after }),
          },
          searchResult(Revision),
        );
        revisions.push(...page.data);
        after = page.cursor.after;
        if (page.data.length === 0) break;
      } while (after !== null && revisions.length < input.limit);
      const authors = revisions.length
        ? yield* actors(
            input,
            revisions.flatMap((revision) => [
              revision.fields.authorPHID,
              ...(revision.attachments?.reviewers?.reviewers ?? []).map(
                (reviewer) => reviewer.reviewerPHID,
              ),
            ]),
          )
        : new Map();
      return {
        items: revisions.map((revision) => normalize(revision, authors)),
        truncated: after !== null,
        continues: false,
      };
    }),
    getChangeRequestSummary: Effect.fn("PhabricatorPullRequestProvider.summary")(function* (input) {
      return normalize(yield* getRevision(input), new Map());
    }),
    getChangeRequest: Effect.fn("PhabricatorPullRequestProvider.detail")(function* (input) {
      const revision = yield* getRevision(input);
      const authors = yield* actors(input, [
        revision.fields.authorPHID,
        ...(revision.attachments?.reviewers?.reviewers ?? []).map(
          (reviewer) => reviewer.reviewerPHID,
        ),
      ]);
      return {
        ...normalize(revision, authors),
        body: [revision.fields.summary, revision.fields.testPlan].filter(Boolean).join("\n\n"),
        changedFiles: 0,
        mergedAt: null,
        closedAt: null,
        reviewers: (revision.attachments?.reviewers?.reviewers ?? []).flatMap((reviewer) => {
          const actor = authors.get(reviewer.reviewerPHID);
          return actor ? [actor] : [];
        }),
        checks: [],
        mergeCapabilities: { merge: false, squash: false, rebase: false },
        viewerPermissions: permissions,
      };
    }),
    getDiff: Effect.fn("PhabricatorPullRequestProvider.diff")(function* (input) {
      if (input.commit) return yield* unsupported("commitDiff");
      const revision = yield* getRevision(input);
      if (!revision.fields.diffPHID)
        return yield* failure("getDiff", "This revision has no active diff.");
      const diffs = yield* call(
        input,
        "differential.diff.search",
        { constraints: { phids: [revision.fields.diffPHID] } },
        searchResult(Diff),
      );
      const diff = diffs.data[0];
      if (!diff)
        return yield* failure("getDiff", "The active diff is not visible to this account.");
      const patch = yield* call(
        input,
        "differential.getrawdiff",
        { diffID: diff.id },
        Schema.String,
      );
      return { patch, truncated: false, nextCursor: null };
    }),
    getViewerPermissions: () => Effect.succeed(permissions),
    getChangeRequestActivity: () => unsupported("getChangeRequestActivity"),
    runAction: () => unsupported("runAction"),
    comment: () => unsupported("comment"),
    submitReview: () => unsupported("submitReview"),
    listReviewerCandidates: () => unsupported("listReviewerCandidates"),
    setReviewerRequest: () => unsupported("setReviewerRequest"),
    replyToThread: () => unsupported("replyToThread"),
    setThreadResolution: () => unsupported("setThreadResolution"),
    setReaction: () => unsupported("setReaction"),
  };
  return provider;
});
