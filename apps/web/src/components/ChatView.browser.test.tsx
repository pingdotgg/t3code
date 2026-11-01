import { createMemoryHistory } from "@tanstack/react-router";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { MessageId, ORCHESTRATION_V2_WS_METHODS, ThreadId } from "@t3tools/contracts";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import type * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";

import { AppRoot } from "~/AppRoot";
import { DraftId, useComposerDraftStore } from "~/composerDraftStore";
import { __setClientSettingsForTests } from "~/hooks/useSettings";
import { getRouter } from "~/router";
import {
  ENVIRONMENT_ID,
  PROJECT_ID,
  installFakeEnvironment,
  threadWithHistory,
  type FakeDriver,
} from "../../test/fakeEnvironment";
import { act, render } from "../../test/render";
import { closeThreadFind, openThreadFindOnQuery, useThreadFindStore } from "./chat/threadFindStore";

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

it("dismisses a previous sidebar message find when the sidebar search changes or clears", async () => {
  await page.viewport(1400, 900);
  const thread = threadWithHistory("sidebar-search", 1);
  const messageId = MessageId.make(`${thread.id}-assistant-0`);
  using _environment = installFakeEnvironment([thread], {
    config: { threadFind: true },
    rpc: {
      [ORCHESTRATION_V2_WS_METHODS.searchThreads]: ({ query }) =>
        Effect.succeed({
          matches:
            query === "Sidebar.tsx"
              ? [
                  {
                    threadId: thread.id,
                    projectId: PROJECT_ID,
                    source: "assistant",
                    snippet: "checked Sidebar.tsx",
                    messageId,
                    messageCreatedAt: null,
                  },
                ]
              : [],
        }),
      [ORCHESTRATION_V2_WS_METHODS.searchThread]: () =>
        Effect.succeed({
          snapshotSequence: 1,
          totalMatches: 1,
          activeIndex: 0,
          match: { entryId: messageId, runId: thread.runs[0]!.id, occurrence: 0 },
        }),
    },
  });
  closeThreadFind();
  using _find = { [Symbol.dispose]: closeThreadFind };
  __setClientSettingsForTests({
    ...DEFAULT_CLIENT_SETTINGS,
    onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
  });
  const router = getRouter(
    createMemoryHistory({ initialEntries: [`/${ENVIRONMENT_ID}/${thread.id}`] }),
  );
  await router.load();
  await using screen = await render(<AppRoot router={router} />, {
    // AppRoot brings its own router.
    router: false,
  });
  const search = screen.getByRole("combobox", { name: "Search threads" });
  await expect.element(search).toBeVisible();
  const find = screen.getByRole("searchbox", { name: "Find in thread" });
  const assertFindClosed = async () => {
    await expect.element(find).not.toBeInTheDocument();
    expect(CSS.highlights.has("t3-thread-find")).toBe(false);
    expect(CSS.highlights.has("t3-thread-find-active")).toBe(false);
  };
  const selectMessageResult = async () => {
    await userEvent.fill(search, "Sidebar.tsx");
    await userEvent.click(screen.getByRole("option", { name: new RegExp(thread.title) }));
    await expect.element(find).toHaveValue("Sidebar.tsx");
    await vi.waitFor(() => expect(CSS.highlights.get("t3-thread-find-active")?.size).toBe(1));
  };
  const openMessageFind = () =>
    act(() =>
      openThreadFindOnQuery(`${ENVIRONMENT_ID}:${thread.id}`, { query: "Sidebar.tsx" }, "sidebar"),
    );

  await selectMessageResult();
  await userEvent.fill(search, thread.title);
  await assertFindClosed();

  await openMessageFind();
  await userEvent.click(screen.getByRole("button", { name: "Clear thread search" }));
  await expect.element(search).toHaveValue("");
  await assertFindClosed();

  await userEvent.fill(search, thread.title);
  await openMessageFind();
  await userEvent.click(search);
  await userEvent.keyboard("{Escape}");
  await expect.element(search).toHaveValue("");
  await assertFindClosed();

  await userEvent.fill(search, thread.title);
  await openMessageFind();
  await userEvent.clear(search);
  await expect.element(search).toHaveValue("");
  await assertFindClosed();

  await selectMessageResult();
  expect(useThreadFindStore.getState().query).toBe("Sidebar.tsx");
});

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
