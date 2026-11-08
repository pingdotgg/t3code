import { createMemoryHistory } from "@tanstack/react-router";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import {
  CommandId,
  ORCHESTRATION_V2_WS_METHODS,
  OrchestrationDispatchCommandError,
  OrchestrationV2ThreadLaunchError,
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

/** Holds every call to `method` until `release`, then ends it with `end`, until disposed. */
function holdRpc<Input>(method: string, end: Effect.Effect<never, Error>) {
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const calls: Input[] = [];
  const answer = answerRpc(method, (input: Input) => {
    calls.push(input);
    return Effect.promise(() => held).pipe(Effect.andThen(end));
  });
  return { calls, release, [Symbol.dispose]: () => answer[Symbol.dispose]() };
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
    nextDraft: "next draft",
  },
  // A dropped connection interrupts the request and shows no thread error.
  {
    failure: "interrupted",
    end: Effect.interrupt,
    banner: null,
    toast: "Send not confirmed",
    failedText: "first message that will fail",
    nextDraft: "next draft",
  },
  // An image alone leaves no text to copy, but the failure still needs a toast.
  {
    failure: "interrupted image",
    end: Effect.interrupt,
    banner: null,
    toast: "Send not confirmed",
    failedText: "",
    nextDraft: "next draft",
  },
  // With nothing typed meanwhile, the failed message goes back into the composer.
  {
    failure: "interrupted, restored",
    end: Effect.interrupt,
    banner: null,
    toast: "Send not confirmed",
    failedText: "first message that will fail",
    nextDraft: null,
  },
  {
    failure: "interrupted image, restored",
    end: Effect.interrupt,
    banner: null,
    toast: "Send not confirmed",
    failedText: "",
    nextDraft: null,
  },
])(
  "a failed send ($failure) drops its message from the timeline and loses no draft",
  async ({ failure, end, banner, toast, failedText, nextDraft }) => {
    // Drafts persist per thread, so each case gets its own.
    const thread = threadWithHistory(`thread-${failure.replace(/\W+/g, "-")}-send`, 1);
    using _environment = installFakeEnvironment([thread]);
    __setClientSettingsForTests({
      ...DEFAULT_CLIENT_SETTINGS,
      onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
    });
    using dispatch = holdRpc<{ readonly messageId: string }>(
      ORCHESTRATION_V2_WS_METHODS.dispatchCommand,
      end,
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
    if (nextDraft) {
      await userEvent.keyboard(nextDraft);
      await expect.element(editor).toHaveTextContent(nextDraft);
    }
    dispatch.release();

    await vi.waitFor(() => expect(sentMessages()).toEqual(onlyHistory));
    await expect.element(page.getByText(toast)).toBeVisible();
    if (banner) {
      await expect.element(page.getByText(banner)).toBeVisible();
    } else {
      // The server can still take an interrupted send. Its copy then shows, and nothing resends.
      const messageId = dispatch.calls[0]!.messageId;
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
    expect(dispatch.calls).toHaveLength(1);
    // A new draft stays; otherwise the failed message is back in the composer.
    await expect.element(editor).toHaveTextContent(nextDraft ?? failedText);
    if (!nextDraft && !failedText) {
      await expect.element(page.getByRole("img", { name: "shot.png" })).toBeVisible();
    }
    // By text, since each timeline row has an icon button labelled the same.
    const copyAction = page.getByText("Copy message", { exact: true });
    // Only text that is no longer in the composer needs copying.
    if (!nextDraft || !failedText) {
      expect(copyAction.query()).toBeNull();
      return;
    }
    await copyAction.click();
    expect(write).toHaveBeenCalledWith(failedText);
  },
);

it("a new thread rejected after you leave its draft offers the failed text from its toast", async () => {
  const other = threadWithHistory("thread-left-for", 1);
  using _environment = installFakeEnvironment([other]);
  __setClientSettingsForTests({
    ...DEFAULT_CLIENT_SETTINGS,
    onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
  });
  const draftId = DraftId.make("draft-rejected-start");
  useComposerDraftStore
    .getState()
    .setProjectDraftThreadId(scopeProjectRef(ENVIRONMENT_ID, PROJECT_ID), draftId, {
      threadId: ThreadId.make("thread-rejected-start"),
    });
  // A new thread starts with a launch, not a dispatch.
  using launch = holdRpc(
    ORCHESTRATION_V2_WS_METHODS.launchThread,
    Effect.fail(
      new OrchestrationV2ThreadLaunchError({
        commandId: CommandId.make("command-rejected-start"),
        projectId: PROJECT_ID,
        message: "Provider is unavailable.",
      }),
    ),
  );
  const router = getRouter(createMemoryHistory({ initialEntries: [`/draft/${draftId}`] }));
  await router.load();
  await using _app = await render(<AppRoot router={router} />, {
    // AppRoot brings its own router.
    router: false,
  });
  using write = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue(undefined);
  const editor = page.getByTestId("composer-editor");
  await expect.element(editor).toBeVisible();
  // The send needs the project, which arrives with the shell snapshot.
  await expect.element(page.getByText("render", { exact: true }).first()).toBeVisible();

  await userEvent.click(editor);
  await userEvent.keyboard("first message that will fail{Enter}");
  await vi.waitFor(() => expect(launch.calls).toHaveLength(1));
  await userEvent.keyboard("later draft");
  await expect.element(editor).toHaveTextContent("later draft");
  await router.navigate({
    to: "/$environmentId/$threadId",
    params: { environmentId: ENVIRONMENT_ID, threadId: other.id },
  });
  await expect.element(page.getByText(`${other.id}: question 0`)).toBeVisible();
  launch.release();

  await expect.element(page.getByText("Could not start thread")).toBeVisible();
  await page.getByText("Copy message", { exact: true }).click();
  expect(write).toHaveBeenCalledWith("first message that will fail");
  await page.getByText("Open draft", { exact: true }).click();
  await expect.element(editor).toHaveTextContent("later draft");
});
