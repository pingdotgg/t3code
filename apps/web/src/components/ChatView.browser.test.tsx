import { createMemoryHistory } from "@tanstack/react-router";
import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { ThreadId } from "@t3tools/contracts";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import type * as Context from "effect/Context";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import { AppRoot } from "~/AppRoot";
// The route loads ChatView lazily, and its first transform (React Compiler over ~4k lines)
// takes 6-11s; importing it here keeps that out of the test's timeout.
import "~/components/ChatView";
import { DraftId, useComposerDraftStore } from "~/composerDraftStore";
import { __setClientSettingsForTests } from "~/hooks/useSettings";
import { useRightPanelStore } from "~/rightPanelStore";
import { getRouter } from "~/router";
import {
  ENVIRONMENT_ID,
  PROJECT_ID,
  emitServerConfig,
  emitVcsStatus,
  installFakeEnvironment,
  threadWithHistory,
  type FakeDriver,
  type FakeThread,
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
  const draftId = DraftId.make("draft-27443");
  const threadId = ThreadId.make("thread-27443");
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

async function openThreadDetailsOnNonRepository(thread: FakeThread) {
  const stack = new AsyncDisposableStack();
  try {
    stack.use(installFakeEnvironment([thread]));
    __setClientSettingsForTests({
      ...DEFAULT_CLIENT_SETTINGS,
      onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
    });
    const threadRef = scopeThreadRef(ENVIRONMENT_ID, thread.id);
    useRightPanelStore.getState().setThreadPanelOpen(threadRef, "inline", true);
    useRightPanelStore.getState().setThreadPanelOpen(threadRef, "popover", true);
    const router = getRouter(
      createMemoryHistory({ initialEntries: [`/${ENVIRONMENT_ID}/${thread.id}`] }),
    );
    await router.load();
    const container = document.createElement("div");
    container.style.cssText = "height: 900px; width: 1400px;";
    // AppRoot brings its own router.
    stack.use(await render(<AppRoot router={router} />, { container, router: false }));
    await expect.element(page.getByText(`${thread.id}: question 0`)).toBeVisible();
    // vcs.status reports a missing folder as a non-repository.
    await vi.waitFor(() =>
      act(() =>
        emitVcsStatus({
          _tag: "snapshot",
          local: {
            isRepo: false,
            hasPrimaryRemote: false,
            isDefaultRef: false,
            refName: null,
            hasWorkingTreeChanges: false,
            workingTree: { files: [], insertions: 0, deletions: 0 },
          },
          remote: null,
        }),
      ),
    );
    return stack.move();
  } catch (error) {
    await stack.disposeAsync();
    throw error;
  }
}

it("offers Initialize Git for a project folder that is not a repository", async () => {
  await using _app = await openThreadDetailsOnNonRepository(threadWithHistory("root-thread", 1));

  await expect.element(page.getByRole("button", { name: "Initialize Git" })).toBeVisible();
});

it("does not offer Initialize Git when the thread's worktree folder is missing", async () => {
  await using _app = await openThreadDetailsOnNonRepository({
    ...threadWithHistory("worktree-thread", 1),
    worktreePath: "/workspace/worktrees/render/t3-removed",
  });

  await expect.element(page.getByText("Worktree missing")).toBeVisible();
  await expect
    .element(page.getByRole("button", { name: "Initialize Git" }))
    .not.toBeInTheDocument();
});

it("keeps Initialize Git for a No project thread's scratch folder", async () => {
  // No project threads store their plain scratch folder as worktreePath.
  await using _app = await openThreadDetailsOnNonRepository({
    ...threadWithHistory("scratch-thread", 1),
    worktreePath: "/workspace/render/2026-11-02-x",
  });
  // The fake connection outlives each test, so the config is pushed rather than installed.
  await using _scratch = { [Symbol.asyncDispose]: () => act(() => emitServerConfig()) };
  await act(() => emitServerConfig({ scratchWorkspaceRoot: "/workspace/render" }));

  await expect.element(page.getByRole("button", { name: "Initialize Git" })).toBeVisible();
  await expect.element(page.getByText("Worktree missing")).not.toBeInTheDocument();
});

it("opens the thread actions menu for an older settled thread the shell leaves out", async () => {
  const thread = { ...threadWithHistory("older-settled", 1), olderSettled: true as const };
  using _environment = installFakeEnvironment([thread]);
  __setClientSettingsForTests({
    ...DEFAULT_CLIENT_SETTINGS,
    onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
  });

  const router = getRouter(
    createMemoryHistory({ initialEntries: [`/${ENVIRONMENT_ID}/${thread.id}`] }),
  );
  await router.load();
  await using _app = await render(<AppRoot router={router} />, {
    // AppRoot brings its own router.
    router: false,
  });
  await expect.element(page.getByText("older-settled: question 0")).toBeVisible();

  await page.getByRole("button", { name: `Thread actions for ${thread.title}` }).click();
  // Without a bound the poll runs to the test deadline and reports a bare timeout.
  await expect
    .element(page.getByRole("menuitem", { name: "Rename thread" }), { timeout: 5_000 })
    .toBeVisible();
});
