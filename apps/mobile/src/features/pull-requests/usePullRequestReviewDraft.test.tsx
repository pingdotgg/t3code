import { RegistryContext, useAtomValue } from "@effect/atom-react";
import { Atom, AsyncResult } from "effect/reactivity";
import type { PullRequestDetail } from "@t3tools/contracts";
import { act, useLayoutEffect } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  viewer: "alice",
  detailPending: true,
  strictDetail: null as Atom.Writable<
    AsyncResult.AsyncResult<PullRequestDetail>,
    AsyncResult.AsyncResult<PullRequestDetail>
  > | null,
  cachedDetail: null as Atom.Writable<
    AsyncResult.AsyncResult<PullRequestDetail>,
    AsyncResult.AsyncResult<PullRequestDetail>
  > | null,
  activityLoaded: false,
  activityError: null as string | null,
  write: vi.fn<(file: unknown, body: string) => Promise<void>>(),
  disk: "",
}));
vi.mock("react-native", () => ({
  AppState: { addEventListener: () => ({ remove: () => {} }) },
}));
vi.mock("../../lib/atomic-file", () => ({ writeFileAtomically: mocks.write }));
vi.mock("expo-file-system", () => ({
  Directory: class {
    create() {}
  },
  File: class {
    exists = true;
    text = async () => mocks.disk;
  },
  Paths: { document: "documents" },
}));
vi.mock("./usePullRequestDiff", () => ({
  pullRequestTarget: (params: object) => ({ environmentId: "env", input: params }),
}));
vi.mock("../../state/pull-requests", async () => {
  const { Atom, AsyncResult } = await import("effect/reactivity");
  mocks.strictDetail = Atom.make<AsyncResult.AsyncResult<PullRequestDetail>>(
    AsyncResult.success({ viewer: "alice", headSha: "head" } as PullRequestDetail, {
      waiting: true,
    }),
  );
  mocks.cachedDetail = Atom.make<AsyncResult.AsyncResult<PullRequestDetail>>(
    AsyncResult.success({ viewer: "alice", headSha: "head" } as PullRequestDetail),
  );
  return {
    composerPullRequests: {
      detail: ({ input }: { input: { allowStale?: boolean } }) =>
        input.allowStale === false ? mocks.strictDetail : mocks.cachedDetail,
      activity: () => "activity",
    },
  };
});
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: (query: Atom.Atom<AsyncResult.AsyncResult<PullRequestDetail>> | string) => {
    if (typeof query !== "string") {
      const result = useAtomValue(query);
      return {
        data: result._tag === "Success" ? result.value : null,
        isPending: result.waiting,
        error: null,
        refresh: () => {},
      };
    }
    return {
      data: mocks.activityLoaded ? { reviewThreads: [] } : null,
      isPending: !mocks.activityLoaded,
      error: mocks.activityError,
      refresh: () => {},
    };
  },
}));

import { appAtomRegistry } from "../../state/atom-registry";
import {
  clearSubmittedReview,
  pullRequestReviewKey,
  type ReviewDraft,
} from "./pullRequestReviewDrafts";
import { setReviewDraftBusy, usePullRequestReviewDraft } from "./usePullRequestReviewDraft";

function setup() {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  mocks.viewer = "alice";
  mocks.detailPending = true;
  mocks.activityLoaded = false;
  mocks.activityError = null;
  mocks.write.mockReset().mockImplementation(async (_file, body) => {
    mocks.disk = body;
  });
  const params = {
    environmentId: "env",
    projectId: "project",
    repository: "owner/repo",
    number: 1,
  };
  const legacyKey = pullRequestReviewKey(params);
  mocks.disk = JSON.stringify({
    version: 1,
    drafts: {
      [legacyKey]: { summary: "Earlier private review", comment: "", comments: [] },
      [pullRequestReviewKey(params, "alice")]: {
        summary: "Alice private summary",
        comment: "",
        comments: [],
      },
    },
  });
  const root = createRoot(document.createElement("div"));
  let current: ReturnType<typeof usePullRequestReviewDraft>;
  function Probe() {
    const result = usePullRequestReviewDraft(params);
    useLayoutEffect(() => {
      current = result;
    });
    return null;
  }
  return {
    params,
    legacyKey,
    get current() {
      return current;
    },
    async render() {
      await act(async () => {
        appAtomRegistry.set(
          mocks.strictDetail!,
          AsyncResult.success({ viewer: mocks.viewer, headSha: "head" } as PullRequestDetail, {
            waiting: mocks.detailPending,
          }),
        );
        root.render(
          <RegistryContext value={appAtomRegistry}>
            <Probe />
          </RegistryContext>,
        );
      });
    },
    [Symbol.dispose]() {
      act(() => root.unmount());
    },
  };
}

it("requires explicit ownership recovery and preserves the original until a scoped write succeeds", async () => {
  using screen = setup();
  await screen.render();
  expect(screen.current.ready).toBe(false);
  expect(screen.current.scope.viewer).toBeNull();
  expect(screen.current.draft.summary).toBe("");
  expect(screen.current.comments).toEqual([]);
  expect(screen.current.legacyDraftAvailable).toBe(false);
  const edit = vi.fn((draft: ReviewDraft) => ({ ...draft, summary: "Unowned feedback" }));
  act(() => screen.current.update(edit));
  expect(edit).not.toHaveBeenCalled();
  await act(async () => {
    expect(await screen.current.recoverLegacyDraft()).toBe(false);
  });
  expect(mocks.write).not.toHaveBeenCalled();
  mocks.viewer = "bob";
  mocks.detailPending = false;
  await screen.render();
  expect(screen.current.ready).toBe(true);
  expect(screen.current.scope.viewer).toBe("bob");
  expect(screen.current.draft.summary).toBe("");
  expect(screen.current.legacyDraftAvailable).toBe(true);
  expect(mocks.write).not.toHaveBeenCalled();
  mocks.viewer = "alice";
  await screen.render();
  expect(screen.current.draft.summary).toBe("Alice private summary");
  const staleRecovery = screen.current.recoverLegacyDraft;
  const staleUpdate = screen.current.update;
  mocks.detailPending = true;
  await screen.render();
  act(() => staleUpdate(edit));
  await act(async () => {
    expect(await staleRecovery()).toBe(false);
  });
  expect(edit).not.toHaveBeenCalled();
  expect(mocks.write).not.toHaveBeenCalled();
  mocks.detailPending = false;
  mocks.viewer = "bob";
  await screen.render();
  act(() => staleUpdate(edit));
  await act(async () => {
    expect(await staleRecovery()).toBe(false);
  });
  expect(edit).not.toHaveBeenCalled();
  expect(mocks.write).not.toHaveBeenCalled();
  mocks.viewer = "alice";
  await screen.render();
  act(() => screen.current.update((draft) => ({ ...draft, summary: "Current feedback" })));
  mocks.write.mockRejectedValueOnce(new Error("Disk full"));
  await act(async () => {
    expect(await screen.current.recoverLegacyDraft()).toBe(false);
  });
  expect(JSON.parse(mocks.disk).drafts[screen.legacyKey].summary).toBe("Earlier private review");
  expect(screen.current.legacyDraftAvailable).toBe(true);
  await act(async () => {
    expect(await screen.current.recoverLegacyDraft()).toBe(true);
  });
  const recovered = JSON.parse(mocks.disk).drafts;
  expect(recovered[pullRequestReviewKey(screen.params, "alice")].summary).toBe(
    "Current feedback\n\nEarlier private review",
  );
  expect(recovered[pullRequestReviewKey(screen.params, "bob")]).toBeUndefined();
  expect(recovered[screen.legacyKey]).toBeUndefined();
  mocks.viewer = "bob";
  await screen.render();
  expect(screen.current.draft.summary).toBe("");
  mocks.viewer = "alice";
  await screen.render();
  const comment = {
    id: "operation-comment",
    path: "file.ts",
    body: "Before hosted edit",
    code: "line",
    headSha: "head",
    position: { kind: "added" as const, newLine: 1 },
  };
  act(() =>
    screen.current.update(() => ({ summary: "To submit", comment: "", comments: [comment] })),
  );
  const captured = screen.current;
  act(() => {
    expect(setReviewDraftBusy(captured.scope, true)).toBe(true);
  });
  mocks.detailPending = true;
  await screen.render();
  const hostedComment = { reviewId: "review", commentId: "hosted", url: "https://host/comment" };
  await act(async () => {
    captured.complete((draft) => ({
      ...draft,
      comments: draft.comments.map((entry) => ({ ...entry, body: "Hosted edit", hostedComment })),
    }));
    expect(await captured.flush()).toBe(true);
  });
  const submitted = JSON.parse(mocks.disk).drafts[
    pullRequestReviewKey(screen.params, "alice")
  ] as ReviewDraft;
  expect(submitted.comments[0]).toMatchObject({ body: "Hosted edit", hostedComment });
  expect(screen.current.draft.summary).toBe("");
  act(() => captured.update(edit));
  expect(edit).not.toHaveBeenCalled();
  act(() => {
    setReviewDraftBusy(captured.scope, false);
    expect(setReviewDraftBusy(captured.scope, true)).toBe(true);
  });
  mocks.detailPending = false;
  mocks.viewer = "bob";
  await screen.render();
  await act(async () => {
    captured.complete((draft) => clearSubmittedReview(draft, submitted));
    expect(await captured.flush()).toBe(true);
  });
  expect(
    JSON.parse(mocks.disk).drafts[pullRequestReviewKey(screen.params, "alice")],
  ).toBeUndefined();
  expect(JSON.parse(mocks.disk).drafts[pullRequestReviewKey(screen.params, "bob")]).toBeUndefined();
  act(() => setReviewDraftBusy(captured.scope, false));
});
