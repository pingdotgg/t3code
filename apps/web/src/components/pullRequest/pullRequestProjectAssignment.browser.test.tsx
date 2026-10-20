import "~/index.css";

import type { EnvironmentId, ProjectId, PullRequestListResult } from "@t3tools/contracts";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const fixture = vi.hoisted(() => ({
  search: {
    state: "open",
    involvement: "all",
    sort: "updated",
    environmentId: undefined as string | undefined,
  },
  primaryConfigured: false,
  remoteConfigured: true,
  revision: 1,
  targets: new Set<string>(),
  invalidateWait: undefined as Promise<void> | undefined,
  continuationFails: false,
}));

vi.mock(import("@tanstack/react-router"), async (original) => ({
  ...(await original()),
  createFileRoute: (() => (options: { component: () => ReactNode }) => ({
    options,
    useSearch: () => fixture.search,
    fullPath: "/pull-requests",
  })) as never,
  useNavigate: (() => vi.fn()) as never,
}));
vi.mock(import("../../state/entities"), async (original) => ({
  ...(await original()),
  useProjects: (() =>
    ["env-1", "env-2"].map((environmentId) => ({
      id: `project-${environmentId}`,
      environmentId,
      title: "Widget",
      workspaceRoot: `/srv/${environmentId}/widget`,
      repositoryIdentity: {
        canonicalKey: "bitbucket.org/acme/widget",
        provider: "bitbucket",
        owner: "acme",
        name: "widget",
        locator: { remoteUrl: "https://bitbucket.org/acme/widget.git" },
      },
    }))) as never,
  useAllEnvironmentShellsBootstrapped: () => true,
}));
vi.mock(import("../../state/environments"), async (original) => ({
  ...(await original()),
  useEnvironments: (() => ({
    environments: ["env-1", "env-2"].map((environmentId) => ({
      environmentId,
      label: environmentId === "env-1" ? "Local server" : "Remote server",
      serverConfig: {
        environment: { capabilities: { pullRequests: true }, platform: { machine: "server" } },
      },
    })),
  })) as never,
}));
vi.mock(import("../../state/pullRequests"), async (original) => {
  const actual = await original();
  const { AsyncResult } = await import("effect/reactivity");
  const Cause = await import("effect/Cause");
  const { PullRequestUnavailableError } = await import("@t3tools/contracts");
  const { mergePullRequestLists } = await import("./pullRequestList.logic");
  const cache = new Map<string, ReturnType<typeof actual.usePullRequestList>>();
  const refresh = vi.fn();
  const emptyStats = { stats: null, isPending: false, refresh };
  const noRefreshes: ReadonlyArray<readonly [EnvironmentId, number]> = [];
  return {
    ...actual,
    usePullRequestTurnRefreshes: () => noRefreshes,
    usePullRequestListStats: () => emptyStats,
    usePullRequestList: (targets) => {
      const key = JSON.stringify([fixture.revision, targets]);
      const cached = cache.get(key);
      if (cached) return cached;
      const values: Array<readonly [EnvironmentId, PullRequestListResult]> = [];
      const observations: Array<readonly [EnvironmentId, PullRequestListResult, number]> = [];
      let error: string | null = null;
      for (const { environmentId, input } of targets) {
        fixture.targets.add(environmentId);
        const value = answer(environmentId, input.cursors !== undefined);
        if (value.providers[0]!.configured) {
          values.push([environmentId, value]);
          observations.push([environmentId, value, Date.now()]);
        } else {
          const failure = new PullRequestUnavailableError({
            reason: "cli-unauthenticated",
            provider: "bitbucket" as never,
            listResult: value,
          });
          const observation = actual.observeFailedPullRequestList(
            AsyncResult.failure(Cause.fail(failure)),
          )!;
          observations.push([environmentId, observation.value, observation.observedAt]);
          error ??= failure.message;
        }
      }
      const result = {
        data: mergePullRequestLists(values),
        error,
        isPending: false,
        observations,
        refresh,
      };
      cache.set(key, result);
      return result;
    },
  };
});
vi.mock(import("../../state/use-atom-command"), async () => {
  const { AsyncResult } = await import("effect/reactivity");
  return {
    useAtomCommand: (() => async () => {
      await fixture.invalidateWait;
      fixture.revision++;
      return AsyncResult.success(undefined);
    }) as never,
  };
});
vi.mock(import("../../hooks/useNavigateBack"), () => ({ useEscapeToGoBack: () => undefined }));
vi.mock(import("../../hooks/useSidebarProjectGroups"), () => ({
  useSidebarProjectGroups: () => [],
}));
vi.mock(import("../../hooks/useLiveRefresh"), () => ({ useLiveRefresh: () => undefined }));
vi.mock(import("../ui/sidebar"), async (original) => ({
  ...(await original()),
  SidebarInset: ({ children }: { children?: ReactNode }) => <main>{children}</main>,
}));

import { Route } from "../../routes/_chat.pull-requests";

function answer(environmentId: EnvironmentId, continuation = false): PullRequestListResult {
  const configured =
    environmentId === "env-1"
      ? fixture.primaryConfigured && !(continuation && fixture.continuationFails)
      : fixture.remoteConfigured;
  const projectId = `project-${environmentId}` as ProjectId;
  return {
    viewers: configured ? { "bitbucket.org": "reviewer" } : {},
    providers: [
      {
        host: "bitbucket.org",
        kind: "bitbucket" as never,
        searchesOnHost: false,
        projectCount: 1,
        configured,
        detail: configured ? null : "Bitbucket rejected the configured credentials.",
      },
    ],
    entries: configured
      ? [
          {
            provider: "bitbucket" as never,
            host: "bitbucket.org",
            projectId,
            projectTitle: "Widget",
            repository: "acme/widget",
            number: 42,
            title: "Handle reconnects without dropping pending work",
            url: "https://bitbucket.org/acme/widget/pull-requests/42",
            author: { login: "reviewer", name: null, avatarUrl: null },
            headBranch: "fix/reconnect",
            baseBranch: "main",
            state: "open",
            isDraft: false,
            mergeability: "mergeable",
            additions: 14,
            deletions: 3,
            createdAt: "2026-10-18T09:00:00Z",
            updatedAt: "2026-10-18T10:00:00Z",
            viewerReviewRequested: false,
            labels: [],
          },
        ]
      : [],
    errors: configured
      ? []
      : [{ projectId, projectTitle: "Widget", message: "Credentials rejected" }],
    truncated: configured && fixture.continuationFails && !continuation,
    nextCursors:
      configured && fixture.continuationFails && !continuation
        ? { "bitbucket.org acme/widget": "next-page" }
        : {},
  };
}

let root: Root;
let container: HTMLDivElement;
const View = Route.options.component!;
await View.preload?.();

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  fixture.search.environmentId = undefined;
  vi.spyOn(Date, "now").mockImplementation(() => fixture.revision * 1000);
  fixture.primaryConfigured = false;
  fixture.remoteConfigured = true;
  fixture.revision++;
  fixture.targets.clear();
  fixture.invalidateWait = undefined;
  fixture.continuationFails = false;
  window.localStorage.clear();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

it("shows the shared repository from the server that can read it", async () => {
  await act(async () => root.render(<View />));
  expect(container.textContent).toContain("Handle reconnects without dropping pending work");
  expect(container.textContent).toContain("Remote server");
  expect([...fixture.targets]).toEqual(["env-1", "env-2"]);
});

it("stops falling back when neither server can read the host", async () => {
  fixture.remoteConfigured = false;
  await act(async () => root.render(<View />));
  expect(container.textContent).toContain("Bitbucket rejected");
  expect(container.textContent).not.toContain("Handle reconnects without dropping pending work");
  expect([...fixture.targets]).toEqual(["env-1", "env-2"]);
});

it("retries the preferred server on refresh after its credentials are fixed", async () => {
  await act(async () => root.render(<View />));
  expect(container.textContent).toContain("Remote server");
  fixture.primaryConfigured = true;
  const refresh = container.querySelector<HTMLButtonElement>(
    '[aria-label="Refresh pull requests"]',
  );
  expect(refresh).not.toBeNull();
  await act(async () => refresh!.click());
  expect(container.textContent).toContain("Handle reconnects without dropping pending work");
  expect(container.textContent).toContain("Local server");
  expect(container.textContent).not.toContain("Remote server");
});

it("keeps the setup error visible when a failing server is explicitly selected", async () => {
  fixture.search.environmentId = "env-1";
  await act(async () => root.render(<View />));
  expect(container.textContent).toContain("Bitbucket rejected");
  expect(container.textContent).not.toContain("No pull requests");
  expect([...fixture.targets]).toEqual(["env-1"]);
});

it("falls back when a continuation fails after a successful baseline", async () => {
  fixture.primaryConfigured = true;
  fixture.continuationFails = true;
  await act(async () => root.render(<View />));
  expect(container.textContent).toContain("Local server");
  const loadMore = [...container.querySelectorAll("button")].find((button) =>
    button.textContent?.includes("Load more pull requests"),
  );
  expect(loadMore).toBeDefined();
  vi.mocked(Date.now).mockImplementation(() => (fixture.revision + 1) * 1000);
  await act(async () => loadMore!.click());
  expect(container.textContent).toContain("Remote server");
  expect(container.textContent).toContain("Handle reconnects without dropping pending work");
  expect([...fixture.targets]).toEqual(["env-1", "env-2"]);
});

it("discards a stale baseline failure that arrives while host invalidation is pending", async () => {
  fixture.primaryConfigured = true;
  await act(async () => root.render(<View />));
  expect(container.textContent).toContain("Local server");
  let completeInvalidation!: () => void;
  fixture.invalidateWait = new Promise<void>((resolve) => {
    completeInvalidation = resolve;
  });
  const refresh = container.querySelector<HTMLButtonElement>(
    '[aria-label="Refresh pull requests"]',
  );
  await act(async () => refresh!.click());
  fixture.primaryConfigured = false;
  fixture.revision++;
  await act(async () => root.render(<View />));
  expect(container.textContent).toContain("Remote server");
  fixture.primaryConfigured = true;
  await act(async () => completeInvalidation());
  expect(container.textContent).toContain("Local server");
  expect(container.textContent).not.toContain("Remote server");
});
