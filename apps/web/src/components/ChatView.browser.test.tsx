import { createMemoryHistory } from "@tanstack/react-router";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import {
  ORCHESTRATION_V2_WS_METHODS,
  OrchestrationDispatchCommandError,
  ThreadId,
} from "@t3tools/contracts";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import type * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { AppRoot } from "~/AppRoot";
// The route loads ChatView lazily, and its first transform (React Compiler over ~4k lines)
// takes 6-11s; importing it here keeps that out of the test's timeout.
import "~/components/ChatView";
import { DraftId, useComposerDraftStore } from "~/composerDraftStore";
import { __setClientSettingsForTests } from "~/hooks/useSettings";
import { getRouter } from "~/router";
import {
  ENVIRONMENT_ID,
  PROJECT_ID,
  answerRpc,
  installFakeEnvironment,
  threadWithHistory,
  type FakeDriver,
} from "../../test/fakeEnvironment";
import { render } from "../../test/render";

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

it.each([
  {
    failure: "rejected",
    end: Effect.fail(
      new OrchestrationDispatchCommandError({ message: "Provider is unavailable." }),
    ),
    banner: "Provider is unavailable.",
  },
  // A dropped connection interrupts the request and shows no thread error.
  { failure: "interrupted", end: Effect.interrupt, banner: null },
])(
  "a failed send ($failure) drops its message from the timeline and keeps the draft typed meanwhile",
  async ({ failure, end, banner }) => {
    // Drafts persist per thread, so each case gets its own.
    const thread = threadWithHistory(`thread-${failure}-send`, 1);
    using _environment = installFakeEnvironment([thread]);
    __setClientSettingsForTests({
      ...DEFAULT_CLIENT_SETTINGS,
      onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
    });
    let failDispatch = () => {};
    const dispatchHeld = new Promise<void>((resolve) => {
      failDispatch = resolve;
    });
    using _dispatch = answerRpc(ORCHESTRATION_V2_WS_METHODS.dispatchCommand, () =>
      Effect.promise(() => dispatchHeld).pipe(Effect.andThen(end)),
    );
    const router = getRouter(
      createMemoryHistory({ initialEntries: [`/${ENVIRONMENT_ID}/${thread.id}`] }),
    );
    await router.load();
    await using _app = await render(<AppRoot router={router} />, {
      // AppRoot brings its own router.
      router: false,
    });
    using write = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue(undefined);
    // Only timeline rows, so the composer and sidebar cannot match the text.
    const sentMessages = () =>
      Array.from(document.querySelectorAll('[data-message-role="user"]'), (row) => row.textContent);
    const failedText = "first message that will fail";
    const editor = page.getByTestId("composer-editor");
    await expect.element(editor).toBeVisible();

    await userEvent.click(editor);
    await userEvent.keyboard(`${failedText}{Enter}`);
    await vi.waitFor(() =>
      expect(sentMessages()).toContainEqual(expect.stringContaining(failedText)),
    );
    await userEvent.keyboard("next draft");
    await expect.element(editor).toHaveTextContent("next draft");
    failDispatch();

    await vi.waitFor(() =>
      expect(sentMessages()).not.toContainEqual(expect.stringContaining(failedText)),
    );
    await expect.element(page.getByText("Message not sent")).toBeVisible();
    if (banner) await expect.element(page.getByText(banner)).toBeVisible();
    await expect.element(editor).toHaveTextContent("next draft");
    // By text, since each timeline row has an icon button labelled the same.
    await page.getByText("Copy message", { exact: true }).click();
    expect(write).toHaveBeenCalledWith(failedText);
  },
);
