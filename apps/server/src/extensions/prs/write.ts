import {
  AuthOrchestrationOperateScope,
  ExtensionOperationError,
  PullRequestUnavailableError,
  type PullRequestRef as NativePullRequestRef,
} from "@t3tools/contracts";
import {
  PRS_WRITE_API,
  type PrsCapabilitiesResult,
  type PrsWriteCapabilitiesResult,
  type PrsWriteEmptyResult,
  type PrsWriteOperationsSupport,
} from "@t3tools/extension-sdk/catalogue";
import type { Json, ViewContext } from "@t3tools/extension-sdk/contracts";
import type {
  HostApiInvocationMetadata,
  HostApiPrincipal,
  HostApiProvider,
} from "@t3tools/extension-runtime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { ServerEnvironment } from "../../environment/ServerEnvironment.ts";
import { ProjectionProjectRepository } from "../../persistence/Services/ProjectionProjects.ts";
import { ProjectionThreadRepository } from "../../persistence/Services/ProjectionThreads.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { PullRequestService, type PullRequestError } from "../../pullRequest/PullRequestService.ts";
import type { PullRequestProviderApi } from "../../pullRequest/PullRequestProvider.ts";
import { PullRequestProviderRegistry } from "../../pullRequest/PullRequestProviderRegistry.ts";
import { makePrsBinding } from "./binding.ts";
import { makeExtensionScopeResolver } from "../scope.ts";

/**
 * t3.prs/write — the ten host-write ops 1:1 on the native `pullRequests.*`
 * mutations. The granted project's repository identity is resolved
 * server-side (makePrsBinding) and every ref is validated against it; the
 * service re-reads viewer permissions before each write, so access
 * withdrawn since a page loaded is refused by the host, not by the
 * client's claim.
 */

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
// Mirrors contracts' CommentBody: markdown is not trimmed; the service
// rejects a whitespace-only body.
const bodyField = Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(65_536));
const actionInput = decode(
  Schema.Struct({
    ...refFields,
    action: Schema.Literals([
      "merge",
      "ready",
      "draft",
      "close",
      "reopen",
      "update-branch",
      "enable-auto-merge",
      "disable-auto-merge",
      "revert",
      "approve-workflows",
    ]),
    mergeMethod: Schema.optional(Schema.Literals(["merge", "squash", "rebase"])),
    updateMethod: Schema.optional(Schema.Literals(["merge", "rebase"])),
    stackNumber: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))),
    expectedStackHeads: Schema.optional(
      Schema.Array(
        Schema.Struct({
          number: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
          headSha: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128)),
        }),
      ).check(Schema.isMaxLength(100)),
    ),
  }),
);
const updateInput = decode(
  Schema.Struct({
    ...refFields,
    title: Schema.optional(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1024))),
    body: Schema.optional(Schema.String.check(Schema.isMaxLength(65_536))),
  }),
);
const commentInput = decode(Schema.Struct({ ...refFields, body: bodyField }));
const updateCommentInput = decode(
  Schema.Struct({
    ...refFields,
    commentId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512)),
    kind: Schema.Literals(["issue-comment", "review-comment"]),
    body: bodyField,
  }),
);
const reviewCommentDraft = Schema.Struct({
  path: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1024)),
  oldPath: Schema.optional(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1024))),
  position: Schema.Union([
    Schema.Struct({
      kind: Schema.Literal("added"),
      newLine: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
    }),
    Schema.Struct({
      kind: Schema.Literal("deleted"),
      oldLine: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
    }),
    Schema.Struct({
      kind: Schema.Literal("context"),
      oldLine: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
      newLine: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
      side: Schema.Literals(["left", "right"]),
    }),
  ]),
  body: bodyField,
});
const submitReviewInput = decode(
  Schema.Struct({
    ...refFields,
    verdict: Schema.Literals(["comment", "approve", "request-changes"]),
    // May be empty — an approval with no remarks.
    body: Schema.String.check(Schema.isMaxLength(65_536)),
    comments: Schema.Array(reviewCommentDraft).check(Schema.isMaxLength(100)),
  }),
);
const threadReplyInput = decode(
  Schema.Struct({
    ...refFields,
    threadId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512)),
    body: bodyField,
  }),
);
const threadResolutionInput = decode(
  Schema.Struct({
    ...refFields,
    threadId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512)),
    resolved: Schema.Boolean,
  }),
);
const reactionInput = decode(
  Schema.Struct({
    ...refFields,
    subjectId: Schema.optional(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512))),
    content: Schema.Literals([
      "thumbs-up",
      "thumbs-down",
      "laugh",
      "hooray",
      "confused",
      "heart",
      "rocket",
      "eyes",
    ]),
    reacted: Schema.Boolean,
  }),
);
const reviewerRequestInput = decode(
  Schema.Struct({
    ...refFields,
    reviewers: Schema.Array(
      Schema.Struct({
        id: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512)),
        kind: Schema.Literals(["user", "team"]),
      }),
    ).check(Schema.isMinLength(1), Schema.isMaxLength(25)),
    requested: Schema.Boolean,
  }),
);
const labelsInput = decode(
  Schema.Struct({
    ...refFields,
    labels: Schema.Array(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512))).check(
      Schema.isMinLength(1),
      Schema.isMaxLength(25),
    ),
    applied: Schema.Boolean,
  }),
);

const failure = (operation: string, detail: string) =>
  new ExtensionOperationError({ operation, detail });
const isOperationError = Schema.is(ExtensionOperationError);
const isPullRequestUnavailableError = Schema.is(PullRequestUnavailableError);

/**
 * Tag-preserving mapping — `PullRequestUnavailableError` keeps its stable
 * reason (cli-missing / cli-unauthenticated / provider-unsupported) so a
 * caller can branch on it rather than on a generic "failed".
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

const NO_WRITE_OPERATIONS: PrsWriteOperationsSupport = {
  "prs.runAction": false,
  "prs.update": false,
  "prs.comment": false,
  "prs.updateComment": false,
  "prs.submitReview": false,
  "prs.replyToThread": false,
  "prs.setThreadResolution": false,
  "prs.setReaction": false,
  "prs.requestReviewers": false,
  "prs.setLabels": false,
};

/**
 * Declared support comes from the granted project's own provider — the
 * same `PullRequestCapabilities` the native page reads before offering a
 * control. A host that cannot do a write reads false rather than failing
 * at call time; anything the capability leaves open is still gated by the
 * service's fresh viewer-permission read.
 */
const writeOperationsSupport = (api: PullRequestProviderApi | null): PrsWriteOperationsSupport => {
  if (api === null) return NO_WRITE_OPERATIONS;
  const capabilities = api.capabilities;
  return {
    "prs.runAction": capabilities.actions.length > 0,
    "prs.update": capabilities.edit?.changeRequest === true,
    "prs.comment": capabilities.comment,
    "prs.updateComment": capabilities.edit?.comment === true,
    "prs.submitReview": capabilities.review.verdicts.length > 0,
    "prs.replyToThread": capabilities.review.reply,
    "prs.setThreadResolution": capabilities.review.resolve,
    "prs.setReaction": capabilities.reactions === true,
    "prs.requestReviewers": capabilities.reviewers.request,
    "prs.setLabels": capabilities.labels === true && api.setLabels !== undefined,
  };
};

interface ScopeDependencies {
  readonly environmentId: string;
  readonly projects: Parameters<typeof makeExtensionScopeResolver>[0]["projects"];
  readonly threads: Parameters<typeof makeExtensionScopeResolver>[0]["threads"];
}

interface PrsWriteApiDependencies extends ScopeDependencies {
  readonly pullRequests: Pick<
    PullRequestService["Service"],
    | "runAction"
    | "update"
    | "comment"
    | "updateComment"
    | "submitReview"
    | "replyToThread"
    | "setThreadResolution"
    | "setReaction"
    | "requestReviewers"
    | "setLabels"
    | "list"
  >;
  readonly prRegistry: Pick<PullRequestProviderRegistry["Service"], "get">;
  readonly projectionSnapshotQuery: Pick<ProjectionSnapshotQuery["Service"], "getProjectShellById">;
}

type Scope = Effect.Success<ReturnType<ReturnType<typeof makeExtensionScopeResolver>>>;
type MethodHandler = (call: {
  readonly input: unknown;
  readonly context: ViewContext;
  readonly signal: AbortSignal;
  readonly metadata: HostApiInvocationMetadata;
}) => Effect.Effect<Json, ExtensionOperationError>;

export function createPrsWriteApiProvider(dependencies: PrsWriteApiDependencies): HostApiProvider {
  const resolve = makeExtensionScopeResolver(dependencies);
  const authorized = (principal: HostApiPrincipal | undefined) =>
    principal !== undefined &&
    principal.environmentId === dependencies.environmentId &&
    principal.scopes.includes(AuthOrchestrationOperateScope);
  const { bindRepository, bindRef } = makePrsBinding(dependencies);

  const runMethod = <Input, Output extends Json>(args: {
    readonly operation: string;
    readonly decode: (input: unknown) => Input;
    readonly run: (safe: Input, scope: Scope) => Effect.Effect<Output, PullRequestError>;
  }): MethodHandler =>
    Effect.fn("PrsWriteApi.invoke")(function* ({ input, context, signal, metadata }) {
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
      yield* Effect.tryPromise({
        try: () => metadata.assertAuthority?.() ?? Promise.resolve(),
        catch: () => failure(args.operation, "Pull request authority was revoked."),
      });
      yield* resolve(scope.context);
      signal.throwIfAborted();
      return result;
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

  /** Every host-write op binds the ref, then forwards the operation fields 1:1. */
  const writeOp = <
    Input extends {
      readonly host?: string | undefined;
      readonly repository: string;
      readonly number: number;
    },
  >(
    operation: string,
    decodeInput: (input: unknown) => Input,
    call: (safe: Input, ref: NativePullRequestRef) => Effect.Effect<void, PullRequestError>,
  ): MethodHandler =>
    runMethod({
      operation,
      decode: decodeInput,
      run: Effect.fn(`prs.${operation}`)(function* (safe, scope) {
        const ref = yield* bindRef(scope, safe);
        yield* call(safe, ref);
        return {} satisfies PrsWriteEmptyResult;
      }),
    });

  return {
    providerId: "t3.host-prs-write",
    definition: PRS_WRITE_API,
    requiresRootAuthority: true,
    invoke: invokeProvider({
      getCapabilities: runMethod({
        operation: "prs.getCapabilities",
        decode: emptyInput,
        run: Effect.fn("prs.write.getCapabilities")(function* (_safe, scope) {
          /**
           * `hosted`/`reason`/`detail` answer "would a write reach a live
           * host right now" — the native listing probe reports the tool and
           * credential state by the same stable reason names the read
           * contract reports. `operations` is declared write support from
           * the granted project's own provider implementation.
           */
          const bound = yield* bindRepository(scope);
          const probe = yield* dependencies.pullRequests
            .list({ state: "open", projectIds: [bound.projectId], limit: 1 })
            .pipe(
              Effect.map(
                () =>
                  ({ reason: null, detail: null }) as {
                    readonly reason: PrsCapabilitiesResult["reason"];
                    readonly detail: string | null;
                  },
              ),
              Effect.catch((cause: PullRequestError) =>
                Effect.succeed({
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
            operations: writeOperationsSupport(bound.api),
            actions: bound.api?.capabilities.actions ?? [],
            mergeMethods: bound.api?.capabilities.mergeMethods ?? [],
            updateMethods: bound.api?.capabilities.updateMethods ?? [],
            verdicts: bound.api?.capabilities.review.verdicts ?? [],
          } satisfies PrsWriteCapabilitiesResult;
        }),
      }),
      runAction: writeOp("runAction", actionInput, (safe, ref) =>
        dependencies.pullRequests.runAction({
          ...ref,
          action: safe.action,
          ...(safe.mergeMethod === undefined ? {} : { mergeMethod: safe.mergeMethod }),
          ...(safe.updateMethod === undefined ? {} : { updateMethod: safe.updateMethod }),
          ...(safe.stackNumber === undefined ? {} : { stackNumber: safe.stackNumber }),
          ...(safe.expectedStackHeads === undefined
            ? {}
            : { expectedStackHeads: safe.expectedStackHeads }),
        }),
      ),
      update: writeOp("update", updateInput, (safe, ref) =>
        dependencies.pullRequests.update({
          ...ref,
          ...(safe.title === undefined ? {} : { title: safe.title }),
          ...(safe.body === undefined ? {} : { body: safe.body }),
        }),
      ),
      comment: writeOp("comment", commentInput, (safe, ref) =>
        dependencies.pullRequests.comment({ ...ref, body: safe.body }),
      ),
      updateComment: writeOp("updateComment", updateCommentInput, (safe, ref) =>
        dependencies.pullRequests.updateComment({
          ...ref,
          commentId: safe.commentId,
          kind: safe.kind,
          body: safe.body,
        }),
      ),
      submitReview: writeOp("submitReview", submitReviewInput, (safe, ref) =>
        dependencies.pullRequests.submitReview({
          ...ref,
          verdict: safe.verdict,
          body: safe.body,
          comments: safe.comments,
        }),
      ),
      replyToThread: writeOp("replyToThread", threadReplyInput, (safe, ref) =>
        dependencies.pullRequests.replyToThread({
          ...ref,
          threadId: safe.threadId,
          body: safe.body,
        }),
      ),
      setThreadResolution: writeOp("setThreadResolution", threadResolutionInput, (safe, ref) =>
        dependencies.pullRequests.setThreadResolution({
          ...ref,
          threadId: safe.threadId,
          resolved: safe.resolved,
        }),
      ),
      setReaction: writeOp("setReaction", reactionInput, (safe, ref) =>
        dependencies.pullRequests.setReaction({
          ...ref,
          ...(safe.subjectId === undefined ? {} : { subjectId: safe.subjectId }),
          content: safe.content,
          reacted: safe.reacted,
        }),
      ),
      requestReviewers: writeOp("requestReviewers", reviewerRequestInput, (safe, ref) =>
        dependencies.pullRequests.requestReviewers({
          ...ref,
          reviewers: safe.reviewers,
          requested: safe.requested,
        }),
      ),
      setLabels: writeOp("setLabels", labelsInput, (safe, ref) =>
        dependencies.pullRequests.setLabels({
          ...ref,
          labels: safe.labels,
          applied: safe.applied,
        }),
      ),
    }),
  };
}

export const makePrsWriteApiProvider = Effect.fn("PrsWriteApi.make")(function* () {
  const environment = yield* ServerEnvironment;
  return createPrsWriteApiProvider({
    environmentId: yield* environment.getEnvironmentId,
    projects: yield* ProjectionProjectRepository,
    threads: yield* ProjectionThreadRepository,
    pullRequests: yield* PullRequestService,
    prRegistry: yield* PullRequestProviderRegistry,
    projectionSnapshotQuery: yield* ProjectionSnapshotQuery,
  });
});
