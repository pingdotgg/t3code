// Render scenarios that mount the whole app (AppRoot with the app's router) on a thread,
// against the in-process environment in fakeEnvironment.ts. Counts cover ChatView, the
// chat and settings routes, the sidebar and the right panel, through the same stores and
// atoms the app reads. See renderScenarios.renders.tsx for the counting rules.
import { createMemoryHistory } from "@tanstack/react-router";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { NodeId, RuntimeRequestId, TurnItemId, type ThreadId } from "@t3tools/contracts";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import type * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import { AsyncResult } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";
import { commands, page, userEvent } from "vite-plus/test/browser";

import "~/index.css";

import { AppRoot } from "~/AppRoot";
import { __setClientSettingsForTests } from "~/hooks/useSettings";
import { useRightPanelStore } from "~/rightPanelStore";
import { getRouter, type AppRouter } from "~/router";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { vcsEnvironment } from "~/state/vcs";
import {
  ENVIRONMENT_ID,
  assistantItem,
  emitTerminalMetadata,
  emitThreadEvent,
  emitVcsStatus,
  installFakeEnvironment,
  isThreadSubscribed,
  runningRun,
  threadWithHistory,
  userItem,
  type FakeDriver,
  type FakeThread,
} from "./fakeEnvironment";
import { commitsSoFar, startCounting, stopCounting, type RenderReport } from "./renderCounter";
import { act, fakeTimers, render } from "./render";

// The socket is the only fake layer: client-runtime's driver hands every connection the
// in-process session. A string path, since a typed import pulls client-runtime's sources
// into this project, and imports inside, since the factory runs before this file's own.
vi.mock("../../../packages/client-runtime/src/connection/driver.ts", async (importOriginal) => {
  const [actual, { fakeDriver }, Layer] = await Promise.all([
    importOriginal<{ readonly ConnectionDriver: Context.Key<unknown, FakeDriver> }>(),
    import("./fakeEnvironment"),
    import("effect/Layer"),
  ]);
  return { ...actual, layer: Layer.succeed(actual.ConnectionDriver, fakeDriver) };
});

// The fake server leaves most requests unanswered, which would raise the slow-request toast
// 15s of wall clock after each one, at a different point in every run.
vi.mock(import("~/rpc/requestLatencyState"), async (original) => ({
  ...(await original()),
  trackRpcRequestSent: () => {},
}));

const GIT_STATUS_UPDATES = 20;
const HISTORY_TURNS = 20;
const STREAM_DELTAS = 30;
const TYPED_TEXT = "fix the flaky tests!";
const TERMINAL_UPDATES = 20;
// The stream scenario leaves a turn on its thread, so it streams into one no other scenario opens.
const THREADS = ["thread-warm", "thread-a", "thread-b", "thread-live"].map((name) =>
  threadWithHistory(name, HISTORY_TURNS),
);
const [WARM, A, B, LIVE] = THREADS.map((thread) => thread.id) as [
  ThreadId,
  ThreadId,
  ThreadId,
  ThreadId,
];

const SIDE_CHAT = { ...threadWithHistory("thread-side", HISTORY_TURNS), sideChatOf: WARM };

// The agent waits on two questions: an option to pick, then a typed answer. They take the same
// height, so moving between them leaves the composer inset that ChatView lays out unchanged.
const QUESTION_AT = DateTime.makeUnsafe("2026-03-17T19:12:28.000Z");
const QUESTION_THREAD = threadWithHistory("thread-question", HISTORY_TURNS);
const QUESTION_REQUEST = RuntimeRequestId.make("thread-question-request");
const QUESTION = {
  ...QUESTION_THREAD,
  items: [
    ...QUESTION_THREAD.items,
    {
      id: TurnItemId.make(QUESTION_REQUEST),
      threadId: QUESTION_THREAD.id,
      runId: null,
      nodeId: NodeId.make(QUESTION_REQUEST),
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: HISTORY_TURNS * 2,
      status: "completed",
      title: null,
      startedAt: QUESTION_AT,
      completedAt: QUESTION_AT,
      updatedAt: QUESTION_AT,
      type: "user_input_request",
      requestId: QUESTION_REQUEST,
      questions: [
        {
          id: "approach",
          header: "Approach",
          question: "Which approach should I take?",
          options: [
            { label: "Incremental", description: "One module at a time" },
            { label: "Rewrite", description: "Everything at once" },
          ],
        },
        {
          id: "tests",
          header: "Tests",
          question: "Which tests should I run?",
          options: [
            { label: "Changed", description: "Only what this touches" },
            { label: "All", description: "The whole suite" },
          ],
        },
      ],
    },
  ],
  runtimeRequests: [
    {
      id: QUESTION_REQUEST,
      nodeId: NodeId.make(QUESTION_REQUEST),
      providerTurnId: null,
      nativeRequestRef: null,
      kind: "user_input",
      status: "pending",
      responseCapability: { type: "message" },
      createdAt: QUESTION_AT,
      resolvedAt: null,
    },
  ],
} satisfies FakeThread;

installFakeEnvironment([...THREADS, SIDE_CHAT, QUESTION]);
// Desktop-sized, so the sidebar, composer and right panel lay out as they do in the app.
await page.viewport(1400, 900);
// A returning user: the first-run gate would otherwise wait on onboarding evidence.
__setClientSettingsForTests({
  ...DEFAULT_CLIENT_SETTINGS,
  onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
});

async function quiet() {
  let seen = -1;
  await vi.waitFor(
    () => {
      const now = commitsSoFar();
      const settled = now === seen;
      seen = now;
      expect(settled).toBe(true);
    },
    { interval: 100, timeout: 15_000 },
  );
}

// Relative times and durations re-render on minute and second ticks of the wall clock, so a
// window that spans a tick counts extra renders. Only Date is frozen; timers run for real.
const frozenClock = () =>
  fakeTimers({ toFake: ["Date"], now: new Date("2026-03-18T09:00:30.000Z") });

const threadPath = (threadId: ThreadId) => `/${ENVIRONMENT_ID}/${threadId}`;
const lastAnswer = (threadId: ThreadId) =>
  page.getByText(`Answer ${HISTORY_TURNS - 1} for ${threadId}.`);

// The app owns its router, as main.tsx does, so render() adds none.
async function mountApp(path: string) {
  const router = getRouter(createMemoryHistory({ initialEntries: [path] }));
  await router.load();
  const container = document.createElement("div");
  container.style.cssText = "height: 900px; width: 1400px;";
  const screen = await render(<AppRoot router={router} />, { container, router: false });
  return { screen, router };
}

async function openThread(threadId: ThreadId) {
  const app = await mountApp(threadPath(threadId));
  await expect.element(lastAnswer(threadId)).toBeVisible();
  await quiet();
  return app;
}

async function measure(action: () => Promise<void>): Promise<RenderReport> {
  await quiet();
  startCounting();
  await action();
  await quiet();
  return stopCounting();
}

// Commits are left out across several windows, and where frame batching splits a window's
// commits differently from run to run while its renders stay identical.
async function report(
  scenario: string,
  windows: ReadonlyArray<RenderReport>,
  { commits: countCommits = windows.length === 1 } = {},
) {
  const components: Record<string, number> = {};
  for (const window of windows) {
    for (const [name, count] of Object.entries(window.components)) {
      components[name] = (components[name] ?? 0) + count;
    }
  }
  const total = windows.reduce((sum, window) => sum + window.renders, 0);
  const commits = countCommits ? windows[0]!.commits : null;
  await commands.writeRenderReport(
    scenario,
    JSON.stringify({ commits, renders: total, components }),
  );
}

// A first mount loads lazy route chunks, fonts and the connection at varying times. The diff
// panel and settings load more chunks on first open (the T3 Connect sidebar, the terminal
// preview's renderer), which can land after a window has gone quiet, so the warm-up opens
// each once and lets it settle.
it("warm up", async () => {
  using _clock = frozenClock();
  const { screen, router } = await openThread(WARM);
  await using _app = screen;
  await document.fonts.ready;
  await quiet();
  await toggleDiff("open")();
  await quiet();
  await toggleDiff("close")();
  await quiet();
  await openSettings(router, "/settings/general")();
  await openSettings(router, "/settings/appearance")();
  await quiet();
});

it("app-mount-thread", async () => {
  using _clock = frozenClock();
  startCounting();
  await using _app = (await mountApp(threadPath(A))).screen;
  await expect.element(lastAnswer(A)).toBeVisible();
  await quiet();
  await report("app-mount-thread", [stopCounting()]);
});

it("app-stream-assistant-turn", async () => {
  using _clock = frozenClock();
  await using _app = (await openThread(LIVE)).screen;
  expect(isThreadSubscribed(LIVE)).toBe(true);
  const live = runningRun(LIVE, "live-run", HISTORY_TURNS + 1, "live-user");
  await act(async () => {
    await emitThreadEvent(LIVE, { type: "run.created", payload: live });
    await emitThreadEvent(LIVE, {
      type: "turn-item.updated",
      payload: userItem(LIVE, live.id, "live-user", HISTORY_TURNS * 2, "Continue"),
    });
  });
  await expect.element(page.getByText("Continue", { exact: true })).toBeVisible();
  const counted = await measure(async () => {
    let text = "";
    for (let delta = 0; delta < STREAM_DELTAS; delta++) {
      text += `word${delta}\n\n`;
      await act(() =>
        emitThreadEvent(LIVE, {
          type: "turn-item.updated",
          payload: assistantItem(
            LIVE,
            live.id,
            "live-assistant",
            HISTORY_TURNS * 2 + 1,
            text,
            true,
          ),
        }),
      );
    }
    await expect
      .element(page.getByText(`word${STREAM_DELTAS - 1}`, { exact: false }))
      .toBeVisible();
  });
  // Only the streaming row changes. The timeline renders for the new item and its layout, not
  // per delta, and history rows not at all.
  expect(counted.components.ConversationTimeline).toBeLessThanOrEqual(3);
  expect(counted.components.UserTimelineRow).toBeUndefined();
  expect(counted.components.AssistantTimelineRow).toBe(STREAM_DELTAS);
  // Each delta adds a paragraph; finished blocks keep their render.
  expect(counted.components.MarkdownParagraph).toBe(STREAM_DELTAS);
  await report("app-stream-assistant-turn", [counted], { commits: false });
});

it("app-terminal-updates-in-other-thread", async () => {
  using _clock = frozenClock();
  await using _app = (await openThread(A)).screen;
  const counted = await measure(async () => {
    for (let update = 0; update < TERMINAL_UPDATES; update++) {
      await act(() =>
        emitTerminalMetadata({
          type: "upsert",
          terminal: {
            threadId: B,
            terminalId: "default",
            cwd: "/repo",
            worktreePath: null,
            status: "running",
            pid: 42,
            exitCode: null,
            exitSignal: null,
            hasRunningSubprocess: true,
            label: `command ${update}`,
            updatedAt: `2026-03-18T09:01:${String(update).padStart(2, "0")}.000Z`,
          },
        }),
      );
    }
  });
  // Only thread B's sidebar row shows these updates.
  expect(counted.components.ChatView).toBeUndefined();
  expect(counted.components.SidebarThreadRow).toBe(TERMINAL_UPDATES);
  await report("app-terminal-updates-in-other-thread", [counted]);
});

it("app-type-in-composer", async () => {
  using _clock = frozenClock();
  await using _app = (await openThread(A)).screen;
  const editor = page.getByTestId("composer-editor");
  await userEvent.click(editor);
  const counted = await measure(async () => {
    await userEvent.type(editor, TYPED_TEXT);
    await expect.element(editor).toHaveTextContent(TYPED_TEXT);
  });
  await report("app-type-in-composer", [counted]);
});

it("app-answer-question", async () => {
  using _clock = frozenClock();
  await using _app = (await openThread(QUESTION.id)).screen;
  const pick = await measure(async () => {
    await userEvent.click(page.getByRole("button", { name: /Incremental/ }));
    await expect.element(page.getByText("Which tests should I run?")).toBeVisible();
  });
  const editor = page.getByTestId("composer-editor");
  await userEvent.click(editor);
  const type = await measure(async () => {
    await userEvent.type(editor, TYPED_TEXT);
    await expect.element(editor).toHaveTextContent(TYPED_TEXT);
  });
  // Answers live in the composer; the chat view renders for the request, not its answers.
  expect(pick.components.ChatView).toBeUndefined();
  expect(type.components.ChatView).toBeUndefined();
  await report("app-answer-question", [pick, type]);
});

it("app-switch-thread", async () => {
  using _clock = frozenClock();
  const { screen, router } = await openThread(A);
  await using _app = screen;
  const go = (threadId: ThreadId) => async () => {
    await act(() =>
      router.navigate({
        to: "/$environmentId/$threadId",
        params: { environmentId: ENVIRONMENT_ID, threadId },
      }),
    );
    await expect.element(lastAnswer(threadId)).toBeVisible();
  };
  const windows = [await measure(go(B)), await measure(go(A))];
  // Only the rows losing and gaining the active highlight change.
  for (const window of windows) expect(window.components.SidebarThreadRow).toBe(2);
  await report("app-switch-thread", windows);
});

// Through the diff.toggle shortcut, the same handler as the header's diff button.
const toggleDiff = (to: "open" | "close") => async () => {
  await userEvent.keyboard("{Control>}d{/Control}");
  const diff = page.getByRole("group", { name: "Diff layout" });
  if (to === "open") await expect.element(diff).toBeVisible();
  else await expect.element(diff).not.toBeInTheDocument();
};

it("app-toggle-diff-panel", async () => {
  using _clock = frozenClock();
  await using _app = (await openThread(A)).screen;
  const open = await measure(toggleDiff("open"));
  const close = await measure(toggleDiff("close"));
  await report("app-toggle-diff-panel", [open, close]);
});

const openSettings =
  (router: AppRouter, to: "/settings/general" | "/settings/appearance") => async () => {
    await act(() => router.navigate({ to }));
    // A section title from each page, since neither page has a heading that names it.
    const name = to === "/settings/general" ? "Time format" : "Interface";
    await expect.element(page.getByRole("heading", { name, exact: true })).toBeVisible();
    // Appearance highlights its code font preview off-thread, then attaches it in a shadow root.
    if (to === "/settings/appearance") {
      await vi.waitFor(
        () =>
          expect([...document.querySelectorAll("div")].some((node) => node.shadowRoot)).toBe(true),
        { interval: 100, timeout: 15_000 },
      );
    }
  };

it("app-open-settings", async () => {
  using _clock = frozenClock();
  const { screen, router } = await openThread(A);
  await using _app = screen;
  await report("app-open-settings", [await measure(openSettings(router, "/settings/general"))]);
});

it("app-switch-settings-section", async () => {
  using _clock = frozenClock();
  const { screen, router } = await openThread(A);
  await using _app = screen;
  await openSettings(router, "/settings/general")();
  await report("app-switch-settings-section", [
    await measure(openSettings(router, "/settings/appearance")),
  ]);
});

// ChatView reads only a few status fields, so changing file counts should not reach it.
// Keep git scenarios last: the status they leave cached adds renders to later scenarios.
it("app-git-file-counts-with-side-chat", async () => {
  using _clock = frozenClock();
  useRightPanelStore.getState().openSideChat(scopeThreadRef(ENVIRONMENT_ID, WARM), SIDE_CHAT.id);
  await using _app = (await openThread(WARM)).screen;
  await expect.element(lastAnswer(SIDE_CHAT.id)).toBeVisible();
  const gitStatus = vcsEnvironment.status({
    environmentId: ENVIRONMENT_ID,
    input: { cwd: "/workspace/render" },
  });
  const local = (insertions: number, refName = "main") => ({
    isRepo: true,
    hasPrimaryRemote: true,
    isDefaultRef: true,
    refName,
    hasWorkingTreeChanges: true,
    workingTree: {
      files: [{ path: "src/app.ts", insertions, deletions: 0 }],
      insertions,
      deletions: 0,
    },
  });
  await act(() => emitVcsStatus({ _tag: "snapshot", local: local(0), remote: null }));
  const counted = await measure(async () => {
    for (let update = 1; update <= GIT_STATUS_UPDATES; update++) {
      await act(() => emitVcsStatus({ _tag: "localUpdated", local: local(update) }));
    }
    // Zero renders only counts if the last update arrived inside this window.
    await vi.waitFor(() => {
      const status = AsyncResult.getOrElse(appAtomRegistry.get(gitStatus), () => null);
      expect(status?.workingTree.insertions).toBe(GIT_STATUS_UPDATES);
    });
  });
  expect(counted.components.ChatView).toBeUndefined();
  // A field the chat view does read still reaches both chats.
  const branchSwitch = await measure(() =>
    act(() => emitVcsStatus({ _tag: "localUpdated", local: local(0, "feature") })),
  );
  expect(branchSwitch.components.ChatView).toBe(2);
  await report("app-git-file-counts-with-side-chat", [counted]);
});

// ChatView re-renders when the tree goes dirty or clean; the composer and side chat timeline should not.
it("app-git-status-updates-with-side-chat", async () => {
  using _clock = frozenClock();
  useRightPanelStore.getState().openSideChat(scopeThreadRef(ENVIRONMENT_ID, WARM), SIDE_CHAT.id);
  await using _app = (await openThread(WARM)).screen;
  await expect.element(lastAnswer(SIDE_CHAT.id)).toBeVisible();
  const local = (insertions: number) => ({
    isRepo: true,
    hasPrimaryRemote: true,
    isDefaultRef: true,
    refName: "main",
    hasWorkingTreeChanges: insertions % 2 === 1,
    workingTree: {
      files: [{ path: "src/app.ts", insertions, deletions: 0 }],
      insertions,
      deletions: 0,
    },
  });
  await act(() => emitVcsStatus({ _tag: "snapshot", local: local(0), remote: null }));
  const counted = await measure(async () => {
    for (let update = 1; update <= GIT_STATUS_UPDATES; update++) {
      await act(() => emitVcsStatus({ _tag: "localUpdated", local: local(update) }));
    }
  });
  expect(counted.components.ChatView).toBe(GIT_STATUS_UPDATES * 2);
  expect(counted.components.ChatComposer).toBeUndefined();
  expect(counted.components.ConversationTimeline).toBeUndefined();
  await report("app-git-status-updates-with-side-chat", [counted]);
});
