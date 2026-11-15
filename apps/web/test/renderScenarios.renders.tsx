// Render scenarios for scripts/render-metrics.ts. Each one mounts real components on
// fixed fixtures, counts React commits and component renders while it drives them,
// and writes the counts through the writeRenderReport browser command. They mount the
// components ChatView composes, not ChatView, which needs a live environment connection.
import { EnvironmentId, MessageId } from "@t3tools/contracts";
import type { LegendListRef } from "@legendapp/list/react";
import { createRef, useRef, useState, type ComponentProps, type ReactNode } from "react";
import { expect, it, vi } from "vite-plus/test";
import { commands, userEvent } from "vite-plus/test/browser";

import "~/index.css";

import { MessagesTimeline } from "~/components/chat/MessagesTimeline";
import {
  ComposerPromptEditorTiptap as ComposerPromptEditor,
  type ComposerPromptEditorHandle,
} from "~/components/ComposerPromptEditorTiptap";
import { commitsSoFar, startCounting, stopCounting } from "./renderCounter";
import { render } from "./render";

declare module "vite-plus/test/browser" {
  interface BrowserCommands {
    /** Defined in vite.config.ts for the renders project. */
    writeRenderReport: (scenario: string, json: string) => Promise<void>;
  }
}

vi.mock(import("~/state/query"), async (original) => ({
  ...(await original()),
  useEnvironmentQuery: (() => ({
    data: { tasks: [] },
    dataUpdatedAt: 0,
    error: null,
    failure: null,
    isPending: false,
    isSuccess: true,
    refresh: () => {},
  })) as never,
}));

const ENVIRONMENT_ID = EnvironmentId.make("environment-local");
const CREATED_AT = "2026-03-17T19:12:28.000Z";
const HISTORY_TURNS = 20;
const STREAM_DELTAS = 30;
const TYPED_TEXT = "fix the flaky tests!";

type TimelineProps = ComponentProps<typeof MessagesTimeline>;
type Entry = TimelineProps["timelineEntries"][number];

function message(id: string, role: "user" | "assistant", text: string, streaming = false): Entry {
  return {
    id: `entry-${id}`,
    kind: "message",
    createdAt: CREATED_AT,
    message: {
      id: MessageId.make(id),
      role,
      text,
      runId: null,
      createdAt: CREATED_AT,
      updatedAt: CREATED_AT,
      streaming,
    },
  } as Entry;
}

// A thread with history: user prompts and markdown answers with lists and inline code.
// No fenced code: Shiki highlights it asynchronously, and whether a block first renders
// its fallback varies run to run.
function history(thread: string): Entry[] {
  return Array.from({ length: HISTORY_TURNS }, (_, turn) => [
    message(`${thread}-user-${turn}`, "user", `${thread}: question ${turn} about the sidebar`),
    message(
      `${thread}-assistant-${turn}`,
      "assistant",
      `Answer ${turn} for ${thread}.\n\n- checked \`Sidebar.tsx\`\n- ran the tests\n\n` +
        "The width is now `clamp(next, MIN_WIDTH, MAX_WIDTH)`, so the layout no longer jumps.",
    ),
  ]).flat();
}

// Props that some trees under comparison have dropped. A JSX spread is not checked for
// excess properties, so this file type-checks on trees with and without them.
const versionedProps = { onManualNavigation: () => {} };

// One list handle per mounted timeline, as ChatView keeps one: the timeline compares the
// handle across renders, and a new one per render would skip its scroll-to-end and settle work.
function timelineFor() {
  const listRef = createRef<LegendListRef | null>();
  return (thread: string, entries: Entry[]) => (
    <MessagesTimeline
      timelineEntries={entries}
      isWorking={false}
      listRef={listRef}
      latestRun={null}
      turnDiffSummaries={[]}
      runs={[]}
      routeThreadKey={`environment-local:${thread}`}
      onOpenTurnDiff={() => {}}
      onOpenThread={() => {}}
      onForkFromRun={async () => {}}
      supportsConversationRollback={false}
      onRevertToTurnCount={() => {}}
      isRevertingCheckpoint={false}
      onImageExpand={() => {}}
      activeThreadEnvironmentId={ENVIRONMENT_ID}
      markdownCwd={undefined}
      resolvedTheme="light"
      timestampFormat="locale"
      workspaceRoot={undefined}
      anchorMessageId={null}
      onAnchorReady={() => {}}
      onAnchorSizeChanged={() => {}}
      contentInsetEndAdjustment={0}
      emptyPlaceholderInset={0}
      liveFollowEnabled
      onIsAtEndChange={() => {}}
      {...versionedProps}
    />
  );
}

function sizedContainer() {
  const container = document.createElement("div");
  container.style.cssText = "height: 900px; width: 900px; display: flex; flex-direction: column;";
  return container;
}

// Legend List measures rows, and the minimap follows scroll, on later frames, and how
// much of that lands inside a window varies run to run. Every window opens and closes
// on a quiet tree: no commit across two consecutive checks.
async function quiet() {
  let seen = -1;
  await vi.waitFor(
    () => {
      const now = commitsSoFar();
      const settled = now === seen;
      seen = now;
      expect(settled).toBe(true);
    },
    { interval: 100, timeout: 10_000 },
  );
}

// Off the guest page the connection runtime retries a missing environment on timers, and
// its atom updates commit at varying times. On it, the runtime fails once and stays quiet.
function onGuestPage(): Disposable {
  const previous = `${window.location.pathname}${window.location.search}`;
  window.history.replaceState(window.history.state, "", "/guest?share=render-scenarios");
  return {
    [Symbol.dispose]: () => window.history.replaceState(window.history.state, "", previous),
  };
}

// A first mount loads lazy modules, web fonts and syntax highlighting at varying times.
// Each scenario mounts its tree once uncounted, so the counted run starts warm.
async function warmUp(ui: ReactNode, container?: HTMLElement) {
  await using screen = await render(ui, container ? { container } : {});
  await document.fonts.ready;
  await quiet();
  expect(screen.container.childElementCount).toBeGreaterThan(0);
}

async function report(scenario: string) {
  await quiet();
  const counts = stopCounting();
  await commands.writeRenderReport(scenario, JSON.stringify(counts));
}

it("mount-thread", async () => {
  using _guest = onGuestPage();
  const timeline = timelineFor();
  await warmUp(timelineFor()("thread-warm", history("thread-warm")), sizedContainer());
  startCounting();
  await using screen = await render(timeline("thread-a", history("thread-a")), {
    container: sizedContainer(),
  });
  await expect.element(screen.getByText(`Answer ${HISTORY_TURNS - 1} for thread-a.`)).toBeVisible();
  await report("mount-thread");
});

it("stream-assistant-turn", async () => {
  using _guest = onGuestPage();
  const timeline = timelineFor();
  const base = history("thread-a");
  const streamed = (text: string) => [
    ...base,
    message("live-user", "user", "Continue"),
    message("live-assistant", "assistant", text, true),
  ];
  await warmUp(timelineFor()("thread-warm", streamed("warm")), sizedContainer());
  await using screen = await render(timeline("thread-a", streamed("")), {
    container: sizedContainer(),
  });
  await expect.element(screen.getByText("Continue")).toBeVisible();
  await quiet();

  startCounting();
  let text = "";
  for (let delta = 0; delta < STREAM_DELTAS; delta++) {
    text += `word${delta} `;
    await screen.rerender(timeline("thread-a", streamed(text)));
  }
  await expect
    .element(screen.getByText(`word${STREAM_DELTAS - 1}`, { exact: false }))
    .toBeVisible();
  await report("stream-assistant-turn");
});

// Thread A to B and back, each switch counted until the tree is quiet again. Commits
// are not reported: the minimap's follow-up renders sometimes split across two frames,
// so the commit count varies by one while the renders stay identical.
it("switch-thread", async () => {
  using _guest = onGuestPage();
  const timeline = timelineFor();
  const a = history("thread-a");
  const b = history("thread-b");
  const lastAnswer = (thread: string) =>
    screen.getByText(`Answer ${HISTORY_TURNS - 1} for ${thread}.`);
  await warmUp(timelineFor()("thread-warm", a), sizedContainer());
  await using screen = await render(timeline("thread-a", a), { container: sizedContainer() });
  await expect.element(lastAnswer("thread-a")).toBeVisible();

  await quiet();
  startCounting();
  await screen.rerender(timeline("thread-b", b));
  await expect.element(lastAnswer("thread-b")).toBeVisible();
  await quiet();
  const toB = stopCounting();
  startCounting();
  await screen.rerender(timeline("thread-a", a));
  await expect.element(lastAnswer("thread-a")).toBeVisible();
  await quiet();
  const toA = stopCounting();

  const components = { ...toB.components };
  for (const [name, count] of Object.entries(toA.components)) {
    components[name] = (components[name] ?? 0) + count;
  }
  await commands.writeRenderReport(
    "switch-thread",
    JSON.stringify({
      commits: null,
      renders: toB.renders + toA.renders,
      components,
    }),
  );
});

function Composer() {
  const [prompt, setPrompt] = useState({ value: "", cursor: 0 });
  const editorRef = useRef<ComposerPromptEditorHandle>(null);
  return (
    <ComposerPromptEditor
      editorRef={editorRef}
      value={prompt.value}
      cursor={prompt.cursor}
      richTextEnabled
      contextRecords={new Map()}
      skills={[]}
      disabled={false}
      placeholder="Ask anything"
      onChange={(value, cursor) => setPrompt({ value, cursor })}
      onPaste={() => {}}
    />
  );
}

it("type-in-composer", async () => {
  using _guest = onGuestPage();
  await warmUp(<Composer />);
  await using screen = await render(<Composer />);
  const editor = screen.getByRole("textbox");
  await userEvent.click(editor);
  await quiet();

  startCounting();
  await userEvent.type(editor, TYPED_TEXT);
  await expect.element(editor).toHaveTextContent(TYPED_TEXT);
  await report("type-in-composer");
});
