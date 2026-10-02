import "../../index.css";

import { EnvironmentId, ProjectId, type PullRequestListResult } from "@t3tools/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { pullRequestQueryKeys } from "../../lib/pullRequestReactQuery";
import {
  useProgressivePullRequestLists,
  type ProgressiveListRequest,
} from "./useProgressivePullRequestLists";

const { ensureEnvironmentApiMock, listMock, pendingCalls } = vi.hoisted(() => {
  const pendingCalls: Array<{
    readonly input: { readonly query?: string; readonly cursors?: Record<string, string> };
    readonly resolve: (value: PullRequestListResult) => void;
  }> = [];
  const listMock = vi.fn(
    (input: { readonly query?: string; readonly cursors?: Record<string, string> }) =>
      new Promise<PullRequestListResult>((resolve) => {
        pendingCalls.push({ input, resolve });
      }),
  );
  return {
    ensureEnvironmentApiMock: vi.fn(() => ({ pullRequests: { list: listMock } })),
    listMock,
    pendingCalls,
  };
});

vi.mock("../../environmentApi", () => ({
  ensureEnvironmentApi: ensureEnvironmentApiMock,
}));

const ENVIRONMENT_A = EnvironmentId.make("environment-a");

const REQUEST_A = { state: "open", involvement: "all", limit: 50 } as const;
const REQUEST_B = { state: "open", involvement: "all", limit: 50, query: "fix" } as const;

function entry(number: number): PullRequestListResult["entries"][number] {
  return {
    provider: "github",
    host: "github.com",
    projectId: ProjectId.make("project-1"),
    projectTitle: "T3 Code",
    repository: "t3tools/t3code",
    number,
    title: `Pull request ${number}`,
    url: `https://github.com/t3tools/t3code/pull/${number}`,
    author: { login: "octocat", name: "The Octocat", avatarUrl: null },
    headBranch: "feature/pull-requests",
    baseBranch: "main",
    state: "open",
    isDraft: false,
    mergeability: "mergeable",
    additions: 0,
    deletions: 0,
    createdAt: "2026-08-10T00:00:00.000Z",
    updatedAt: "2026-08-10T00:00:00.000Z",
    viewerReviewRequested: false,
    labels: [],
  };
}

function page(
  numbers: readonly number[],
  nextCursors: Record<string, string> = {},
): PullRequestListResult {
  return {
    viewers: {},
    providers: [],
    entries: numbers.map((number) => entry(number)),
    errors: [],
    truncated: Object.keys(nextCursors).length > 0,
    nextCursors,
  };
}

const CURSORS_A = { "github.com owner/repo": "cursor-a1" };

function Harness({
  initialRequest,
  queryClient,
  onResult,
}: {
  readonly initialRequest: ProgressiveListRequest;
  readonly queryClient: QueryClient;
  readonly onResult: (result: ReturnType<typeof useProgressivePullRequestLists>) => void;
}) {
  const [request, setRequest] = useState(initialRequest);
  useEffect(() => {
    (
      window as unknown as { __setPullRequestList?: (value: ProgressiveListRequest) => void }
    ).__setPullRequestList = setRequest;
  }, []);
  return (
    <QueryClientProvider client={queryClient}>
      <Inner request={request} onResult={onResult} />
    </QueryClientProvider>
  );
}

function Inner({
  request,
  onResult,
}: {
  readonly request: ProgressiveListRequest;
  readonly onResult: (result: ReturnType<typeof useProgressivePullRequestLists>) => void;
}) {
  const result = useProgressivePullRequestLists([ENVIRONMENT_A], request);
  useEffect(() => {
    onResult(result);
  });
  return <div data-testid="entries">{result.entries.map((item) => item.number).join(",")}</div>;
}

function entriesText(): string {
  return document.querySelector('[data-testid="entries"]')?.textContent ?? "";
}

async function waitForEntries(expected: string): Promise<void> {
  await vi.waitFor(() => {
    if (entriesText() !== expected) {
      throw new Error(`Expected entries "${expected}" but saw "${entriesText()}"`);
    }
  });
}

async function waitForCalls(count: number): Promise<void> {
  await vi.waitFor(() => {
    if (pendingCalls.length < count) {
      throw new Error(`Expected ${count} list calls but saw ${pendingCalls.length}`);
    }
  });
}

function setRequest(request: ProgressiveListRequest): void {
  const setter = (
    window as unknown as { readonly __setPullRequestList?: (value: ProgressiveListRequest) => void }
  ).__setPullRequestList;
  if (!setter) throw new Error("Harness request setter is not mounted.");
  setter(request);
}

describe("useProgressivePullRequestLists generations", () => {
  it("refetches an old key with its own request, not the newest one", async () => {
    pendingCalls.length = 0;
    listMock.mockClear();
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const latestRef: {
      current: ReturnType<typeof useProgressivePullRequestLists> | null;
    } = { current: null };
    await render(
      <Harness
        initialRequest={{ ...REQUEST_A }}
        queryClient={queryClient}
        onResult={(result) => {
          latestRef.current = result;
        }}
      />,
    );

    // Land A's first page, then move to B and land B's page.
    await waitForCalls(1);
    expect(pendingCalls[0]?.input.query).toBeUndefined();
    pendingCalls[0]?.resolve(page([1]));
    await waitForEntries("1");
    setRequest({ ...REQUEST_B });
    await waitForCalls(2);
    expect(pendingCalls[1]?.input.query).toBe("fix");
    pendingCalls[1]?.resolve(page([9]));
    await waitForEntries("9");

    // Refetch A's key (the retry/window-focus path): it must ask for A's
    // query, not the newest one, or A's cache entry is corrupted. The
    // refetch promise only settles once the mocked fetch below resolves,
    // so it must not be awaited here.
    void queryClient.refetchQueries({
      queryKey: pullRequestQueryKeys.list(ENVIRONMENT_A, { ...REQUEST_A }),
      exact: true,
    });
    await waitForCalls(3);
    expect(pendingCalls[2]?.input.query).toBeUndefined();
    expect(pendingCalls[2]?.input.cursors).toBeUndefined();

    // A's own page lands in A's entry; switching back shows A's rows with
    // no extra fetch and no rows from B.
    pendingCalls[2]?.resolve(page([1]));
    setRequest({ ...REQUEST_A });
    await waitForEntries("1");
    expect(pendingCalls).toHaveLength(3);
    expect(latestRef.current?.entries.map((item) => item.number)).toEqual([1]);
  });

  it("discards a continuation that lands after the request changed", async () => {
    pendingCalls.length = 0;
    listMock.mockClear();
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const latestRef: {
      current: ReturnType<typeof useProgressivePullRequestLists> | null;
    } = { current: null };
    await render(
      <Harness
        initialRequest={{ ...REQUEST_A }}
        queryClient={queryClient}
        onResult={(result) => {
          latestRef.current = result;
        }}
      />,
    );

    // A's first page carries a continuation; the progressive auto-fetch
    // starts it and it stays in flight.
    await waitForCalls(1);
    pendingCalls[0]?.resolve(page([1], CURSORS_A));
    await waitForEntries("1");
    await waitForCalls(2);
    // The continuation was bound to A's request generation.
    expect(pendingCalls[1]?.input.query).toBeUndefined();
    expect(pendingCalls[1]?.input.cursors).toEqual(CURSORS_A);

    // Move to B and land B's page, then land the stale A continuation:
    // it must be discarded instead of mixing #2 into B's rows.
    setRequest({ ...REQUEST_B });
    await waitForCalls(3);
    pendingCalls[2]?.resolve(page([9]));
    await waitForEntries("9");
    pendingCalls[1]?.resolve(page([2]));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(entriesText()).toBe("9");
    expect(pendingCalls).toHaveLength(3);
    expect(latestRef.current?.entries.map((item) => item.number)).toEqual([9]);
  });
});
