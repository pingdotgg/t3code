import { createMemoryHistory } from "@tanstack/react-router";
import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  EnvironmentId,
  IssueTrackerKind,
  ORCHESTRATION_V2_WS_METHODS,
  RunId,
  ThreadId,
  WS_METHODS,
  type IssueDetail,
  type IssueRef,
  type ThreadIssueLink,
} from "@t3tools/contracts";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import {
  compileResolvedKeybindingsConfig,
  mergeWithDefaultKeybindings,
} from "@t3tools/shared/keybindings";
import type * as Context from "effect/Context";
import * as Schema from "effect/Schema";
import * as Effect from "effect/Effect";
import { expect, it, onTestFinished, vi } from "vite-plus/test";
import { cdp, page, userEvent } from "vite-plus/test/browser";

import { AppRoot } from "~/AppRoot";
// The route loads ChatView lazily, and its first transform (React Compiler over ~4k lines)
// takes 6-11s; importing it here keeps that out of the test's timeout.
import "~/components/ChatView";
import { openVimMessageText } from "~/components/chat/vimMessageText";
import { DraftId, useComposerDraftStore } from "~/composerDraftStore";
import { selectThreadDiffPanelSelection, useDiffPanelStore } from "~/diffPanelStore";
import { __setClientSettingsForTests } from "~/hooks/useSettings";
import stylesheet from "~/index.css?inline";
import { environmentContextRecord } from "~/lib/composerContextRecords";
import { startWorkspaceFocus } from "~/lib/workspaceFocus";
import { usePromptStashStore } from "~/promptStashStore";
import { useRightPanelStore } from "~/rightPanelStore";
import { getRouter } from "~/router";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { environmentThreadDetails } from "~/state/threads";
import {
  ENVIRONMENT_ID,
  PROJECT_ID,
  answerAssetUrls,
  answerRpc,
  assistantItem,
  dispatchedCommands,
  emitThreadEvent,
  hasPendingAssetUrl,
  installFakeEnvironment,
  rejectPendingCommand,
  threadWithHistory,
  threadWithQuestion,
  type FakeDriver,
} from "../../test/fakeEnvironment";
import { act, fakeTimers, render } from "../../test/render";

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
  // Sending verifies each ready upload still exists on the server.
  const verify = answerRpc(WS_METHODS.assetsCreateUrl, () =>
    Effect.succeed({ relativeUrl: "/upload-1", expiresAt: 0 }),
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
      verify[Symbol.dispose]();
    },
  };
}

// One input event, where typing a key at a time takes seconds on a loaded CI runner.
const insertText = (text: string) => cdp().send("Input.insertText", { text });

/** Holds every call to `method` until `release`, then ends it with `end`, until disposed. */
class LaunchRefused extends Schema.TaggedError<LaunchRefused>()("LaunchRefused", {}) {}

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

// The socket is the only fake layer.
vi.mock("../../../../packages/client-runtime/src/connection/driver.ts", async (importOriginal) => {
  const [actual, { fakeDriver }, Layer] = await Promise.all([
    importOriginal<{ readonly ConnectionDriver: Context.Key<unknown, FakeDriver> }>(),
    import("../../test/fakeEnvironment"),
    import("effect/Layer"),
  ]);
  return { ...actual, layer: Layer.succeed(actual.ConnectionDriver, fakeDriver) };
});

// Null runs the real compression; a test sets it to hold an image in preparation.
const compression = vi.hoisted(() => ({ gate: null as Promise<void> | null }));
vi.mock(import("~/lib/imageCompression"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    prepareImageForAttachment: async (...args) => {
      await compression.gate;
      return actual.prepareImageForAttachment(...args);
    },
  };
});

vi.mock(import("~/rpc/requestLatencyState"), async (original) => ({
  ...(await original()),
  trackRpcRequestSent: () => {},
}));

function vimCursorRange() {
  const range = CSS.highlights.get("t3-vim-cursor")?.values().next().value;
  return range instanceof Range ? range : undefined;
}

function installStylesheet() {
  const style = document.createElement("style");
  style.textContent = stylesheet;
  document.head.append(style);
  return { [Symbol.dispose]: () => style.remove() };
}

it("opens a linked Linear issue from an inactive thread's sidebar badge", async () => {
  using _style = installStylesheet();
  const first = threadWithHistory("issue-first", 1);
  const linked = threadWithHistory("issue-linked", 1);
  const issueRef = {
    projectId: PROJECT_ID,
    tracker: IssueTrackerKind.make("linear"),
    host: "linear.app",
    scope: "WEB",
    key: "WEB-123",
  } satisfies IssueRef;
  const issue: ThreadIssueLink = {
    ...issueRef,
    url: "https://linear.app/example/issue/WEB-123/add-keyboard-support",
    source: "manual",
    linkedAt: "2026-01-01T00:00:00.000Z",
    displayKey: "#123",
    title: "Add keyboard support",
  };
  const completed = {
    ...issue,
    key: "WEB-124",
    displayKey: "WEB-124",
    url: "https://linear.app/example/issue/WEB-124/keep-tabs-visible",
    title: "Keep tabs visible",
  };
  const grouped = threadWithHistory("issue-grouped", 1);
  using _environment = installFakeEnvironment([
    first,
    {
      ...linked,
      issues: [issue],
      pullRequests: [
        {
          host: "github.com",
          repository: "pingdotgg/t3code",
          number: 124,
          url: "https://github.com/pingdotgg/t3code/pull/124",
          source: "manual",
          linkedAt: "2026-01-01T00:00:00.000Z",
          snapshot: null,
          stack: null,
        },
      ],
    },
    { ...grouped, issues: [completed, issue] },
  ]);
  const liveTitle = "Add keyboard shortcuts to the sidebar";
  using _detail = answerRpc(WS_METHODS.issuesDetail, (input: IssueRef) => {
    const isCompleted = input.key === completed.key;
    expect(input).toEqual({ ...issueRef, key: isCompleted ? completed.key : issue.key });
    return Effect.succeed({
      ...(isCompleted ? completed : issue),
      title: isCompleted ? completed.title : liveTitle,
      author: { login: "sam", name: null, avatarUrl: null },
      state: isCompleted
        ? { category: "closed", closeReason: "completed", name: "Done" }
        : { category: "open", name: "Open" },
      createdAt: issue.linkedAt,
      updatedAt: issue.linkedAt,
      closedAt: null,
      assignees: [],
      labels: [],
      commentCount: 3,
      projectTitle: "render",
      writable: false,
      capabilities: {
        create: false,
        edit: false,
        comment: false,
        labels: false,
        assignees: false,
        reactions: false,
        templates: false,
        linkedPullRequests: false,
        events: false,
        search: false,
      },
      viewerPermissions: {
        setState: false,
        comment: false,
        edit: false,
        labels: false,
        assignees: false,
      },
      states: [],
      viewer: null,
      body: "",
      comments: [],
      commentsCursor: null,
      events: [],
      linkedPullRequests: [],
    } satisfies IssueDetail);
  });
  __setClientSettingsForTests({
    ...DEFAULT_CLIENT_SETTINGS,
    onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
  });
  await page.viewport(1400, 900);
  const router = getRouter(
    createMemoryHistory({ initialEntries: [`/${ENVIRONMENT_ID}/${first.id}`] }),
  );
  await router.load();
  await using _app = await render(<AppRoot router={router} />, {
    // AppRoot brings its own router.
    router: false,
  });
  const badge = page.getByRole("button", {
    name: `Issue ${issue.displayKey}: ${issue.title}, Open`,
  });
  await expect.element(badge).toBeVisible();
  expect(badge.element().querySelector("span")).toHaveClass(/text-emerald-600/);
  expect(badge.element()).toHaveTextContent("123");
  expect(badge.element()).not.toHaveTextContent("#");
  const prBadge = page.getByRole("link", { name: "PR #124, status pending" });
  await expect.element(prBadge).toHaveTextContent("124");
  for (const control of [badge, prBadge]) {
    expect(control.element().querySelector("span")).toHaveClass(
      "contents",
      "text-xs",
      "tabular-nums",
    );
  }
  const groupedBadge = page.getByRole("button", { name: "2 linked issues" });
  await vi.waitFor(() =>
    expect(groupedBadge.element().querySelector("span")).toHaveClass(/text-emerald-600/),
  );
  await userEvent.hover(badge);
  const issueName = `Issue ${issue.displayKey}: ${liveTitle}`;
  const previewLink = page.getByRole("link", { name: issueName });
  await userEvent.hover(previewLink.getByText("sam", { exact: true }));
  await expect.element(previewLink).toBeVisible();
  const contextMenu = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
  await act(() => previewLink.element().dispatchEvent(contextMenu));
  expect(contextMenu.defaultPrevented).toBe(false);
  await userEvent.click(badge);
  const issueRow = page
    .getByRole("region", { name: "Linked issues" })
    .getByRole("link", { name: issueName });
  await expect.element(issueRow.getByRole("img", { name: "Open" })).toBeVisible();
  await expect.element(issueRow.getByRole("img", { name: "3 comments" })).toBeVisible();
  await expect.element(issueRow.getByRole("img", { name: "Linear" })).toBeVisible();
  await expect.element(issueRow.getByText(issue.scope, { exact: true })).toBeVisible();
  await userEvent.click(issueRow);
  expect(router.history.location.pathname).toBe(`/${ENVIRONMENT_ID}/${linked.id}`);
  await expect.element(page.getByRole("heading", { name: liveTitle })).toBeVisible();
  await act(() => useRightPanelStore.getState().close(scopeThreadRef(ENVIRONMENT_ID, linked.id)));
  await expect
    .element(
      page.getByRole("region", { name: "Thread details" }).getByRole("link", {
        name: issueName,
        exact: true,
      }),
    )
    .toBeVisible();
});

it("a machine chip stashed in one thread restores with its machine in another", async () => {
  const other = threadWithHistory("thread-stash-restore", 1);
  const asking = threadWithQuestion("thread-stash-question", "Which file should change?");
  using _environment = installFakeEnvironment([other, asking]);
  __setClientSettingsForTests({
    ...DEFAULT_CLIENT_SETTINGS,
    onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
  });
  const draftId = DraftId.make("draft-stash-machine");
  const machine = environmentContextRecord(EnvironmentId.make("environment-build"), "Build box");
  const drafts = useComposerDraftStore.getState();
  drafts.setProjectDraftThreadId(scopeProjectRef(ENVIRONMENT_ID, PROJECT_ID), draftId, {
    threadId: ThreadId.make("thread-stash-machine"),
  });
  drafts.setPrompt(draftId, "Deploy on ");
  drafts.addEnvironmentContexts(draftId, [machine]);
  const router = getRouter(createMemoryHistory({ initialEntries: [`/draft/${draftId}`] }));
  await router.load();
  await using _app = await render(<AppRoot router={router} />, {
    // AppRoot brings its own router.
    router: false,
  });
  const editor = page.getByTestId("composer-editor");
  const pressStashShortcut = async () => {
    await userEvent.click(editor);
    await userEvent.keyboard("{ControlOrMeta>}s{/ControlOrMeta}");
  };
  await vi.waitFor(() => expect(editor.element().textContent).toContain("Deploy on"));
  // A draft can't stash until the shell snapshot lists its project.
  await expect.element(page.getByText("render", { exact: true }).first()).toBeVisible();
  await pressStashShortcut();
  await vi.waitFor(() => expect(usePromptStashStore.getState().entries).toHaveLength(1));

  // An answer carries no machines, so an open question refuses the restore and keeps the entry.
  await router.navigate({ to: `/${ENVIRONMENT_ID}/${asking.id}` });
  await expect.element(page.getByText("Which file should change?")).toBeVisible();
  await userEvent.click(page.getByRole("button", { name: /^Stashed prompts/ }));
  await userEvent.click(page.getByRole("button", { name: /^Restore stashed prompt/ }));
  await vi.waitFor(() =>
    expect(document.body.textContent).toContain("Stashed machines can't go in an answer"),
  );
  expect(usePromptStashStore.getState().entries).toHaveLength(1);

  await router.navigate({ to: `/${ENVIRONMENT_ID}/${other.id}` });
  await expect.element(page.getByText("Answer 0 for thread-stash-restore.")).toBeVisible();
  await pressStashShortcut();

  await vi.waitFor(() => expect(editor.element().textContent).toContain("Deploy on"));
  expect(
    useComposerDraftStore.getState().getComposerDraft(scopeThreadRef(ENVIRONMENT_ID, other.id))
      ?.environmentContexts,
  ).toEqual([machine]);
  expect(
    useComposerDraftStore.getState().getComposerDraft(draftId)?.environmentContexts ?? [],
  ).toEqual([]);
});

it("a question that opens while a stashed file is checked keeps a machine stash", async () => {
  const thread = threadWithHistory("thread-stash-late-question", 1);
  const asking = threadWithQuestion("thread-stash-late-question", "Which file should change?");
  const [request] = asking.runtimeRequests ?? [];
  const question = asking.items.at(-1);
  if (!request || !question) throw new Error("threadWithQuestion has no question");
  using _environment = installFakeEnvironment([thread]);
  __setClientSettingsForTests({
    ...DEFAULT_CLIENT_SETTINGS,
    onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
  });
  usePromptStashStore.getState().stashEntry({
    id: "stash-late-question",
    createdAt: "2026-01-01T00:00:00.000Z",
    prompt: "Deploy on ",
    attachments: [],
    files: [
      {
        id: "file-notes",
        name: "notes.txt",
        mimeType: "text/plain",
        sizeBytes: 5,
        attachmentId: "attachment-notes",
        environmentId: ENVIRONMENT_ID,
      },
    ],
    droppedImageNames: [],
    records: [environmentContextRecord(EnvironmentId.make("environment-build"), "Build box")],
  });
  const router = getRouter(
    createMemoryHistory({ initialEntries: [`/${ENVIRONMENT_ID}/${thread.id}`] }),
  );
  await router.load();
  await using _app = await render(<AppRoot router={router} />, {
    // AppRoot brings its own router.
    router: false,
  });
  await expect.element(page.getByText("Answer 0 for thread-stash-late-question.")).toBeVisible();
  await userEvent.click(page.getByRole("button", { name: /^Stashed prompts/ }));
  await userEvent.click(page.getByRole("button", { name: /^Restore stashed prompt/ }));

  // The question opens while the restore still waits on the server's file check.
  await vi.waitFor(() => expect(hasPendingAssetUrl()).toBe(true));
  await emitThreadEvent(thread.id, { type: "turn-item.updated", payload: question });
  await emitThreadEvent(thread.id, { type: "runtime-request.updated", payload: request });
  await expect.element(page.getByText("Which file should change?")).toBeVisible();
  await answerAssetUrls();

  await vi.waitFor(() =>
    expect(document.body.textContent).toContain("Stashed machines can't go in an answer"),
  );
  expect(usePromptStashStore.getState().entries).toHaveLength(1);
  usePromptStashStore.getState().takeEntry("stash-late-question");
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

it("a failed image-only first send of a new thread keeps the new draft", async () => {
  using _environment = installFakeEnvironment([]);
  __setClientSettingsForTests({
    ...DEFAULT_CLIENT_SETTINGS,
    onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
  });
  const draftId = DraftId.make("draft-image-only-interrupted");
  useComposerDraftStore
    .getState()
    .setProjectDraftThreadId(scopeProjectRef(ENVIRONMENT_ID, PROJECT_ID), draftId, {
      threadId: ThreadId.make("thread-image-only-interrupted"),
    });
  // A refusal fails at once; an interrupted launch would wait for a reconnect and be resent.
  using launch = holdRpc(
    ORCHESTRATION_V2_WS_METHODS.launchThread,
    Effect.fail(new LaunchRefused()),
  );
  const router = getRouter(createMemoryHistory({ initialEntries: [`/draft/${draftId}`] }));
  await router.load();
  await using _app = await render(<AppRoot router={router} />, {
    // AppRoot brings its own router.
    router: false,
  });
  using _uploads = acceptAttachmentUploads();
  const editor = page.getByTestId("composer-editor");
  await expect.element(editor).toBeVisible();
  // The send needs the project, which arrives with the shell snapshot.
  await expect.element(page.getByText("render", { exact: true }).first()).toBeVisible();

  await userEvent.click(editor);
  const clipboardData = new DataTransfer();
  clipboardData.items.add(new File([PNG], "shot.png", { type: "image/png" }));
  editor
    .element()
    .dispatchEvent(new ClipboardEvent("paste", { clipboardData, bubbles: true, cancelable: true }));
  await expect.element(page.getByRole("img", { name: "shot.png" })).toBeVisible();
  await userEvent.keyboard("{Enter}");
  await vi.waitFor(() => expect(launch.calls).toHaveLength(1));
  await userEvent.keyboard("next draft");
  await expect.element(editor).toHaveTextContent("next draft");
  launch.release();

  await expect.element(page.getByText("Message not sent")).toBeVisible();
  await expect.element(editor).toHaveTextContent("next draft");
  // With no text there is nothing to copy.
  expect(page.getByText("Copy message", { exact: true }).query()).toBeNull();
});

it.each(["new", "existing"] as const)(
  "Enter while an image compresses shows a cancellable banner, cancels on edit or Esc, and still sends after leaving a %s thread",
  async (kind) => {
    const thread = threadWithHistory(`upload-wait-${kind}`, 1);
    const other = threadWithHistory(`upload-wait-other-${kind}`, 1);
    using _environment = installFakeEnvironment(kind === "existing" ? [thread, other] : [other], {
      acceptCommands: true,
    });
    __setClientSettingsForTests({
      ...DEFAULT_CLIENT_SETTINGS,
      onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
    });
    const draftId = DraftId.make(`draft-upload-wait-${kind}`);
    if (kind === "new") {
      useComposerDraftStore
        .getState()
        .setProjectDraftThreadId(scopeProjectRef(ENVIRONMENT_ID, PROJECT_ID), draftId, {
          threadId: thread.id,
        });
    }
    using launch = holdRpc(ORCHESTRATION_V2_WS_METHODS.launchThread, Effect.interrupt);
    const router = getRouter(
      createMemoryHistory({
        initialEntries: [kind === "new" ? `/draft/${draftId}` : `/${ENVIRONMENT_ID}/${thread.id}`],
      }),
    );
    await router.load();
    await using _app = await render(<AppRoot router={router} />, {
      // AppRoot brings its own router.
      router: false,
    });
    const compressed = Promise.withResolvers<void>();
    compression.gate = compressed.promise;
    using _compression = { [Symbol.dispose]: () => (compression.gate = null) };
    using _uploads = acceptAttachmentUploads();
    const editor = page.getByTestId("composer-editor");
    await expect.element(editor).toBeVisible();
    await expect.element(page.getByText("render", { exact: true }).first()).toBeVisible();

    await userEvent.click(editor);
    const clipboardData = new DataTransfer();
    clipboardData.items.add(new File([PNG], "shot.png", { type: "image/png" }));
    editor
      .element()
      .dispatchEvent(
        new ClipboardEvent("paste", { clipboardData, bubbles: true, cancelable: true }),
      );

    // Enter arms the send and shows the banner plus a disabled spinner button.
    await userEvent.keyboard("check image{Enter}");
    await expect.element(page.getByText("Sending once image is ready")).toBeVisible();
    const waitingButton = page.getByRole("button", { name: "Sending when ready", exact: true });
    await expect.element(waitingButton).toBeDisabled();
    await expect.element(waitingButton).toHaveAttribute("aria-busy", "true");

    // Typing disarms the queued send and keeps the edit.
    await userEvent.keyboard(" now");
    await expect.element(page.getByText("Sending once image is ready")).not.toBeInTheDocument();
    await expect.element(editor).toHaveTextContent("check image now");

    // Enter arms again; Esc cancels cleanly.
    await userEvent.keyboard("{Enter}");
    await expect.element(page.getByText("Sending once image is ready")).toBeVisible();
    await userEvent.keyboard("{Escape}");
    await expect.element(page.getByText("Sending once image is ready")).not.toBeInTheDocument();

    // Enter arms again; leaving the thread still sends once the image is ready.
    await userEvent.keyboard("{Enter}");
    await expect.element(page.getByText("Sending once image is ready")).toBeVisible();
    await router.navigate({ to: `/${ENVIRONMENT_ID}/${other.id}` });
    await expect.element(page.getByText(`Answer 0 for upload-wait-other-${kind}.`)).toBeVisible();

    compressed.resolve();
    await vi.waitFor(() => {
      if (kind === "new") {
        expect(launch.calls).toHaveLength(1);
      } else {
        expect(dispatchedCommands()).toContainEqual(
          expect.objectContaining({
            type: "message.dispatch",
            threadId: thread.id,
            attachments: [expect.objectContaining({ type: "image", id: "upload-1" })],
          }),
        );
      }
    });
    launch.release();
  },
);

it("a file picked after the phone composer collapses still attaches", async () => {
  const thread = threadWithHistory("thread-40993", 1);
  using _environment = installFakeEnvironment([thread]);
  await page.viewport(390, 844);
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
  using _uploads = acceptAttachmentUploads();
  const editor = page.getByTestId("composer-editor");
  await expect.element(page.getByText(`Answer 0 for ${thread.id}.`)).toBeVisible();
  await userEvent.click(editor);
  await expect.element(page.getByRole("button", { name: "Attach files" })).toBeVisible();
  const input = document.querySelector<HTMLInputElement>(
    'form[data-chat-composer-form] input[type="file"]',
  );
  expect(input).not.toBeNull();

  // Opening the native picker blurs the editor, which collapses the phone composer.
  (editor.element() as HTMLElement).blur();
  await expect.element(page.getByRole("button", { name: "Attach files" })).not.toBeInTheDocument();
  const files = new DataTransfer();
  files.items.add(new File([PNG], "picked.png", { type: "image/png" }));
  input!.files = files.files;
  input!.dispatchEvent(new Event("change", { bubbles: true }));

  await expect.element(page.getByRole("img", { name: "picked.png" })).toBeVisible();
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

it("retains each thread's diff selection when returning from another thread or Settings", async () => {
  const a = threadWithHistory("diff-selection-a", 1);
  const b = threadWithHistory("diff-selection-b", 1);
  using _environment = installFakeEnvironment([a, b]);
  __setClientSettingsForTests({
    ...DEFAULT_CLIENT_SETTINGS,
    onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
  });
  const aRef = scopeThreadRef(ENVIRONMENT_ID, a.id);
  const bRef = scopeThreadRef(ENVIRONMENT_ID, b.id);
  useRightPanelStore.getState().open(aRef, "diff");
  useRightPanelStore.getState().open(bRef, "diff");
  useDiffPanelStore.getState().selectBranchBaseRef(bRef, "origin/release");
  const router = getRouter(createMemoryHistory({ initialEntries: [`/${ENVIRONMENT_ID}/${a.id}`] }));
  await router.load();
  await using _app = await render(<AppRoot router={router} />, {
    // AppRoot brings its own router.
    router: false,
  });
  await expect.element(page.getByText(`Answer 0 for ${a.id}.`)).toBeVisible();
  await act(() => useDiffPanelStore.getState().selectGitScope(aRef, "unstaged"));

  await act(() =>
    router.navigate({
      to: "/$environmentId/$threadId",
      params: { environmentId: ENVIRONMENT_ID, threadId: b.id },
    }),
  );
  await expect.element(page.getByText(`Answer 0 for ${b.id}.`)).toBeVisible();
  expect(selectThreadDiffPanelSelection(useDiffPanelStore.getState().byThreadKey, bRef)).toEqual({
    kind: "branch",
    baseRef: "origin/release",
  });
  await act(() =>
    router.navigate({
      to: "/$environmentId/$threadId",
      params: { environmentId: ENVIRONMENT_ID, threadId: a.id },
    }),
  );
  await expect.element(page.getByText(`Answer 0 for ${a.id}.`)).toBeVisible();
  expect(selectThreadDiffPanelSelection(useDiffPanelStore.getState().byThreadKey, aRef)).toEqual({
    kind: "unstaged",
  });

  await act(() => useDiffPanelStore.getState().selectTurn(aRef, a.runs[0]!.id));
  await act(() => router.navigate({ to: "/settings/general" }));
  await expect
    .element(page.getByRole("heading", { name: "Time format", exact: true }))
    .toBeVisible();
  await act(() =>
    router.navigate({
      to: "/$environmentId/$threadId",
      params: { environmentId: ENVIRONMENT_ID, threadId: a.id },
    }),
  );
  await expect.element(page.getByText(`Answer 0 for ${a.id}.`)).toBeVisible();
  expect(
    selectThreadDiffPanelSelection(useDiffPanelStore.getState().byThreadKey, aRef),
  ).toMatchObject({
    kind: "turn",
    turnId: a.runs[0]!.id,
  });
});

it("a stashed prompt ending in a file chip restores with the chip", async () => {
  using _environment = installFakeEnvironment([]);
  __setClientSettingsForTests({
    ...DEFAULT_CLIENT_SETTINGS,
    onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
  });
  const draftId = DraftId.make("draft-28338");
  const drafts = useComposerDraftStore.getState();
  drafts.setProjectDraftThreadId(scopeProjectRef(ENVIRONMENT_ID, PROJECT_ID), draftId, {
    threadId: ThreadId.make("thread-28338"),
  });
  drafts.setPrompt(draftId, "Check [package.json](package.json) ");
  const router = getRouter(createMemoryHistory({ initialEntries: [`/draft/${draftId}`] }));
  await router.load();
  await using _app = await render(<AppRoot router={router} />, {
    // AppRoot brings its own router.
    router: false,
  });
  const chip = page.getByRole("button", { name: "Preview package.json" });
  await expect.element(chip).toBeVisible();
  // The stash shortcut is a no-op until the shell snapshot lists the project.
  await expect.element(page.getByText("render", { exact: true }).first()).toBeVisible();

  const editor = page.getByTestId("composer-editor");
  await userEvent.click(editor);
  await userEvent.keyboard("{ControlOrMeta>}s{/ControlOrMeta}");
  await expect.element(chip).not.toBeInTheDocument();
  await userEvent.keyboard("{ControlOrMeta>}s{/ControlOrMeta}");

  await vi.waitFor(() => expect(editor.element().textContent).toContain("Check"));
  expect(editor.element().textContent).not.toContain("[package.json](package.json)");
  await expect.element(chip).toBeVisible();
});

it("a rejected send leaves the timeline when a new draft was typed meanwhile", async () => {
  const thread = threadWithHistory("rejected-send", 1);
  using _environment = installFakeEnvironment([thread], {
    acceptCommands: true,
    holdCommand: (command) => command.type === "message.dispatch",
  });
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
  await expect.element(page.getByText(`Answer 0 for ${thread.id}.`)).toBeVisible();

  const editor = page.getByTestId("composer-editor");
  await userEvent.click(editor);
  await userEvent.keyboard("Failed prompt{Enter}");
  await vi.waitFor(() =>
    expect(dispatchedCommands().map((command) => command.type)).toContain("message.dispatch"),
  );
  await expect.element(page.getByText("Failed prompt")).toBeVisible();
  await userEvent.keyboard("Next draft");

  await rejectPendingCommand("Attachment 'sample.png' cannot be sent.");

  await expect.element(page.getByText("Attachment 'sample.png' cannot be sent.")).toBeVisible();
  await expect.element(page.getByText("Failed prompt")).not.toBeInTheDocument();
  expect(editor.element().textContent).toContain("Next draft");
});

it("Enter on an empty prompt resumes an interrupted thread", async () => {
  const history = threadWithHistory("interrupted", 1);
  const interruptedRun = { ...history.runs[0]!, status: "interrupted" as const };
  const thread = { ...history, runs: [interruptedRun] };
  using _environment = installFakeEnvironment([thread], { acceptCommands: true });
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
  await expect.element(page.getByRole("button", { name: "Resume thread" })).toBeVisible();

  await userEvent.click(page.getByTestId("composer-editor"));
  await userEvent.keyboard("{Enter}");

  await vi.waitFor(() =>
    expect(dispatchedCommands()).toContainEqual(
      expect.objectContaining({ manualContinuationOfRunId: interruptedRun.id }),
    ),
  );
});

it("opening a thread or returning to the window on a touch tablet does not focus the composer", async () => {
  const realMatchMedia = window.matchMedia.bind(window);
  using _touch = vi
    .spyOn(window, "matchMedia")
    .mockImplementation((query) => realMatchMedia(query === "(pointer: coarse)" ? "all" : query));
  const first = threadWithHistory("thread-29469-a", 1);
  const second = threadWithHistory("thread-29469-b", 1);
  using _environment = installFakeEnvironment([first, second]);
  // iPad Pro 11 in landscape: the desktop layout, above max-sm.
  await page.viewport(1194, 834);
  __setClientSettingsForTests({
    ...DEFAULT_CLIENT_SETTINGS,
    onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
  });
  const router = getRouter(
    createMemoryHistory({ initialEntries: [`/${ENVIRONMENT_ID}/${first.id}`] }),
  );
  await router.load();
  await using _app = await render(<AppRoot router={router} />, {
    // AppRoot brings its own router.
    router: false,
  });
  const composer = page.getByTestId("composer-editor");
  await expect.element(page.getByText(`Answer 0 for ${first.id}.`)).toBeVisible();

  // Fake frames hold the next thread entry's focus frame until the test advances it.
  using _timers = fakeTimers();
  await act(() =>
    router.navigate({
      to: "/$environmentId/$threadId",
      params: { environmentId: ENVIRONMENT_ID, threadId: second.id },
    }),
  );
  await expect.element(page.getByText(`Answer 0 for ${second.id}.`)).toBeVisible();
  vi.advanceTimersToNextFrame();
  // Focusing the editor raises the on-screen keyboard, which shrinks the page on iPadOS.
  expect(document.activeElement).not.toBe(composer.element());

  // ChatView waits two frames after window focus before refocusing the composer.
  window.dispatchEvent(new FocusEvent("focus"));
  vi.advanceTimersToNextFrame();
  vi.advanceTimersToNextFrame();
  expect(document.activeElement).not.toBe(composer.element());
});

it("a mounted thread view lets go of the thread structures it has replaced", async () => {
  // Items are shared with the fixture, so a reopen's snapshot also carries the earlier updates.
  const history = threadWithHistory("updated", 3);
  const items = [...history.items];
  const updated = { ...history, items };
  const other = threadWithHistory("other", 3);
  using _environment = installFakeEnvironment([updated, other]);
  __setClientSettingsForTests({
    ...DEFAULT_CLIENT_SETTINGS,
    onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
  });
  const router = getRouter(createMemoryHistory({ initialEntries: ["/"] }));
  await router.load();
  await using _app = await render(<AppRoot router={router} />, { router: false });
  const open = async (threadId: ThreadId, text: string) => {
    await act(() =>
      router.navigate({
        to: "/$environmentId/$threadId",
        params: { environmentId: ENVIRONMENT_ID, threadId },
      }),
    );
    await expect.element(page.getByText(text).first()).toBeVisible();
  };
  const structureAtom = environmentThreadDetails.quietThreadAtom(
    scopeThreadRef(ENVIRONMENT_ID, updated.id),
  );

  // Each round, a new answer arrives while the thread is shown, then the user switches away.
  const shown: Array<WeakRef<object>> = [];
  await open(other.id, "Answer 2 for other.");
  for (let round = 0; round < 6; round++) {
    await open(updated.id, round === 0 ? "Answer 2 for updated." : `Update ${round - 1}.`);
    const update = assistantItem(
      updated.id,
      RunId.make("updated-run-2"),
      `updated-update-${round}`,
      6 + round,
      `Update ${round}.`,
    );
    items.push(update);
    await act(() => emitThreadEvent(updated.id, { type: "turn-item.updated", payload: update }));
    await expect.element(page.getByText(`Update ${round}.`)).toBeVisible();
    shown.push(new WeakRef(appAtomRegistry.get(structureAtom)!.projection));
    await open(other.id, "Answer 2 for other.");
  }
  await cdp().send("HeapProfiler.collectGarbage");

  // The thread keeps its latest structure, and the timeline may remember the one before it.
  const kept = shown.slice(0, -2).flatMap((structure, round) => (structure.deref() ? [round] : []));
  expect(kept).toEqual([]);
});

it("a shortcut conditioned on rightPanelOpen sees the thread's open right panel", async () => {
  await page.viewport(1280, 800);
  const thread = threadWithHistory("thread-panel-shortcut", 1);
  using _environment = installFakeEnvironment([thread], {
    keybindings: mergeWithDefaultKeybindings(
      compileResolvedKeybindingsConfig([
        { key: "ctrl+t", command: "rightPanel.new", when: "rightPanelOpen && !terminalFocus" },
        { key: "ctrl+t", command: "rightPanel.toggle", when: "!rightPanelOpen" },
      ]),
    ),
  });
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
  const composer = page.getByTestId("composer-editor");
  const toggle = page.getByRole("button", { name: "Toggle right panel", exact: true });
  await expect.element(toggle).toHaveAttribute("aria-pressed", "false");
  await toggle.click();
  await page.getByRole("button", { name: /^Files/ }).click();
  await composer.click();
  await userEvent.keyboard("{Control>}t{/Control}");
  await expect.element(page.getByRole("menuitem", { name: /Files/ })).toBeVisible();
  await expect.element(toggle).toHaveAttribute("aria-pressed", "true");
});

it("selecting a side-chat tab focuses that side chat's composer", async () => {
  const parent = threadWithHistory("focus-parent", 1);
  // The shell loaded by the file's first test stays; a family read serves side chats added later.
  const sideChat = (name: string) => ({
    ...threadWithHistory(name, 1),
    sideChatOf: parent.id,
    olderSettled: true as const,
  });
  const side = sideChat("focus-side");
  const otherSide = sideChat("focus-other-side");
  await page.viewport(1400, 900);
  using _environment = installFakeEnvironment([parent, side, otherSide]);
  __setClientSettingsForTests({
    ...DEFAULT_CLIENT_SETTINGS,
    onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
  });
  const parentRef = scopeThreadRef(ENVIRONMENT_ID, parent.id);
  useRightPanelStore.getState().openThread(parentRef, otherSide.id);
  useRightPanelStore.getState().openThread(parentRef, side.id);
  const router = getRouter(
    createMemoryHistory({ initialEntries: [`/${ENVIRONMENT_ID}/${parent.id}`] }),
  );
  await router.load();
  await using screen = await render(<AppRoot router={router} />, {
    // AppRoot brings its own router.
    router: false,
  });
  using _focus = { [Symbol.dispose]: startWorkspaceFocus(router) };
  const mainEditor = screen.getByRole("textbox", { name: `Message ${parent.title}`, exact: true });
  const sideEditor = screen.getByRole("textbox", { name: `Message ${side.title}`, exact: true });
  await expect.element(sideEditor).toBeVisible();
  await userEvent.click(mainEditor);
  await userEvent.keyboard("main draft");

  await userEvent.click(screen.getByRole("button", { name: otherSide.title, exact: true }));
  const otherEditor = screen.getByRole("textbox", {
    name: `Message ${otherSide.title}`,
    exact: true,
  });
  await expect.element(otherEditor).toHaveFocus();
  await userEvent.keyboard("other draft");
  await expect.element(otherEditor).toHaveTextContent("other draft");

  await userEvent.click(screen.getByRole("button", { name: side.title, exact: true }));
  await expect.element(sideEditor).toHaveFocus();
  await expect.element(mainEditor).toHaveTextContent("main draft");
});

it("a subagent tab shows its read-only bar under no header of its own", async () => {
  const parent = threadWithHistory("subagent-parent", 1);
  const subagent = {
    ...threadWithHistory("subagent-child", 1),
    providerSubagentOf: parent.id,
    olderSettled: true as const,
  };
  await page.viewport(1400, 900);
  using _environment = installFakeEnvironment([parent, subagent]);
  __setClientSettingsForTests({
    ...DEFAULT_CLIENT_SETTINGS,
    vimModeEnabled: true,
    onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
  });
  const parentRef = scopeThreadRef(ENVIRONMENT_ID, parent.id);
  useRightPanelStore.getState().openThread(parentRef, subagent.id);
  const router = getRouter(
    createMemoryHistory({ initialEntries: [`/${ENVIRONMENT_ID}/${parent.id}`] }),
  );
  await router.load();
  await using screen = await render(<AppRoot router={router} />, {
    // AppRoot brings its own router.
    router: false,
  });
  const pane = screen.getByTestId("side-thread-pane");
  // No header of its own: the tab names it, and only a side chat has actions to put in one.
  await expect.element(pane.getByRole("heading", { name: subagent.title })).not.toBeInTheDocument();
  await expect.element(pane.getByText("Runs on its own")).toBeVisible();
  await expect.element(pane.getByRole("button", { name: "Add to chat" })).not.toBeInTheDocument();
  await expect
    .element(screen.getByRole("textbox", { name: `Message ${subagent.title}`, exact: true }))
    .not.toBeInTheDocument();
  await expect
    .element(screen.getByRole("textbox", { name: `Message ${parent.title}`, exact: true }))
    .toBeVisible();
  const enter = pane.getByRole("button", { name: "Enter Vim normal mode" });
  await expect.element(pane.getByText("INSERT", { exact: true })).not.toBeInTheDocument();
  await enter.click();
  await expect.element(pane.getByRole("button", { name: "Exit Vim navigation" })).toHaveFocus();
  await userEvent.keyboard("ggvip");
  await vi.waitFor(() => expect(document.getSelection()?.toString()).toContain("subagent-child"));
  await userEvent.keyboard("{Escape}{Escape}");
  await expect.element(enter).toHaveFocus();
  await expect.element(pane.getByText("NORMAL", { exact: true })).not.toBeInTheDocument();
});

it("/side sends the draft's attachments and context, and keeps them when it does not start", async () => {
  await page.viewport(1400, 900);
  const thread = threadWithHistory("side-attachments", 1);
  let holdFork = false;
  using _environment = installFakeEnvironment([thread], {
    acceptCommands: true,
    holdCommand: (command) => holdFork && command.type === "thread.fork",
  });
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
  using _uploads = acceptAttachmentUploads();
  await expect.element(page.getByText(`Answer 0 for ${thread.id}.`)).toBeVisible();

  const editor = page.getByRole("textbox", { name: `Message ${thread.title}`, exact: true });
  const image = page.getByRole("img", { name: "shot.png" });
  const sendImageToSideChat = async () => {
    await userEvent.click(editor);
    const clipboardData = new DataTransfer();
    clipboardData.items.add(new File([PNG], "shot.png", { type: "image/png" }));
    editor
      .element()
      .dispatchEvent(
        new ClipboardEvent("paste", { clipboardData, bubbles: true, cancelable: true }),
      );
    await expect.element(image).toBeVisible();
    await insertText("/side what is this?");
    await userEvent.keyboard("{Enter}");
    await expect.element(image).not.toBeInTheDocument();
  };
  // The tab opens once the start finished; until then `/side` refuses another side chat.
  const sideChatTabs = page.getByRole("button", { name: "Side chat", exact: true });
  const sentMessage = async (fields: Record<string, unknown>, openTabs: number) => {
    await vi.waitFor(() =>
      expect(dispatchedCommands()).toContainEqual(
        expect.objectContaining({ type: "message.dispatch", ...fields }),
      ),
    );
    await expect.element(sideChatTabs).toHaveLength(openTabs);
  };

  await sendImageToSideChat();
  await sentMessage(
    {
      text: "what is this?",
      attachments: [expect.objectContaining({ type: "image", id: "upload-1" })],
      context: {
        version: 1,
        records: [expect.objectContaining({ kind: "image", attachmentId: "upload-1" })],
      },
    },
    1,
  );

  // A reply alone is enough to send.
  await page.getByRole("button", { name: "Reply to this response" }).first().click();
  await userEvent.click(editor);
  await insertText("/side ");
  await userEvent.keyboard("{Enter}");
  await sentMessage(
    {
      context: expect.objectContaining({
        records: [expect.objectContaining({ kind: "response" })],
      }),
    },
    2,
  );

  // A failed start puts the message back after the draft typed meanwhile.
  holdFork = true;
  await sendImageToSideChat();
  await insertText("next draft");
  await vi.waitFor(() =>
    expect(dispatchedCommands().filter((command) => command.type === "thread.fork")).toHaveLength(
      3,
    ),
  );
  await rejectPendingCommand("Side chats are paused.");
  await expect.element(image).toBeVisible();
  await vi.waitFor(() =>
    expect((editor.element() as HTMLElement).innerText.split("\n").filter(Boolean)).toEqual([
      "next draft",
      "/side what is this?",
    ]),
  );
});

it("opening Settings without a page event closes the composer model picker and permissions menu", async () => {
  using _environment = installFakeEnvironment([]);
  __setClientSettingsForTests({
    ...DEFAULT_CLIENT_SETTINGS,
    onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
  });
  const draftId = DraftId.make("draft-29219");
  useComposerDraftStore
    .getState()
    .setProjectDraftThreadId(scopeProjectRef(ENVIRONMENT_ID, PROJECT_ID), draftId, {
      threadId: ThreadId.make("thread-29219"),
    });

  const router = getRouter(createMemoryHistory({ initialEntries: [`/draft/${draftId}`] }));
  await router.load();
  await using _app = await render(<AppRoot router={router} />, {
    // AppRoot brings its own router.
    router: false,
  });
  await expect.element(page.getByTestId("composer-editor")).toBeVisible();
  const trigger = document.querySelector<HTMLElement>("[data-chat-provider-model-picker]");
  if (!trigger) throw new Error("composer model picker trigger missing");
  await userEvent.click(trigger);
  const search = page.getByPlaceholder("Search models...");
  await expect.element(search).toBeVisible();

  // The desktop menu's open-settings accelerator navigates with no key or pointer event in the page.
  await act(() => router.navigate({ to: "/settings" }));
  await expect.element(page.getByRole("dialog", { name: "Settings" })).toBeVisible();
  await expect.element(search).not.toBeInTheDocument();

  await act(() => router.navigate({ to: "/draft/$draftId", params: { draftId } }));
  await page.getByRole("button", { name: /^Permissions: / }).click();
  // The modal Settings dialog aria-hides everything outside it, so match text, not role.
  const permissions = page.getByText("Allow commands and edits without prompts.").last();
  await expect.element(permissions).toBeVisible();
  await act(() => router.navigate({ to: "/settings" }));
  await expect.element(page.getByRole("dialog", { name: "Settings" })).toBeVisible();
  await expect.element(permissions).not.toBeInTheDocument();
});

it("selects and yanks sent prompts and assistant replies across virtualized Vim history", async () => {
  using _style = installStylesheet();
  await page.viewport(1280, 800);
  const thread = threadWithHistory("vim-replies", 24);
  const paragraph = "我的👩🏽‍💻提问";
  const prompt = paragraph + "\n\n检查build_step结果";
  const reply = assistantItem(
    thread.id,
    thread.runs[1]!.id,
    "vim-replies-assistant-1",
    3,
    "中**文**👩🏽‍💻测试  \n仍在同一段\n\n第二段",
  );
  using _environment = installFakeEnvironment([
    {
      ...thread,
      items: thread.items.map((item) => {
        if (item.id === reply.id) return reply;
        if (item.type === "user_message" && item.ordinal === 0) return { ...item, text: prompt };
        if (item.type === "user_message" && item.ordinal === 4) return { ...item, text: "" };
        return item;
      }),
    },
  ]);
  __setClientSettingsForTests({
    ...DEFAULT_CLIENT_SETTINGS,
    onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
  });
  const router = getRouter(
    createMemoryHistory({ initialEntries: [`/${ENVIRONMENT_ID}/${thread.id}`] }),
  );
  await router.load();
  await using _app = await render(<AppRoot router={router} />, {
    router: false,
  });
  const toggleVimInSettings = async (enabled: boolean) => {
    await act(() => router.navigate({ to: "/settings/chat" }));
    const toggle = page.getByRole("switch", { name: "Vim mode" });
    await expect.element(toggle).toHaveAttribute("aria-checked", String(!enabled));
    await toggle.click();
    await expect.element(toggle).toHaveAttribute("aria-checked", String(enabled));
    await act(() =>
      router.navigate({
        to: "/$environmentId/$threadId",
        params: { environmentId: ENVIRONMENT_ID, threadId: thread.id },
      }),
    );
    await expect.element(page.getByRole("dialog", { name: "Settings" })).not.toBeInTheDocument();
  };
  const editor = page.getByTestId("composer-editor");
  using write = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue(undefined);
  await expect.element(page.getByText(`Answer 23 for ${thread.id}.`)).toBeVisible();
  const modeButton = page.getByRole("button", { name: "Enter Vim normal mode" });
  await expect.element(modeButton).not.toBeInTheDocument();
  await toggleVimInSettings(true);
  await expect.element(modeButton).toBeVisible();
  await userEvent.click(editor);
  await userEvent.keyboard("draft");
  await expect.element(editor).toHaveTextContent("draft");
  await userEvent.keyboard("{ArrowLeft}");
  expect(document.getSelection()?.anchorOffset).toBe(4);
  const cursor = () => vimCursorRange()?.toString();
  await userEvent.keyboard("{Escape}");
  await vi.waitFor(() => expect(cursor()).toMatch(/^.$/u));
  expect(document.getSelection()?.toString()).toBe("");
  await userEvent.keyboard("gg");
  await vi.waitFor(() => expect(cursor()).toBe("我"));
  expect(document.getSelection()?.toString()).toBe("");
  await userEvent.keyboard("ll");
  expect(cursor()).toBe("👩🏽‍💻");
  const clipboard = Promise.withResolvers<void>();
  write.mockImplementationOnce(() => clipboard.promise);
  await userEvent.keyboard("vy");
  expect(write).toHaveBeenCalledWith("👩🏽‍💻");
  await expect.element(page.getByText("NORMAL", { exact: true })).toBeVisible();
  clipboard.resolve();
  expect(cursor()).toBe("👩🏽‍💻");
  await userEvent.keyboard("vip");
  expect(document.getSelection()?.toString()).toBe(paragraph);
  await userEvent.keyboard("y");
  await vi.waitFor(() => expect(write).toHaveBeenCalledWith(paragraph + "\n"));
  expect(cursor()).toBe("我");
  write.mockClear();
  await userEvent.keyboard("yip");
  expect(write).toHaveBeenCalledWith(paragraph + "\n");
  expect(document.getSelection()?.toString()).toBe("");
  await userEvent.keyboard("jwviw");
  expect(document.getSelection()?.toString()).toBe("build_step");
  await userEvent.keyboard("{Escape}yiw");
  await vi.waitFor(() => expect(write).toHaveBeenCalledWith("build_step"));
  await userEvent.keyboard("gg");
  await userEvent.keyboard("vll");
  expect(document.getSelection()?.toString()).toBe("我的👩🏽‍💻");
  await userEvent.keyboard("y");
  await vi.waitFor(() => expect(write).toHaveBeenCalledWith("我的👩🏽‍💻"));
  await expect.element(page.getByText("NORMAL", { exact: true })).toBeVisible();
  await userEvent.keyboard("JJ");
  const nextPrompt = page.getByText("vim-replies: question 1", { exact: true });
  await expect.element(nextPrompt).toBeInViewport();
  expect(nextPrompt.element().closest("[data-vim-message]")).toBeTruthy();
  await userEvent.keyboard("Jvll");
  expect(document.getSelection()?.toString()).toBe("中文👩🏽‍💻");
  await userEvent.keyboard("ia");
  await expect.element(page.getByText("VISUAL", { exact: true })).toBeVisible();
  expect(document.getSelection()?.toString()).toBe("中文👩🏽‍💻");
  await act(() =>
    emitThreadEvent(thread.id, {
      type: "turn-item.updated",
      payload: { ...reply, text: reply.text + "续写", streaming: true },
    }),
  );
  await expect.element(page.getByText("第二段续写")).toBeVisible();
  expect(document.getSelection()?.toString()).toBe("中文👩🏽‍💻");
  await userEvent.keyboard("{Escape}vip");
  expect(document.getSelection()?.toString()).toContain("仍在同一段");
  expect(document.getSelection()?.toString()).not.toContain("第二段");
  await userEvent.keyboard("y");
  await vi.waitFor(() => expect(write).toHaveBeenCalledWith("中文👩🏽‍💻测试\n仍在同一段\n"));
  await userEvent.keyboard("v");
  await userEvent.keyboard("jjj$");
  expect(document.getSelection()?.toString()).toContain("第二段");
  await userEvent.keyboard("{Escape}j");
  await vi.waitFor(() =>
    expect(document.querySelector("[data-vim-message]")?.textContent).toContain("Answer 2 for"),
  );
  await userEvent.keyboard("KK");
  await vi.waitFor(() =>
    expect(document.querySelector("[data-vim-message]")?.textContent).toBe(
      "vim-replies: question 1",
    ),
  );
  await userEvent.keyboard("G");
  await vi.waitFor(() =>
    expect(document.querySelector("[data-vim-message]")?.textContent).toContain("Answer 23 for"),
  );
  await userEvent.keyboard("ggvip");
  await vi.waitFor(() => expect(document.getSelection()?.toString()).toBe(paragraph));
  const promptBody = document.querySelector("[data-user-message-body][data-vim-message]");
  expect(promptBody).toHaveAttribute("tabindex", "-1");
  await userEvent.keyboard("{Escape}i");
  expect(promptBody).not.toHaveAttribute("tabindex");
  await expect.element(editor).toHaveFocus();
  expect(cursor()).toBeUndefined();
  expect(document.getSelection()?.anchorOffset).toBe(4);
  await userEvent.keyboard("!");
  expect(editor.element().textContent).toBe("draf!t");
  await toggleVimInSettings(false);
  await expect.element(modeButton).not.toBeInTheDocument();
  await userEvent.click(editor);
  await userEvent.keyboard("vjk");
  expect(editor.element().textContent).toContain("vjk");
  expect(document.getSelection()?.toString()).toBe("");
});

it("pages smoothly through a tall Vim reply and extends the Visual selection by a screen", async () => {
  using _style = installStylesheet();
  await page.viewport(1100, 700);
  const thread = threadWithHistory("vim-paging", 2);
  const longPrompt = Array.from({ length: 36 }, (_, index) => `Prompt paragraph ${index}.`).join(
    "\n\n",
  );
  const reply = assistantItem(
    thread.id,
    thread.runs[1]!.id,
    "vim-paging-assistant-1",
    3,
    Array.from({ length: 100 }, (_, index) => {
      if (index === 98)
        return `Paragraph 98 wraps across several screens. ${"wrapped text ".repeat(400)}`;
      if (index === 97) return ["```", "x".repeat(240), "```"].join("\n");
      return `Paragraph ${index} about keyboard navigation.`;
    }).join("\n\n"),
  );
  using _environment = installFakeEnvironment(
    [
      {
        ...thread,
        items: thread.items.map((item) => {
          if (item.id === reply.id) return reply;
          if (item.type === "user_message" && item.ordinal === 2)
            return { ...item, text: longPrompt };
          return item;
        }),
      },
    ],
    {
      keybindings: mergeWithDefaultKeybindings(
        compileResolvedKeybindingsConfig([
          { key: "ctrl+d", command: "diff.toggle" },
          { key: "ctrl+f", command: "chat.find" },
          { key: "ctrl+b", command: "sidebar.toggle" },
          { key: "ctrl+u", command: "usage.open" },
        ]),
      ),
    },
  );
  __setClientSettingsForTests({
    ...DEFAULT_CLIENT_SETTINGS,
    vimModeEnabled: true,
    wordWrap: false,
    onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
  });
  const router = getRouter(
    createMemoryHistory({ initialEntries: [`/${ENVIRONMENT_ID}/${thread.id}`] }),
  );
  await router.load();
  await using _app = await render(<AppRoot router={router} />, { router: false });
  const editor = page.getByTestId("composer-editor");
  await expect.element(page.getByText("Paragraph 99 about keyboard navigation.")).toBeVisible();
  await userEvent.click(editor);
  await userEvent.keyboard("draft{Escape}ggJJ");
  const promptBody = page
    .getByText("Prompt paragraph 0.", { exact: true })
    .element()
    .closest<HTMLElement>("[data-user-message-body]")!;
  await vi.waitFor(() => expect(promptBody.dataset.userMessageCollapsed).toBe("true"));
  await expect.element(page.getByText("Prompt paragraph 0.", { exact: true })).toBeInViewport();
  await userEvent.keyboard("v");
  await vi.waitFor(() => expect(promptBody.dataset.userMessageCollapsed).toBe("false"));
  await userEvent.keyboard("{PageDown}");
  expect(document.getSelection()?.toString()).toContain("Prompt paragraph 8.");
  await vi.waitFor(() => {
    const caret = vimCursorRange()!.getBoundingClientRect();
    expect(caret.bottom).toBeLessThanOrEqual(
      editor.element().closest("[data-chat-composer-stack]")!.getBoundingClientRect().top,
    );
    expect(caret.top).toBeGreaterThanOrEqual(
      promptBody.closest(".messages-timeline-scroll")!.getBoundingClientRect().top,
    );
  });
  await userEvent.keyboard("{Escape}J");
  const source = page.getByText("Paragraph 0 about keyboard navigation.");
  await expect.element(source).toBeInViewport();
  const scroll = source.element().closest<HTMLElement>(".messages-timeline-scroll")!;
  const modeLabel = page.getByText("NORMAL", { exact: true }).element();
  const modeButton = modeLabel.closest("button")!;
  await userEvent.hover(modeButton);
  expect(getComputedStyle(modeButton).textDecorationLine).toBe("none");
  expect(getComputedStyle(modeButton).outlineStyle).toBe("none");
  const normalColor = getComputedStyle(modeLabel).color;
  const start = scroll.scrollTop;
  const viewport = scroll.getBoundingClientRect();
  const composerTop = editor
    .element()
    .closest("[data-chat-composer-stack]")!
    .getBoundingClientRect().top;
  const half = (Math.min(viewport.bottom, composerTop) - viewport.top - 36) / 2;
  const at = (offset: number) =>
    vi.waitFor(() => expect(Math.abs(scroll.scrollTop - offset)).toBeLessThan(5));
  const offsets: number[] = [];
  const trackScroll = () => offsets.push(scroll.scrollTop);
  const session = cdp();
  onTestFinished(async () => {
    await session.send("Emulation.setEmulatedMedia", { features: [] });
  });
  const setMotion = (value: string) =>
    session.send("Emulation.setEmulatedMedia", {
      features: [{ name: "prefers-reduced-motion", value }],
    });
  await setMotion("no-preference");
  scroll.addEventListener("scroll", trackScroll);
  await userEvent.keyboard("{Control>}d{/Control}");
  await at(start + half);
  scroll.removeEventListener("scroll", trackScroll);
  expect(offsets.some((offset) => offset > start + 1 && offset < start + half - 1)).toBe(true);
  await userEvent.keyboard("{Control>}f{/Control}");
  await at(start + 3 * half);
  await userEvent.keyboard("{PageUp}{Control>}u{/Control}");
  await at(start);
  await userEvent.keyboard(" {PageDown}{Control>}b{/Control}");
  await at(start + 2 * half);
  const pageTop = scroll.scrollTop;
  await userEvent.keyboard("v");
  expect(getComputedStyle(page.getByText("VISUAL", { exact: true }).element()).color).not.toBe(
    normalColor,
  );
  expect(getComputedStyle(modeButton).textDecorationLine).toBe("none");
  for (const key of ["PageDown", "Escape"]) {
    modeButton.dispatchEvent(
      new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }),
    );
  }
  const normalCell = vimCursorRange()!.getBoundingClientRect();
  expect(normalCell.bottom).toBeGreaterThan(viewport.top);
  expect(normalCell.bottom).toBeLessThanOrEqual(composerTop);
  await userEvent.keyboard("v");
  const initial = document.getSelection()!.getRangeAt(0);
  const top = scroll.getBoundingClientRect().top;
  expect(initial.getBoundingClientRect().bottom).toBeGreaterThan(top);
  expect(Math.abs(scroll.scrollTop - pageTop)).toBeLessThan(32);
  await userEvent.keyboard("{PageDown}");
  expect(document.getSelection()?.toString()).toMatch(/Paragraph \d+[\s\S]+Paragraph \d+/);
  await vi.waitFor(() => expect(scroll.scrollTop - start).toBeGreaterThan(3 * half));
  await userEvent.keyboard("{Control>}b{/Control}");
  await vi.waitFor(() => expect(Math.abs(scroll.scrollTop - pageTop)).toBeLessThan(32));
  await userEvent.keyboard("{Escape}");
  await setMotion("reduce");
  const from = scroll.scrollTop;
  offsets.length = 0;
  scroll.addEventListener("scroll", trackScroll);
  await userEvent.keyboard("{Control>}d{/Control}");
  await at(from + half);
  scroll.removeEventListener("scroll", trackScroll);
  expect(offsets.some((offset) => offset > from + 1 && offset < from + half - 1)).toBe(false);
  const jump = async (keys: string, line: string, smooth: boolean) => {
    const origin = scroll.scrollTop;
    offsets.length = 0;
    await userEvent.keyboard(keys);
    await vi.waitFor(() => {
      const range = vimCursorRange();
      expect(range?.startContainer.textContent).toContain(line);
      const rect = range!.getBoundingClientRect();
      expect(rect.top).toBeGreaterThanOrEqual(viewport.top);
      expect(rect.bottom).toBeLessThanOrEqual(composerTop);
    });
    const low = Math.min(origin, scroll.scrollTop);
    const high = Math.max(origin, scroll.scrollTop);
    expect(high - low).toBeGreaterThan(half);
    expect(offsets.some((offset) => offset > low + half / 2 && offset < high - half / 2)).toBe(
      smooth,
    );
  };
  scroll.addEventListener("scroll", trackScroll);
  await setMotion("no-preference");
  await jump("gg", "vim-paging: question 0", true);
  await userEvent.keyboard("G");
  await vi.waitFor(() => expect(scroll.scrollTop).toBeGreaterThan(2 * viewport.height));
  await jump("ggvip", "vim-paging: question 0", true);
  expect(document.getSelection()?.toString()).toBe("vim-paging: question 0");
  await userEvent.keyboard("{Escape}");
  await jump("G", "Paragraph 99", true);
  await jump("k", "Paragraph 98 wraps", true);
  await jump("j", "Paragraph 99", true);
  await jump("K", "Prompt paragraph 35.", true);
  await jump("gg", "vim-paging: question 0", true);
  await userEvent.keyboard("JJ");
  await jump("J", "Paragraph 0 about keyboard navigation.", true);
  await setMotion("reduce");
  await jump("gg", "vim-paging: question 0", false);
  await jump("G", "Paragraph 99", false);
  await setMotion("no-preference");
  await userEvent.keyboard("kk$");
  const codeCell = vimCursorRange()!;
  const code = codeCell.startContainer.parentElement!.closest("pre")!;
  expect(code.scrollLeft).toBeGreaterThan(0);
  expect(codeCell.getBoundingClientRect().right).toBeLessThanOrEqual(
    code.getBoundingClientRect().right + 1,
  );
  await setMotion("reduce");
  await userEvent.keyboard("G");
  await jump("K", "Prompt paragraph 35.", false);
  scroll.removeEventListener("scroll", trackScroll);
  await userEvent.keyboard("i");
  expect(editor.element().textContent).toBe("draft");
});

it("keeps intermediate messages visible while Vim scrolls to either end of a long thread", async () => {
  using _style = installStylesheet();
  await page.viewport(1100, 700);
  const thread = threadWithHistory("vim-long-jumps", 100);
  const lastReply = "End of the long conversation.";
  const wideLine = `${"0123456789".repeat(30)}Z`;
  using _environment = installFakeEnvironment([
    {
      ...thread,
      items: thread.items.map((item) => {
        if (item.type !== "assistant_message") return item;
        if (item.ordinal === 197) return { ...item, text: ["```", wideLine, "```"].join("\n") };
        if (item.ordinal === 199) return { ...item, text: lastReply };
        return item;
      }),
    },
  ]);
  __setClientSettingsForTests({
    ...DEFAULT_CLIENT_SETTINGS,
    vimModeEnabled: true,
    wordWrap: false,
    onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
  });
  const router = getRouter(
    createMemoryHistory({ initialEntries: [`/${ENVIRONMENT_ID}/${thread.id}`] }),
  );
  await router.load();
  await using _app = await render(<AppRoot router={router} />, { router: false });
  const last = page.getByText(lastReply);
  await expect.element(last).toBeVisible();
  const scroll = last.element().closest<HTMLElement>(".messages-timeline-scroll")!;
  const viewport = scroll.getBoundingClientRect();
  const scrollTo = scroll.scrollTo.bind(scroll);
  using _nativeScroll = vi
    .spyOn(scroll, "scrollTo")
    .mockImplementation((x?: ScrollToOptions | number, y?: number) => {
      if (typeof x === "number") return scrollTo(x, y ?? 0);
      if (
        x?.behavior === "smooth" &&
        Math.abs((x.top ?? scroll.scrollTop) - scroll.scrollTop) > 2 * viewport.height
      )
        return scrollTo({ ...x, behavior: "instant" });
      return scrollTo(x);
    });
  const editor = page.getByTestId("composer-editor");
  const composer = editor.element().closest("[data-chat-composer-stack]")!;
  await userEvent.click(editor);
  await userEvent.keyboard("{Escape}");
  for (const [key, end] of [
    ["gg", "vim-long-jumps: question 0"],
    ["G", lastReply],
  ] as const) {
    const positions: number[] = [];
    const visibleRows = new Set<string>();
    const record = () => {
      positions.push(scroll.scrollTop);
      const row = document
        .elementFromPoint(viewport.left + viewport.width / 2, viewport.top + viewport.height / 2)
        ?.closest<HTMLElement>("[data-timeline-row-id]");
      if (row?.dataset.timelineRowId) visibleRows.add(row.dataset.timelineRowId);
    };
    record();
    scroll.addEventListener("scroll", record);
    try {
      await userEvent.keyboard(key);
      await vi.waitFor(
        () => {
          const caret = vimCursorRange();
          expect(caret?.startContainer.textContent).toBe(end);
          const rect = caret!.getBoundingClientRect();
          expect(rect.height).toBeGreaterThan(0);
          expect(rect.top).toBeGreaterThanOrEqual(viewport.top);
          expect(rect.bottom).toBeLessThanOrEqual(composer.getBoundingClientRect().top);
        },
        { timeout: 5000 },
      );
      record();
    } finally {
      scroll.removeEventListener("scroll", record);
    }
    const distance = Math.abs(positions.at(-1)! - positions[0]!);
    const maxStep = Math.max(
      ...positions.slice(1).map((top, index) => Math.abs(top - positions[index]!)),
    );
    expect(distance).toBeGreaterThan(10 * viewport.height);
    expect(maxStep / distance).toBeLessThan(0.4);
    expect(visibleRows.size).toBeGreaterThan(3);
    if (key === "gg") {
      const follow = page.getByRole("button", { name: "Scroll to end" });
      await expect.element(follow).toBeVisible();
      using _frames = fakeTimers();
      follow.element().closest("button")!.click();
      scroll.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: -100 }));
      await act(() => vi.advanceTimersToNextFrame());
      expect(scroll.scrollTop).toBeLessThan(viewport.height);
    }
  }
  const line = page.getByText(wideLine, { exact: true });
  await userEvent.keyboard("KK");
  await expect.element(line).toBeInViewport();
  await userEvent.keyboard("$");
  const originalBlock = line.element().closest("pre")!;
  expect(originalBlock.scrollLeft).toBeGreaterThan(0);
  const cell = vimCursorRange()!;
  expect(cell.toString()).toBe("Z");
  const returnTop = Math.round(
    scroll.scrollTop + cell.getBoundingClientRect().top - viewport.bottom - 24,
  );
  scroll.scrollTop = 0;
  await expect.element(line).not.toBeInTheDocument();
  scroll.scrollTop = returnTop;
  await vi.waitFor(() => {
    const block = line.element().closest("pre")!;
    const restored = vimCursorRange()!;
    expect(block).not.toBe(originalBlock);
    expect(block.contains(restored.startContainer)).toBe(true);
    expect(restored.toString()).toBe("Z");
    const rect = restored.getBoundingClientRect();
    const bounds = block.getBoundingClientRect();
    expect(rect.left).toBeGreaterThanOrEqual(bounds.left - 1);
    expect(rect.right).toBeLessThanOrEqual(bounds.right + 1);
    expect(rect.top).toBeGreaterThan(viewport.bottom);
    expect(scroll.scrollTop).toBe(returnTop);
  });
  for (const shiftKey of [false, true]) {
    await userEvent.keyboard("f");
    const tab = new KeyboardEvent("keydown", {
      key: "Tab",
      shiftKey,
      bubbles: true,
      cancelable: true,
    });
    document.activeElement!.dispatchEvent(tab);
    expect(tab.defaultPrevented).toBe(false);
  }
});

it("lands inside the taller cell when paging through a Markdown table", async () => {
  await using screen = await render(
    <table style={{ whiteSpace: "pre", lineHeight: "24px" }}>
      <tbody>
        <tr style={{ verticalAlign: "top" }}>
          <td>{"first\nsecond\nthird"}</td>
          <td>short</td>
        </tr>
        <tr>
          <td>next row</td>
        </tr>
      </tbody>
    </table>,
  );
  const reader = openVimMessageText(screen.container);
  try {
    reader.moveToScreenY(screen.getByText("short").element().getBoundingClientRect().top + 36);
    expect(reader.paint(false)?.toString()).toBe("s");
  } finally {
    reader.close();
  }
});
