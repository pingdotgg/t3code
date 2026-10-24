import { EnvironmentId, MessageId, RunId, ScheduledTaskId, ThreadId } from "@t3tools/contracts";
import type { LegendListRef } from "@legendapp/list/react";
import { createRef, Profiler, type ComponentProps, type ReactElement } from "react";
import { describe, expect, it, vi } from "vite-plus/test";

import "~/index.css";

import { act, render } from "../../../test/render";
import { paintedMinimapMarkerIndices } from "../../../test/minimapPixels";
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

function history(prefix = "history", count = 60): Entry[] {
  const body = [
    "The conversation covers scroll anchoring, measured row heights, and loading earlier turns.",
    "Keep the current question in view while the surrounding history changes and replies wrap.",
    "Check the viewport against the rendered messages before navigating to another question.",
  ].join(" ");
  return Array.from({ length: count }, (_, index) =>
    message(
      `Message ${prefix}-${index}\n\n${Array.from({ length: 4 }, () => body).join("\n\n")}`,
      { role: index % 2 === 0 ? "user" : "assistant" },
      `${prefix}-${index}`,
    ),
  );
}

function userTurns(entries: ReadonlyArray<Entry>) {
  return entries.filter(
    (entry): entry is Extract<Entry, { kind: "message" }> =>
      entry.kind === "message" && entry.message.role === "user",
  );
}

function visibleTurns(container: HTMLElement, list: LegendListRef, entries: ReadonlyArray<Entry>) {
  const viewport = list.getScrollableNode().getBoundingClientRect();
  return userTurns(entries).flatMap((entry, index) => {
    const row = container.querySelector<HTMLElement>(`[data-timeline-row-id="${entry.id}"]`);
    if (!row) return [];
    const bounds = row.getBoundingClientRect();
    return bounds.height > 0 && bounds.top < viewport.bottom && bounds.bottom > viewport.top
      ? [index]
      : [];
  });
}

function expectMinimapMatchesViewport(
  container: HTMLElement,
  list: LegendListRef,
  entries: ReadonlyArray<Entry>,
) {
  // Use mounted DOM geometry as the oracle, independently of the parent's range resolver.
  const visible = visibleTurns(container, list, entries);
  expect(visible.length).toBeGreaterThan(0);
  const painted = paintedMinimapMarkerIndices(container, userTurns(entries).length);
  expect(painted).toEqual(visible);
  return painted;
}

function expectEntryNearTop(container: HTMLElement, list: LegendListRef, entry: Entry) {
  const row = container.querySelector<HTMLElement>(`[data-timeline-row-id="${entry.id}"]`);
  expect(row).not.toBeNull();
  const offset =
    row!.getBoundingClientRect().top - list.getScrollableNode().getBoundingClientRect().top;
  expect(offset).toBeGreaterThanOrEqual(0);
  expect(offset).toBeLessThan(48);
}

describe("MessagesTimeline minimap integration", () => {
  it.each(["populated", "empty"] as const)(
    "uses the %s destination after switching threads with a parent refresh queued",
    async (destination) => {
      const entries = history("source");
      const destinationEntries = destination === "empty" ? [] : history("destination", 24);
      const props = { ...baseProps(), liveFollowEnabled: false };
      await using screen = await renderElement(
        <MessagesTimeline {...props} timelineEntries={entries} />,
      );
      await vi.waitFor(() => expect(props.listRef.current).not.toBeNull());
      const list = props.listRef.current!;
      const middle = entries[40]!;
      await vi.waitFor(() => expect(list.getState().indexByKey(middle.id)).toBeDefined());
      await act(() => {
        void list.scrollToIndex({
          index: list.getState().indexByKey(middle.id)!,
          animated: false,
          viewOffset: 24,
        });
      });
      await vi.waitFor(() => {
        expectEntryNearTop(screen.container, list, middle);
        expectMinimapMatchesViewport(screen.container, list, entries);
      });
      const sourceCanvas = screen.container.querySelector("[data-minimap-canvas]");
      const sourceMarkers = paintedMinimapMarkerIndices(
        screen.container,
        userTurns(entries).length,
      );
      const requestFrame = window.requestAnimationFrame.bind(window);
      const cancelFrame = window.cancelAnimationFrame.bind(window);
      const queuedFrames: number[] = [];
      const refresh = vi.fn<FrameRequestCallback>();
      using cancelFrameSpy = vi.spyOn(window, "cancelAnimationFrame");
      using requestFrameSpy = vi
        .spyOn(window, "requestAnimationFrame")
        .mockImplementation((callback) => {
          // Identify only the parent's minimap callback by its ref reset and refresh call.
          // LegendList and the parent's other frame callbacks keep their native scheduling.
          const source = callback.toString();
          if (
            queuedFrames.length > 0 ||
            !/minimapRefreshFrameRef\.current\s*=\s*null/.test(source) ||
            !/refreshMinimap\s*\(/.test(source)
          ) {
            return requestFrame(callback);
          }
          const frame = requestFrame(callback);
          cancelFrame(frame);
          queuedFrames.push(frame);
          refresh.mockImplementation(callback);
          return frame;
        });

      await vi.waitFor(async () => {
        await act(() => list.getScrollableNode().dispatchEvent(new Event("scroll")));
        expect(
          queuedFrames,
          "A must queue the parent's minimap refresh before switching",
        ).toHaveLength(1);
      });
      expect(refresh).not.toHaveBeenCalled();

      // Preserve the parent, its list ref and callbacks; only the thread identity changes.
      await screen.rerender(
        <MessagesTimeline
          {...props}
          routeThreadKey={`${props.routeThreadKey}-${destination}`}
          timelineEntries={destinationEntries}
        />,
      );
      await vi.waitFor(() => {
        if (destinationEntries.length === 0) {
          expect(props.listRef.current).toBeNull();
        } else {
          expect(props.listRef.current).toBe(list);
          expect(list.getState().indexByKey(middle.id)).toBeUndefined();
          expect(list.getState().data).toHaveLength(destinationEntries.length);
        }
      });

      if (destinationEntries.length > 0) {
        const target = destinationEntries[8]!;
        await vi.waitFor(() => expect(list.getState().indexByKey(target.id)).toBeDefined());
        await act(() => {
          void list.scrollToIndex({
            index: list.getState().indexByKey(target.id)!,
            animated: false,
            viewOffset: 24,
          });
        });
        await vi.waitFor(() => {
          expectEntryNearTop(screen.container, list, target);
          expect(visibleTurns(screen.container, list, destinationEntries).length).toBeGreaterThan(
            0,
          );
          expect(screen.container.querySelector("[data-minimap-canvas]")).not.toBe(sourceCanvas);
        });
      }

      expect(refresh).not.toHaveBeenCalled();
      expect(cancelFrameSpy).not.toHaveBeenCalledWith(queuedFrames[0]);
      requestFrameSpy.mockRestore();
      await act(() => {
        refresh(0);
        // Assert during this callback's turn, before any later frame can repair stale pixels.
        if (destinationEntries.length > 0) {
          const painted = expectMinimapMatchesViewport(screen.container, list, destinationEntries);
          expect(painted).not.toEqual(sourceMarkers);
        } else {
          expect(screen.container.querySelector("[data-minimap-canvas]")).toBeNull();
          expect(screen.container.querySelector("[data-timeline-row-id]")).toBeNull();
          expect(screen.buttons(/^(Previous|Next) turn$/)).toHaveLength(0);
        }
      });
      expect(refresh).toHaveBeenCalledTimes(1);
      if (destinationEntries.length === 0) return;

      const turns = userTurns(destinationEntries);
      const current = visibleTurns(screen.container, list, destinationEntries)[0]!;
      const previous = turns[current - 1]!;
      const next = turns[current]!;
      await click(screen.button("Previous turn"));
      await vi.waitFor(() => {
        expectEntryNearTop(screen.container, list, previous);
        expectMinimapMatchesViewport(screen.container, list, destinationEntries);
      });
      await click(screen.button("Next turn"));
      await vi.waitFor(() => {
        expectEntryNearTop(screen.container, list, next);
        expectMinimapMatchesViewport(screen.container, list, destinationEntries);
      });
    },
  );

  it("refreshes visible markers and previous/next destinations after prepending history", async () => {
    const entries = history();
    const props = { ...baseProps(), liveFollowEnabled: false };
    await using screen = await renderElement(
      <MessagesTimeline {...props} timelineEntries={entries} />,
    );
    await vi.waitFor(() => expect(props.listRef.current).not.toBeNull());
    const list = props.listRef.current!;
    const middle = entries[40]!;
    await vi.waitFor(() => expect(list.getState().indexByKey(middle.id)).toBeDefined());
    await act(() => {
      void list.scrollToIndex({
        index: list.getState().indexByKey(middle.id)!,
        animated: false,
        viewOffset: 24,
      });
    });
    await vi.waitFor(() => {
      expectEntryNearTop(screen.container, list, middle);
      expectMinimapMatchesViewport(screen.container, list, entries);
    });
    const originalMarkers = paintedMinimapMarkerIndices(
      screen.container,
      userTurns(entries).length,
    );
    const prepended = [...history("earlier", 12), ...entries];

    // Keep the ref, callbacks and thread key stable so this updates the existing list.
    await screen.rerender(<MessagesTimeline {...props} timelineEntries={prepended} />);
    await vi.waitFor(() => {
      expect(props.listRef.current).toBe(list);
      expectEntryNearTop(screen.container, list, middle);
      const after = expectMinimapMatchesViewport(screen.container, list, prepended);
      expect(after).not.toEqual(originalMarkers);
    });

    const turns = userTurns(prepended);
    const current = visibleTurns(screen.container, list, prepended)[0]!;
    const previous = turns[current - 1]!;
    const next = turns[current]!;
    await click(screen.button("Previous turn"));
    await vi.waitFor(() => {
      expectEntryNearTop(screen.container, list, previous);
      expectMinimapMatchesViewport(screen.container, list, prepended);
    });
    await click(screen.button("Next turn"));
    await vi.waitFor(() => {
      expectEntryNearTop(screen.container, list, next);
      expectMinimapMatchesViewport(screen.container, list, prepended);
    });
  });

  it("refreshes the visible band after a height-only resize without changing rows or scroll offset", async () => {
    const entries = history();
    const props = { ...baseProps(), liveFollowEnabled: false };
    await using screen = await renderElement(
      <MessagesTimeline {...props} timelineEntries={entries} />,
    );
    await vi.waitFor(() => expect(props.listRef.current).not.toBeNull());
    const list = props.listRef.current!;
    const middle = entries[40]!;
    await vi.waitFor(() => expect(list.getState().indexByKey(middle.id)).toBeDefined());
    await act(() => {
      void list.scrollToIndex({
        index: list.getState().indexByKey(middle.id)!,
        animated: false,
        viewOffset: 24,
      });
    });
    await vi.waitFor(() => {
      expectEntryNearTop(screen.container, list, middle);
      expect(expectMinimapMatchesViewport(screen.container, list, entries).length).toBeGreaterThan(
        1,
      );
    });
    const viewport = list.getScrollableNode();
    const scrollTop = viewport.scrollTop;
    const before = paintedMinimapMarkerIndices(screen.container, userTurns(entries).length);
    const rows = list.getState().data;

    await act(() => {
      screen.container.style.height = "360px";
    });
    await vi.waitFor(() => {
      expect(viewport.clientHeight).toBe(360);
      expect(list.getState().data).toBe(rows);
      expect(Math.abs(viewport.scrollTop - scrollTop)).toBeLessThan(1);
      const after = expectMinimapMatchesViewport(screen.container, list, entries);
      expect(after.length).toBeLessThan(before.length);
      expect(after[0]).toBe(before[0]);
    });

    const next = userTurns(entries)[visibleTurns(screen.container, list, entries)[0]! + 1]!;
    await click(screen.button("Next turn"));
    await vi.waitFor(() => {
      expectEntryNearTop(screen.container, list, next);
      expectMinimapMatchesViewport(screen.container, list, entries);
    });
  });
});

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
