import {
  SourceControlProviderKind,
  type PullRequestReviewCapabilities,
  type PullRequestReviewerCapabilities,
} from "@t3tools/contracts";
import {
  providerAuth,
  type SourceControlProviderDiscoverySpec,
} from "@t3tools/source-control-core/server/discovery";
import type { SourceControlDriverInstance } from "@t3tools/source-control-core/server/driver";
import type { PullRequestProviderApi } from "@t3tools/source-control-core/server/PullRequestProvider";
import type * as SourceControlProvider from "@t3tools/source-control-core/server/SourceControlProvider";
import * as Effect from "effect/Effect";

const FULL_REVIEW: PullRequestReviewCapabilities = {
  inlineComment: true,
  reply: true,
  resolve: true,
  verdicts: ["comment", "approve", "request-changes"],
};

const FULL_REVIEWERS: PullRequestReviewerCapabilities = { request: true, listCandidates: true };

const kindOf = (kind: string) => SourceControlProviderKind.make(kind);

/**
 * A pull request provider that can do everything and holds nothing: lists are empty, writes
 * succeed, and reads a test did not supply die.
 */
export function fakePullRequestProvider(
  kind: string,
  overrides: Partial<PullRequestProviderApi> = {},
): PullRequestProviderApi {
  return {
    kind: kindOf(kind),
    capabilities: {
      diff: true,
      comment: true,
      actions: ["merge", "ready", "draft", "close", "reopen"],
      mergeMethods: ["merge"],
      search: true,
      reactions: true,
      review: FULL_REVIEW,
      reviewers: FULL_REVIEWERS,
      edit: { changeRequest: true, comment: true },
    },
    getViewer: () => Effect.succeed("bilal"),
    getViewerPermissions: () =>
      Effect.succeed({
        actions: ["merge", "ready", "draft", "close", "reopen"],
        comment: true,
        resolve: true,
        verdicts: ["comment", "approve", "request-changes"],
        requestReviewers: true,
      }),
    listChangeRequests: () => Effect.succeed({ items: [], truncated: false, continues: true }),
    getChangeRequest: () => Effect.die("unused"),
    getChangeRequestActivity: () => Effect.die("unused"),
    getDiff: () => Effect.die("unused"),
    runAction: () => Effect.void,
    updateChangeRequest: () => Effect.void,
    comment: () => Effect.void,
    updateComment: () => Effect.void,
    submitReview: () => Effect.void,
    replyToThread: () => Effect.void,
    setThreadResolution: () => Effect.void,
    setReaction: () => Effect.void,
    listReviewerCandidates: () => Effect.succeed({ candidates: [], truncated: false }),
    setReviewerRequest: () => Effect.void,
    ...overrides,
  };
}

type SourceControlProviderService = SourceControlProvider.SourceControlProvider["Service"];

const unexpected = (kind: string, operation: string) => () =>
  Effect.die(`Unexpected ${kind} ${operation} in a test that supplied none.`);

/** A source control provider whose every operation dies unless the test supplies it. */
export function fakeSourceControlProvider(
  kind: string,
  overrides: Partial<SourceControlProviderService> = {},
): SourceControlProviderService {
  return {
    kind: kindOf(kind),
    listChangeRequests: unexpected(kind, "listChangeRequests"),
    getChangeRequest: unexpected(kind, "getChangeRequest"),
    createChangeRequest: unexpected(kind, "createChangeRequest"),
    getRepositoryCloneUrls: unexpected(kind, "getRepositoryCloneUrls"),
    createRepository: unexpected(kind, "createRepository"),
    getDefaultBranch: unexpected(kind, "getDefaultBranch"),
    checkoutChangeRequest: unexpected(kind, "checkoutChangeRequest"),
    ...overrides,
  };
}

/** Discovery over an API integration that reports an unknown sign-in. */
export function fakeDiscovery(
  kind: string,
  overrides: Partial<Extract<SourceControlProviderDiscoverySpec, { readonly type: "api" }>> = {},
): SourceControlProviderDiscoverySpec {
  return {
    type: "api",
    kind: kindOf(kind),
    label: kind,
    installHint: `Install ${kind}.`,
    probeAuth: Effect.succeed(providerAuth({ status: "unknown" })),
    ...overrides,
  };
}

export interface FakeSourceControlDriverOptions {
  readonly sourceControl?: Partial<SourceControlProviderService>;
  /** Null for a host whose pull requests this build cannot read. */
  readonly pullRequests?: Partial<PullRequestProviderApi> | null;
  readonly discovery?: SourceControlProviderDiscoverySpec;
  readonly fetchMedia?: SourceControlDriverInstance["fetchMedia"];
}

/** A driver instance for a host named `kind` that needs none of the server's services. */
export function fakeSourceControlDriverInstance(
  kind: string,
  options: FakeSourceControlDriverOptions = {},
): SourceControlDriverInstance {
  return {
    sourceControl: fakeSourceControlProvider(kind, options.sourceControl),
    discovery: options.discovery ?? fakeDiscovery(kind),
    pullRequests:
      options.pullRequests === null ? null : fakePullRequestProvider(kind, options.pullRequests),
    ...(options.fetchMedia === undefined ? {} : { fetchMedia: options.fetchMedia }),
  };
}
