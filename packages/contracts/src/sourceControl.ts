import * as Schema from "effect/Schema";
import * as Effect from "effect/Effect";
import {
  IsoDateTime,
  PositiveInt,
  ProjectId,
  TrimmedNonEmptyString,
  TrimmedString,
} from "./baseSchemas.ts";
import { VcsDriverKind } from "./vcs.ts";

/** Stable user-selected key for a configured GitHub identity. */
export const GitHubAccountId = TrimmedNonEmptyString.check(
  Schema.isMaxLength(64),
  Schema.isPattern(/^[a-zA-Z][a-zA-Z0-9_-]*$/),
).pipe(Schema.brand("GitHubAccountId"));
export type GitHubAccountId = typeof GitHubAccountId.Type;

/** Non-secret account metadata returned to clients and stored in settings.json. */
export const GitHubAccount = Schema.Struct({
  label: TrimmedNonEmptyString,
  login: Schema.optionalKey(TrimmedNonEmptyString),
  host: TrimmedNonEmptyString.pipe(Schema.withDecodingDefault(Effect.succeed("github.com"))),
  tokenConfigured: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
});
export type GitHubAccount = typeof GitHubAccount.Type;

/** Patch-only shape. The token is intercepted by the server and never persisted in this shape. */
export const GitHubAccountPatch = Schema.Struct({
  label: TrimmedNonEmptyString,
  login: Schema.optionalKey(TrimmedNonEmptyString),
  host: Schema.optionalKey(TrimmedNonEmptyString),
  token: Schema.optionalKey(TrimmedString),
});
export type GitHubAccountPatch = typeof GitHubAccountPatch.Type;

const GitHubOAuthFlowId = TrimmedNonEmptyString.check(Schema.isMaxLength(128));

export const GitHubOAuthStartInput = Schema.Struct({
  accountId: GitHubAccountId,
  label: TrimmedNonEmptyString,
  host: TrimmedNonEmptyString.pipe(Schema.withDecodingDefault(Effect.succeed("github.com"))),
});
export type GitHubOAuthStartInput = typeof GitHubOAuthStartInput.Type;

export const GitHubOAuthCancelInput = Schema.Struct({
  accountId: GitHubAccountId,
  flowId: GitHubOAuthFlowId,
});
export type GitHubOAuthCancelInput = typeof GitHubOAuthCancelInput.Type;

export const GitHubOAuthState = Schema.Struct({
  accountId: GitHubAccountId,
  phase: Schema.Literals([
    "idle",
    "starting",
    "waiting",
    "verifying",
    "succeeded",
    "failed",
    "cancelled",
  ]),
  flowId: Schema.NullOr(GitHubOAuthFlowId),
  verificationUrl: Schema.NullOr(Schema.String),
  userCode: Schema.NullOr(TrimmedNonEmptyString),
  account: Schema.NullOr(GitHubAccount),
  message: Schema.NullOr(Schema.String),
});
export type GitHubOAuthState = typeof GitHubOAuthState.Type;

/** Safe GitHub sign-in failure; OAuth codes and credentials never enter this error. */
export class GitHubOAuthError extends Schema.TaggedError<GitHubOAuthError>()("GitHubOAuthError", {
  accountId: GitHubAccountId,
  operation: Schema.String,
  detail: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    return this.detail;
  }
}

export const SourceControlProviderKind = Schema.Literals([
  "github",
  "gitlab",
  "forgejo",
  "azure-devops",
  "bitbucket",
  "unknown",
]);
export type SourceControlProviderKind = typeof SourceControlProviderKind.Type;

export const SourceControlProviderInfo = Schema.Struct({
  kind: SourceControlProviderKind,
  name: TrimmedNonEmptyString,
  baseUrl: Schema.String,
});
export type SourceControlProviderInfo = typeof SourceControlProviderInfo.Type;

export const ChangeRequestState = Schema.Literals(["open", "closed", "merged"]);
export type ChangeRequestState = typeof ChangeRequestState.Type;

export const ChangeRequest = Schema.Struct({
  provider: SourceControlProviderKind,
  number: PositiveInt,
  title: TrimmedNonEmptyString,
  url: Schema.String,
  baseRefName: TrimmedNonEmptyString,
  headRefName: TrimmedNonEmptyString,
  state: ChangeRequestState,
  /** Present when the provider can tell that an open change request is still a draft. */
  isDraft: Schema.optional(Schema.Boolean),
  closedAt: Schema.optional(Schema.NullOr(Schema.String)),
  mergedAt: Schema.optional(Schema.NullOr(Schema.String)),
  updatedAt: Schema.Option(Schema.DateTimeUtc),
  isCrossRepository: Schema.optional(Schema.Boolean),
  headRepositoryNameWithOwner: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  headRepositoryOwnerLogin: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
});
export type ChangeRequest = typeof ChangeRequest.Type;

export const SourceControlPullRequestCheckStatus = Schema.Literals([
  "passing",
  "pending",
  "failing",
  "unknown",
]);
export type SourceControlPullRequestCheckStatus = typeof SourceControlPullRequestCheckStatus.Type;

export const SourceControlPullRequestReviewDecision = Schema.Literals([
  "approved",
  "changes-requested",
  "review-required",
  "none",
]);
export type SourceControlPullRequestReviewDecision =
  typeof SourceControlPullRequestReviewDecision.Type;

export const SourceControlPullRequestMergeState = Schema.Literals([
  "ready",
  "blocked",
  "conflicting",
  "unknown",
]);
export type SourceControlPullRequestMergeState = typeof SourceControlPullRequestMergeState.Type;

const GitHubHeadOid = TrimmedNonEmptyString.check(
  Schema.isMaxLength(40),
  Schema.isPattern(/^[0-9a-f]{40}$/iu),
);

/** Review and merge signals for an open pull request in a registered project. */
export const SourceControlProjectPullRequest = Schema.Struct({
  number: PositiveInt,
  title: TrimmedNonEmptyString,
  url: TrimmedNonEmptyString,
  baseRefName: TrimmedNonEmptyString,
  headRefName: TrimmedNonEmptyString,
  headRefOid: GitHubHeadOid,
  authorLogin: Schema.NullOr(TrimmedNonEmptyString),
  isDraft: Schema.Boolean,
  mergeState: SourceControlPullRequestMergeState,
  reviewDecision: SourceControlPullRequestReviewDecision,
  checkStatus: SourceControlPullRequestCheckStatus,
  canMerge: Schema.Boolean,
  mergeBlockedReason: Schema.NullOr(TrimmedNonEmptyString),
  updatedAt: IsoDateTime,
});
export type SourceControlProjectPullRequest = typeof SourceControlProjectPullRequest.Type;

export const SourceControlProjectPullRequestsInput = Schema.Struct({
  projectId: ProjectId,
});
export type SourceControlProjectPullRequestsInput =
  typeof SourceControlProjectPullRequestsInput.Type;

export const SourceControlProjectPullRequestsResult = Schema.Struct({
  projectId: ProjectId,
  provider: Schema.Literal("github"),
  repository: TrimmedNonEmptyString,
  pullRequests: Schema.Array(SourceControlProjectPullRequest),
});
export type SourceControlProjectPullRequestsResult =
  typeof SourceControlProjectPullRequestsResult.Type;

export const SourceControlPullRequestMergeMethod = Schema.Literals(["squash", "merge", "rebase"]);
export type SourceControlPullRequestMergeMethod = typeof SourceControlPullRequestMergeMethod.Type;

export const SourceControlMergeProjectPullRequestInput = Schema.Struct({
  projectId: ProjectId,
  number: PositiveInt,
  expectedHeadOid: GitHubHeadOid,
  method: SourceControlPullRequestMergeMethod,
});
export type SourceControlMergeProjectPullRequestInput =
  typeof SourceControlMergeProjectPullRequestInput.Type;

export const SourceControlMergeProjectPullRequestResult = Schema.Struct({
  projectId: ProjectId,
  number: PositiveInt,
  method: SourceControlPullRequestMergeMethod,
  submitted: Schema.Boolean,
});
export type SourceControlMergeProjectPullRequestResult =
  typeof SourceControlMergeProjectPullRequestResult.Type;

export const SourceControlRepositoryCloneUrls = Schema.Struct({
  nameWithOwner: TrimmedNonEmptyString,
  url: TrimmedNonEmptyString,
  sshUrl: TrimmedNonEmptyString,
});
export type SourceControlRepositoryCloneUrls = typeof SourceControlRepositoryCloneUrls.Type;

export const SourceControlRepositoryVisibility = Schema.Literals(["private", "public"]);
export type SourceControlRepositoryVisibility = typeof SourceControlRepositoryVisibility.Type;

export const SourceControlCloneProtocol = Schema.Literals(["auto", "ssh", "https"]);
export type SourceControlCloneProtocol = typeof SourceControlCloneProtocol.Type;

export const SourceControlRepositoryInfo = Schema.Struct({
  provider: SourceControlProviderKind,
  nameWithOwner: TrimmedNonEmptyString,
  url: TrimmedNonEmptyString,
  sshUrl: TrimmedNonEmptyString,
});
export type SourceControlRepositoryInfo = typeof SourceControlRepositoryInfo.Type;

export const SourceControlRepositoryLookupInput = Schema.Struct({
  provider: SourceControlProviderKind,
  repository: TrimmedNonEmptyString,
  cwd: Schema.optional(TrimmedNonEmptyString),
});
export type SourceControlRepositoryLookupInput = typeof SourceControlRepositoryLookupInput.Type;

export const SourceControlCloneRepositoryInput = Schema.Struct({
  provider: Schema.optional(SourceControlProviderKind),
  repository: Schema.optional(TrimmedNonEmptyString),
  remoteUrl: Schema.optional(TrimmedNonEmptyString),
  destinationPath: TrimmedNonEmptyString,
  protocol: Schema.optional(SourceControlCloneProtocol),
});
export type SourceControlCloneRepositoryInput = typeof SourceControlCloneRepositoryInput.Type;

export const SourceControlCloneRepositoryResult = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  remoteUrl: TrimmedNonEmptyString,
  repository: Schema.NullOr(SourceControlRepositoryInfo),
});
export type SourceControlCloneRepositoryResult = typeof SourceControlCloneRepositoryResult.Type;

export const SourceControlPublishRepositoryInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  provider: SourceControlProviderKind,
  repository: TrimmedNonEmptyString,
  visibility: SourceControlRepositoryVisibility,
  remoteName: Schema.optional(TrimmedNonEmptyString),
  protocol: Schema.optional(SourceControlCloneProtocol),
});
export type SourceControlPublishRepositoryInput = typeof SourceControlPublishRepositoryInput.Type;

export const SourceControlPublishStatus = Schema.Literals(["pushed", "remote_added"]);
export type SourceControlPublishStatus = typeof SourceControlPublishStatus.Type;

export const SourceControlPublishRepositoryResult = Schema.Struct({
  repository: SourceControlRepositoryInfo,
  remoteName: TrimmedNonEmptyString,
  remoteUrl: TrimmedNonEmptyString,
  branch: TrimmedNonEmptyString,
  upstreamBranch: Schema.optional(TrimmedNonEmptyString),
  status: SourceControlPublishStatus,
});
export type SourceControlPublishRepositoryResult = typeof SourceControlPublishRepositoryResult.Type;

export const SourceControlDiscoveryStatus = Schema.Literals(["available", "missing"]);
export type SourceControlDiscoveryStatus = typeof SourceControlDiscoveryStatus.Type;

export const SourceControlProviderAuthStatus = Schema.Literals([
  "authenticated",
  "unauthenticated",
  "unknown",
]);
export type SourceControlProviderAuthStatus = typeof SourceControlProviderAuthStatus.Type;

export const SourceControlProviderAuth = Schema.Struct({
  status: SourceControlProviderAuthStatus,
  account: Schema.Option(TrimmedNonEmptyString),
  host: Schema.Option(TrimmedNonEmptyString),
  detail: Schema.Option(TrimmedNonEmptyString),
});
export type SourceControlProviderAuth = typeof SourceControlProviderAuth.Type;

const SourceControlDiscoverySharedFields = {
  label: TrimmedNonEmptyString,
  executable: Schema.optional(TrimmedNonEmptyString),
  status: SourceControlDiscoveryStatus,
  version: Schema.Option(TrimmedNonEmptyString),
  installHint: TrimmedNonEmptyString,
  detail: Schema.Option(TrimmedNonEmptyString),
} as const;

export const VcsDiscoveryItem = Schema.Struct({
  kind: VcsDriverKind,
  implemented: Schema.Boolean,
  ...SourceControlDiscoverySharedFields,
});
export type VcsDiscoveryItem = typeof VcsDiscoveryItem.Type;

export const SourceControlProviderDiscoveryItem = Schema.Struct({
  kind: SourceControlProviderKind,
  ...SourceControlDiscoverySharedFields,
  auth: SourceControlProviderAuth,
});
export type SourceControlProviderDiscoveryItem = typeof SourceControlProviderDiscoveryItem.Type;

export const SourceControlDiscoveryResult = Schema.Struct({
  versionControlSystems: Schema.Array(VcsDiscoveryItem),
  sourceControlProviders: Schema.Array(SourceControlProviderDiscoveryItem),
});
export type SourceControlDiscoveryResult = typeof SourceControlDiscoveryResult.Type;

export class SourceControlProviderError extends Schema.TaggedError<SourceControlProviderError>()(
  "SourceControlProviderError",
  {
    provider: SourceControlProviderKind,
    operation: Schema.String,
    cwd: Schema.String,
    command: Schema.optional(Schema.String),
    repository: Schema.optional(Schema.String),
    reference: Schema.optional(Schema.String),
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Source control provider ${this.provider} failed in ${this.operation}: ${this.detail}`;
  }
}

export class SourceControlRepositoryError extends Schema.TaggedError<SourceControlRepositoryError>()(
  "SourceControlRepositoryError",
  {
    provider: SourceControlProviderKind,
    operation: Schema.String,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Source control repository operation ${this.operation} failed for ${this.provider}: ${this.detail}`;
  }
}
