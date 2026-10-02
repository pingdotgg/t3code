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
    readonly reject: (error: unknown) => void;
  }> = [];
  const listMock = vi.fn(
    (input: { readonly query?: string; readonly cursors?: Record<string, string> }) =>
      new Promise<PullRequestListResult>((resolve, reject) => {
        pendingCalls.push({ input, resolve, reject });
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
  errors: PullRequestListResult["errors"] = [],
): PullRequestListResult {
  return {
    viewers: {},
    providers: [],
    entries: numbers.map((number) => entry(number)),
    errors,
    truncated: Object.keys(nextCursors).length > 0,
    nextCursors,
  };
}

const CURSORS_A = { "github.com owner/repo": "cursor-a1" };
const CURSORS_A2 = { "github.com owner/repo": "cursor-a2" };
const CURSORS_B = { "github.com owner/repo": "cursor-b1" };

type HookResult = ReturnType<typeof useProgressivePullRequestLists>;

function captureResult() {
  const ref: { current: HookResult | null } = { current: null };
  return {
    ref,
    onResult: (result: HookResult) => {
      ref.current = result;
    },
  };
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 200));
}

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

  it("suspends automatic pagination after a continuation failure until explicit retry", async () => {
    pendingCalls.length = 0;
    listMock.mockClear();
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const captured = captureResult();
    await render(
      <Harness
        initialRequest={{ ...REQUEST_A }}
        queryClient={queryClient}
        onResult={captured.onResult}
      />,
    );

    await waitForCalls(1);
    pendingCalls[0]?.resolve(page([1], CURSORS_A));
    await waitForEntries("1");
    await waitForCalls(2);
    pendingCalls[1]?.reject(new Error("disconnected"));

    // Automatic pagination must not loop on the same cursor: no new calls
    // settle, and the environment reports the failure.
    await settle();
    expect(pendingCalls).toHaveLength(2);
    await vi.waitFor(() => {
      if (captured.ref.current?.envStates[0]?.error == null) {
        throw new Error("Expected the environment to report the continuation failure");
      }
    });

    // An explicit retry resumes exactly once and lands its page.
    captured.ref.current?.fetchMore();
    await waitForCalls(3);
    expect(pendingCalls[2]?.input.cursors).toEqual(CURSORS_A);
    pendingCalls[2]?.resolve(page([2]));
    await waitForEntries("1,2");
    await settle();
    expect(pendingCalls).toHaveLength(3);
  });

  it("aggregates repository errors from continuation pages", async () => {
    pendingCalls.length = 0;
    listMock.mockClear();
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const captured = captureResult();
    await render(
      <Harness
        initialRequest={{ ...REQUEST_A }}
        queryClient={queryClient}
        onResult={captured.onResult}
      />,
    );

    await waitForCalls(1);
    pendingCalls[0]?.resolve(page([1], CURSORS_A));
    await waitForEntries("1");
    await waitForCalls(2);
    pendingCalls[1]?.resolve(
      page([2], {}, [
        {
          projectId: ProjectId.make("project-1"),
          projectTitle: "T3 Code",
          message: "t3tools/t3code could not be read.",
        },
      ]),
    );
    await waitForEntries("1,2");

    // The later failure is surfaced like a first-page one instead of
    // reading as a successfully finished pagination.
    await vi.waitFor(() => {
      const errors = captured.ref.current?.errors ?? [];
      if (!errors.some((error) => error.message === "t3tools/t3code could not be read.")) {
        throw new Error("Expected the continuation-page error to be aggregated");
      }
    });
    expect(captured.ref.current?.hasPartialFailure).toBe(true);
  });

  it("rebuilds appended pages when the base query refreshes with new rows", async () => {
    pendingCalls.length = 0;
    listMock.mockClear();
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const captured = captureResult();
    await render(
      <Harness
        initialRequest={{ ...REQUEST_A }}
        queryClient={queryClient}
        onResult={captured.onResult}
      />,
    );

    await waitForCalls(1);
    pendingCalls[0]?.resolve(page([1], CURSORS_A));
    await waitForEntries("1");
    await waitForCalls(2);
    pendingCalls[1]?.resolve(page([2]));
    await waitForEntries("1,2");

    // The base refresh carries changed rows: appended pages drop so the
    // stale #2 cannot linger, and pagination rebuilds from the new base.
    // (Not awaited: the refetch only settles once the mock below resolves.)
    void queryClient.refetchQueries({
      queryKey: pullRequestQueryKeys.list(ENVIRONMENT_A, { ...REQUEST_A }),
      exact: true,
    });
    await waitForCalls(3);
    pendingCalls[2]?.resolve(page([1, 7], CURSORS_A2));
    await waitForEntries("1,7");
    await waitForCalls(4);
    expect(pendingCalls[3]?.input.cursors).toEqual(CURSORS_A2);
    pendingCalls[3]?.resolve(page([8]));
    await waitForEntries("1,7,8");

    // An identical base payload shares structure with the cached one, so a
    // refresh that changed nothing rebuilds nothing.
    void queryClient.refetchQueries({
      queryKey: pullRequestQueryKeys.list(ENVIRONMENT_A, { ...REQUEST_A }),
      exact: true,
    });
    await waitForCalls(5);
    pendingCalls[4]?.resolve(page([1, 7], CURSORS_A2));
    await waitForEntries("1,7,8");
    await settle();
    expect(pendingCalls).toHaveLength(5);
    expect(captured.ref.current?.entries.map((item) => item.number)).toEqual([1, 7, 8]);
  });

  it("keeps a newer continuation's fetching flag when an older one settles", async () => {
    pendingCalls.length = 0;
    listMock.mockClear();
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const captured = captureResult();
    await render(
      <Harness
        initialRequest={{ ...REQUEST_A }}
        queryClient={queryClient}
        onResult={captured.onResult}
      />,
    );

    await waitForCalls(1);
    pendingCalls[0]?.resolve(page([1], CURSORS_A));
    await waitForEntries("1");
    await waitForCalls(2);
    // Move to B while A's continuation is in flight; B's own continuation
    // starts for the same environment once B's first page lands.
    setRequest({ ...REQUEST_B });
    await waitForCalls(3);
    pendingCalls[2]?.resolve(page([9], CURSORS_B));
    await waitForEntries("9");
    await waitForCalls(4);
    expect(pendingCalls[3]?.input.query).toBe("fix");

    // The stale A continuation settles into a discarded generation. Its
    // cleanup must not clear B's in-flight flag, or the auto-fetch loop
    // would start an overlapping duplicate request for B's cursor.
    pendingCalls[1]?.resolve(page([2]));
    await settle();
    expect(pendingCalls).toHaveLength(4);
    expect(entriesText()).toBe("9");
    pendingCalls[3]?.resolve(page([10]));
    await waitForEntries("9,10");
    expect(captured.ref.current?.entries.map((item) => item.number)).toEqual([9, 10]);
  });
});
