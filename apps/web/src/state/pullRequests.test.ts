import type { PullRequestAnswerHandlers } from "@t3tools/client-runtime/state/pull-requests";
import { SourceControlProviderKind } from "@t3tools/contracts";
import {
  EnvironmentId,
  ProjectId,
  type PullRequestDetail,
  type PullRequestListEntry,
  type PullRequestListInput,
  PullRequestUnavailableError,
  PullRequestOperationError,
  type PullRequestListResult,
  type PullRequestRef,
  type PullRequestSummary,
  type RepositoryIdentity,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import { AsyncResult, Atom } from "effect/reactivity";
import { describe, expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";

const listAnswers = vi.hoisted(() => new Map<string, unknown>());
const detailAnswers = vi.hoisted(() => new Map<string, unknown>());
const projectIdentities = vi.hoisted(() => new Map<string, RepositoryIdentity | null>());
const capturedHandlers = vi.hoisted(
  () =>
    ({
      pullRequests: undefined as PullRequestAnswerHandlers | undefined,
      linkedSummary: undefined as
        | ((
            target: { readonly environmentId: EnvironmentId; readonly input: PullRequestRef },
            summary: PullRequestSummary,
            atomRegistry: unknown,
          ) => Effect.Effect<void>)
        | undefined,
    }) as {
      pullRequests: PullRequestAnswerHandlers | undefined;
      linkedSummary:
        | ((
            target: { readonly environmentId: EnvironmentId; readonly input: PullRequestRef },
            summary: PullRequestSummary,
            atomRegistry: unknown,
          ) => Effect.Effect<void>)
        | undefined;
    },
);
const registry = await vi.hoisted(async () =>
  (await import("effect/reactivity")).AtomRegistry.make(),
);

vi.mock("@effect/atom-react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@effect/atom-react")>()),
  useAtomValue: (atom: Atom.Atom<unknown>, select?: (value: unknown) => unknown) => {
    const value = registry.get(atom);
    return select === undefined ? value : select(value);
  },
}));
vi.mock("../rpc/atomRegistry", () => ({ appAtomRegistry: registry }));
vi.mock("./projects", () => ({
  environmentProjects: {
    projectAtom: ({
      environmentId,
      projectId,
    }: {
      readonly environmentId: string;
      readonly projectId: string;
    }) =>
      Atom.make(
        projectIdentities.has(`${environmentId}|${projectId}`)
          ? { repositoryIdentity: projectIdentities.get(`${environmentId}|${projectId}`) ?? null }
          : null,
      ),
  },
}));
vi.mock("@t3tools/client-runtime/state/pull-requests", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@t3tools/client-runtime/state/pull-requests")>();
  return {
    ...actual,
    createLinkedPullRequestSummaryAtomFamily: (
      ...args: Parameters<typeof actual.createLinkedPullRequestSummaryAtomFamily>
    ) => {
      capturedHandlers.linkedSummary = args[2] as typeof capturedHandlers.linkedSummary;
      return actual.createLinkedPullRequestSummaryAtomFamily(...args);
    },
    createPullRequestEnvironmentAtoms: (
      ...args: Parameters<typeof actual.createPullRequestEnvironmentAtoms>
    ) => {
      capturedHandlers.pullRequests = args[1];
      return {
        ...actual.createPullRequestEnvironmentAtoms(...args),
        list: ({ environmentId }: { readonly environmentId: string }) =>
          listAnswers.get(environmentId),
        detail: ({ input }: { readonly input: PullRequestRef }) =>
          detailAnswers.get(`${input.host ?? ""}|${input.repository}|${input.number}`),
      };
    },
  };
});

import {
  newestPullRequestObservation,
  observedPullRequestSummary,
  observedPullRequestTitle,
  observePullRequestChecks,
  observePullRequestMetadata,
  newestPullRequestSummary,
  newestDisplayedPullRequestSummary,
  rememberPullRequestListAnswer,
  restorePullRequestList,
  restoredPullRequestList,
  threadPullRequestLinkToSummary,
  observeFailedPullRequestList,
  usePullRequestDetails,
  usePullRequestList,
  useSharedPullRequestSummary,
} from "./pullRequests";

it("observes both typed list failures without changing their status or replaying cached timestamps", () => {
  const listResult: PullRequestListResult = {
    viewers: {},
    providers: [],
    entries: [],
    errors: [],
    truncated: false,
    nextCursors: {},
  };
  using clock = vi.spyOn(Date, "now").mockReturnValue(100);
  for (const error of [
    new PullRequestUnavailableError({ reason: "cli-unauthenticated", listResult }),
    new PullRequestOperationError({ operation: "list", detail: "HTTP 403", listResult }),
  ]) {
    clock.mockReturnValue(100);
    const failure = AsyncResult.failure<PullRequestListResult, unknown>(Cause.fail(error));
    expect(observeFailedPullRequestList(failure)).toEqual({ value: listResult, observedAt: 100 });
    clock.mockReturnValue(200);
    expect(observeFailedPullRequestList(failure)?.observedAt).toBe(100);
    expect(failure._tag).toBe("Failure");
    expect(observeFailedPullRequestList({ ...failure, waiting: true })).toBeUndefined();
  }
  expect(
    observeFailedPullRequestList(
      AsyncResult.failure(Cause.fail(new PullRequestUnavailableError({ reason: "cli-missing" }))),
    ),
  ).toBeUndefined();
});

function summary(overrides: Partial<PullRequestSummary> = {}): PullRequestSummary {
  return {
    provider: SourceControlProviderKind.make("github"),
    projectId: ProjectId.make("pull-request-cache-test"),
    repository: "acme/widget",
    number: 7,
    title: "Improve widget",
    url: "https://github.com/acme/widget/pull/7",
    state: "open",
    isDraft: false,
    headBranch: "improve-widget",
    baseBranch: "main",
    updatedAt: "2026-09-10T00:00:00Z",
    author: { login: "oliver", name: null, avatarUrl: null },
    mergeability: "mergeable",
    checksState: "passing",
    ...overrides,
  };
}

const observed = (value: PullRequestSummary, observedAt: number) => ({
  summary: value,
  observedAt,
});

describe("pull request summary cache", () => {
  it("orders same-dated snapshots by the server's read time, not by arrival", () => {
    const stale = observed(summary({ observedAt: 200 }), 500);
    const held = observed(
      summary({ mergeability: "conflicting", checksState: "failing", observedAt: 300 }),
      100,
    );
    expect(newestPullRequestObservation(stale, held)?.summary).toMatchObject({
      mergeability: "conflicting",
      checksState: "failing",
      observedAt: 300,
    });
    expect(newestPullRequestObservation(held, stale)).toBe(held);
    expect(newestPullRequestObservation(held, { ...held, observedAt: 900 })).toBe(held);
  });

  it("uses arrival order only when neither snapshot carries a server read time", () => {
    const first = observed(summary(), 100);
    const later = observed(summary({ checksState: "failing" }), 200);
    expect(newestPullRequestObservation(first, later)).toMatchObject({ observedAt: 200 });
    expect(newestPullRequestObservation(later, first)).toBe(later);
    const stamped = observed(summary({ observedAt: 50 }), 1);
    expect(newestPullRequestObservation(later, stamped)?.summary.observedAt).toBe(50);
    expect(newestPullRequestObservation(stamped, later)).toBe(stamped);
  });

  it("keeps known status when a newer snapshot omits it, and clears it when told to", () => {
    const list = observed(summary({ reviewDecision: "approved", observedAt: 100 }), 100);
    const sparse = observed(
      summary({ checksState: undefined, reviewDecision: undefined, observedAt: 200 }),
      200,
    );
    expect(newestPullRequestObservation(list, sparse)?.summary).toMatchObject({
      checksState: "passing",
      reviewDecision: "approved",
    });
    const cleared = observed(summary({ checksState: null, observedAt: 300 }), 300);
    expect(newestPullRequestObservation(list, cleared)?.summary.checksState).toBeNull();
  });

  it("treats merged as final and otherwise prefers the later host update", () => {
    const merged = summary({ state: "merged", updatedAt: "2026-09-01T00:00:00Z" });
    const reopened = summary({ updatedAt: "2026-09-12T00:00:00Z", observedAt: 900 });
    expect(newestPullRequestSummary(merged, reopened)).toBe(merged);
    expect(newestPullRequestSummary(reopened, merged)).toBe(merged);
    const older = summary({ updatedAt: "2026-09-11T00:00:00Z", observedAt: 999 });
    expect(newestPullRequestSummary(older, reopened)).toBe(reopened);
    expect(newestPullRequestSummary(reopened, older)).toBe(reopened);
    const edited = summary({ title: "Accepted title" });
    expect(newestPullRequestSummary(summary(), edited)).toBe(edited);
    const loaded = summary();
    expect(newestDisplayedPullRequestSummary(loaded, false, edited, loaded, [])).toBe(loaded);
    expect(newestDisplayedPullRequestSummary(summary(), true, edited, loaded, [])).toBe(edited);
    const titleEdit = { reference: loaded, title: "Pending title" };
    expect(newestDisplayedPullRequestSummary(loaded, true, null, loaded, [titleEdit])?.title).toBe(
      "Pending title",
    );
  });

  it("reuses saved thread state while detail is stale and lets newer detail replace it", () => {
    const stale = summary();
    const link = {
      host: "github.com",
      repository: stale.repository,
      number: stale.number,
      url: stale.url,
      source: "manual" as const,
      linkedAt: stale.updatedAt,
      stack: null,
      snapshot: {
        ...stale,
        state: "closed" as const,
        isDraft: false,
        updatedAt: "2026-09-11T00:00:00Z",
        syncedAt: "2026-09-12T00:00:00Z",
      },
    };
    const saved = threadPullRequestLinkToSummary(link, stale.projectId);
    expect(newestPullRequestSummary(stale, saved)?.state).toBe("closed");
    const fresh = summary({ isDraft: true, updatedAt: "2026-09-13T00:00:00Z" });
    expect(newestPullRequestSummary(fresh, saved)).toBe(fresh);
    expect(threadPullRequestLinkToSummary({ ...link, snapshot: null }, stale.projectId)).toBeNull();
    expect(
      threadPullRequestLinkToSummary(
        { ...link, snapshot: { ...link.snapshot, updatedAt: null } },
        stale.projectId,
      ),
    ).toBeNull();
  });
});

describe("pull request observations", () => {
  const fromSummary = (value: PullRequestSummary, observedAt: number) =>
    observePullRequestMetadata({ metadata: null, checks: null }, observed(value, observedAt));
  const checksRead = (
    checksState: "passing" | "failing" | "pending" | null,
    readAt: number | undefined,
    observedAt: number,
  ) => ({ checksState, readAt, observedAt });

  it("keeps a newer list's mergeability when a checks read lands after it", () => {
    const detail = summary({
      mergeability: "conflicting",
      checksState: "pending",
      observedAt: 100,
    });
    let state = fromSummary(detail, 1);
    state = observePullRequestMetadata(
      state,
      observed(summary({ mergeability: "mergeable", checksState: "pending", observedAt: 200 }), 2),
    );
    state = observePullRequestChecks(state, checksRead("passing", 300, 3));
    expect(observedPullRequestSummary(state)).toMatchObject({
      mergeability: "mergeable",
      checksState: "passing",
    });
  });

  it("keeps a newer checks read when an older list read lands after it", () => {
    let state = fromSummary(
      summary({ mergeability: "conflicting", checksState: "pending", observedAt: 100 }),
      1,
    );
    state = observePullRequestChecks(state, checksRead("passing", 300, 2));
    state = observePullRequestMetadata(
      state,
      observed(summary({ mergeability: "mergeable", checksState: "pending", observedAt: 250 }), 3),
    );
    expect(observedPullRequestSummary(state)).toMatchObject({
      mergeability: "mergeable",
      checksState: "passing",
    });
  });

  it("lets a newer read's checks replace an older checks read", () => {
    let state = fromSummary(summary({ checksState: "pending", observedAt: 100 }), 1);
    state = observePullRequestChecks(state, checksRead("passing", 300, 2));
    state = observePullRequestMetadata(
      state,
      observed(summary({ checksState: "failing", observedAt: 400 }), 3),
    );
    expect(observedPullRequestSummary(state)?.checksState).toBe("failing");
  });

  it("orders checks by arrival when the server reports no read time", () => {
    let state = fromSummary(summary({ checksState: "pending" }), 1);
    state = observePullRequestChecks(state, checksRead("passing", undefined, 2));
    expect(observedPullRequestSummary(state)?.checksState).toBe("passing");
    state = observePullRequestChecks(state, checksRead("failing", undefined, 1));
    expect(observedPullRequestSummary(state)?.checksState).toBe("passing");
  });

  it("keeps the summary object when a checks reread changes no state", () => {
    let state = fromSummary(summary({ checksState: "pending", observedAt: 100 }), 1);
    state = observePullRequestChecks(state, checksRead("passing", 300, 2));
    const shown = observedPullRequestSummary(state);
    state = observePullRequestChecks(state, checksRead("passing", 300, 3));
    expect(observedPullRequestSummary(state)).toBe(shown);
    state = observePullRequestChecks(state, checksRead("failing", 400, 4));
    expect(observedPullRequestSummary(state)?.checksState).toBe("failing");
  });

  it("shows nothing until some read has described the pull request", () => {
    const state = observePullRequestChecks(
      { metadata: null, checks: null },
      checksRead("failing", 1, 1),
    );
    expect(observedPullRequestSummary(state)).toBeNull();
  });
});

describe("pull request list answers across a reload", () => {
  const makeStorage = () => {
    const held = new Map<string, string>();
    return {
      held,
      getItem: (key: string) => held.get(key) ?? null,
      setItem: (key: string, value: string) => void held.set(key, value),
      removeItem: (key: string) => void held.delete(key),
      key: (index: number) => [...held.keys()][index] ?? null,
      get length() {
        return held.size;
      },
    };
  };
  const listEntry = (number: number, updatedAt = "2026-07-02T00:00:00Z") =>
    ({
      provider: SourceControlProviderKind.make("github"),
      host: "github.com",
      projectId: ProjectId.make("project-1"),
      projectTitle: "t3code",
      repository: "pingdotgg/t3code",
      number,
      title: `Pull request ${number}`,
      url: `https://github.com/pingdotgg/t3code/pull/${number}`,
      author: { login: "octocat", name: null, avatarUrl: null },
      headBranch: `feat/branch-${number}`,
      baseBranch: "main",
      state: "open",
      isDraft: false,
      mergeability: "mergeable",
      additions: 1,
      deletions: 0,
      createdAt: "2026-07-01T00:00:00Z",
      updatedAt,
      viewerReviewRequested: false,
      labels: [],
    }) as PullRequestListEntry;
  const answer = (entries: ReadonlyArray<PullRequestListEntry>, host = "github.com") =>
    ({
      entries,
      viewers: { [host]: "Bilal" },
      providers: [
        {
          host,
          kind: SourceControlProviderKind.make("github"),
          searchesOnHost: true,
          projectCount: 1,
          configured: true,
          detail: null,
        },
      ],
      errors: [{ projectId: ProjectId.make("project-1"), projectTitle: "t3code", message: "boom" }],
      truncated: true,
      nextCursors: { "pingdotgg/t3code": "cursor-1" },
    }) as PullRequestListResult;
  const local = EnvironmentId.make("env-local");
  const remote = EnvironmentId.make("env-remote");
  const input: PullRequestListInput = { state: "open", involvement: "all", limit: 99 };

  it("restores every environment's first page as one merged list without stale failures or cursors", () => {
    const storage = makeStorage();
    rememberPullRequestListAnswer(
      storage,
      { environmentId: local, input },
      answer([listEntry(1, "2026-07-01T00:00:00Z")]),
    );
    rememberPullRequestListAnswer(
      storage,
      { environmentId: remote, input },
      answer([listEntry(2, "2026-07-03T00:00:00Z")], "gitlab.com"),
    );
    const restored = restorePullRequestList(storage, [
      { environmentId: local, input },
      { environmentId: remote, input },
    ]);
    expect(restored?.entries.map((row) => [row.environmentId, row.number])).toEqual([
      [remote, 2],
      [local, 1],
    ]);
    expect(restored?.viewers).toEqual({
      "env-local github.com": "Bilal",
      "env-remote gitlab.com": "Bilal",
    });
    expect(restored?.providers.map((provider) => provider.host)).toEqual([
      "github.com",
      "gitlab.com",
    ]);
    expect(restored?.errors).toEqual([]);
    expect(restored?.nextCursors).toEqual({});
  });

  it("falls back to a fresh read when the browser blocks storage", () => {
    vi.stubGlobal("window", {
      get localStorage(): Storage {
        throw new DOMException("The operation is insecure.", "SecurityError");
      },
    });
    try {
      expect(restoredPullRequestList([{ environmentId: local, input }])).toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("keeps a page of rows and only first-page reads", () => {
    const storage = makeStorage();
    const rows = Array.from({ length: 120 }, (_, index) => listEntry(index + 1));
    rememberPullRequestListAnswer(storage, { environmentId: local, input }, answer(rows));
    const searched = { ...input, query: "fix" };
    rememberPullRequestListAnswer(storage, { environmentId: local, input: searched }, answer(rows));
    const continued = { ...input, cursors: { "pingdotgg/t3code": "cursor-1" } };
    rememberPullRequestListAnswer(
      storage,
      { environmentId: local, input: continued },
      answer(rows),
    );
    expect(
      restorePullRequestList(storage, [{ environmentId: local, input }])?.entries,
    ).toHaveLength(99);
    expect(restorePullRequestList(storage, [{ environmentId: local, input: searched }])).toBeNull();
    expect(
      restorePullRequestList(storage, [{ environmentId: local, input: continued }]),
    ).toBeNull();
  });

  it("restores answers kept under a project assignment for a cold start that has none yet", () => {
    const storage = makeStorage();
    rememberPullRequestListAnswer(
      storage,
      {
        environmentId: local,
        input: { ...input, projectIds: [ProjectId.make("project-1")] },
      },
      answer([listEntry(1)]),
    );
    rememberPullRequestListAnswer(
      storage,
      {
        environmentId: remote,
        input: { ...input, projectIds: [ProjectId.make("project-2")] },
      },
      answer([listEntry(2, "2026-07-03T00:00:00Z")]),
    );
    const restored = restorePullRequestList(storage, [
      { environmentId: local, input },
      { environmentId: remote, input },
    ]);
    expect(restored?.entries.map((row) => [row.environmentId, row.number])).toEqual([
      [remote, 2],
      [local, 1],
    ]);
  });

  it("shows a pull request once when answers from before a reassignment overlap", () => {
    const storage = makeStorage();
    rememberPullRequestListAnswer(
      storage,
      { environmentId: local, input },
      answer([listEntry(1, "2026-07-01T00:00:00Z")]),
    );
    rememberPullRequestListAnswer(
      storage,
      { environmentId: remote, input },
      answer([listEntry(1, "2026-07-03T00:00:00Z")]),
    );
    const restored = restorePullRequestList(storage, [
      { environmentId: local, input },
      { environmentId: remote, input },
    ]);
    expect(restored?.entries.map((row) => [row.environmentId, row.updatedAt])).toEqual([
      [local, "2026-07-01T00:00:00Z"],
    ]);
  });

  it("keeps a shared repository's rows when it moves to an environment that has not answered yet", () => {
    const storage = makeStorage();
    const own = ProjectId.make("project-own");
    const shared = { ...listEntry(2), projectId: ProjectId.make("project-shared") };
    rememberPullRequestListAnswer(
      storage,
      { environmentId: local, input },
      answer([{ ...listEntry(1), projectId: own }, shared]),
    );
    rememberPullRequestListAnswer(
      storage,
      { environmentId: remote, input },
      answer([listEntry(3, "2026-07-03T00:00:00Z")]),
    );
    // The shared repository now belongs to the remote environment, which has not answered yet.
    rememberPullRequestListAnswer(
      storage,
      { environmentId: local, input: { ...input, projectIds: [own] } },
      answer([{ ...listEntry(1), projectId: own }]),
    );
    const restored = restorePullRequestList(storage, [
      { environmentId: local, input },
      { environmentId: remote, input },
    ]);
    expect(restored?.entries.map((row) => row.number).toSorted()).toEqual([1, 2, 3]);
  });

  it("keeps one page per environment when retained rows join a partial answer", () => {
    const storage = makeStorage();
    const own = ProjectId.make("project-own");
    const shared = ProjectId.make("project-shared");
    const rows = (projectId: ProjectId, first: number) =>
      Array.from({ length: 99 }, (_, index) => ({ ...listEntry(first + index), projectId }));
    rememberPullRequestListAnswer(
      storage,
      { environmentId: local, input },
      answer(rows(shared, 1)),
    );
    rememberPullRequestListAnswer(
      storage,
      { environmentId: local, input: { ...input, projectIds: [own] } },
      answer(rows(own, 101)),
    );
    const restored = restorePullRequestList(storage, [{ environmentId: local, input }]);
    expect(restored?.entries).toHaveLength(99);
    expect(restored?.entries.every((row) => row.projectId === own)).toBe(true);
  });

  it("does not keep grown pages", () => {
    const storage = makeStorage();
    const grown = { ...input, limit: 198 };
    rememberPullRequestListAnswer(storage, { environmentId: local, input: grown }, answer([]));
    expect(restorePullRequestList(storage, [{ environmentId: local, input: grown }])).toBeNull();
  });

  it("forgets whole scopes, never one environment of a scope that is kept", () => {
    const storage = makeStorage();
    const scoped = (projectIndex: number) => ({
      ...input,
      projectId: ProjectId.make(`p-${projectIndex}`),
    });
    for (let projectIndex = 0; projectIndex < 9; projectIndex++) {
      for (const [offset, environmentId] of [local, remote].entries()) {
        rememberPullRequestListAnswer(
          storage,
          { environmentId, input: scoped(projectIndex) },
          answer([listEntry(projectIndex * 2 + offset + 1, `2026-07-0${2 - offset}T00:00:00Z`)]),
        );
      }
    }
    const restore = (projectIndex: number) =>
      restorePullRequestList(storage, [
        { environmentId: local, input: scoped(projectIndex) },
        { environmentId: remote, input: scoped(projectIndex) },
      ]);
    expect(restore(0)).toBeNull();
    for (let projectIndex = 1; projectIndex < 9; projectIndex++) {
      expect(restore(projectIndex)?.entries.map((row) => row.environmentId)).toEqual([
        local,
        remote,
      ]);
    }
  });

  it("names the environment whose list failed while the others' rows still show", () => {
    listAnswers.set(local, Atom.make(AsyncResult.success(answer([listEntry(1)]))));
    listAnswers.set(
      remote,
      Atom.make(
        AsyncResult.failure(
          Cause.fail(
            new Error("Relay could not reach the environment endpoint (endpoint_request_failed)."),
          ),
        ),
      ),
    );

    const view = usePullRequestList([
      { environmentId: local, input },
      { environmentId: remote, input },
    ]);

    expect(view.data?.entries.map((row) => [row.environmentId, row.number])).toEqual([[local, 1]]);
    expect(view.error).toEqual({
      environmentId: remote,
      message: "Relay could not reach the environment endpoint (endpoint_request_failed).",
    });
  });

  it("retries only the environment whose list failed, leaving one still loading to finish", () => {
    const requests: string[] = [];
    const read = (environmentId: string, answer: Effect.Effect<never, string>) =>
      Atom.make(
        Effect.suspend(() => {
          requests.push(environmentId);
          return answer;
        }),
      );
    const slow = EnvironmentId.make("env-slow");
    const failing = EnvironmentId.make("env-failing");
    const reads = [read(slow, Effect.never), read(failing, Effect.fail("Unreachable"))];
    listAnswers.set(slow, reads[0]);
    listAnswers.set(failing, reads[1]);
    const unmounts = reads.map((atom) => registry.mount(atom));
    try {
      const view = usePullRequestList([
        { environmentId: slow, input },
        { environmentId: failing, input },
      ]);
      expect(view).toMatchObject({ isPending: true, error: { environmentId: failing } });

      view.retry();

      expect(requests).toEqual([slow, failing, failing]);
    } finally {
      for (const unmount of unmounts) unmount();
    }
  });

  it("removes the composite snapshots it replaced", () => {
    const storage = makeStorage();
    storage.held.set("t3.pullRequests.list:env-local,env-remote", "{}");
    storage.held.set("t3.pullRequests.list:env-local", "{}");
    storage.held.set("t3.other", "kept");
    rememberPullRequestListAnswer(storage, { environmentId: local, input }, answer([]));
    expect(
      [...storage.held.keys()].filter((key) => key.startsWith("t3.pullRequests.list:")),
    ).toEqual([]);
    expect(storage.held.get("t3.other")).toBe("kept");
  });

  it("surfaces non-not-found detail errors while ignoring repository-local not-found failures", () => {
    const projectId = ProjectId.make("project-1");
    const notFound = new PullRequestOperationError({
      operation: "detail",
      detail: "Pull request not found.",
      reason: "not-found",
    });
    const unauthenticated = new PullRequestUnavailableError({
      reason: "cli-unauthenticated",
    });
    const foundDetail = {
      ...summary({ projectId, repository: "acme/api", number: 25 }),
      capabilities: {
        diff: true,
        comment: true,
        actions: [],
        mergeMethods: [],
        search: true,
        review: { inlineComment: true, reply: true, resolve: true, verdicts: [] },
        reviewers: { request: false, listCandidates: false },
      },
      projectTitle: "Workspace",
      workspaceRoot: "/workspace/acme/api",
      body: "",
      additions: 1,
      deletions: 0,
      changedFiles: 1,
      createdAt: "2026-09-09T00:00:00Z",
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
    } as PullRequestDetail;

    detailAnswers.clear();
    detailAnswers.set(
      "github.com|acme/api|25",
      Atom.make(AsyncResult.failure(Cause.fail(notFound))),
    );
    detailAnswers.set(
      "gitlab.com|acme/api|25",
      Atom.make(AsyncResult.failure(Cause.fail(unauthenticated))),
    );
    const failedView = usePullRequestDetails([
      {
        environmentId: local,
        input: { projectId, host: "github.com", repository: "acme/api", number: 25 },
      },
      {
        environmentId: local,
        input: { projectId, host: "gitlab.com", repository: "acme/api", number: 25 },
      },
    ]);
    expect(failedView.details).toEqual([]);
    expect(failedView.error).toMatchObject({ environmentId: local });

    detailAnswers.set(
      "github.com|acme/api|26",
      Atom.make(AsyncResult.failure(Cause.fail(notFound))),
    );
    detailAnswers.set(
      "gitlab.com|acme/api|26",
      Atom.make(AsyncResult.failure(Cause.fail(notFound))),
    );
    const notFoundView = usePullRequestDetails([
      {
        environmentId: local,
        input: { projectId, host: "github.com", repository: "acme/api", number: 26 },
      },
      {
        environmentId: local,
        input: { projectId, host: "gitlab.com", repository: "acme/api", number: 26 },
      },
    ]);
    expect(notFoundView.details).toEqual([]);
    expect(notFoundView.error).toBeNull();

    detailAnswers.set(
      "github.com|acme/api|27",
      Atom.make(AsyncResult.failure(Cause.fail(notFound))),
    );
    detailAnswers.set(
      "gitlab.com|acme/api|27",
      Atom.make(AsyncResult.success({ ...foundDetail, number: 27 })),
    );
    const foundView = usePullRequestDetails([
      {
        environmentId: local,
        input: { projectId, host: "github.com", repository: "acme/api", number: 27 },
      },
      {
        environmentId: local,
        input: { projectId, host: "gitlab.com", repository: "acme/api", number: 27 },
      },
    ]);
    expect(foundView.details).toEqual([{ ...foundDetail, number: 27 }]);
    expect(foundView.error).toBeNull();
  });
});

describe("pull request observation host isolation", () => {
  const environmentId = EnvironmentId.make("env-host-isolation");
  const listInput: PullRequestListInput = { state: "all", involvement: "all", limit: 50 };

  const makeEntry = (overrides: Partial<PullRequestListEntry>): PullRequestListEntry => ({
    provider: SourceControlProviderKind.make("github"),
    host: "github.com",
    projectId: ProjectId.make("project-tracked"),
    projectTitle: "Workspace",
    repository: "acme/api",
    number: 7,
    title: "Public PR",
    url: "https://github.com/acme/api/pull/7",
    author: { login: "octocat", name: null, avatarUrl: null },
    headBranch: "feat/public",
    baseBranch: "main",
    state: "open",
    isDraft: false,
    mergeability: "mergeable",
    additions: 1,
    deletions: 0,
    createdAt: "2026-09-09T00:00:00Z",
    updatedAt: "2026-09-10T00:00:00Z",
    observedAt: 100,
    viewerReviewRequested: false,
    labels: [],
    checksState: "passing",
    ...overrides,
  });

  const makeDetail = (overrides: Partial<PullRequestDetail>): PullRequestDetail =>
    ({
      ...summary(),
      capabilities: {
        diff: true,
        comment: true,
        actions: [],
        mergeMethods: [],
        search: true,
        review: { inlineComment: true, reply: true, resolve: true, verdicts: [] },
        reviewers: { request: false, listCandidates: false },
      },
      projectTitle: "Workspace",
      workspaceRoot: "/workspace/acme/api",
      body: "",
      additions: 1,
      deletions: 0,
      changedFiles: 1,
      createdAt: "2026-09-09T00:00:00Z",
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
      ...overrides,
    }) as PullRequestDetail;

  it.effect("isolates observations across hosts for same-named tracked-folder repositories", () =>
    Effect.gen(function* () {
      const projectId = ProjectId.make("project-tracked-multi-host");
      projectIdentities.set(`${environmentId}|${projectId}`, null);
      const handlers = capturedHandlers.pullRequests!;
      const linkedSummary = capturedHandlers.linkedSummary!;

      const publicRef: PullRequestRef = {
        projectId,
        host: "github.com",
        repository: "acme/api",
        number: 7,
      };
      const enterpriseRef: PullRequestRef = {
        projectId,
        host: "github.example.com",
        repository: "acme/api",
        number: 7,
      };

      // List writes a merged PR on github.com and an open PR on github.example.com under one project.
      yield* handlers.list!(
        { environmentId, input: listInput },
        {
          viewers: {},
          providers: [],
          entries: [
            makeEntry({
              projectId,
              host: "github.com",
              title: "Public merged PR",
              url: "https://github.com/acme/api/pull/7",
              state: "merged",
              checksState: "passing",
              observedAt: 100,
            }),
            makeEntry({
              projectId,
              host: "github.example.com",
              title: "Enterprise open PR",
              url: "https://github.example.com/acme/api/pull/7",
              state: "open",
              checksState: "pending",
              observedAt: 100,
            }),
          ],
          errors: [],
          truncated: false,
          nextCursors: {},
        },
        registry,
      );

      expect(useSharedPullRequestSummary(environmentId, enterpriseRef)).toMatchObject({
        state: "open",
        title: "Enterprise open PR",
        checksState: "pending",
      });
      expect(useSharedPullRequestSummary(environmentId, publicRef)).toMatchObject({
        state: "merged",
        title: "Public merged PR",
        checksState: "passing",
      });
      // Mixed case and surrounding whitespace share the same normalized host key.
      expect(
        observedPullRequestTitle(registry, environmentId, {
          ...enterpriseRef,
          host: " GitHub.Example.COM ",
        }),
      ).toBe("Enterprise open PR");
      expect(observedPullRequestTitle(registry, environmentId, publicRef)).toBe("Public merged PR");

      // Checks, detail, edits, and linked summaries for one host must not bleed into the other.
      yield* handlers.checks!(
        { environmentId, input: enterpriseRef },
        {
          observedAt: 200,
          state: "open",
          checks: [
            {
              name: "ci",
              status: "failure",
              description: null,
              url: null,
            },
          ],
        },
        registry,
      );
      expect(useSharedPullRequestSummary(environmentId, enterpriseRef)?.checksState).toBe(
        "failing",
      );
      expect(useSharedPullRequestSummary(environmentId, publicRef)?.checksState).toBe("passing");

      yield* handlers.acceptedEdit!(
        { environmentId, input: enterpriseRef },
        { reference: enterpriseRef, title: "Enterprise edited title" },
        registry,
      );
      expect(observedPullRequestTitle(registry, environmentId, enterpriseRef)).toBe(
        "Enterprise edited title",
      );
      expect(observedPullRequestTitle(registry, environmentId, publicRef)).toBe("Public merged PR");

      // A hostless detail/linked summary resolves its host from the answer URL.
      const hostlessRef: PullRequestRef = { projectId, repository: "acme/api", number: 7 };
      yield* handlers.detail!(
        { environmentId, input: hostlessRef },
        makeDetail({
          projectId,
          repository: "acme/api",
          number: 7,
          title: "Enterprise detail title",
          url: "https://github.example.com/acme/api/pull/7",
          state: "open",
          updatedAt: "2026-09-12T00:00:00Z",
          observedAt: 300,
          checks: [{ name: "ci", status: "success", description: null, url: null }],
        }),
        registry,
      );
      expect(useSharedPullRequestSummary(environmentId, enterpriseRef)).toMatchObject({
        state: "open",
        title: "Enterprise detail title",
        checksState: "passing",
      });
      expect(useSharedPullRequestSummary(environmentId, publicRef)?.title).toBe("Public merged PR");

      yield* linkedSummary(
        { environmentId, input: hostlessRef },
        summary({
          projectId,
          repository: "acme/api",
          number: 7,
          title: "Enterprise linked title",
          url: "https://github.example.com/acme/api/pull/7",
          state: "open",
          updatedAt: "2026-09-13T00:00:00Z",
          observedAt: 400,
        }),
        registry,
      );
      expect(observedPullRequestTitle(registry, environmentId, enterpriseRef)).toBe(
        "Enterprise linked title",
      );
      expect(observedPullRequestTitle(registry, environmentId, publicRef)).toBe("Public merged PR");
    }),
  );

  it.effect(
    "resolves hostless references through project repository identity so they share with hostful reads",
    () =>
      Effect.gen(function* () {
        const githubProjectId = ProjectId.make("project-root-github");
        const gitlabProjectId = ProjectId.make("project-root-gitlab");
        projectIdentities.set(`${environmentId}|${githubProjectId}`, {
          canonicalKey: "github.com/acme/api",
          provider: SourceControlProviderKind.make("github"),
          locator: {
            source: "git-remote",
            remoteName: "origin",
            remoteUrl: "https://github.com/acme/api.git",
          },
        });
        projectIdentities.set(`${environmentId}|${gitlabProjectId}`, {
          canonicalKey: "gitlab.example.com/acme/api",
          provider: SourceControlProviderKind.make("gitlab"),
          locator: {
            source: "git-remote",
            remoteName: "origin",
            remoteUrl: "git@gitlab.example.com:acme/api.git",
          },
        });

        const handlers = capturedHandlers.pullRequests!;
        yield* handlers.list!(
          { environmentId, input: listInput },
          {
            viewers: {},
            providers: [],
            entries: [
              makeEntry({
                projectId: githubProjectId,
                host: "github.com",
                title: "GitHub root PR",
                url: "https://github.com/acme/api/pull/7",
                checksState: "pending",
                observedAt: 100,
              }),
              makeEntry({
                provider: SourceControlProviderKind.make("gitlab"),
                projectId: gitlabProjectId,
                host: "gitlab.example.com",
                title: "GitLab root MR",
                url: "https://gitlab.example.com/acme/api/-/merge_requests/7",
                checksState: "pending",
                observedAt: 100,
              }),
            ],
            errors: [],
            truncated: false,
            nextCursors: {},
          },
          registry,
        );

        const hostlessGithubRef: PullRequestRef = {
          projectId: githubProjectId,
          repository: "acme/api",
          number: 7,
        };
        const hostlessGitlabRef: PullRequestRef = {
          projectId: gitlabProjectId,
          repository: "acme/api",
          number: 7,
        };

        expect(useSharedPullRequestSummary(environmentId, hostlessGithubRef)?.title).toBe(
          "GitHub root PR",
        );
        expect(observedPullRequestTitle(registry, environmentId, hostlessGithubRef)).toBe(
          "GitHub root PR",
        );
        expect(useSharedPullRequestSummary(environmentId, hostlessGitlabRef)?.title).toBe(
          "GitLab root MR",
        );

        // Hostless checks and accepted edits land in the same host-qualified entry.
        yield* handlers.checks!(
          { environmentId, input: hostlessGitlabRef },
          {
            observedAt: 200,
            state: "open",
            checks: [{ name: "pipeline", status: "success", description: null, url: null }],
          },
          registry,
        );
        yield* handlers.acceptedEdit!(
          { environmentId, input: hostlessGithubRef },
          { reference: hostlessGithubRef, title: "GitHub edited via hostless ref" },
          registry,
        );

        expect(
          useSharedPullRequestSummary(environmentId, {
            ...hostlessGitlabRef,
            host: "gitlab.example.com",
          })?.checksState,
        ).toBe("passing");
        expect(
          useSharedPullRequestSummary(environmentId, {
            ...hostlessGithubRef,
            host: "github.com",
          })?.title,
        ).toBe("GitHub edited via hostless ref");
      }),
  );
});
