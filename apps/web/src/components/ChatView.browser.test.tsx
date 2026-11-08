import { createMemoryHistory } from "@tanstack/react-router";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import {
  ORCHESTRATION_V2_WS_METHODS,
  OrchestrationDispatchCommandError,
  ThreadId,
  WS_METHODS,
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
  emitThreadEvent,
  installFakeEnvironment,
  runningRun,
  threadWithHistory,
  userItem,
  type FakeDriver,
} from "../../test/fakeEnvironment";
import { render } from "../../test/render";

const PNG = Uint8Array.from(
  atob(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
  ),
  (char) => char.charCodeAt(0),
);

/** Accepts every attachment upload without sending its bytes, until disposed. */
function acceptAttachmentUploads(): Disposable {
  const mint = answerRpc(WS_METHODS.attachmentsCreateUploadUrl, () =>
    Effect.succeed({ attachmentId: "upload-1", relativeUrl: "/upload", expiresAt: 0 }),
  );
  const status = vi.spyOn(XMLHttpRequest.prototype, "status", "get").mockReturnValue(200);
  const send = vi.spyOn(XMLHttpRequest.prototype, "send").mockImplementation(function (
    this: XMLHttpRequest,
  ) {
    queueMicrotask(() => this.dispatchEvent(new ProgressEvent("load")));
  });
  return {
    [Symbol.dispose]: () => {
      send.mockRestore();
      status.mockRestore();
      mint[Symbol.dispose]();
    },
  };
}

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
    toast: "Message not sent",
    failedText: "first message that will fail",
  },
  // A dropped connection interrupts the request and shows no thread error.
  {
    failure: "interrupted",
    end: Effect.interrupt,
    banner: null,
    toast: "Send not confirmed",
    failedText: "first message that will fail",
  },
  // An image alone leaves no text to copy, but the failure still needs a toast.
  {
    failure: "interrupted image",
    end: Effect.interrupt,
    banner: null,
    toast: "Send not confirmed",
    failedText: "",
  },
])(
  "a failed send ($failure) drops its message from the timeline and keeps the draft typed meanwhile",
  async ({ failure, end, banner, toast, failedText }) => {
    // Drafts persist per thread, so each case gets its own.
    const thread = threadWithHistory(`thread-${failure.replace(" ", "-")}-send`, 1);
    using _environment = installFakeEnvironment([thread]);
    __setClientSettingsForTests({
      ...DEFAULT_CLIENT_SETTINGS,
      onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
    });
    let failDispatch = () => {};
    const dispatchHeld = new Promise<void>((resolve) => {
      failDispatch = resolve;
    });
    const dispatched: string[] = [];
    using _dispatch = answerRpc(
      ORCHESTRATION_V2_WS_METHODS.dispatchCommand,
      (command: { readonly messageId: string }) => {
        dispatched.push(command.messageId);
        return Effect.promise(() => dispatchHeld).pipe(Effect.andThen(end));
      },
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
    using _uploads = failedText ? null : acceptAttachmentUploads();
    // Only timeline rows, not the composer or sidebar.
    const sentMessages = () =>
      Array.from(document.querySelectorAll('[data-message-role="user"]'), (row) => row.textContent);
    const onlyHistory = [expect.stringContaining(`${thread.id}: question 0`)];
    const editor = page.getByTestId("composer-editor");
    await expect.element(editor).toBeVisible();
    await vi.waitFor(() => expect(sentMessages()).toEqual(onlyHistory));

    await userEvent.click(editor);
    if (failedText) {
      await userEvent.keyboard(failedText);
    } else {
      const clipboardData = new DataTransfer();
      clipboardData.items.add(new File([PNG], "shot.png", { type: "image/png" }));
      editor
        .element()
        .dispatchEvent(
          new ClipboardEvent("paste", { clipboardData, bubbles: true, cancelable: true }),
        );
      await expect.element(page.getByRole("img", { name: "shot.png" })).toBeVisible();
    }
    await userEvent.keyboard("{Enter}");
    await vi.waitFor(() => expect(sentMessages()).toHaveLength(2));
    await userEvent.keyboard("next draft");
    await expect.element(editor).toHaveTextContent("next draft");
    failDispatch();

    await vi.waitFor(() => expect(sentMessages()).toEqual(onlyHistory));
    await expect.element(page.getByText(toast)).toBeVisible();
    if (banner) {
      await expect.element(page.getByText(banner)).toBeVisible();
    } else {
      // The server can still take an interrupted send. Its copy then shows, and nothing resends.
      const messageId = dispatched[0]!;
      const late = runningRun(thread.id, "late-run", 2, messageId);
      await emitThreadEvent(thread.id, { type: "run.created", payload: late });
      await emitThreadEvent(thread.id, {
        type: "turn-item.updated",
        payload: userItem(thread.id, late.id, messageId, 2, failedText),
      });
      await vi.waitFor(() =>
        expect(sentMessages()).toEqual([...onlyHistory, expect.stringContaining(failedText)]),
      );
      expect(page.getByText("Message not sent").query()).toBeNull();
    }
    expect(dispatched).toHaveLength(1);
    await expect.element(editor).toHaveTextContent("next draft");
    // By text, since each timeline row has an icon button labelled the same.
    const copyAction = page.getByText("Copy message", { exact: true });
    if (!failedText) {
      expect(copyAction.query()).toBeNull();
      return;
    }
    await copyAction.click();
    expect(write).toHaveBeenCalledWith(failedText);
  },
);
