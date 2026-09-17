import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  NonNegativeInt,
  PositiveInt,
  type PullRequestReviewCommentDraft,
} from "@t3tools/contracts";
import type * as GitCafeCli from "../sourceControl/GitCafeCli.ts";
import { PullRequestProviderError, type PullRequestProviderApi } from "./PullRequestProvider.ts";
import { gitCafeWriteApi } from "./gitCafeWriteApi.ts";

const Oid = Schema.String.check(Schema.isPattern(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u));
const DraftRef = Schema.Struct({ id: Schema.String, version: NonNegativeInt });
const DraftComment = Schema.Struct({
  id: Schema.String,
  body: Schema.String,
  path: Schema.String,
  line: PositiveInt,
  side: Schema.Literals(["left", "right"]),
  commitOid: Oid,
  startLine: Schema.optional(Schema.NullOr(PositiveInt)),
  startSide: Schema.optional(Schema.NullOr(Schema.Literals(["left", "right"]))),
});
const DraftRead = Schema.Struct({
  draft: Schema.NullOr(
    Schema.Struct({
      ...DraftRef.fields,
      verdict: Schema.Literals(["approve", "request_changes", "comment"]),
      body: Schema.NullOr(Schema.String),
      commitOid: Oid,
      baseOid: Oid,
      pullVersion: NonNegativeInt,
      stale: Schema.Boolean,
      comments: Schema.Array(DraftComment),
    }),
  ),
});
const SavedDraft = Schema.Struct({
  ...DraftRef.fields,
  verdict: Schema.String,
  body: Schema.NullOr(Schema.String),
  commitOid: Oid,
  baseOid: Oid,
  pullVersion: NonNegativeInt,
});
const SavedComment = Schema.Struct({ draft: DraftRef, comment: DraftComment });
const PullRevision = Schema.Struct({
  version: NonNegativeInt,
  headOid: Oid,
  observedBaseOid: Schema.NullOr(Oid),
});
const Submitted = Schema.Struct({ id: Schema.String });
const Principal = Schema.Struct({ actorId: Schema.String });
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

type Submit = Parameters<PullRequestProviderApi["submitReview"]>[0];
type Draft = NonNullable<(typeof DraftRead.Type)["draft"]>;
type Progress = {
  fingerprint: string;
  actorId: string;
  draftId?: string;
  finalDraft?: typeof DraftRef.Type;
  submitted?: boolean;
  uncertainDraft?: boolean;
  uncertainComment?: boolean;
};

const fail = (detail: string, cause?: unknown, notDispatched = false) =>
  new PullRequestProviderError({
    provider: "gitcafe",
    operation: "submitReview",
    reason: "failed",
    detail,
    ...(notDispatched ? { notDispatched: true as const } : {}),
    ...(cause === undefined ? {} : { cause }),
  });

const normalizeBody = (body: string) => (body.length === 0 ? null : body);
const verdict = (value: Submit["verdict"]) =>
  value === "request-changes" ? "request_changes" : value;
const anchor = (comment: PullRequestReviewCommentDraft, headOid: string, baseOid: string) => {
  switch (comment.position.kind) {
    case "added":
      return {
        body: comment.body,
        path: comment.path,
        line: comment.position.newLine,
        side: "right" as const,
        commitOid: headOid,
        startLine: null,
        startSide: null,
      };
    case "deleted":
      return {
        body: comment.body,
        path: comment.oldPath ?? comment.path,
        line: comment.position.oldLine,
        side: "left" as const,
        commitOid: baseOid,
        startLine: null,
        startSide: null,
      };
    case "context":
      return {
        body: comment.body,
        path: comment.position.side === "left" ? (comment.oldPath ?? comment.path) : comment.path,
        line:
          comment.position.side === "left" ? comment.position.oldLine : comment.position.newLine,
        side: comment.position.side,
        commitOid: comment.position.side === "left" ? baseOid : headOid,
        startLine: null,
        startSide: null,
      };
  }
};
const sameComment = (actual: typeof DraftComment.Type, expected: ReturnType<typeof anchor>) =>
  actual.body === expected.body &&
  actual.path === expected.path &&
  actual.line === expected.line &&
  actual.side === expected.side &&
  actual.commitOid === expected.commitOid &&
  (actual.startLine ?? null) === expected.startLine &&
  (actual.startSide ?? null) === expected.startSide;

export function makeGitCafeReviewWrites(
  cli: GitCafeCli.GitCafeCli["Service"],
): Pick<PullRequestProviderApi, "submitReview"> {
  const request = gitCafeWriteApi(cli);
  // This is deliberately local to one provider service. Eviction loses recovery convenience but
  // remains safe: an existing draft is never claimed without its retained ownership proof.
  const progress = new Map<string, Progress>();
  const remember = (key: string, state: Progress) => {
    progress.delete(key);
    progress.set(key, state);
    if (progress.size > 256) progress.delete(progress.keys().next().value!);
  };
  const viewerActorId = Effect.fn("GitCafeReviewWrites.viewerActorId")(function* (raw: Submit) {
    const response = yield* cli
      .api({ cwd: raw.cwd, host: raw.host, endpoint: "/auth/principal" })
      .pipe(
        Effect.mapError((cause) =>
          fail("GitCafe could not verify the current account before submitting the review.", cause),
        ),
      );
    const identity = yield* Schema.decodeEffect(Schema.fromJsonString(Principal))(response).pipe(
      Effect.mapError((cause) => fail("GitCafe returned an unreadable account identity.", cause)),
    );
    return identity.actorId;
  });
  const submitReview = Effect.fn("GitCafeReviewWrites.submitReview")(function* (raw: Submit) {
    const revision = raw.reviewRevision;
    if (revision === undefined || raw.requestId === undefined)
      return yield* fail(
        "GitCafe requires the exact reviewed revision and a stable request ID. Refresh the pull request and retry.",
        undefined,
        true,
      );
    if (raw.comments.length > 100)
      return yield* fail("GitCafe reviews support at most 100 line comments.", undefined, true);
    if (
      !Schema.is(Oid)(revision.headOid) ||
      /^0+$/u.test(revision.headOid) ||
      !Schema.is(Oid)(revision.baseOid) ||
      /^0+$/u.test(revision.baseOid)
    )
      return yield* fail(
        "The reviewed GitCafe revision contains an invalid commit ID. Refresh the pull request and retry.",
        undefined,
        true,
      );
    if (!/^[A-Za-z0-9_-]{1,128}$/u.test(raw.requestId))
      return yield* fail("The GitCafe review request ID is invalid.", undefined, true);

    const path = `/pulls/${raw.number}`;
    const body = normalizeBody(raw.body);
    const mappedVerdict = verdict(raw.verdict);
    const comments = raw.comments.map((comment) =>
      anchor(comment, revision.headOid, revision.baseOid),
    );
    const actorId = yield* viewerActorId(raw);
    const key = `${raw.host}\0${raw.repository}\0${raw.cwd}\0${raw.requestId}`;
    const fingerprint = encodeJson({
      number: raw.number,
      revision,
      verdict: mappedVerdict,
      body,
      comments,
    });
    const remembered = progress.get(key);
    if (remembered !== undefined && remembered.actorId !== actorId)
      return yield* fail(
        "The GitCafe account changed while this review submission was unsettled. Switch back to the original account before retrying.",
      );
    if (remembered !== undefined && remembered.fingerprint !== fingerprint)
      return yield* fail(
        "This GitCafe review request ID was already used for different review input.",
      );
    const state = remembered ?? { fingerprint, actorId };
    remember(key, state);

    const finalBody = {
      verdict: mappedVerdict,
      ...(body === null ? {} : { body }),
      commitOid: revision.headOid,
      expectedVersion: revision.version,
      requestId: raw.requestId,
    };
    // The domain checks idempotency before revision admission. Replaying first is essential when
    // the successful response was lost and the pull subsequently advanced.
    if (state.submitted === true)
      return yield* request(raw, `${path}/reviews`, Submitted, {
        operation: "submitReview",
        method: "POST",
        body:
          state.finalDraft === undefined ? finalBody : { ...finalBody, draft: state.finalDraft },
      }).pipe(Effect.asVoid);

    const fresh = yield* request(raw, path, PullRevision, { operation: "submitReview" });
    if (fresh.version !== revision.version || fresh.headOid !== revision.headOid)
      return yield* fail(
        "The GitCafe pull request changed since this review was written. Refresh the diff and review the new revision before submitting.",
        undefined,
        remembered === undefined,
      );

    if (comments.length === 0) {
      state.submitted = true;
      return yield* request(raw, `${path}/reviews`, Submitted, {
        operation: "submitReview",
        method: "POST",
        body: finalBody,
      }).pipe(Effect.asVoid);
    }

    if (fresh.observedBaseOid === null)
      return yield* fail(
        "GitCafe has not observed the pull request base revision. Refresh the pull request and retry.",
      );

    const read = yield* request(raw, `${path}/review-draft/`, DraftRead, {
      operation: "submitReview",
    });
    let draft: Draft;
    if (read.draft === null) {
      if (state.uncertainDraft === true)
        return yield* fail(
          `GitCafe still reports no review draft, but T3 cannot prove that the earlier creation is not in flight. Open https://${raw.host}/${raw.repository}/pulls/${raw.number} and inspect the draft before retrying; do not create another review yet.`,
        );
      const created = yield* request(raw, `${path}/review-draft/`, SavedDraft, {
        operation: "submitReview",
        method: "PUT",
        body: {
          expected: null,
          verdict: mappedVerdict,
          body,
          commitOid: revision.headOid,
          baseOid: fresh.observedBaseOid,
          expectedPullVersion: revision.version,
        },
      }).pipe(
        Effect.tapError((error) =>
          Effect.sync(() => {
            const status = (error.cause as { status?: unknown } | undefined)?.status;
            if (typeof status !== "number" || status >= 500) state.uncertainDraft = true;
          }),
        ),
      );
      draft = { ...created, verdict: mappedVerdict, stale: false, comments: [] };
      state.draftId = draft.id;
    } else {
      draft = read.draft;
      const ours = state.draftId === draft.id;
      if (!ours)
        return yield* fail(
          `An existing GitCafe review draft cannot be safely claimed by T3. Open https://${raw.host}/${raw.repository}/pulls/${raw.number}, submit or discard that draft, then retry.`,
        );
      if (
        draft.stale ||
        draft.verdict !== mappedVerdict ||
        draft.body !== body ||
        draft.commitOid !== revision.headOid ||
        draft.baseOid !== fresh.observedBaseOid ||
        draft.pullVersion !== revision.version
      )
        return yield* fail(
          "The GitCafe review draft no longer matches this request. Open GitCafe and inspect the draft before retrying.",
        );
    }
    if (
      draft.comments.length > comments.length ||
      !draft.comments.every((comment, index) => sameComment(comment, comments[index]!))
    )
      return yield* fail(
        "The GitCafe review draft contains unrelated line comments. Open GitCafe and inspect the draft before retrying.",
      );
    if (state.uncertainComment === true)
      return yield* fail(
        `T3 cannot prove whether the last draft comment was saved. Open https://${raw.host}/${raw.repository}/pulls/${raw.number} and inspect the review draft before retrying.`,
      );

    let ref = { id: draft.id, version: draft.version };
    for (let index = draft.comments.length; index < comments.length; index++) {
      const result = yield* request(raw, `${path}/review-draft/comments`, SavedComment, {
        operation: "submitReview",
        method: "POST",
        body: { ...comments[index]!, expected: ref },
      }).pipe(
        Effect.tapError((error) =>
          Effect.sync(() => {
            const status = (error.cause as { status?: unknown } | undefined)?.status;
            if (typeof status !== "number" || status >= 500) state.uncertainComment = true;
          }),
        ),
      );
      ref = result.draft;
    }
    state.finalDraft = ref;
    state.submitted = true;
    yield* request(raw, `${path}/reviews`, Submitted, {
      operation: "submitReview",
      method: "POST",
      body: { ...finalBody, draft: ref },
    });
  });
  return { submitReview };
}
