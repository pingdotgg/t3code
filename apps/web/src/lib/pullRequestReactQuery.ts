import type {
  CollaborativeAcceptanceCaseId,
  CollaborativeAcceptancePauseReason,
  CollaborativeAcceptanceStatus,
  EnvironmentId,
  GitHubApiQuotaRefreshInput,
  GitHubApiUsageReport,
  GitHubApiUsageReportInput,
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
  PullRequestMonitorLaunchFallbackInput,
  PullRequestMonitorContextResult,
  PullRequestMonitorStartInput,
  PullRequestMonitorStatusInput,
  PullRequestMonitorStopInput,
  ThreadId,
} from "@t3tools/contracts";
import { PullRequestDiffResult as PullRequestDiffResultSchema } from "@t3tools/contracts";
import {
  infiniteQueryOptions,
  keepPreviousData,
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
  usageReport: (environmentId: EnvironmentId | null, input: GitHubApiUsageReportInput) =>
    [
      "pull-requests",
      environmentId ?? null,
      "usage-report",
      input.window ?? "1h",
      input.host ?? null,
      input.feature ?? null,
      input.query ?? null,
    ] as const,
  monitorStatus: (environmentId: EnvironmentId | null, reference: PullRequestRef) =>
    [
      "pull-requests",
      environmentId ?? null,
      "monitor-status",
      reference.projectId,
      reference.repository,
      reference.number,
    ] as const,
  monitorContext: (environmentId: EnvironmentId | null, reference: PullRequestRef) =>
    [
      "pull-requests",
      environmentId ?? null,
      "monitor-context",
      reference.projectId,
      reference.repository,
      reference.number,
    ] as const,
  collaborativeAcceptanceStatus: (
    environmentId: EnvironmentId | null,
    threadId: ThreadId | null,
    caseId: CollaborativeAcceptanceCaseId | null,
  ) => ["collaborative-acceptance", environmentId ?? null, threadId, caseId] as const,
  collaborativeAcceptanceLookup: (
    environmentId: EnvironmentId | null,
    threadId: ThreadId | null,
    reference: PullRequestRef,
  ) =>
    [
      "collaborative-acceptance",
      environmentId ?? null,
      "pull-request",
      threadId,
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
  quotaRefresh: (environmentId: EnvironmentId | null) =>
    ["pull-requests", "mutation", environmentId ?? null, "quota-refresh"] as const,
  monitorStart: (environmentId: EnvironmentId | null) =>
    ["pull-requests", "mutation", environmentId ?? null, "monitor-start"] as const,
  monitorStop: (environmentId: EnvironmentId | null) =>
    ["pull-requests", "mutation", environmentId ?? null, "monitor-stop"] as const,
  monitorLaunchFallback: (environmentId: EnvironmentId | null) =>
    ["pull-requests", "mutation", environmentId ?? null, "monitor-fallback"] as const,
  collaborativeAcceptance: (environmentId: EnvironmentId | null, action: string) =>
    ["collaborative-acceptance", "mutation", environmentId ?? null, action] as const,
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
    placeholderData: keepPreviousData,
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

/**
 * Warm the detail a row is about to open, so selecting it reads from the cache instead of
 * paying for another round trip. Only the detail: the activity's review-thread walk is
 * paginated and unbounded, while the detail is one consolidated read. React Query dedupes
 * against fresh entries, so rows opened recently cost nothing here.
 */
export function prefetchPullRequestDetail(
  queryClient: QueryClient,
  input: {
    readonly environmentId: EnvironmentId | null;
    readonly reference: PullRequestRef;
  },
): Promise<void> {
  if (input.environmentId === null) return Promise.resolve();
  return queryClient.prefetchQuery(pullRequestDetailQueryOptions(input));
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
  readonly signal?: AbortSignal;
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
      ...(input.signal === undefined ? {} : { signal: input.signal }),
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
    queryFn: ({ pageParam, signal }) => {
      if (!input.environmentId) {
        throw new Error("Pull request diffs are unavailable.");
      }
      return fetchPullRequestDiff({
        environmentId: input.environmentId,
        signal,
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

export function gitHubApiUsageReportQueryOptions(input: {
  readonly environmentId: EnvironmentId | null;
  readonly request: GitHubApiUsageReportInput;
  readonly enabled?: boolean;
}) {
  return queryOptions<GitHubApiUsageReport>({
    queryKey: pullRequestQueryKeys.usageReport(input.environmentId, input.request),
    queryFn: () => requirePullRequestApi(input.environmentId).usageReport(input.request),
    enabled: input.environmentId !== null && (input.enabled ?? true),
    placeholderData: keepPreviousData,
    staleTime: PULL_REQUEST_STALE_TIME_MS,
    refetchOnWindowFocus: true,
  });
}

export function gitHubApiQuotaRefreshMutationOptions(input: {
  readonly environmentId: EnvironmentId | null;
  readonly queryClient: QueryClient;
}) {
  return mutationOptions({
    mutationKey: pullRequestMutationKeys.quotaRefresh(input.environmentId),
    mutationFn: (value: GitHubApiQuotaRefreshInput) =>
      requirePullRequestApi(input.environmentId).quotaRefresh(value),
    onSuccess: () =>
      input.queryClient.invalidateQueries({
        queryKey: [...pullRequestQueryKeys.environment(input.environmentId), "usage-report"],
      }),
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

export function pullRequestMonitorStatusQueryOptions(input: {
  readonly environmentId: EnvironmentId;
  readonly reference: PullRequestRef;
  readonly enabled?: boolean;
}) {
  const statusInput: PullRequestMonitorStatusInput = { reference: input.reference };
  return queryOptions({
    queryKey: pullRequestQueryKeys.monitorStatus(input.environmentId, input.reference),
    staleTime: PULL_REQUEST_STALE_TIME_MS,
    // Server owns monitor truth; keep the strip fresh while the panel is open.
    refetchInterval: 15_000,
    enabled: input.enabled ?? true,
    queryFn: async () => {
      const api = await ensureEnvironmentApi(input.environmentId);
      return api.pullRequestMonitors.status(statusInput);
    },
  });
}

export function pullRequestMonitorContextQueryOptions(input: {
  readonly environmentId: EnvironmentId;
  readonly reference: PullRequestRef;
  readonly enabled?: boolean;
}) {
  return queryOptions<PullRequestMonitorContextResult>({
    queryKey: pullRequestQueryKeys.monitorContext(input.environmentId, input.reference),
    staleTime: PULL_REQUEST_STALE_TIME_MS,
    refetchInterval: 15_000,
    enabled: input.enabled ?? true,
    queryFn: () =>
      ensureEnvironmentApi(input.environmentId).pullRequestMonitors.context({
        reference: input.reference,
        includeClosed: true,
        limit: 20,
      }),
  });
}

export function collaborativeAcceptanceStatusQueryOptions(input: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId | null;
  readonly caseId: CollaborativeAcceptanceCaseId | null;
  readonly enabled?: boolean;
}) {
  return queryOptions({
    queryKey: pullRequestQueryKeys.collaborativeAcceptanceStatus(
      input.environmentId,
      input.threadId,
      input.caseId,
    ),
    staleTime: PULL_REQUEST_STALE_TIME_MS,
    refetchInterval: 15_000,
    enabled: input.enabled ?? true,
    queryFn: () => {
      if (input.threadId === null || input.caseId === null) {
        throw new Error("Collaborative acceptance status is unavailable.");
      }
      return ensureEnvironmentApi(input.environmentId).collaborativeAcceptance.status({
        threadId: input.threadId,
        caseId: input.caseId,
      });
    },
  });
}

export function collaborativeAcceptanceLookupQueryOptions(input: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId | null;
  readonly reference: PullRequestRef;
  readonly enabled?: boolean;
}) {
  return queryOptions({
    queryKey: pullRequestQueryKeys.collaborativeAcceptanceLookup(
      input.environmentId,
      input.threadId,
      input.reference,
    ),
    staleTime: PULL_REQUEST_STALE_TIME_MS,
    refetchInterval: 15_000,
    enabled: input.enabled ?? true,
    queryFn: () => {
      if (input.threadId === null) {
        throw new Error("Collaborative acceptance lookup is unavailable.");
      }
      return ensureEnvironmentApi(
        input.environmentId,
      ).collaborativeAcceptance.resolveForPullRequest({
        threadId: input.threadId,
        pullRequest: input.reference,
      });
    },
  });
}

function collaborativeAcceptanceMutationOptions<TInput>(input: {
  readonly environmentId: EnvironmentId;
  readonly queryClient: QueryClient;
  readonly action: string;
  readonly mutationFn: (value: TInput) => Promise<CollaborativeAcceptanceStatus>;
}) {
  return mutationOptions({
    mutationKey: pullRequestMutationKeys.collaborativeAcceptance(input.environmentId, input.action),
    mutationFn: input.mutationFn,
    onSuccess: async (result) => {
      const record = result.record;
      if (!record) return;
      await input.queryClient.invalidateQueries({
        queryKey: pullRequestQueryKeys.collaborativeAcceptanceStatus(
          input.environmentId,
          record.case.parentThreadId,
          record.case.caseId,
        ),
      });
    },
  });
}

export function collaborativeAcceptancePauseMutationOptions(input: {
  readonly environmentId: EnvironmentId;
  readonly queryClient: QueryClient;
}) {
  return collaborativeAcceptanceMutationOptions<{
    readonly threadId: ThreadId;
    readonly caseId: CollaborativeAcceptanceCaseId;
    readonly reason: CollaborativeAcceptancePauseReason;
  }>({
    ...input,
    action: "pause",
    mutationFn: (value) =>
      ensureEnvironmentApi(input.environmentId).collaborativeAcceptance.pause(value),
  });
}

export function collaborativeAcceptanceResumeMutationOptions(input: {
  readonly environmentId: EnvironmentId;
  readonly queryClient: QueryClient;
}) {
  return collaborativeAcceptanceMutationOptions<{
    readonly threadId: ThreadId;
    readonly caseId: CollaborativeAcceptanceCaseId;
  }>({
    ...input,
    action: "resume",
    mutationFn: (value) =>
      ensureEnvironmentApi(input.environmentId).collaborativeAcceptance.resume(value),
  });
}

export function collaborativeAcceptanceRequestReviewMutationOptions(input: {
  readonly environmentId: EnvironmentId;
  readonly queryClient: QueryClient;
}) {
  return collaborativeAcceptanceMutationOptions<{
    readonly threadId: ThreadId;
    readonly caseId: CollaborativeAcceptanceCaseId;
  }>({
    ...input,
    action: "request-review",
    mutationFn: (value) =>
      ensureEnvironmentApi(input.environmentId).collaborativeAcceptance.requestReview(value),
  });
}

function invalidateMonitorQueries(
  queryClient: QueryClient,
  environmentId: EnvironmentId,
  reference: PullRequestRef,
) {
  return queryClient.invalidateQueries({
    queryKey: pullRequestQueryKeys.monitorStatus(environmentId, reference),
  });
}

export function pullRequestMonitorStartMutationOptions(input: {
  readonly environmentId: EnvironmentId;
  readonly queryClient: QueryClient;
}) {
  return mutationOptions({
    mutationKey: pullRequestMutationKeys.monitorStart(input.environmentId),
    mutationFn: async (payload: PullRequestMonitorStartInput) => {
      const api = await ensureEnvironmentApi(input.environmentId);
      return api.pullRequestMonitors.start(payload);
    },
    onSuccess: async (result) => {
      await invalidateMonitorQueries(input.queryClient, input.environmentId, {
        projectId: result.monitor.projectId,
        repository: result.monitor.repository,
        number: result.monitor.number,
      });
    },
  });
}

export function pullRequestMonitorStopMutationOptions(input: {
  readonly environmentId: EnvironmentId;
  readonly queryClient: QueryClient;
}) {
  return mutationOptions({
    mutationKey: pullRequestMutationKeys.monitorStop(input.environmentId),
    mutationFn: async (payload: PullRequestMonitorStopInput) => {
      const api = await ensureEnvironmentApi(input.environmentId);
      return api.pullRequestMonitors.stop(payload);
    },
    onSuccess: async (result) => {
      await invalidateMonitorQueries(input.queryClient, input.environmentId, {
        projectId: result.monitor.projectId,
        repository: result.monitor.repository,
        number: result.monitor.number,
      });
    },
  });
}

export function pullRequestMonitorLaunchFallbackMutationOptions(input: {
  readonly environmentId: EnvironmentId;
  readonly queryClient: QueryClient;
}) {
  return mutationOptions({
    mutationKey: pullRequestMutationKeys.monitorLaunchFallback(input.environmentId),
    mutationFn: async (payload: PullRequestMonitorLaunchFallbackInput) => {
      const api = await ensureEnvironmentApi(input.environmentId);
      return api.pullRequestMonitors.launchFallback(payload);
    },
    onSuccess: async (result) => {
      await invalidateMonitorQueries(input.queryClient, input.environmentId, {
        projectId: result.monitor.projectId,
        repository: result.monitor.repository,
        number: result.monitor.number,
      });
    },
  });
}
