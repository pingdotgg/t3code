// @effect-diagnostics nodeBuiltinImport:off - delivered-payload hashes are recomputed in pure mappers outside a service context.
import {
  AuthOrchestrationReadScope,
  ExtensionOperationError,
  PullRequestOperationError,
  PullRequestUnavailableError,
  type PullRequestActivity as NativePullRequestActivity,
  type PullRequestDetail as NativePullRequestDetail,
  type PullRequestListResult as NativePullRequestListResult,
  type ThreadPullRequestKey,
} from "@t3tools/contracts";
import {
  PRS_READ_API,
  type PrsActivity,
  type PrsCapabilitiesResult,
  type PrsComment,
  type PrsCommit,
  type PrsDetail,
  type PrsDiffStreamEvent,
  type PrsLabelCandidateList,
  type PrsLinkedThreadsResult,
  type PrsListResult,
  type PrsListStatsResult,
  type PrsOperationsSupport,
  type PrsRefreshedEvent,
  type PrsReviewThread,
  type PrsReviewerCandidateList,
  type PrsStack,
  type PrsSummary,
  type PrsThreadCommentsResult,
  type VcsDiffFileContentsStreamEvent,
} from "@t3tools/extension-sdk/catalogue";
import type { ApiStreamEvent } from "@t3tools/extension-sdk/capabilities";
import { copyJson, type Json, type ViewContext } from "@t3tools/extension-sdk/contracts";
import type {
  HostApiInvocationMetadata,
  HostApiPrincipal,
  HostApiProvider,
} from "@t3tools/extension-runtime";
import * as NodeCrypto from "node:crypto";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { ServerEnvironment } from "../../environment/ServerEnvironment.ts";
import { ProjectionProjectRepository } from "../../persistence/Services/ProjectionProjects.ts";
import { ProjectionThreadRepository } from "../../persistence/Services/ProjectionThreads.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { PullRequestService, type PullRequestError } from "../../pullRequest/PullRequestService.ts";
import type {
  PullRequestProviderApi,
  PullRequestProviderError,
} from "../../pullRequest/PullRequestProvider.ts";
import { PullRequestProviderRegistry } from "../../pullRequest/PullRequestProviderRegistry.ts";
import { listLinkedPullRequestThreads } from "../../pullRequest/linkedThreads.ts";
import { pullRequestSyncKey } from "../../pullRequest/pullRequestSyncKey.ts";
import { makePrsBinding } from "./binding.ts";
import { makeExtensionScopeResolver } from "../scope.ts";

/**
 * Public bounds the adapter enforces server-side, again — the broker's ajv
 * pass validates first, and these Effect decoders add
 * `onExcessProperty: "error"`. Output bounds keep a unary result inside the
 * broker's 64 KiB envelope: collections are cut from the tail and the result
 * flagged `truncated`, never silently reduced.
 */
const MAX_RESULT_BYTES = 48 * 1024;
const MAX_DETAIL_BODY_CHARS = 16_384;
const MAX_COMMENT_BODY_CHARS = 8_192;
const MAX_ACTIVITY_COMMENTS = 100;
const MAX_ACTIVITY_THREADS = 100;
const MAX_ACTIVITY_COMMITS = 250;
const MAX_THREAD_COMMENTS = 100;
const MAX_CANDIDATES = 200;
const MAX_LABEL_CANDIDATES = 500;
const MAX_LINKED_THREADS = 200;
const MAX_LIST_ENTRIES = 100;
/** Whole-patch delivery bound for `streamDiff` (UTF-16 units) — 512 chunks. */
const MAX_DIFF_STREAM_UNITS = 4 * 1024 * 1024;
const MAX_FILE_CONTENTS_CHARS = 1_048_576;
/** Contract chunk bound (UTF-16 units), same as t3.vcs/diff@1.1.0. */
const STREAM_CHUNK_UNITS = 8_192;
const STREAM_FRAME_BUDGET = 64 * 1024;

const string256 = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256));
const hostField = Schema.optional(string256);
const repositoryField = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512));
const refFields = {
  host: hostField,
  repository: repositoryField,
  number: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
} as const;
const decode = <A, I>(schema: Schema.Codec<A, I>) =>
  Schema.decodeUnknownSync(schema, { onExcessProperty: "error" });
const emptyInput = decode(Schema.Struct({}));
const refInput = decode(Schema.Struct(refFields));
const listInput = decode(
  Schema.Struct({
    state: Schema.Literals(["all", "open", "closed", "merged"]),
    involvement: Schema.optional(Schema.Literals(["all", "reviewing", "authored"])),
    filters: Schema.optional(
      Schema.Struct({
        draft: Schema.optional(Schema.Literals(["only", "hide"])),
        review: Schema.optional(
          Schema.Literals(["approved", "changes-requested", "review-required", "none"]),
        ),
        checks: Schema.optional(Schema.Literals(["passing", "failing"])),
        labels: Schema.optional(
          Schema.Array(
            Schema.Array(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200))).check(
              Schema.isMaxLength(10),
            ),
          ).check(Schema.isMaxLength(10)),
        ),
        excludedLabels: Schema.optional(
          Schema.Array(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200))).check(
            Schema.isMaxLength(10),
          ),
        ),
        author: Schema.optional(
          Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
        ),
      }),
    ),
    host: hostField,
    limit: Schema.optional(
      Schema.Int.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(50)),
    ),
    cursors: Schema.optional(
      Schema.Record(
        Schema.String,
        Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4096)),
      ),
    ),
    query: Schema.optional(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200))),
  }),
);
const listStatsInput = decode(
  Schema.Struct({
    refs: Schema.Array(Schema.Struct(refFields)).check(
      Schema.isMinLength(1),
      Schema.isMaxLength(100),
    ),
  }),
);
const threadCommentsInput = decode(
  Schema.Struct({
    ...refFields,
    threadId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512)),
    cursor: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4096)),
  }),
);
const invalidateInput = decode(
  Schema.Struct({ reference: Schema.optional(Schema.Struct(refFields)) }),
);
const diffInput = decode(
  Schema.Struct({
    ...refFields,
    commit: Schema.optional(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128))),
    cursor: Schema.optional(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4096))),
  }),
);
const diffFileContentsInput = decode(
  Schema.Struct({
    ...refFields,
    commit: Schema.optional(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128))),
    changeType: Schema.Literals(["change", "rename-pure", "rename-changed", "new", "deleted"]),
    oldPath: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1024)),
    newPath: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1024)),
  }),
);

const failure = (operation: string, detail: string) =>
  new ExtensionOperationError({ operation, detail });

const isOperationError = Schema.is(ExtensionOperationError);

/**
 * Tag-preserving mapping — a `PullRequestUnavailableError` keeps its name so
 * cli-missing / cli-unauthenticated / provider-unsupported are observable by
 * name, not flattened into a generic "failed".
 */
const operationError = (operation: string) => (cause: unknown) => {
  if (isOperationError(cause)) return cause;
  const tag =
    cause !== null &&
    typeof cause === "object" &&
    "_tag" in cause &&
    typeof (cause as { _tag: unknown })._tag === "string"
      ? (cause as { _tag: string })._tag
      : cause instanceof Error
        ? cause.name
        : undefined;
  // `PullRequestUnavailableError` carries the stable reason callers act on —
  // cli-missing / cli-unauthenticated / provider-unsupported — so it is named
  // in the detail, not just the tag.
  const reason =
    cause !== null &&
    typeof cause === "object" &&
    "reason" in cause &&
    typeof (cause as { reason: unknown }).reason === "string"
      ? (cause as { reason: string }).reason
      : undefined;
  const message = cause instanceof Error ? cause.message : "Pull request operation failed.";
  const label = tag === undefined ? "" : reason === undefined ? `${tag}: ` : `${tag}(${reason}): `;
  return failure(operation, `${label}${message}`.slice(0, 512));
};

/**
 * The native stats read erases a provider failure into an empty page —
 * the right call for the page's best-effort numbers, wrong for a contract
 * that promises working credentials or a named failure. This preserves
 * the provider's stable reason the same way the service's strict reads
 * do: a missing or unauthenticated tool surfaces as
 * `PullRequestUnavailableError` (cli-missing / cli-unauthenticated),
 * anything else as an operation error carrying the provider's detail.
 */
const providerFailure =
  (operation: string) =>
  (error: PullRequestProviderError): PullRequestError =>
    error.reason === "missing-tool" || error.reason === "unauthenticated"
      ? new PullRequestUnavailableError({
          reason: error.reason === "missing-tool" ? "cli-missing" : "cli-unauthenticated",
          provider: error.provider,
          cause: error,
        })
      : new PullRequestOperationError({ operation, detail: error.detail, cause: error });

const sha256 = (text: string) => NodeCrypto.createHash("sha256").update(text, "utf8").digest("hex");
const byteLength = (value: unknown) => Buffer.byteLength(JSON.stringify(value), "utf8");
const capBody = (body: string, bound = MAX_COMMENT_BODY_CHARS) =>
  body.length <= bound ? { body, cut: false } : { body: body.slice(0, bound), cut: true };

/** Same surrogate-safe splitting the vcs diff streams use. */
const splitStreamChunks = (data: string): string[] => {
  const chunks: string[] = [];
  for (let start = 0; start < data.length;) {
    let end = Math.min(start + STREAM_CHUNK_UNITS, data.length);
    if (end < data.length) {
      const previous = data.charCodeAt(end - 1);
      const next = data.charCodeAt(end);
      if (previous >= 0xd800 && previous <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) {
        end -= 1;
      }
    }
    chunks.push(data.slice(start, end));
    start = end;
  }
  return chunks;
};

const assertStreamFrameFits = (operation: string, value: object) => {
  if (
    Buffer.byteLength(
      JSON.stringify({
        streamId: "x".repeat(128),
        sequence: Number.MAX_SAFE_INTEGER,
        type: "snapshot",
        value,
      }),
      "utf8",
    ) > STREAM_FRAME_BUDGET
  ) {
    throw failure(operation, "Pull request stream event exceeds encoded frame bounds.");
  }
};

const NO_PR_OPERATIONS: PrsOperationsSupport = {
  "prs.list": false,
  "prs.listStats": false,
  "prs.summary": false,
  "prs.detail": false,
  "prs.activity": false,
  "prs.threadComments": false,
  // Environment-local answers — a link query and a cache clear succeed on a
  // local-only repository, and the refresh stream exists regardless of host.
  "prs.linkedThreads": true,
  "prs.stack": false,
  "prs.reviewerCandidates": false,
  "prs.labelCandidates": false,
  "prs.invalidate": true,
  "prs.streamDiff": false,
  "prs.streamDiffFileContents": false,
  "prs.subscribeRefreshes": true,
};

const isPullRequestUnavailableError = Schema.is(PullRequestUnavailableError);

/**
 * Declared support comes from the granted project's own provider
 * implementation — the exact api object its calls would reach — so an
 * optional member the provider never implemented reads false rather than
 * inheriting some other host's answer.
 */
const operationsSupport = (api: PullRequestProviderApi | null): PrsOperationsSupport => {
  if (api === null) return NO_PR_OPERATIONS;
  return {
    ...NO_PR_OPERATIONS,
    "prs.list": true,
    "prs.listStats": api.listChangeRequestStats !== undefined,
    "prs.summary": true,
    "prs.detail": true,
    "prs.activity": true,
    "prs.threadComments": api.getReviewThreadComments !== undefined,
    "prs.stack": api.getChangeRequestStack !== undefined,
    "prs.reviewerCandidates": api.capabilities.reviewers.listCandidates === true,
    "prs.labelCandidates":
      api.capabilities.labels === true && api.listLabelCandidates !== undefined,
    "prs.streamDiff": api.capabilities.diff === true,
    "prs.streamDiffFileContents":
      api.capabilities.diff === true && api.getDiffFileContents !== undefined,
  };
};

interface ScopeDependencies {
  readonly environmentId: string;
  readonly projects: Parameters<typeof makeExtensionScopeResolver>[0]["projects"];
  readonly threads: Parameters<typeof makeExtensionScopeResolver>[0]["threads"];
}

interface PrsApiDependencies extends ScopeDependencies {
  readonly pullRequests: Pick<
    PullRequestService["Service"],
    | "list"
    | "listStats"
    | "summary"
    | "stack"
    | "detail"
    | "activity"
    | "threadComments"
    | "diff"
    | "diffFileContents"
    | "reviewerCandidates"
    | "labelCandidates"
    | "invalidate"
    | "subscribeRefreshes"
  >;
  readonly prRegistry: Pick<PullRequestProviderRegistry["Service"], "get">;
  readonly projectionSnapshotQuery: Pick<ProjectionSnapshotQuery["Service"], "getProjectShellById">;
  readonly sql: SqlClient.SqlClient;
}

type Scope = Effect.Success<ReturnType<ReturnType<typeof makeExtensionScopeResolver>>>;
type MethodHandler = (call: {
  readonly input: unknown;
  readonly context: ViewContext;
  readonly signal: AbortSignal;
  readonly metadata: HostApiInvocationMetadata;
}) => Effect.Effect<Json, ExtensionOperationError>;

export function createPrsApiProvider(dependencies: PrsApiDependencies): HostApiProvider {
  const resolve = makeExtensionScopeResolver(dependencies);
  const authorized = (principal: HostApiPrincipal | undefined) =>
    principal !== undefined &&
    principal.environmentId === dependencies.environmentId &&
    principal.scopes.includes(AuthOrchestrationReadScope);

  const { bindRepository, requireHosted, boundRef, bindRef } = makePrsBinding(dependencies);

  /** Halving that always terminates: floor(1/2) is 0, so a length-one
      collection reaches empty in one step and no loop can stall on a single
      still-oversized entry. */
  const shrink = <T>(items: ReadonlyArray<T>): T[] => items.slice(0, Math.floor(items.length / 2));

  /**
   * JSON.stringify silently drops `undefined` members but the broker's
   * copyJson rejects them; strip them up front so a native result carrying
   * an explicitly-undefined optional field is delivered, not refused.
   */
  const stripUndefinedMembers = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(stripUndefinedMembers);
    if (value !== null && typeof value === "object")
      return Object.fromEntries(
        Object.entries(value)
          .filter(([, member]) => member !== undefined)
          .map(([key, member]) => [key, stripUndefinedMembers(member)]),
      );
    return value;
  };

  /**
   * Delivered results must fit the invoke envelope. Collections are cut from
   * the tail — strict halving, never `max(1, …)` — until the serialized
   * answer fits, and every loss is disclosed on the `truncated` flag.
   * Continuation cursors are dropped whenever entries were cut, because a
   * cursor describes the position after the full native page — resuming from
   * it would silently skip rows the caller never saw. The honest recovery
   * from a truncated page is a narrower query or a smaller limit. Whatever
   * still exceeds the budget with every collection empty is irreducible;
   * `runMethod`'s envelope check then fails the operation by name rather
   * than handing the broker a frame it must reject.
   */
  const boundList = (result: NativePullRequestListResult): PrsListResult => {
    let entries = result.entries.slice(0, MAX_LIST_ENTRIES);
    const assembled = () => ({ ...result, entries });
    while (entries.length > 0 && byteLength(assembled()) > MAX_RESULT_BYTES) {
      entries = shrink(entries);
    }
    const cut = entries.length < result.entries.length;
    return {
      ...assembled(),
      ...(cut ? { truncated: true, nextCursors: {} } : {}),
    } as PrsListResult;
  };

  const boundActivity = (result: NativePullRequestActivity): PrsActivity => {
    let truncated = false;
    const capComment = <T extends { readonly body: string }>(comment: T): T => {
      const { body, cut } = capBody(comment.body);
      if (cut) truncated = true;
      return cut ? { ...comment, body } : comment;
    };
    let comments = result.comments
      .slice(0, MAX_ACTIVITY_COMMENTS)
      .map(capComment) as readonly PrsComment[];
    let commentsTruncated = result.commentsTruncated || comments.length < result.comments.length;
    if (commentsTruncated) truncated = true;
    let reviewThreads = result.reviewThreads.slice(0, MAX_ACTIVITY_THREADS).map((thread) => ({
      ...thread,
      comments: thread.comments.map(capComment),
    })) as readonly PrsReviewThread[];
    let commits = result.commits.slice(0, MAX_ACTIVITY_COMMITS) as readonly PrsCommit[];
    let reviewers = result.reviewers;
    let reactions = result.reactions;
    if (
      reviewThreads.length < result.reviewThreads.length ||
      commits.length < result.commits.length
    )
      truncated = true;
    const assembled = (): PrsActivity =>
      ({
        ...(result.author === undefined ? {} : { author: result.author }),
        ...(reviewers === undefined ? {} : { reviewers }),
        comments,
        commentCount: result.commentCount,
        commentsTruncated,
        reviewThreads,
        commits,
        ...(reactions === undefined ? {} : { reactions }),
        truncated,
      }) as PrsActivity;
    const tooBig = () => byteLength(assembled()) > MAX_RESULT_BYTES;
    // Least-informative collections empty first; each pass strictly halves,
    // so every while reaches zero and the sequence always terminates.
    while (reactions !== undefined && reactions.length > 0 && tooBig()) {
      reactions = shrink(reactions);
      truncated = true;
    }
    while (reviewers !== undefined && reviewers.length > 0 && tooBig()) {
      reviewers = shrink(reviewers);
      truncated = true;
    }
    while (commits.length > 0 && tooBig()) {
      commits = shrink(commits);
      truncated = true;
    }
    while (reviewThreads.length > 0 && tooBig()) {
      reviewThreads = shrink(reviewThreads);
      truncated = true;
    }
    while (comments.length > 0 && tooBig()) {
      comments = shrink(comments);
      commentsTruncated = true;
      truncated = true;
    }
    return assembled();
  };

  const boundDetail = (detail: NativePullRequestDetail): PrsDetail => {
    const { body, cut } = capBody(detail.body, MAX_DETAIL_BODY_CHARS);
    return (cut ? { ...detail, body, bodyTruncated: true } : detail) as PrsDetail;
  };

  const boundThreadComments = <
    T extends {
      readonly comments: ReadonlyArray<{ readonly body: string }>;
      readonly nextCursor: string | null;
    },
  >(
    result: T,
  ): T & { readonly truncated: boolean } => {
    let truncated = false;
    let dropped = result.comments.length > MAX_THREAD_COMMENTS;
    let comments = result.comments.slice(0, MAX_THREAD_COMMENTS).map((comment) => {
      const { body, cut } = capBody(comment.body);
      if (cut) truncated = true;
      return cut ? { ...comment, body } : comment;
    });
    const assembled = (): T & { readonly truncated: boolean } => ({
      ...result,
      comments,
      nextCursor: dropped ? null : result.nextCursor,
      truncated: truncated || dropped,
    });
    while (comments.length > 0 && byteLength(assembled()) > MAX_RESULT_BYTES) {
      comments = shrink(comments);
      dropped = true;
    }
    return assembled();
  };

  const boundCandidates = <
    T extends {
      readonly candidates: ReadonlyArray<unknown>;
      readonly truncated: boolean;
    },
  >(
    result: T,
    bound: number,
  ): T => {
    let candidates = result.candidates.slice(0, bound);
    const assembled = (): T => ({
      ...result,
      candidates,
      truncated: result.truncated || candidates.length < result.candidates.length,
    });
    while (candidates.length > 0 && byteLength(assembled()) > MAX_RESULT_BYTES) {
      candidates = shrink(candidates);
    }
    return assembled();
  };

  const boundLinkedThreads = (
    threads: PrsLinkedThreadsResult["threads"],
  ): PrsLinkedThreadsResult => {
    let kept = threads.slice(0, MAX_LINKED_THREADS);
    const assembled = (): PrsLinkedThreadsResult => ({
      threads: kept,
      truncated: kept.length < threads.length,
    });
    while (kept.length > 0 && byteLength(assembled()) > MAX_RESULT_BYTES) {
      kept = shrink(kept);
    }
    return assembled();
  };

  const runMethod = <Input, Output extends Json>(args: {
    readonly operation: string;
    readonly decode: (input: unknown) => Input;
    readonly run: (safe: Input, scope: Scope) => Effect.Effect<Output, PullRequestError>;
  }): MethodHandler =>
    Effect.fn("PrsApi.invoke")(function* ({ input, context, signal, metadata }) {
      signal.throwIfAborted();
      if (!authorized(metadata.principal)) {
        return yield* failure(args.operation, "Pull request authority is unavailable.");
      }
      const safe = yield* Effect.try({
        try: () => args.decode(input),
        catch: () => failure(args.operation, "Invalid pull request request input."),
      });
      const scope = yield* resolve(context);
      const result = yield* args
        .run(safe, scope)
        .pipe(Effect.mapError(operationError(args.operation)));
      // The wire image cannot carry `undefined` members — the broker's
      // copyJson rejects them before stringify — so optional fields that
      // arrived explicitly undefined are stripped here first, then copyJson
      // normalizes to the shipped image and enforces the encoded budget.
      // Whatever trimming could not fit — an irreducible fixed section, one
      // entry larger than the envelope — fails the operation by name rather
      // than surfacing a broker rejection.
      const delivered = yield* Effect.try({
        try: () => copyJson(stripUndefinedMembers(result), MAX_RESULT_BYTES) as Output,
        catch: (cause) =>
          failure(
            args.operation,
            `The pull request result is not deliverable: ${cause instanceof Error ? cause.message : String(cause)}`,
          ),
      });
      yield* Effect.tryPromise({
        try: () => metadata.assertAuthority?.() ?? Promise.resolve(),
        catch: () => failure(args.operation, "Pull request authority was revoked."),
      });
      yield* resolve(scope.context);
      signal.throwIfAborted();
      return delivered;
    });

  const invokeProvider =
    (operations: Record<string, MethodHandler>) =>
    (
      method: string,
      input: unknown,
      context: ViewContext,
      signal: AbortSignal,
      metadata: HostApiInvocationMetadata,
    ) => {
      const handler = operations[method];
      if (!handler)
        return Effect.runPromise(
          Effect.fail(failure(`prs.${method}`, "Pull request API method is unavailable.")),
          { signal },
        );
      return Effect.runPromise(handler({ input, context, signal, metadata }), { signal });
    };

  const streamDiff = Effect.fn("PrsApi.streamDiff")(function* (
    safe: {
      readonly host?: string | undefined;
      readonly repository: string;
      readonly number: number;
      readonly commit?: string | undefined;
      readonly cursor?: string | undefined;
    },
    scope: Scope,
  ) {
    /**
     * The native diff is sliced (`pullRequests.diff` pages file-granular
     * slices). Walk slices until the diff is whole or the delivered-unit
     * budget is hit; a slice that alone exceeds the budget fails the stream
     * rather than delivering a mid-file prefix the manifest could not resume
     * from honestly.
     */
    const hosted = yield* bindRepository(scope).pipe(
      Effect.flatMap(requireHosted),
      Effect.mapError(operationError("prs.streamDiff")),
    );
    const ref = yield* boundRef(hosted, safe).pipe(
      Effect.mapError(operationError("prs.streamDiff")),
    );
    let patch = "";
    let truncated = false;
    let nextCursor: string | null = null;
    const omitted: Array<{ path: string; additions: number; deletions: number }> = [];
    let cursor = safe.cursor;
    for (;;) {
      const slice = yield* dependencies.pullRequests
        .diff({
          projectId: ref.projectId,
          repository: ref.repository,
          number: ref.number,
          ...(cursor === undefined ? {} : { cursor }),
          ...(safe.commit === undefined ? {} : { commit: safe.commit }),
        })
        .pipe(Effect.mapError(operationError("prs.streamDiff")));
      if (slice.truncated) truncated = true;
      if (slice.omittedFileStats !== undefined) omitted.push(...slice.omittedFileStats);
      if (patch.length > 0 && patch.length + slice.patch.length > MAX_DIFF_STREAM_UNITS) {
        // Stop between whole slices: this slice is undelivered, and the
        // manifest's nextCursor points back at it.
        truncated = true;
        nextCursor = cursor ?? null;
        break;
      }
      if (slice.patch.length > MAX_DIFF_STREAM_UNITS) {
        return yield* failure(
          "prs.streamDiff",
          "A single pull request diff slice exceeds the stream delivery bound.",
        );
      }
      patch += slice.patch;
      if (slice.nextCursor === null) break;
      cursor = slice.nextCursor;
    }
    const chunks = splitStreamChunks(patch);
    return {
      patch,
      chunks,
      manifest: {
        kind: "manifest" as const,
        repository: ref.repository,
        number: ref.number,
        host: hosted.host,
        ...(safe.commit === undefined ? {} : { commit: safe.commit }),
        diffHash: sha256(patch),
        diffByteLength: Buffer.byteLength(patch, "utf8"),
        chunkCount: chunks.length,
        truncated,
        nextCursor,
        ...(omitted.length === 0 ? {} : { omittedFileStats: omitted }),
      } satisfies PrsDiffStreamEvent,
    };
  });

  return {
    providerId: "t3.host-prs-read",
    definition: PRS_READ_API,
    requiresRootAuthority: true,
    invoke: invokeProvider({
      getCapabilities: runMethod({
        operation: "prs.getCapabilities",
        decode: emptyInput,
        run: Effect.fn("prs.getCapabilities")(function* (_safe, scope) {
          /**
           * Two distinct answers. `hosted`/`providers`/`reason`/`detail`
           * come from probing the native listing — it reports every host
           * this project's remotes resolve to, whether its tool and
           * credentials work right now, and a stable `PullRequestError`
           * reason when they do not. `operations` is declared support, from
           * the granted project's own provider implementation — an optional
           * member the provider never implemented reads false rather than
           * borrowing some other configured host's answer.
           */
          const bound = yield* bindRepository(scope);
          const probe = yield* dependencies.pullRequests
            .list({ state: "open", projectIds: [bound.projectId], limit: 1 })
            .pipe(
              Effect.map(
                (result) =>
                  ({ providers: result.providers, reason: null, detail: null }) as {
                    readonly providers: PrsCapabilitiesResult["providers"];
                    readonly reason: PrsCapabilitiesResult["reason"];
                    readonly detail: string | null;
                  },
              ),
              Effect.catch((cause: PullRequestError) =>
                Effect.succeed({
                  providers: [] as PrsCapabilitiesResult["providers"],
                  reason: isPullRequestUnavailableError(cause) ? cause.reason : null,
                  detail: cause.message.slice(0, 512),
                }),
              ),
            );
          const hosted = bound.api !== null && bound.repository !== null && bound.host !== null;
          const unhosted = new PullRequestUnavailableError({ reason: "provider-unsupported" });
          return {
            hosted,
            reason: probe.reason ?? (hosted ? null : unhosted.reason),
            detail: probe.detail ?? (hosted ? null : unhosted.message),
            providers: probe.providers,
            operations: operationsSupport(bound.api),
          } satisfies PrsCapabilitiesResult;
        }),
      }),
      list: runMethod({
        operation: "prs.list",
        decode: listInput,
        run: Effect.fn("prs.list")(function* (safe, scope) {
          const bound = yield* bindRepository(scope).pipe(Effect.flatMap(requireHosted));
          // The optional host filter may only ever narrow to this project's
          // own host — any other value would ask the service to enumerate
          // foreign checkouts under this project's credentials.
          if (safe.host !== undefined && safe.host.trim().toLowerCase() !== bound.host) {
            return yield* new PullRequestOperationError({
              operation: "resolveRepository",
              detail: "The change request host is not the granted project's host.",
            });
          }
          const { host: _host, ...rest } = safe;
          return yield* dependencies.pullRequests
            .list({ ...rest, projectIds: [bound.projectId] })
            .pipe(Effect.map(boundList));
        }),
      }),
      listStats: runMethod({
        operation: "prs.listStats",
        decode: listStatsInput,
        run: Effect.fn("prs.listStats")(function* (safe, scope) {
          const bound = yield* bindRepository(scope).pipe(Effect.flatMap(requireHosted));
          // The service silently skips refs whose provider lacks the
          // optional stats API; the contract fails by name instead.
          const readStats = bound.api.listChangeRequestStats;
          if (readStats === undefined) {
            return yield* new PullRequestOperationError({
              operation: "listStats",
              detail: "This host does not report per-change-request line counts.",
            });
          }
          const refs = yield* Effect.forEach(safe.refs, (ref) => boundRef(bound, ref));
          /**
           * Strict read, not `PullRequestService.listStats`: the service
           * erases a provider failure into `{stats: []}` — right for the
           * page's best-effort numbers, wrong here, where a missing or
           * unauthenticated tool must fail by name with its stable reason.
           * The provider is called directly with the bound project's own
           * checkout and repository; nothing caller-supplied routes it.
           */
          const read = yield* readStats({
            cwd: bound.workspaceRoot,
            host: bound.host,
            changeRequests: refs.map((ref) => ({
              repository: ref.repository,
              number: ref.number,
            })),
          }).pipe(Effect.mapError(providerFailure("listStats")));
          const wanted = new Set(refs.map((ref) => ref.number));
          return {
            stats: read
              .filter((stat) => wanted.has(stat.number))
              .map((stat) => ({
                projectId: bound.projectId,
                repository: stat.repository,
                number: stat.number,
                additions: stat.additions,
                deletions: stat.deletions,
              })),
          } satisfies PrsListStatsResult;
        }),
      }),
      summary: runMethod({
        operation: "prs.summary",
        decode: refInput,
        run: (safe, scope) =>
          bindRef(scope, safe).pipe(
            Effect.flatMap((ref) => dependencies.pullRequests.summary(ref)),
            Effect.map((result): PrsSummary => result as PrsSummary),
          ),
      }),
      detail: runMethod({
        operation: "prs.detail",
        decode: refInput,
        run: (safe, scope) =>
          bindRef(scope, safe).pipe(
            Effect.flatMap((ref) => dependencies.pullRequests.detail(ref)),
            Effect.map(boundDetail),
          ),
      }),
      activity: runMethod({
        operation: "prs.activity",
        decode: refInput,
        run: (safe, scope) =>
          bindRef(scope, safe).pipe(
            Effect.flatMap((ref) => dependencies.pullRequests.activity(ref)),
            Effect.map(boundActivity),
          ),
      }),
      threadComments: runMethod({
        operation: "prs.threadComments",
        decode: threadCommentsInput,
        run: (safe, scope) =>
          bindRef(scope, safe).pipe(
            Effect.flatMap((ref) =>
              dependencies.pullRequests.threadComments({
                ...ref,
                threadId: safe.threadId,
                cursor: safe.cursor,
              }),
            ),
            Effect.map(
              (result): PrsThreadCommentsResult =>
                boundThreadComments(result) as PrsThreadCommentsResult,
            ),
          ),
      }),
      stack: runMethod({
        operation: "prs.stack",
        decode: refInput,
        run: Effect.fn("prs.stack")(function* (safe, scope) {
          const bound = yield* bindRepository(scope).pipe(Effect.flatMap(requireHosted));
          // The service answers null both for "not stacked" and for "this
          // host keeps no stack objects"; the contract fails the second by
          // name instead.
          if (bound.api.getChangeRequestStack === undefined) {
            return yield* new PullRequestOperationError({
              operation: "stack",
              detail: "This host does not track change-request stacks.",
            });
          }
          const ref = yield* boundRef(bound, safe);
          return yield* dependencies.pullRequests
            .stack(ref)
            .pipe(Effect.map((result): PrsStack | null => result as PrsStack | null));
        }),
      }),
      linkedThreads: runMethod({
        operation: "prs.linkedThreads",
        decode: refInput,
        run: Effect.fn("prs.linkedThreads")(function* (safe, scope) {
          const bound = yield* bindRepository(scope);
          let key: ThreadPullRequestKey | null;
          if (bound.repository !== null && bound.host !== null && bound.identity !== null) {
            // A hosted project: the ref must name its own repository —
            // boundRef performs that check — and the link key is derived
            // from the server-side identity, never from caller input.
            yield* boundRef(
              {
                projectId: bound.projectId,
                repository: bound.repository,
                host: bound.host,
              },
              safe,
            );
            key = pullRequestSyncKey(
              { projectId: bound.projectId, repository: bound.repository, number: safe.number },
              bound.identity,
            );
          } else {
            // A local-only project has no identity to bind to; the caller's
            // own host/repository form the key, and the row filter below
            // still restricts results to this project's threads.
            key =
              safe.host === undefined
                ? null
                : pullRequestSyncKey(
                    {
                      projectId: bound.projectId,
                      host: safe.host,
                      repository: safe.repository,
                      number: safe.number,
                    },
                    null,
                  );
          }
          if (key === null) return { threads: [], truncated: false };
          const result = yield* listLinkedPullRequestThreads(key).pipe(
            Effect.provideService(SqlClient.SqlClient, dependencies.sql),
          );
          // The join matches links recorded under any project sharing this
          // host/repository/number; a plugin only ever sees threads of the
          // project it was granted.
          return boundLinkedThreads(
            result.threads.filter((thread) => thread.projectId === bound.projectId),
          );
        }),
      }),
      reviewerCandidates: runMethod({
        operation: "prs.reviewerCandidates",
        decode: refInput,
        run: (safe, scope) =>
          bindRef(scope, safe).pipe(
            Effect.flatMap((ref) => dependencies.pullRequests.reviewerCandidates(ref)),
            Effect.map(
              (result): PrsReviewerCandidateList =>
                boundCandidates(result, MAX_CANDIDATES) as PrsReviewerCandidateList,
            ),
          ),
      }),
      labelCandidates: runMethod({
        operation: "prs.labelCandidates",
        decode: refInput,
        run: (safe, scope) =>
          bindRef(scope, safe).pipe(
            Effect.flatMap((ref) => dependencies.pullRequests.labelCandidates(ref)),
            Effect.map(
              (result): PrsLabelCandidateList =>
                boundCandidates(result, MAX_LABEL_CANDIDATES) as PrsLabelCandidateList,
            ),
          ),
      }),
      invalidate: runMethod({
        operation: "prs.invalidate",
        decode: invalidateInput,
        run: Effect.fn("prs.invalidate")(function* (safe, scope) {
          if (safe.reference === undefined) {
            yield* dependencies.pullRequests.invalidate({});
            return {};
          }
          const ref = yield* bindRef(scope, safe.reference);
          yield* dependencies.pullRequests.invalidate({ reference: ref });
          return {};
        }),
      }),
    }),
    subscribe: (name, input, context, signal, metadata, resumeCursor) => {
      if (
        name !== "streamDiff" &&
        name !== "streamDiffFileContents" &&
        name !== "subscribeRefreshes"
      )
        throw failure(`prs.${name}`, "Pull request stream is unavailable.");
      if (resumeCursor !== undefined)
        throw failure(`prs.${name}`, "Pull request stream resume is unsupported.");
      const safe = (() => {
        try {
          return name === "streamDiff"
            ? ({ kind: "diff", input: diffInput(input) } as const)
            : name === "streamDiffFileContents"
              ? ({ kind: "fileContents", input: diffFileContentsInput(input) } as const)
              : ({ kind: "refreshes", input: emptyInput(input) } as const);
        } catch {
          throw failure(`prs.${name}`, "Invalid pull request stream request.");
        }
      })();
      if (!authorized(metadata.principal))
        throw failure(`prs.${name}`, "Pull request authority is unavailable.");
      const assertAuthority = () => metadata.assertAuthority?.() ?? Promise.resolve();
      if (safe.kind === "refreshes") {
        /**
         * The native refresh counter as data frames — one `{kind:"refreshed"}`
         * per invalidation, so a plugin re-reads exactly when the native
         * client would. Same queue discipline as the vcs status stream:
         * bursts past the queue close the stream with a named reason rather
         * than growing unboundedly behind a slow consumer.
         */
        const maxQueuedEvents = 64;
        const queue: ApiStreamEvent[] = [];
        let finished = false;
        let aborted = signal.aborted;
        let wake: (() => void) | null = null;
        let cleanup: (() => void) | null = null;
        let setup: Promise<void> | null = null;
        let setupFailure: unknown = null;
        const controller = new AbortController();
        const runSignal = AbortSignal.any([signal, controller.signal]);
        let removeAbortListener: (() => void) | null = null;

        const finish = () => {
          finished = true;
          cleanup?.();
          cleanup = null;
          removeAbortListener?.();
          removeAbortListener = null;
          wake?.();
          wake = null;
        };
        const pushClosed = (reason: "overflow" | "refresh-error") => {
          queue.length = 0;
          queue.push({
            type: "closed",
            value: { kind: "closed", reason } satisfies PrsRefreshedEvent,
          });
          finish();
        };
        const push = (event: ApiStreamEvent) => {
          if (finished || aborted) return;
          if (queue.length >= maxQueuedEvents) {
            pushClosed("overflow");
          } else {
            queue.push(event);
          }
          wake?.();
          wake = null;
        };
        const abort = () => {
          aborted = true;
          controller.abort();
          queue.length = 0;
          finish();
          wake?.();
          wake = null;
        };
        signal.addEventListener("abort", abort, { once: true });
        removeAbortListener = () => signal.removeEventListener("abort", abort);

        const iterable: AsyncIterable<ApiStreamEvent> = {
          [Symbol.asyncIterator]() {
            let returned = false;
            // Only an external cancel poisons the iterator; an internal
            // controller.abort() on stream completion must still let queued
            // events drain before `done`.
            const failIfAborted = () => {
              if (aborted)
                throw runSignal.reason ?? failure("prs.subscribeRefreshes", "Stream cancelled.");
            };
            const finishIterator = async () => {
              controller.abort();
              finish();
            };
            return {
              async next() {
                if (returned) return { done: true, value: undefined };
                failIfAborted();
                setup ??= (async () => {
                  try {
                    await Effect.runPromise(resolve(context), { signal: runSignal });
                    await assertAuthority();
                    cleanup = () => controller.abort();
                    Effect.runPromise(
                      Stream.runForEach(dependencies.pullRequests.subscribeRefreshes, (revision) =>
                        Effect.sync(() =>
                          push({
                            type: "data",
                            value: { kind: "refreshed", revision } satisfies PrsRefreshedEvent,
                          }),
                        ),
                      ),
                      { signal: runSignal },
                    ).then(
                      () => finish(),
                      () => pushClosed("refresh-error"),
                    );
                  } catch (error) {
                    setupFailure = error;
                    finish();
                    throw error;
                  }
                })();
                try {
                  await setup;
                  if (setupFailure !== null) throw setupFailure;
                  failIfAborted();
                  // The native stream callback may finish this observer while next() waits.
                  // eslint-disable-next-line no-unmodified-loop-condition
                  while (queue.length === 0 && !finished) {
                    await new Promise<void>((resolveWait) => {
                      wake = resolveWait;
                    });
                    failIfAborted();
                  }
                  failIfAborted();
                  const value = queue.shift();
                  if (!value) {
                    await finishIterator();
                    returned = true;
                    return { done: true, value: undefined };
                  }
                  return { done: false, value };
                } catch (error) {
                  await finishIterator();
                  returned = true;
                  throw error;
                }
              },
              async return() {
                returned = true;
                abort();
                await finishIterator();
                return { done: true, value: undefined };
              },
            };
          },
        };
        return iterable;
      }
      return (async function* (): AsyncGenerator<ApiStreamEvent> {
        const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect, { signal });
        signal.throwIfAborted();
        const scope = await run(resolve(context));
        // The unary discipline stretched over a finite transfer: re-resolve
        // the scope and re-assert authority at each frame boundary so a
        // revoked principal or moved workspace stops the stream mid-flight.
        const guard = async () => {
          signal.throwIfAborted();
          await run(resolve(scope.context));
          await assertAuthority();
        };
        if (safe.kind === "diff") {
          const { chunks, manifest } = await run(
            streamDiff(safe.input, scope).pipe(Effect.mapError(operationError("prs.streamDiff"))),
          );
          assertStreamFrameFits("prs.streamDiff", manifest);
          yield { type: "snapshot", value: manifest };
          const payloadHash = NodeCrypto.createHash("sha256");
          for (const [chunkIndex, data] of chunks.entries()) {
            await guard();
            payloadHash.update(data, "utf8");
            const chunk: PrsDiffStreamEvent = { kind: "chunk", chunkIndex, data };
            assertStreamFrameFits("prs.streamDiff", chunk);
            yield { type: "data", value: chunk };
          }
          const complete: PrsDiffStreamEvent = {
            kind: "complete",
            payloadSha256: payloadHash.digest("hex"),
          };
          await guard();
          yield { type: "data", value: complete };
          return;
        }
        const fileContentsRef = await run(
          bindRepository(scope).pipe(
            Effect.flatMap(requireHosted),
            Effect.flatMap((hosted) => boundRef(hosted, safe.input)),
            Effect.mapError(operationError("prs.streamDiffFileContents")),
          ),
        );
        const contents = await run(
          dependencies.pullRequests
            .diffFileContents({
              projectId: fileContentsRef.projectId,
              repository: fileContentsRef.repository,
              number: fileContentsRef.number,
              ...(safe.input.commit === undefined ? {} : { commit: safe.input.commit }),
              changeType: safe.input.changeType,
              oldPath: safe.input.oldPath,
              newPath: safe.input.newPath,
            })
            .pipe(Effect.mapError(operationError("prs.streamDiffFileContents"))),
        );
        if (
          contents.oldContents.length > MAX_FILE_CONTENTS_CHARS ||
          contents.newContents.length > MAX_FILE_CONTENTS_CHARS
        ) {
          throw failure(
            "prs.streamDiffFileContents",
            "Pull request diff file contents exceed the public bounds.",
          );
        }
        const sides = [
          { side: "old" as const, contents: contents.oldContents },
          { side: "new" as const, contents: contents.newContents },
        ].map((entry) => ({ ...entry, chunks: splitStreamChunks(entry.contents) }));
        const manifest = {
          kind: "manifest" as const,
          oldByteLength: Buffer.byteLength(contents.oldContents, "utf8"),
          oldChunkCount: sides[0]!.chunks.length,
          newByteLength: Buffer.byteLength(contents.newContents, "utf8"),
          newChunkCount: sides[1]!.chunks.length,
        } satisfies VcsDiffFileContentsStreamEvent;
        assertStreamFrameFits("prs.streamDiffFileContents", manifest);
        yield { type: "snapshot", value: manifest };
        for (const { side, chunks } of sides) {
          for (const [chunkIndex, data] of chunks.entries()) {
            await guard();
            const chunk = { kind: "chunk" as const, side, chunkIndex, data };
            assertStreamFrameFits("prs.streamDiffFileContents", chunk);
            yield { type: "data", value: chunk };
          }
        }
        await guard();
        yield {
          type: "data",
          value: {
            kind: "complete",
            oldSha256: sha256(sides[0]!.contents),
            newSha256: sha256(sides[1]!.contents),
          } satisfies VcsDiffFileContentsStreamEvent,
        };
      })();
    },
  };
}

export const makePrsApiProvider = Effect.fn("PrsApi.make")(function* () {
  const environment = yield* ServerEnvironment;
  return createPrsApiProvider({
    environmentId: yield* environment.getEnvironmentId,
    projects: yield* ProjectionProjectRepository,
    threads: yield* ProjectionThreadRepository,
    pullRequests: yield* PullRequestService,
    prRegistry: yield* PullRequestProviderRegistry,
    projectionSnapshotQuery: yield* ProjectionSnapshotQuery,
    sql: yield* SqlClient.SqlClient,
  });
});
