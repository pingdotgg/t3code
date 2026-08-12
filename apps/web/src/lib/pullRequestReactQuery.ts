import type {
  EnvironmentId,
  PullRequestActionInput,
  PullRequestActivity,
  PullRequestCommentInput,
  PullRequestDetail,
  PullRequestDiffInput,
  PullRequestDiffResult,
  PullRequestInvalidateInput,
  PullRequestListInput,
  PullRequestListStatsInput,
  PullRequestListStatsResult,
  PullRequestRef,
  PullRequestReviewerCandidateList,
  PullRequestReviewerRequestInput,
  PullRequestSubmitReviewInput,
  PullRequestThreadReplyInput,
  PullRequestThreadResolutionInput,
} from "@t3tools/contracts";
import { PullRequestDiffResult as PullRequestDiffResultSchema } from "@t3tools/contracts";
import {
  infiniteQueryOptions,
  mutationOptions,
  queryOptions,
  type QueryClient,
} from "@tanstack/react-query";
import * as Schema from "effect/Schema";

import { ensureEnvironmentApi } from "../environmentApi";
import {
  readSavedEnvironmentBearerToken,
  resolveEnvironmentHttpUrl,
} from "../environments/runtime";

const PULL_REQUEST_STALE_TIME_MS = 30_000;
const decodePullRequestDiff = Schema.decodeUnknownPromise(PullRequestDiffResultSchema);

export const pullRequestQueryKeys = {
  all: ["pull-requests"] as const,
  environment: (environmentId: EnvironmentId | null) =>
    ["pull-requests", environmentId ?? null] as const,
  list: (environmentId: EnvironmentId | null, input: PullRequestListInput) =>
    [
      "pull-requests",
      environmentId ?? null,
      "list",
      input.state,
      input.involvement ?? "all",
      input.projectId ?? null,
      input.host ?? null,
      input.query ?? null,
      input.limit ?? null,
      input.cursors ?? null,
    ] as const,
  listStats: (environmentId: EnvironmentId | null, input: PullRequestListStatsInput) =>
    [
      "pull-requests",
      environmentId ?? null,
      "list-stats",
      input.refs.map((reference) => [reference.projectId, reference.repository, reference.number]),
    ] as const,
  detail: (environmentId: EnvironmentId | null, reference: PullRequestRef) =>
    [
      "pull-requests",
      environmentId ?? null,
      "detail",
      reference.projectId,
      reference.repository,
      reference.number,
    ] as const,
  activity: (environmentId: EnvironmentId | null, reference: PullRequestRef) =>
    [
      "pull-requests",
      environmentId ?? null,
      "activity",
      reference.projectId,
      reference.repository,
      reference.number,
    ] as const,
  diffInfinite: (
    environmentId: EnvironmentId | null,
    input: Omit<PullRequestDiffInput, "cursor">,
  ) =>
    [
      "pull-requests",
      environmentId ?? null,
      "diff-infinite",
      input.projectId,
      input.repository,
      input.number,
      input.commit ?? null,
    ] as const,
  reviewerCandidates: (environmentId: EnvironmentId | null, reference: PullRequestRef) =>
    [
      "pull-requests",
      environmentId ?? null,
      "reviewer-candidates",
      reference.projectId,
      reference.repository,
      reference.number,
    ] as const,
};

export const pullRequestMutationKeys = {
  runAction: (environmentId: EnvironmentId | null) =>
    ["pull-requests", "mutation", environmentId ?? null, "action"] as const,
  comment: (environmentId: EnvironmentId | null) =>
    ["pull-requests", "mutation", environmentId ?? null, "comment"] as const,
  submitReview: (environmentId: EnvironmentId | null) =>
    ["pull-requests", "mutation", environmentId ?? null, "submit-review"] as const,
  replyToThread: (environmentId: EnvironmentId | null) =>
    ["pull-requests", "mutation", environmentId ?? null, "reply"] as const,
  setThreadResolution: (environmentId: EnvironmentId | null) =>
    ["pull-requests", "mutation", environmentId ?? null, "thread-resolution"] as const,
  requestReviewers: (environmentId: EnvironmentId | null) =>
    ["pull-requests", "mutation", environmentId ?? null, "request-reviewers"] as const,
  invalidate: (environmentId: EnvironmentId | null) =>
    ["pull-requests", "mutation", environmentId ?? null, "invalidate"] as const,
};

function requirePullRequestApi(environmentId: EnvironmentId | null) {
  if (!environmentId) {
    throw new Error("Pull requests are unavailable.");
  }
  return ensureEnvironmentApi(environmentId).pullRequests;
}

export function pullRequestListInfiniteQueryOptions(input: {
  readonly environmentId: EnvironmentId | null;
  readonly request: Omit<PullRequestListInput, "cursors">;
  readonly enabled?: boolean;
}) {
  type ListPageParam = {
    readonly kind: "cursors";
    readonly cursors: PullRequestListInput["cursors"];
  } | null;

  return infiniteQueryOptions({
    queryKey: pullRequestQueryKeys.list(input.environmentId, input.request),
    initialPageParam: null as ListPageParam,
    queryFn: ({ pageParam }) =>
      requirePullRequestApi(input.environmentId).list({
        ...input.request,
        ...(pageParam?.kind === "cursors" ? { cursors: pageParam.cursors } : {}),
      }),
    getNextPageParam: (lastPage) => {
      if (Object.keys(lastPage.nextCursors).length > 0) {
        return { kind: "cursors", cursors: lastPage.nextCursors } as const;
      }
      return undefined;
    },
    enabled: input.environmentId !== null && (input.enabled ?? true),
    staleTime: PULL_REQUEST_STALE_TIME_MS,
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
  });
}

export function pullRequestListStatsQueryOptions(input: {
  readonly environmentId: EnvironmentId | null;
  readonly request: PullRequestListStatsInput;
  readonly enabled?: boolean;
}) {
  return queryOptions<PullRequestListStatsResult>({
    queryKey: pullRequestQueryKeys.listStats(input.environmentId, input.request),
    queryFn: () => requirePullRequestApi(input.environmentId).listStats(input.request),
    enabled:
      input.environmentId !== null && input.request.refs.length > 0 && (input.enabled ?? true),
    staleTime: PULL_REQUEST_STALE_TIME_MS,
  });
}

export function pullRequestDetailQueryOptions(input: {
  readonly environmentId: EnvironmentId | null;
  readonly reference: PullRequestRef;
  readonly enabled?: boolean;
}) {
  return queryOptions<PullRequestDetail>({
    queryKey: pullRequestQueryKeys.detail(input.environmentId, input.reference),
    queryFn: () => requirePullRequestApi(input.environmentId).detail(input.reference),
    enabled: input.environmentId !== null && (input.enabled ?? true),
    staleTime: PULL_REQUEST_STALE_TIME_MS,
  });
}

export function pullRequestActivityQueryOptions(input: {
  readonly environmentId: EnvironmentId | null;
  readonly reference: PullRequestRef;
  readonly enabled?: boolean;
}) {
  return queryOptions<PullRequestActivity>({
    queryKey: pullRequestQueryKeys.activity(input.environmentId, input.reference),
    queryFn: () => requirePullRequestApi(input.environmentId).activity(input.reference),
    enabled: input.environmentId !== null && (input.enabled ?? true),
    staleTime: PULL_REQUEST_STALE_TIME_MS,
  });
}

async function pullRequestHttpError(response: Response): Promise<Error> {
  const text = await response.text();
  if (!text) {
    return new Error(`Unable to load pull request diff (${response.status}).`);
  }
  try {
    const parsed = JSON.parse(text) as { readonly message?: unknown; readonly error?: unknown };
    if (typeof parsed.message === "string") {
      return new Error(parsed.message);
    }
    if (typeof parsed.error === "string") {
      return new Error(parsed.error);
    }
  } catch {
    // Keep the host response below when it is not JSON.
  }
  return new Error(text);
}

export async function fetchPullRequestDiff(input: {
  readonly environmentId: EnvironmentId;
  readonly request: PullRequestDiffInput;
}): Promise<PullRequestDiffResult> {
  const bearerToken = await readSavedEnvironmentBearerToken(input.environmentId).catch(() => null);
  const response = await fetch(
    resolveEnvironmentHttpUrl({
      environmentId: input.environmentId,
      pathname: "/api/pull-requests/diff",
    }),
    {
      method: "POST",
      credentials: "include",
      headers: {
        "content-type": "application/json",
        ...(bearerToken ? { authorization: `Bearer ${bearerToken}` } : {}),
      },
      body: JSON.stringify(input.request),
    },
  );
  if (!response.ok) {
    throw await pullRequestHttpError(response);
  }
  return decodePullRequestDiff(await response.json());
}

export function pullRequestDiffInfiniteQueryOptions(input: {
  readonly environmentId: EnvironmentId | null;
  readonly request: Omit<PullRequestDiffInput, "cursor">;
  readonly enabled?: boolean;
}) {
  return infiniteQueryOptions({
    queryKey: pullRequestQueryKeys.diffInfinite(input.environmentId, input.request),
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) => {
      if (!input.environmentId) {
        throw new Error("Pull request diffs are unavailable.");
      }
      return fetchPullRequestDiff({
        environmentId: input.environmentId,
        request: {
          ...input.request,
          ...(pageParam ? { cursor: pageParam } : {}),
        },
      });
    },
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    enabled: input.environmentId !== null && (input.enabled ?? true),
    staleTime: PULL_REQUEST_STALE_TIME_MS,
  });
}

export function pullRequestReviewerCandidatesQueryOptions(input: {
  readonly environmentId: EnvironmentId | null;
  readonly reference: PullRequestRef;
  readonly enabled?: boolean;
}) {
  return queryOptions<PullRequestReviewerCandidateList>({
    queryKey: pullRequestQueryKeys.reviewerCandidates(input.environmentId, input.reference),
    queryFn: () => requirePullRequestApi(input.environmentId).reviewerCandidates(input.reference),
    enabled: input.environmentId !== null && (input.enabled ?? true),
    staleTime: PULL_REQUEST_STALE_TIME_MS,
  });
}

export function invalidatePullRequestQueries(
  queryClient: QueryClient,
  environmentId: EnvironmentId | null,
  reference: PullRequestRef,
  options: {
    readonly includeDiff?: boolean;
    readonly includeListings?: boolean;
  } = {},
) {
  const invalidations = [
    queryClient.invalidateQueries({
      queryKey: pullRequestQueryKeys.detail(environmentId, reference),
    }),
    queryClient.invalidateQueries({
      queryKey: pullRequestQueryKeys.activity(environmentId, reference),
    }),
    queryClient.invalidateQueries({
      queryKey: pullRequestQueryKeys.reviewerCandidates(environmentId, reference),
    }),
  ];
  if (options.includeDiff) {
    invalidations.push(
      queryClient.invalidateQueries({
        queryKey: [
          ...pullRequestQueryKeys.environment(environmentId),
          "diff",
          reference.projectId,
          reference.repository,
          reference.number,
        ],
      }),
      queryClient.invalidateQueries({
        queryKey: [
          ...pullRequestQueryKeys.environment(environmentId),
          "diff-infinite",
          reference.projectId,
          reference.repository,
          reference.number,
        ],
      }),
    );
  }
  if (options.includeListings) {
    invalidations.push(
      queryClient.invalidateQueries({
        queryKey: [...pullRequestQueryKeys.environment(environmentId), "list"],
      }),
      queryClient.invalidateQueries({
        queryKey: [...pullRequestQueryKeys.environment(environmentId), "list-stats"],
      }),
    );
  }
  return Promise.all(invalidations);
}

function pullRequestMutationOptions<TInput extends PullRequestRef>(input: {
  readonly environmentId: EnvironmentId | null;
  readonly queryClient: QueryClient;
  readonly mutationKey: readonly unknown[];
  readonly mutationFn: (
    api: ReturnType<typeof requirePullRequestApi>,
    value: TInput,
  ) => Promise<void>;
  readonly invalidation?: {
    readonly includeDiff?: boolean;
    readonly includeListings?: boolean;
  };
}) {
  return mutationOptions({
    mutationKey: input.mutationKey,
    mutationFn: (value: TInput) =>
      input.mutationFn(requirePullRequestApi(input.environmentId), value),
    onSuccess: (_result, value) =>
      invalidatePullRequestQueries(input.queryClient, input.environmentId, value, {
        ...(input.invalidation?.includeDiff ? { includeDiff: true } : {}),
        ...(input.invalidation?.includeListings ? { includeListings: true } : {}),
      }),
  });
}

export function pullRequestRunActionMutationOptions(input: {
  readonly environmentId: EnvironmentId | null;
  readonly queryClient: QueryClient;
}) {
  return pullRequestMutationOptions<PullRequestActionInput>({
    ...input,
    mutationKey: pullRequestMutationKeys.runAction(input.environmentId),
    mutationFn: (api, value) => api.runAction(value),
    invalidation: { includeListings: true },
  });
}

export function pullRequestCommentMutationOptions(input: {
  readonly environmentId: EnvironmentId | null;
  readonly queryClient: QueryClient;
}) {
  return pullRequestMutationOptions<PullRequestCommentInput>({
    ...input,
    mutationKey: pullRequestMutationKeys.comment(input.environmentId),
    mutationFn: (api, value) => api.comment(value),
  });
}

export function pullRequestSubmitReviewMutationOptions(input: {
  readonly environmentId: EnvironmentId | null;
  readonly queryClient: QueryClient;
}) {
  return pullRequestMutationOptions<PullRequestSubmitReviewInput>({
    ...input,
    mutationKey: pullRequestMutationKeys.submitReview(input.environmentId),
    mutationFn: (api, value) => api.submitReview(value),
  });
}

export function pullRequestReplyToThreadMutationOptions(input: {
  readonly environmentId: EnvironmentId | null;
  readonly queryClient: QueryClient;
}) {
  return pullRequestMutationOptions<PullRequestThreadReplyInput>({
    ...input,
    mutationKey: pullRequestMutationKeys.replyToThread(input.environmentId),
    mutationFn: (api, value) => api.replyToThread(value),
  });
}

export function pullRequestSetThreadResolutionMutationOptions(input: {
  readonly environmentId: EnvironmentId | null;
  readonly queryClient: QueryClient;
}) {
  return pullRequestMutationOptions<PullRequestThreadResolutionInput>({
    ...input,
    mutationKey: pullRequestMutationKeys.setThreadResolution(input.environmentId),
    mutationFn: (api, value) => api.setThreadResolution(value),
  });
}

export function pullRequestRequestReviewersMutationOptions(input: {
  readonly environmentId: EnvironmentId | null;
  readonly queryClient: QueryClient;
}) {
  return pullRequestMutationOptions<PullRequestReviewerRequestInput>({
    ...input,
    mutationKey: pullRequestMutationKeys.requestReviewers(input.environmentId),
    mutationFn: (api, value) => api.requestReviewers(value),
  });
}

export function pullRequestInvalidateMutationOptions(input: {
  readonly environmentId: EnvironmentId | null;
  readonly queryClient: QueryClient;
}) {
  return mutationOptions({
    mutationKey: pullRequestMutationKeys.invalidate(input.environmentId),
    mutationFn: (value: PullRequestInvalidateInput) =>
      requirePullRequestApi(input.environmentId).invalidate(value),
    onSuccess: (_result, value) => {
      if (value.reference) {
        return invalidatePullRequestQueries(
          input.queryClient,
          input.environmentId,
          value.reference,
          {
            includeDiff: true,
          },
        );
      }
      return Promise.all([
        input.queryClient.invalidateQueries({
          queryKey: [...pullRequestQueryKeys.environment(input.environmentId), "list"],
        }),
        input.queryClient.invalidateQueries({
          queryKey: [...pullRequestQueryKeys.environment(input.environmentId), "list-stats"],
        }),
      ]);
    },
  });
}
