import {
  EnvironmentId,
  ProjectId,
  PullRequestOperationError,
  PullRequestUnavailableError,
  SourceControlProviderKind,
  type PullRequestDetail,
  type PullRequestListResult,
  type PullRequestRef,
} from "@t3tools/contracts";
import { RegistryContext } from "@effect/atom-react";
import * as Cause from "effect/Cause";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { act, useLayoutEffect } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  detail: vi.fn(),
}));

vi.mock("./session", () => ({ environmentSession: {} }));
vi.mock("./presentation", () => ({ useEnvironmentPresentation: () => ({}) }));
vi.mock("./pull-requests", () => ({
  composerPullRequests: {
    list: mocks.list,
    detail: mocks.detail,
  },
}));
vi.mock("./projects", () => ({ projectEnvironment: {} }));
vi.mock("./atom-registry", () => ({ appAtomRegistry: {} }));
vi.mock("./orchestration", () => ({ orchestrationEnvironment: {} }));
vi.mock("./vcs", () => ({ vcsEnvironment: {} }));
vi.mock("./threads", () => ({ olderSettledThreads: {}, threadFamilies: {} }));

import { useComposerPullRequestSearch } from "./queries";

const ENV_ID = EnvironmentId.make("env-1");
const PROJECT_ID = ProjectId.make("project-1");
const GITHUB = SourceControlProviderKind.make("github");

function detail(host: string, repository: string, number: number): PullRequestDetail {
  return {
    provider: GITHUB,
    capabilities: {
      diff: true,
      comment: true,
      actions: [],
      mergeMethods: [],
      search: true,
      review: { inlineComment: true, reply: true, resolve: true, verdicts: [] },
      reviewers: { request: false, listCandidates: false },
    },
    projectId: PROJECT_ID,
    projectTitle: "Workspace",
    workspaceRoot: `/workspace/${host}/${repository}`,
    repository,
    number,
    title: `PR ${number} on ${host}`,
    body: "",
    url: `https://${host}/${repository}/pull/${number}`,
    author: null,
    state: "open",
    isDraft: false,
    mergeability: "mergeable",
    additions: 1,
    deletions: 0,
    changedFiles: 1,
    headBranch: `feat/${number}`,
    baseBranch: "main",
    createdAt: "2026-07-01T00:00:00Z",
    updatedAt: "2026-07-02T00:00:00Z",
    mergedAt: null,
    closedAt: null,
    reviewers: [],
    labels: [],
    checks: [],
    mergeCapabilities: { merge: false, squash: false, rebase: false },
    viewerPermissions: {
      actions: [],
      comment: false,
      resolve: false,
      verdicts: [],
      requestReviewers: false,
    },
  };
}

function listResult(
  repositories: NonNullable<PullRequestListResult["repositories"]>,
): PullRequestListResult {
  return {
    viewers: { "github.com": "alice", "gitlab.com": "alice" },
    providers: [
      {
        host: "github.com",
        kind: GITHUB,
        searchesOnHost: true,
        projectCount: repositories.length,
        configured: true,
        detail: null,
      },
    ],
    repositories,
    entries: [],
    errors: [],
    truncated: false,
    nextCursors: {},
  };
}

function setup(input: {
  readonly repository?: string | null;
  readonly hasTrackedFolders?: boolean;
  readonly list: PullRequestListResult;
  readonly detailFor: (ref: PullRequestRef) => AsyncResult.AsyncResult<PullRequestDetail, unknown>;
}) {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
  const registry = AtomRegistry.make();
  const listAtom = Atom.make(AsyncResult.success(input.list));
  const detailAtoms = new Map<
    string,
    Atom.Atom<AsyncResult.AsyncResult<PullRequestDetail, unknown>>
  >();
  const detailRefs: PullRequestRef[] = [];
  mocks.list.mockReset();
  mocks.detail.mockReset();
  mocks.list.mockImplementation(() => listAtom);
  mocks.detail.mockImplementation(({ input: ref }: { input: PullRequestRef }) => {
    const key = JSON.stringify(ref);
    let atom = detailAtoms.get(key);
    if (atom === undefined) {
      detailRefs.push(ref);
      atom = Atom.make(input.detailFor(ref));
      detailAtoms.set(key, atom);
    }
    return atom;
  });

  const root = createRoot(document.createElement("div"));
  let latest: ReturnType<typeof useComposerPullRequestSearch> | null = null;
  function Probe({ query }: { readonly query: string | null }) {
    const value = useComposerPullRequestSearch({
      environmentId: ENV_ID,
      projectId: PROJECT_ID,
      repository: input.repository ?? null,
      hasTrackedFolders: input.hasTrackedFolders ?? true,
      query,
    });
    useLayoutEffect(() => {
      latest = value;
    });
    return null;
  }

  return {
    detailRefs,
    get result() {
      return latest!;
    },
    render(query: string | null) {
      act(() =>
        root.render(
          <RegistryContext.Provider value={registry}>
            <Probe query={query} />
          </RegistryContext.Provider>,
        ),
      );
      act(() => vi.advanceTimersByTime(180));
    },
    [Symbol.dispose]() {
      act(() => root.unmount());
      registry.dispose();
      vi.useRealTimers();
    },
  };
}

it("surfaces exact-lookup auth/transport errors while preserving matches from other repos and ignoring not-found", () => {
  using authFailure = setup({
    list: listResult([
      { host: "github.com", repository: "acme/api" },
      { host: "gitlab.com", repository: "acme/api" },
    ]),
    detailFor: (ref) =>
      ref.host === "github.com"
        ? AsyncResult.failure(
            Cause.fail(new PullRequestUnavailableError({ reason: "cli-unauthenticated" })),
          )
        : AsyncResult.success(detail("gitlab.com", "acme/api", ref.number)),
  });
  authFailure.render("25");
  expect(authFailure.detailRefs).toEqual([
    { projectId: PROJECT_ID, host: "github.com", repository: "acme/api", number: 25 },
    { projectId: PROJECT_ID, host: "gitlab.com", repository: "acme/api", number: 25 },
  ]);
  expect(authFailure.result.error).toBe("This host has no working credentials.");
  expect(authFailure.result.entries.map((entry) => entry.url)).toEqual([
    "https://gitlab.com/acme/api/pull/25",
  ]);

  using notFoundOnly = setup({
    list: listResult([
      { host: "github.com", repository: "acme/api" },
      { host: "gitlab.com", repository: "acme/api" },
    ]),
    detailFor: (ref) =>
      ref.host === "github.com"
        ? AsyncResult.failure(
            Cause.fail(
              new PullRequestOperationError({
                operation: "detail",
                detail: "Pull request not found.",
                reason: "not-found",
              }),
            ),
          )
        : AsyncResult.success(detail("gitlab.com", "acme/api", ref.number)),
  });
  notFoundOnly.render("25");
  expect(notFoundOnly.result.error).toBeNull();
  expect(notFoundOnly.result.entries.map((entry) => entry.url)).toEqual([
    "https://gitlab.com/acme/api/pull/25",
  ]);
});

it("surfaces exact-lookup transport errors when root-repository listing succeeds", () => {
  using transportFailure = setup({
    repository: "acme/api",
    hasTrackedFolders: false,
    list: listResult([]),
    detailFor: () => AsyncResult.failure(Cause.fail(new Error("transport disconnected"))),
  });
  transportFailure.render("25");
  expect(transportFailure.result.error).toBe("transport disconnected");
  expect(transportFailure.result.entries).toEqual([]);
});
