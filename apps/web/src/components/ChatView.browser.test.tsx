import { createMemoryHistory } from "@tanstack/react-router";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { ThreadId } from "@t3tools/contracts";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import type * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { AppRoot } from "~/AppRoot";
// The route loads ChatView lazily, and its first transform (React Compiler over ~4k lines)
// takes 6-11s; importing it here keeps that out of the test's timeout.
import "~/components/ChatView";
import { startMainAppLocationTracking } from "~/components/sidebar/mainAppLocation";
import { DraftId, useComposerDraftStore } from "~/composerDraftStore";
import { __setClientSettingsForTests } from "~/hooks/useSettings";
import { getRouter } from "~/router";
import { useUiStateStore } from "~/uiStateStore";
import {
  ENVIRONMENT_ID,
  PROJECT_ID,
  emitThreadShell,
  installFakeEnvironment,
  shellOf,
  threadWithHistory,
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

it("preserves the current conversation and draft across Pull requests and Back", async () => {
  const firstThread = threadWithHistory("return-first", 1);
  const threads = [firstThread, threadWithHistory("return-second", 1)];
  using _environment = installFakeEnvironment(threads);
  __setClientSettingsForTests({
    ...DEFAULT_CLIENT_SETTINGS,
    onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
  });
  const router = getRouter(
    createMemoryHistory({ initialEntries: [`/${ENVIRONMENT_ID}/${firstThread.id}`] }),
  );
  await router.load();
  using _tracking = { [Symbol.dispose]: startMainAppLocationTracking(router) };
  await using _app = await render(<AppRoot router={router} />, {
    // AppRoot brings its own router.
    router: false,
  });

  for (const thread of threads) {
    await router.navigate({ href: `/${ENVIRONMENT_ID}/${thread.id}` });
    const editor = page.getByTestId("composer-editor");
    const question = page.getByText(`${thread.id}: question 0`, { exact: true });
    await expect.element(editor).toBeVisible();
    await expect.element(question).toBeVisible();
    const questionNode = question.element();
    const editorNode = editor.element();
    const conversationNode = page
      .getByRole("region", { name: "Conversation", exact: true })
      .element();
    const draft = `Unsent draft for ${thread.id}`;
    await userEvent.type(editor, draft);
    await expect.element(editor).toHaveTextContent(draft);

    await router.navigate({ href: "/pull-requests" });
    await expect.element(page.getByRole("button", { name: "Back to threads" })).toBeVisible();
    expect(conversationNode.isConnected).toBe(true);
    expect(questionNode.isConnected).toBe(true);
    await expect.element(editor).not.toBeVisible();
    await expect.element(page.elementLocator(conversationNode)).not.toBeVisible();
    await expect.element(page.elementLocator(questionNode)).not.toBeVisible();

    // A run that finishes out of sight stays unseen until the conversation shows again.
    const finishedAt = `2026-03-18T00:00:0${threads.indexOf(thread)}.000Z`;
    const visitedOn: string[] = [];
    using _visits = {
      [Symbol.dispose]: useUiStateStore.subscribe((state) => {
        if (
          visitedOn.length === 0 &&
          Object.values(state.threadLastVisitedAtById).includes(finishedAt)
        )
          visitedOn.push(router.state.location.pathname);
      }),
    };
    // Hiding unmounts what the hidden view pauses once React runs its effects.
    await act(async () => {});
    // Without a server watermark the tracker records visits locally, where the test reads them.
    const { lastVisitedAt: _watermark, ...shell } = shellOf(thread);
    const finishedTitle = `${thread.title} finished`;
    await emitThreadShell({
      ...shell,
      title: finishedTitle,
      updatedAt: DateTime.makeUnsafe(finishedAt),
    });
    await expect.element(page.getByText(finishedTitle).first()).toBeInTheDocument();

    await userEvent.click(page.getByRole("button", { name: "Back to threads" }));
    await expect.element(editor).toBeVisible();
    await expect.element(question).toBeVisible();
    await vi.waitFor(() => expect(visitedOn).toEqual([`/${ENVIRONMENT_ID}/${thread.id}`]));
    expect(router.state.location.pathname).toBe(`/${ENVIRONMENT_ID}/${thread.id}`);
    expect(page.getByRole("region", { name: "Conversation", exact: true }).element()).toBe(
      conversationNode,
    );
    expect(question.element()).toBe(questionNode);
    expect(editor.element()).toBe(editorNode);
    await expect.element(editor).toHaveTextContent(draft);
  }
});
