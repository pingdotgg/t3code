import { EnvironmentId, MessageId, RunId, ScheduledTaskId, ThreadId } from "@t3tools/contracts";
import type { LegendListRef } from "@legendapp/list/react";
import { createRef, Profiler, useState, type ComponentProps, type ReactElement } from "react";
import { describe, expect, it, vi } from "vite-plus/test";

import "~/index.css";

import { userEvent } from "vite-plus/test/browser";
import { readTimelinePosition } from "./timelineScrollAnchoring";
import { act, fakeTimers, render } from "../../../test/render";
import { MessagesTimeline } from "./MessagesTimeline";
import { remarkThoughtPreview } from "./TimelineWorkEntryRow.logic";
import { parseMarkdownWithMath } from "@t3tools/shared/markdownMath";
import { collectThreadFindRanges } from "./threadFindHighlights";

const environmentQuery = vi.hoisted(() => ({
  error: "Pull request not found",
  data: null as unknown,
}));
vi.mock(import("~/state/query"), async (original) => ({
  ...(await original()),
  useEnvironmentQuery: (() => ({
    data: environmentQuery.data,
    dataUpdatedAt: 0,
    error: environmentQuery.error,
    failure: null,
    isPending: false,
    isSuccess: false,
    refresh: () => {},
  })) as never,
}));

const ENVIRONMENT_ID = EnvironmentId.make("environment-local");
const CREATED_AT = "2026-03-17T19:12:28.000Z";

type TimelineProps = ComponentProps<typeof MessagesTimeline>;
type Entry = TimelineProps["timelineEntries"][number];

// The timeline remembers scroll position and open disclosures per thread key,
// so every render gets a fresh thread.
function baseProps(): Omit<TimelineProps, "timelineEntries"> {
  return {
    isWorking: false,
    activeTurnInProgress: false,
    listRef: createRef<LegendListRef | null>(),
    latestRun: null,
    turnDiffSummaries: [],
    runs: [],
    routeThreadKey: `environment-local:thread-${Math.random().toString(36).slice(2)}`,
    onOpenTurnDiff: () => {},
    onOpenThread: () => {},
    onForkFromRun: async () => {},
    onRollbackCheckpoint: () => {},
    supportsConversationRollback: false,
    onRevertToTurnCount: () => {},
    isRevertingCheckpoint: false,
    onImageExpand: () => {},
    activeThreadEnvironmentId: ENVIRONMENT_ID,
    markdownCwd: undefined,
    resolvedTheme: "light",
    timestampFormat: "locale",
    workspaceRoot: undefined,
    anchorMessageId: null,
    onAnchorReady: () => {},
    onAnchorSizeChanged: () => {},
    contentInsetEndAdjustment: 0,
    emptyPlaceholderInset: 0,
    liveFollowEnabled: true,
    onIsAtEndChange: () => {},
    onManualNavigation: () => {},
  };
}

function message(
  text: string,
  overrides: Partial<Extract<Entry, { kind: "message" }>["message"]> = {},
  id = "message-1",
): Entry {
  return {
    id: `entry-${id}`,
    kind: "message",
    createdAt: CREATED_AT,
    message: {
      id: MessageId.make(id),
      role: "user",
      text,
      runId: null,
      createdAt: CREATED_AT,
      updatedAt: CREATED_AT,
      streaming: false,
      ...overrides,
    },
  };
}

async function renderElement(element: ReactElement) {
  const container = document.createElement("div");
  container.style.cssText = "height: 1200px; width: 900px; display: flex; flex-direction: column;";
  const screen = await render(element, { container });
  const buttons = (name: string | RegExp) =>
    [...container.querySelectorAll<HTMLElement>("button, [role=button]")].filter((button) => {
      const label = button.getAttribute("aria-label") ?? button.textContent ?? "";
      return typeof name === "string" ? label === name : name.test(label);
    });
  return Object.assign(screen, {
    text: () => container.textContent ?? "",
    buttons,
    button: (name: string | RegExp) => {
      const [match] = buttons(name);
      if (!match) throw new Error(`Missing button: ${String(name)}`);
      return match;
    },
  });
}

function renderTimeline(entries: ReadonlyArray<Entry>, props: Partial<TimelineProps> = {}) {
  return renderElement(
    <MessagesTimeline {...baseProps()} timelineEntries={entries as Entry[]} {...props} />,
  );
}

async function click(element: HTMLElement) {
  await act(async () => element.click());
}

function setup({ scheduledTasks = [] as ReadonlyArray<{ id: string; title: string }> } = {}) {
  environmentQuery.data = { tasks: scheduledTasks };
}

const TASK_ID = ScheduledTaskId.make("task-1");
const AUTOMATION_PROMPT = "Triage the inbox\n\nLabel every new issue and close duplicates.";

describe("MessagesTimeline messages", () => {
  it("settles when equally long messages have very different rendered heights", async () => {
    const props = baseProps();
    const tall = message("a\n\n".repeat(6000), { role: "assistant" }, "tall");
    const earlier = Array.from({ length: 80 }, (_, index) =>
      message(
        `<details><summary>Reply ${index}</summary>${"compact ".repeat(2250)}</details>`,
        { role: "assistant" },
        `earlier-${index}`,
      ),
    );
    let nestedCommits = 0;
    let maxNestedCommits = 0;
    const onRender = (_id: string, phase: string) => {
      nestedCommits = phase === "nested-update" ? nestedCommits + 1 : 0;
      maxNestedCommits = Math.max(maxNestedCommits, nestedCommits);
    };
    const timeline = (entries: Entry[]) => (
      <Profiler id="timeline" onRender={onRender}>
        <MessagesTimeline {...props} timelineEntries={entries} />
      </Profiler>
    );
    await using screen = await renderElement(timeline([tall]));
    await vi.waitFor(() =>
      expect(props.listRef.current?.getState().sizeAtIndex(0)).toBeGreaterThan(100_000),
    );
    const viewport = props.listRef.current!.getScrollableNode()!;
    await act(() => {
      viewport.scrollTop = 0;
      viewport.dispatchEvent(new Event("scroll"));
    });
    await screen.rerender(timeline([...earlier, tall]));
    await act(() => {
      void props.listRef.current!.scrollToIndex({ index: 0, animated: false });
    });
    await vi.waitFor(async () => {
      await act(() => {
        viewport.scrollTop = 0;
        viewport.dispatchEvent(new Event("scroll"));
      });
      expect(screen.text().includes("Reply 0")).toBe(true);
      expect(props.listRef.current!.getState().sizeAtIndex(0)).toBeGreaterThan(0);
    });
    expect(maxNestedCommits).toBeLessThan(20);
  });

  it("preserves XML-like tags and comparisons in user messages as text", async () => {
    const source = [
      'Without reading a file, do you have <global-agent-instructions scope="workspace">',
      'Before <nested data-value="a&b">inside</nested> after',
      "</global-agent-instructions> in your context?",
      "Comparison: 2 < 3 and 5 > 4.",
    ];
    await using screen = await renderTimeline([message(source.join("\n"))]);
    for (const line of source) expect(screen.text()).toContain(line);
    expect(screen.container.querySelector("global-agent-instructions, nested")).toBeNull();
  });

  it("renders unsafe user HTML as inert source text", async () => {
    const source =
      '<script>globalThis.__t3Xss = 1</script><img src="x" onerror="globalThis.__t3Xss = 2">';
    await using screen = await renderTimeline([message(source)]);
    expect(screen.text()).toContain(source);
    expect(screen.container.querySelector("script, img")).toBeNull();
    expect((globalThis as { __t3Xss?: number }).__t3Xss).toBeUndefined();
  });

  it("renders sanitized raw HTML in assistant messages", async () => {
    await using screen = await renderTimeline([
      message(
        [
          '<details onclick="globalThis.__t3Xss = 1">',
          "<summary>Safe details</summary>",
          "<script>globalThis.__t3Xss = 2</script>",
          '<img src="x" onerror="globalThis.__t3Xss = 3">',
          '<a href="javascript:globalThis.__t3Xss = 4">Unsafe link</a>',
          "</details>",
        ].join(""),
        { role: "assistant" },
      ),
    ]);
    expect(screen.container.querySelector("[data-markdown-details]")?.textContent).toContain(
      "Safe details",
    );
    expect(screen.text()).not.toContain("<details");
    expect(screen.container.querySelector("script, [onclick], [onerror]")).toBeNull();
    expect(screen.container.innerHTML).not.toContain("javascript:");
    await click(screen.button("Safe details"));
    expect((globalThis as { __t3Xss?: number }).__t3Xss).toBeUndefined();
  });
});

describe("MessagesTimeline automation prompts", () => {
  it("folds an automation prompt into a bubble titled by its task", async () => {
    setup({ scheduledTasks: [{ id: TASK_ID, title: "Nightly triage" }] });
    await using screen = await renderTimeline([
      message(AUTOMATION_PROMPT, { scheduledTaskId: TASK_ID }),
    ]);
    const row = screen.button(/^Automation/);
    expect(row.textContent).toContain("Nightly triage");
    expect(row.getAttribute("aria-expanded")).toBe("false");
    expect(screen.text()).not.toContain("close duplicates");

    await click(row);
    expect(screen.text()).toContain("Label every new issue and close duplicates.");
    const link = [...screen.container.querySelectorAll("a")].find(
      (anchor) => anchor.textContent === "Open automation",
    );
    expect(link?.getAttribute("href")).toContain(`taskId=${TASK_ID}`);
    expect(screen.buttons(/copy/i)).not.toHaveLength(0);
  });

  it("falls back to the prompt's first line without a task title", async () => {
    setup();
    await using screen = await renderTimeline([
      message(AUTOMATION_PROMPT, { scheduledTaskId: TASK_ID }),
    ]);
    expect(screen.button(/^Automation/).textContent).toContain("Triage the inbox");
  });

  it("leaves ordinary user messages as full bubbles", async () => {
    setup();
    await using screen = await renderTimeline([message(AUTOMATION_PROMPT)]);
    expect(screen.buttons(/^Automation/)).toHaveLength(0);
    expect(screen.text()).toContain("Label every new issue and close duplicates.");
  });

  it("reveals a find match beyond the folded automation prompt's initial viewport", async () => {
    setup();
    const prompt = `${"Inspect the next item.\n\n".repeat(16)}Close duplicates.`;
    await using screen = await renderTimeline([message(prompt, { scheduledTaskId: TASK_ID })], {
      findExpanded: true,
      findQuery: "duplicates",
      activeFindMatch: { entryId: "entry-message-1", runId: null, occurrence: 0 },
    });
    await vi.waitFor(() =>
      expect(screen.button(/^Automation/).getAttribute("aria-expanded")).toBe("true"),
    );
    const { range } = collectThreadFindRanges(screen.container, "duplicates")[0]!;
    const details = screen.container.querySelector("[data-thread-find-text]")!;
    expect(range.getBoundingClientRect().top - details.getBoundingClientRect().top).toBeGreaterThan(
      384,
    );
    expect(range.getBoundingClientRect().bottom).toBeLessThanOrEqual(
      details.getBoundingClientRect().bottom,
    );
  });

  it("shows edit-from-here once an automation prompt is expanded", async () => {
    setup();
    const runId = RunId.make("run-1");
    await using screen = await renderTimeline(
      [
        message(
          AUTOMATION_PROMPT,
          { scheduledTaskId: TASK_ID, runId, inputIntent: "turn_start" },
          "user-1",
        ),
        message("Done", { role: "assistant", runId }, "assistant-1"),
      ],
      {
        supportsConversationRollback: true,
        threadStartCheckpointReady: true,
        turnDiffSummaries: [
          {
            runId,
            checkpointTurnCount: 1,
            checkpointRef: "checkpoint-1" as never,
            status: "ready",
            files: [],
            assistantMessageId: MessageId.make("assistant-1"),
            completedAt: CREATED_AT,
          },
        ],
      },
    );
    expect(screen.buttons("Edit from here")).toHaveLength(0);
    await click(screen.button(/^Automation/));
    expect(screen.buttons("Edit from here")).toHaveLength(1);
  });
});

const SENDER_THREAD_ID = ThreadId.make("thread-sender");
const AGENT_MESSAGE = "Review finished\n\nThe migration drops the index before backfilling it.";

describe("MessagesTimeline agent messages", () => {
  it("folds a message from another agent into a one-line preview", async () => {
    setup();
    const onOpenThread = vi.fn();
    await using screen = await renderTimeline(
      [message(AGENT_MESSAGE, { createdBy: "agent", senderThreadId: SENDER_THREAD_ID })],
      { onOpenThread },
    );
    const row = screen.button(/^Agent/);
    expect(row.textContent).toContain("Review finished");
    expect(row.getAttribute("aria-expanded")).toBe("false");
    expect(screen.text()).not.toContain("drops the index");
    expect(screen.buttons("Open thread")).toHaveLength(0);

    await click(row);
    expect(screen.text()).toContain("The migration drops the index before backfilling it.");
    await click(screen.button("Open thread"));
    expect(onOpenThread).toHaveBeenCalledWith(SENDER_THREAD_ID);

    await click(screen.button(/^Agent/));
    expect(screen.text()).not.toContain("drops the index");
  });

  it("leaves messages sent by T3 Code as full bubbles", async () => {
    setup();
    await using screen = await renderTimeline([
      message(AGENT_MESSAGE, { createdBy: "agent", creationSource: "server" }),
    ]);
    expect(screen.buttons(/^Agent/)).toHaveLength(0);
    expect(screen.text()).toContain("drops the index");
  });

  it("reveals a find match inside a folded agent message", async () => {
    setup();
    const text = `${"Checked the next file.\n\n".repeat(16)}The migration drops the index.`;
    await using screen = await renderTimeline(
      [message(text, { createdBy: "agent", senderThreadId: SENDER_THREAD_ID })],
      {
        findExpanded: true,
        findQuery: "drops the index",
        activeFindMatch: { entryId: "entry-message-1", runId: null, occurrence: 0 },
      },
    );
    await vi.waitFor(() =>
      expect(screen.button(/^Agent/).getAttribute("aria-expanded")).toBe("true"),
    );
    const { range } = collectThreadFindRanges(screen.container, "drops the index")[0]!;
    const body = screen.container.querySelector("[data-user-message-body]")!;
    expect(range.getBoundingClientRect().height).toBeGreaterThan(0);
    expect(range.getBoundingClientRect().bottom).toBeLessThanOrEqual(
      body.getBoundingClientRect().bottom,
    );
  });
});

describe("compact reasoning math", () => {
  it("keeps formulas while flattening compact reasoning previews", () => {
    const tree = parseMarkdownWithMath("## Reasoning\n\nUse **norm** $|x|$ and \\[x^2\\]");
    remarkThoughtPreview("Reasoning")(tree);
    expect(tree.children.map((node) => node.type)).toEqual([
      "text",
      "inlineMath",
      "text",
      "inlineMath",
    ]);
    expect(tree.children.map((node) => ("value" in node ? node.value : null))).toEqual([
      "Reasoning Use norm ",
      "|x|",
      " and ",
      "x^2",
    ]);
  });
});

describe("MessagesTimeline scroll position", () => {
  const tall = (index: number) =>
    message(
      `Message ${index}\n\n${"Long paragraph. ".repeat(80)}`,
      { role: "assistant" },
      `message-${index}`,
    );
  const tallEntries = Array.from({ length: 12 }, (_, index) => tall(index));

  async function waitForList(props: ReturnType<typeof baseProps>) {
    await vi.waitFor(() => {
      const viewport = props.listRef.current?.getScrollableNode();
      expect(viewport?.scrollHeight ?? 0).toBeGreaterThan(viewport?.clientHeight ?? 0);
    });
    return props.listRef.current!.getScrollableNode()!;
  }

  it("keeps following after a non-user scroll reports an end gap before new rows", async () => {
    const onIsAtEndChange = vi.fn();
    const props = { ...baseProps(), onIsAtEndChange };
    const timeline = (entries: Entry[]) => (
      <MessagesTimeline {...props} timelineEntries={entries} />
    );
    await using screen = await renderElement(timeline(tallEntries));
    const viewport = await waitForList(props);
    await vi.waitFor(() => expect(onIsAtEndChange).toHaveBeenLastCalledWith(true));
    // Let restoration finish before the completed reply adds more than a viewport.
    {
      using _timers = fakeTimers();
      await act(async () => {
        for (let frame = 0; frame < 8; frame += 1) await vi.advanceTimersByTimeAsync(16);
      });
    }
    // Deliver a non-user scroll callback with a gap larger than the follow threshold,
    // without a wheel, touch or other user-navigation event disabling follow.
    await act(async () => {
      await props.listRef.current!.scrollToOffset({
        offset: viewport.scrollTop - 2 * viewport.clientHeight,
        animated: false,
      });
      viewport.dispatchEvent(new Event("scroll"));
    });
    expect(onIsAtEndChange).toHaveBeenLastCalledWith(false);
    expect(viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop).toBeGreaterThan(
      viewport.clientHeight,
    );
    using _timers = fakeTimers();
    await act(async () => screen.rerender(timeline([...tallEntries, tall(12)])));
    await act(async () => {
      for (let frame = 0; frame < 8; frame += 1) await vi.advanceTimersByTimeAsync(16);
    });
    await vi.waitFor(() =>
      expect(
        viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop,
      ).toBeLessThanOrEqual(2),
    );
  });

  it.each(["together", "anchor-first", "rows-first"] as const)(
    "preserves an anchored reading position when anchor clearing and changed rows arrive %s",
    async (order) => {
      const onIsAtEndChange = vi.fn();
      const onAnchorReady = vi.fn();
      const props = { ...baseProps(), onIsAtEndChange, onAnchorReady };
      const sent = message("Newest prompt.", {}, "anchored-prompt");
      const reply = tall(12);
      const entries = [...tallEntries, sent, reply];
      const timeline = (anchorCleared: boolean, rowsChanged = anchorCleared) => (
        <MessagesTimeline
          {...props}
          timelineEntries={rowsChanged ? [...entries, tall(13)] : entries}
          anchorMessageId={anchorCleared ? null : MessageId.make("anchored-prompt")}
          isWorking={!anchorCleared}
        />
      );
      await using screen = await renderElement(timeline(false));
      const viewport = await waitForList(props);
      await vi.waitFor(() => expect(onAnchorReady).toHaveBeenCalled());
      await act(async () => {
        await props.listRef.current!.scrollToOffset({ offset: 600, animated: false });
        viewport.dispatchEvent(new Event("scroll"));
      });
      await vi.waitFor(() => expect(onIsAtEndChange).toHaveBeenLastCalledWith(false));
      const offset = viewport.scrollTop;
      using _timers = fakeTimers();

      if (order !== "together") {
        await act(async () =>
          screen.rerender(timeline(order === "anchor-first", order === "rows-first")),
        );
      }
      await act(async () => screen.rerender(timeline(true)));
      await act(async () => {
        // Drain the two-frame growth check and its first end correction.
        for (let frame = 0; frame < 4; frame += 1) await vi.advanceTimersByTimeAsync(16);
      });

      expect(viewport.scrollTop).toBeCloseTo(offset, 0);
      expect(viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop).toBeGreaterThan(
        600,
      );
    },
  );

  it("keeps streamed growth smooth after restoring a working thread", async () => {
    const props = baseProps();
    const timeline = (restored: boolean, growth = 0) => (
      <MessagesTimeline
        {...props}
        routeThreadKey={restored ? `${props.routeThreadKey}-restored` : props.routeThreadKey}
        isWorking
        timelineEntries={[
          ...tallEntries.slice(0, -1),
          message(
            `Message 11\n\n${"Long paragraph. ".repeat(80 + growth * 20)}`,
            { role: "assistant", streaming: true },
            "message-11",
          ),
        ]}
      />
    );
    await using screen = await renderElement(timeline(false));
    const viewport = await waitForList(props);
    await vi.waitFor(() =>
      expect(
        viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop,
      ).toBeLessThanOrEqual(2),
    );
    const initialHeight = viewport.scrollHeight;
    const scrollable: { scrollTo(options: ScrollToOptions): void } = viewport;
    using scrollTo = vi.spyOn(scrollable, "scrollTo");
    using restoration = vi.spyOn(props.listRef.current!, "scrollToEnd");
    {
      using _timers = fakeTimers();
      await screen.rerender(timeline(true));
      await vi.waitFor(() => expect(restoration).toHaveResolved());
      scrollTo.mockClear();
      for (let growth = 1; growth <= 16; growth += 1) {
        await screen.rerender(timeline(true, growth));
        await act(async () => vi.advanceTimersByTimeAsync(16));
      }
      // LegendList coalesces further growth behind its 500ms smooth-follow timer.
      await act(async () => vi.advanceTimersByTimeAsync(1000));
    }
    expect(viewport.scrollHeight).toBeGreaterThan(initialHeight);
    const behaviors = scrollTo.mock.calls.map(([options]) => options.behavior);
    const smoothStart = behaviors.indexOf("smooth");
    expect(smoothStart).toBeGreaterThanOrEqual(0);
    expect(behaviors.slice(smoothStart + 1)).not.toContain("auto");
    await vi.waitFor(() =>
      expect(
        viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop,
      ).toBeLessThanOrEqual(2),
    );
  });

  it("does not interrupt a smooth jump when following is re-enabled without new rows", async () => {
    const onIsAtEndChange = vi.fn();
    const props = { ...baseProps(), onIsAtEndChange };
    const timeline = (following: boolean) => (
      <MessagesTimeline {...props} timelineEntries={tallEntries} liveFollowEnabled={following} />
    );
    await using screen = await renderElement(timeline(false));
    const viewport = await waitForList(props);
    const list = props.listRef.current!;
    await act(async () => {
      await list.scrollToEnd({ animated: false });
      await list.scrollToOffset({ offset: 0, animated: false });
      viewport.dispatchEvent(new Event("scroll"));
    });
    expect(onIsAtEndChange).toHaveBeenLastCalledWith(false);
    using _timers = fakeTimers();
    const scrollable: { scrollTo(options: ScrollToOptions): void } = viewport;
    const scrollTo = vi.spyOn(scrollable, "scrollTo");

    await act(async () => screen.rerender(timeline(true)));
    await act(async () => {
      void props.listRef.current!.scrollToEnd({ animated: true });
      for (let frame = 0; frame < 5; frame += 1) {
        await vi.advanceTimersByTimeAsync(16);
      }
    });

    expect(scrollTo.mock.calls.some(([options]) => options?.behavior === "smooth")).toBe(true);
    expect(scrollTo.mock.calls.some(([options]) => options?.behavior === "auto")).toBe(false);
  });

  it("lets an explicit smooth jump cancel an active end pin", async () => {
    const onIsAtEndChange = vi.fn();
    const props = { ...baseProps(), onIsAtEndChange };
    const cancelEndPinRef = createRef<(() => void) | null>();
    const timeline = (entries: Entry[]) => (
      <MessagesTimeline {...props} timelineEntries={entries} cancelEndPinRef={cancelEndPinRef} />
    );
    await using screen = await renderElement(timeline(tallEntries));
    const viewport = await waitForList(props);
    const list = props.listRef.current!;
    // Finish initial positioning and leave LegendList's follow threshold before
    // adding rows, so its own maintenance cannot satisfy the correction first.
    await act(async () => {
      await list.scrollToEnd({ animated: false });
      await list.scrollToOffset({ offset: 0, animated: false });
      viewport.dispatchEvent(new Event("scroll"));
    });
    expect(onIsAtEndChange).toHaveBeenLastCalledWith(false);
    expect(list.getState().isWithinMaintainScrollAtEndThreshold).toBe(false);
    using _timers = fakeTimers();
    const scrollable: { scrollTo(options: ScrollToOptions): void } = viewport;
    const scrollTo = vi.spyOn(scrollable, "scrollTo");
    const originalScrollToEnd = list.scrollToEnd.bind(list);
    let jumped = false;
    vi.spyOn(list, "scrollToEnd").mockImplementation((options) => {
      const result = originalScrollToEnd(options);
      if (!options?.animated && !jumped) {
        jumped = true;
        queueMicrotask(() => {
          cancelEndPinRef.current?.();
          viewport.scrollTop = 0;
          scrollTo.mockClear();
          void list.scrollToEnd({ animated: true });
        });
      }
      return result;
    });
    await act(async () => {
      viewport.scrollTop = 0;
      await screen.rerender(
        timeline([...tallEntries, ...Array.from({ length: 12 }, (_, index) => tall(index + 12))]),
      );
    });
    await vi.waitFor(() => expect(jumped).toBe(true));
    await act(async () => {
      for (let frame = 0; frame < 5; frame += 1) await vi.advanceTimersByTimeAsync(16);
    });
    expect(scrollTo.mock.calls.some(([options]) => options?.behavior === "smooth")).toBe(true);
    expect(scrollTo.mock.calls.some(([options]) => options?.behavior === "auto")).toBe(false);
  });

  it("restores a manual reading position after reopening and switching threads", async () => {
    const props = baseProps();
    function Chat() {
      const [liveFollowEnabled, setLiveFollowEnabled] = useState(true);
      // The chat view stops following the live edge when the reader scrolls.
      return (
        <div className="contents" onWheelCapture={() => setLiveFollowEnabled(false)}>
          <MessagesTimeline
            {...props}
            timelineEntries={tallEntries}
            liveFollowEnabled={liveFollowEnabled}
          />
        </div>
      );
    }
    await using screen = await renderElement(<Chat />);
    const viewport = await waitForList(props);
    await vi.waitFor(() => expect(readTimelinePosition(props.routeThreadKey)?.atEnd).toBe(true));

    await userEvent.wheel(viewport, { delta: { y: -600 } });
    await vi.waitFor(() => expect(readTimelinePosition(props.routeThreadKey)?.atEnd).toBe(false));
    const offset = viewport.scrollTop;
    await screen.unmount();
    expect(readTimelinePosition(props.routeThreadKey)).toMatchObject({
      atEnd: false,
      scrollOffset: offset,
    });

    const timeline = (routeThreadKey: string) => (
      <MessagesTimeline {...props} routeThreadKey={routeThreadKey} timelineEntries={tallEntries} />
    );
    await using reopened = await renderElement(timeline(props.routeThreadKey));
    const reopenedViewport = await waitForList(props);
    await vi.waitFor(() =>
      expect(Math.abs(reopenedViewport.scrollTop - offset)).toBeLessThanOrEqual(1),
    );

    await act(async () => reopened.rerender(timeline(`${props.routeThreadKey}-other`)));
    await vi.waitFor(() =>
      expect(
        reopenedViewport.scrollHeight - reopenedViewport.clientHeight - reopenedViewport.scrollTop,
      ).toBeLessThanOrEqual(1),
    );
    await act(async () => reopened.rerender(timeline(props.routeThreadKey)));
    await vi.waitFor(() =>
      expect(Math.abs(reopenedViewport.scrollTop - offset)).toBeLessThanOrEqual(1),
    );
  });
});
