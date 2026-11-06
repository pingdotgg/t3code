import { createMemoryHistory } from "@tanstack/react-router";
import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { ThreadId } from "@t3tools/contracts";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import * as DateTime from "effect/DateTime";
import type * as Context from "effect/Context";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { AppRoot } from "~/AppRoot";
import { useRightPanelStore, selectActiveRightPanelSurface } from "~/rightPanelStore";
import { useDiffPanelStore, selectThreadDiffPanelSelection } from "~/diffPanelStore";
// The route loads ChatView lazily, and its first transform (React Compiler over ~4k lines)
// takes 6-11s; importing it here keeps that out of the test's timeout.
import "~/components/ChatView";
import { DraftId, useComposerDraftStore } from "~/composerDraftStore";
import { __setClientSettingsForTests, persistClientSettingsPatch } from "~/hooks/useSettings";
import { getRouter } from "~/router";
import {
  ENVIRONMENT_ID,
  PROJECT_ID,
  installFakeEnvironment,
  threadWithHistory,
  emitVcsStatus,
  type FakeDriver,
} from "../../test/fakeEnvironment";
import { act, render } from "../../test/render";

// The socket is the only fake layer; see test/appScenarios.renders.tsx.
vi.mock("../../../../packages/client-runtime/src/connection/driver.ts", async (importOriginal) => {
  const [actual, { fakeDriver }, Layer] = await Promise.all([
    importOriginal<{ readonly ConnectionDriver: Context.Key<unknown, FakeDriver> }>(),
    import("../../test/fakeEnvironment"),
    import("effect/Layer"),
  ]);
  return { ...actual, layer: Layer.succeed(actual.ConnectionDriver, fakeDriver) };
});

vi.mock(import("~/rpc/requestLatencyState"), async (original) => ({
  ...(await original()),
  trackRpcRequestSent: () => {},
}));

it("a new draft does not load its reserved thread before the server lists it", async () => {
  using _environment = installFakeEnvironment([]);
  using fetchSpy = vi.spyOn(globalThis, "fetch");
  __setClientSettingsForTests({
    ...DEFAULT_CLIENT_SETTINGS,
    onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
  });
  const draftId = DraftId.make("draft-reserved");
  const threadId = ThreadId.make("thread-reserved");
  useComposerDraftStore
    .getState()
    .setProjectDraftThreadId(scopeProjectRef(ENVIRONMENT_ID, PROJECT_ID), draftId, { threadId });

  const router = getRouter(createMemoryHistory({ initialEntries: [`/draft/${draftId}`] }));
  await router.load();
  await using _app = await render(<AppRoot router={router} />, {
    // AppRoot brings its own router.
    router: false,
  });
  await expect.element(page.getByTestId("composer-editor")).toBeVisible();
  // The shell snapshot has arrived once the sidebar lists the project, so the connection is up.
  await expect.element(page.getByText("render", { exact: true }).first()).toBeVisible();

  const threadRequests = fetchSpy.mock.calls
    .map(([input]) => String(input instanceof Request ? input.url : input))
    .filter((url) => url.includes(`/api/orchestration/threads/${threadId}/`));
  // A 404 here marks the thread deleted, and the view never loads it once the send creates it.
  expect(threadRequests).toEqual([]);
});

it("separates local work and opens the current PR only when committed comparison is enabled", async () => {
  const thread = threadWithHistory("committed-changes", 1);
  const ref = scopeThreadRef(ENVIRONMENT_ID, thread.id);
  using _environment = installFakeEnvironment([thread], {
    reviewPreview: {
      cwd: "/project",
      generatedAt: DateTime.makeUnsafe("2026-11-06T00:00:00Z"),
      sources: [
        {
          id: "branch-range",
          kind: "branch-range",
          branchMode: "committed",
          title: "Changes",
          baseRef: "origin/main",
          headRef: "abcdef1234567890",
          diff: "",
          diffHash: "empty",
          truncated: false,
          files: [],
        },
      ],
    },
  });
  __setClientSettingsForTests({
    ...DEFAULT_CLIENT_SETTINGS,
    onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
  });
  await page.viewport(1600, 1000);
  useRightPanelStore.getState().setThreadPanelOpen(ref, "inline", true);
  useDiffPanelStore.getState().selectBranchBaseRef(ref, "old-base");
  const router = getRouter(
    createMemoryHistory({ initialEntries: [`/${ENVIRONMENT_ID}/${thread.id}`] }),
  );
  await router.load();
  const container = document.createElement("div");
  container.style.cssText = "height: 1000px; width: 1600px;";
  await using _app = await render(<AppRoot router={router} />, {
    container,
    // AppRoot brings its own router.
    router: false,
  });
  await expect.element(page.getByTestId("composer-editor")).toBeVisible();
  await act(() =>
    emitVcsStatus({
      _tag: "snapshot",
      local: {
        isRepo: true,
        hasPrimaryRemote: true,
        isDefaultRef: true,
        refName: "main",
        hasWorkingTreeChanges: true,
        workingTree: {
          files: [{ path: "local.ts", insertions: 100, deletions: 2 }],
          insertions: 100,
          deletions: 2,
        },
        branchChanges: { baseRef: "origin/main", insertions: 100, deletions: 2 },
      },
      remote: null,
    }),
  );
  const changes = page.getByRole("button", { name: /^Changes.*origin\/main/ });
  await expect.element(changes).toBeVisible();
  expect(changes.element().textContent).toContain("+100");
  await expect.element(page.getByRole("button", { name: /^Uncommitted/ })).not.toBeInTheDocument();
  await userEvent.click(changes);
  await vi.waitFor(() =>
    expect(selectThreadDiffPanelSelection(useDiffPanelStore.getState().byThreadKey, ref)).toEqual({
      kind: "branch",
      baseRef: "old-base",
    }),
  );
  await act(() => persistClientSettingsPatch({ changesComparison: "committed" }, async () => {}));
  await vi.waitFor(() => expect(changes.element().textContent).toContain("+0"));
  expect(changes.element().textContent).not.toContain("+100");
  await userEvent.click(page.getByRole("button", { name: /^Uncommitted/ }));
  await vi.waitFor(() =>
    expect(selectThreadDiffPanelSelection(useDiffPanelStore.getState().byThreadKey, ref)).toEqual({
      kind: "unstaged",
    }),
  );
  await userEvent.click(changes);
  await vi.waitFor(() =>
    expect(selectThreadDiffPanelSelection(useDiffPanelStore.getState().byThreadKey, ref)).toEqual({
      kind: "branch",
      baseRef: null,
    }),
  );
  await act(() =>
    emitVcsStatus({
      _tag: "remoteUpdated",
      remote: {
        hasUpstream: true,
        aheadCount: 0,
        behindCount: 0,
        pr: {
          number: 42,
          title: "Current PR",
          url: "https://github.com/example/repo/pull/42",
          baseRef: "release",
          headRef: "main",
          localRefName: "main",
          state: "open",
        },
      },
    }),
  );
  await expect.element(page.getByRole("button", { name: /^Changes.*#42/ })).toBeVisible();
  await userEvent.click(page.getByRole("button", { name: /^Changes.*#42/ }));
  await vi.waitFor(() =>
    expect(
      selectActiveRightPanelSurface(useRightPanelStore.getState().byThreadKey, ref),
    ).toMatchObject({ kind: "pull-request", number: 42, detailTab: "code" }),
  );
  await act(() => persistClientSettingsPatch({ changesComparison: "all" }, async () => {}));
  await expect.element(changes).toBeVisible();
  expect(changes.element().textContent).toContain("+100");
  await expect.element(page.getByRole("button", { name: /^Uncommitted/ })).not.toBeInTheDocument();
  await userEvent.click(changes);
  await vi.waitFor(() =>
    expect(
      selectActiveRightPanelSurface(useRightPanelStore.getState().byThreadKey, ref),
    ).toMatchObject({ kind: "diff" }),
  );
});
