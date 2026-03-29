import { MessageId } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { buildTimelineRows } from "./MessagesTimeline.logic";

vi.mock("../../hooks/useTheme", () => ({
  useTheme: () => ({
    theme: "light",
    resolvedTheme: "light",
  }),
}));

function matchMedia() {
  return {
    matches: false,
    addEventListener: () => {},
    removeEventListener: () => {},
  };
}

beforeAll(() => {
  const classList = {
    add: () => {},
    remove: () => {},
    toggle: () => {},
    contains: () => false,
  };

  vi.stubGlobal("localStorage", {
    getItem: () => null,
    setItem: () => {},
    removeItem: () => {},
    clear: () => {},
  });
  vi.stubGlobal("window", {
    matchMedia,
    addEventListener: () => {},
    removeEventListener: () => {},
    desktopBridge: undefined,
  });
  vi.stubGlobal("document", {
    documentElement: {
      classList,
      offsetHeight: 0,
    },
  });
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    callback(0);
    return 0;
  });
});

async function renderTimelineWithCopyFormat(options: {
  timelineEntries: Parameters<typeof buildTimelineRows>[0]["timelineEntries"];
  assistantResponseCopyFormat?: "markdown" | "plain-text";
}) {
  const { MessagesTimeline } = await import("./MessagesTimeline");
  const rows = buildTimelineRows({
    timelineEntries: options.timelineEntries,
    completionDividerBeforeEntryId: null,
    isWorking: false,
    activeTurnStartedAt: null,
  });

  return renderToStaticMarkup(
    <MessagesTimeline
      rows={rows}
      activeTurnInProgress={false}
      activeTurnStartedAt={null}
      scrollContainer={null}
      completionSummary={null}
      turnDiffSummaryByAssistantMessageId={new Map()}
      nowIso="2026-03-17T19:12:30.000Z"
      expandedWorkGroups={{}}
      onToggleWorkGroup={() => {}}
      onOpenTurnDiff={() => {}}
      revertTurnCountByUserMessageId={new Map()}
      onRevertUserMessage={() => {}}
      isRevertingCheckpoint={false}
      onImageExpand={() => {}}
      markdownCwd={undefined}
      resolvedTheme="light"
      timestampFormat="locale"
      workspaceRoot={undefined}
      activeSearchRowId={null}
      matchedSearchRowIds={new Set()}
      searchQuery=""
      {...(options.assistantResponseCopyFormat
        ? {
            assistantResponseCopyFormat: options.assistantResponseCopyFormat,
          }
        : {})}
    />,
  );
}

describe("MessagesTimeline", () => {
  it("renders inline terminal labels with the composer chip UI", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const rows = buildTimelineRows({
      timelineEntries: [
        {
          id: "entry-1",
          kind: "message",
          createdAt: "2026-03-17T19:12:28.000Z",
          message: {
            id: MessageId.makeUnsafe("message-2"),
            role: "user",
            text: [
              "yoo what's @terminal-1:1-5 mean",
              "",
              "<terminal_context>",
              "- Terminal 1 lines 1-5:",
              "  1 | julius@mac effect-http-ws-cli % bun i",
              "  2 | bun install v1.3.9 (cf6cdbbb)",
              "</terminal_context>",
            ].join("\n"),
            createdAt: "2026-03-17T19:12:28.000Z",
            streaming: false,
          },
        },
      ],
      completionDividerBeforeEntryId: null,
      isWorking: false,
      activeTurnStartedAt: null,
    });
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        rows={rows}
        activeTurnInProgress={false}
        activeTurnStartedAt={null}
        scrollContainer={null}
        completionSummary={null}
        turnDiffSummaryByAssistantMessageId={new Map()}
        nowIso="2026-03-17T19:12:30.000Z"
        expandedWorkGroups={{}}
        onToggleWorkGroup={() => {}}
        onOpenTurnDiff={() => {}}
        revertTurnCountByUserMessageId={new Map()}
        onRevertUserMessage={() => {}}
        isRevertingCheckpoint={false}
        onImageExpand={() => {}}
        markdownCwd={undefined}
        resolvedTheme="light"
        timestampFormat="locale"
        workspaceRoot={undefined}
        activeSearchRowId={null}
        matchedSearchRowIds={new Set()}
        searchQuery=""
      />,
    );

    expect(markup).toContain("Terminal 1 lines 1-5");
    expect(markup).toContain("lucide-terminal");
    expect(markup).toContain("yoo what&#x27;s ");
  });

  it("highlights rendered terminal chip labels during search", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const rows = buildTimelineRows({
      timelineEntries: [
        {
          id: "entry-1",
          kind: "message",
          createdAt: "2026-03-17T19:12:28.000Z",
          message: {
            id: MessageId.makeUnsafe("message-chip-search"),
            role: "user",
            text: [
              "check this @terminal-1:1-5",
              "",
              "<terminal_context>",
              "- Terminal 1 lines 1-5:",
              "  1 | echoed output",
              "</terminal_context>",
            ].join("\n"),
            createdAt: "2026-03-17T19:12:28.000Z",
            streaming: false,
          },
        },
      ],
      completionDividerBeforeEntryId: null,
      isWorking: false,
      activeTurnStartedAt: null,
    });
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        rows={rows}
        activeTurnInProgress={false}
        activeTurnStartedAt={null}
        scrollContainer={null}
        completionSummary={null}
        turnDiffSummaryByAssistantMessageId={new Map()}
        nowIso="2026-03-17T19:12:30.000Z"
        expandedWorkGroups={{}}
        onToggleWorkGroup={() => {}}
        onOpenTurnDiff={() => {}}
        revertTurnCountByUserMessageId={new Map()}
        onRevertUserMessage={() => {}}
        isRevertingCheckpoint={false}
        onImageExpand={() => {}}
        markdownCwd={undefined}
        resolvedTheme="light"
        timestampFormat="locale"
        workspaceRoot={undefined}
        activeSearchRowId="entry-1"
        matchedSearchRowIds={new Set(["entry-1"])}
        searchQuery="Terminal 1 lines 1-5"
      />,
    );

    expect(markup).toContain("Terminal 1 lines 1-5");
    expect(markup).toContain('data-thread-search-highlight="active"');
  });

  it("renders context compaction entries in the normal work log", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const rows = buildTimelineRows({
      timelineEntries: [
        {
          id: "entry-1",
          kind: "work",
          createdAt: "2026-03-17T19:12:28.000Z",
          entry: {
            id: "work-1",
            createdAt: "2026-03-17T19:12:28.000Z",
            label: "Context compacted",
            tone: "info",
          },
        },
      ],
      completionDividerBeforeEntryId: null,
      isWorking: false,
      activeTurnStartedAt: null,
    });
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        rows={rows}
        activeTurnInProgress={false}
        activeTurnStartedAt={null}
        scrollContainer={null}
        completionSummary={null}
        turnDiffSummaryByAssistantMessageId={new Map()}
        nowIso="2026-03-17T19:12:30.000Z"
        expandedWorkGroups={{}}
        onToggleWorkGroup={() => {}}
        onOpenTurnDiff={() => {}}
        revertTurnCountByUserMessageId={new Map()}
        onRevertUserMessage={() => {}}
        isRevertingCheckpoint={false}
        onImageExpand={() => {}}
        markdownCwd={undefined}
        resolvedTheme="light"
        timestampFormat="locale"
        workspaceRoot={undefined}
        activeSearchRowId={null}
        matchedSearchRowIds={new Set()}
        searchQuery=""
      />,
    );

    expect(markup).toContain("Context compacted");
    expect(markup).toContain("Work log");
  });

  it("renders active inline search highlights without row-level emphasis", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const rows = buildTimelineRows({
      timelineEntries: [
        {
          id: "message-1",
          kind: "message",
          createdAt: "2026-03-17T19:12:28.000Z",
          message: {
            id: MessageId.makeUnsafe("message-1"),
            role: "user",
            text: "Search target",
            createdAt: "2026-03-17T19:12:28.000Z",
            streaming: false,
          },
        },
      ],
      completionDividerBeforeEntryId: null,
      isWorking: false,
      activeTurnStartedAt: null,
    });
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        rows={rows}
        activeTurnInProgress={false}
        activeTurnStartedAt={null}
        scrollContainer={null}
        completionSummary={null}
        turnDiffSummaryByAssistantMessageId={new Map()}
        nowIso="2026-03-17T19:12:30.000Z"
        expandedWorkGroups={{}}
        onToggleWorkGroup={() => {}}
        onOpenTurnDiff={() => {}}
        revertTurnCountByUserMessageId={new Map()}
        onRevertUserMessage={() => {}}
        isRevertingCheckpoint={false}
        onImageExpand={() => {}}
        markdownCwd={undefined}
        resolvedTheme="light"
        timestampFormat="locale"
        workspaceRoot={undefined}
        activeSearchRowId="message-1"
        matchedSearchRowIds={new Set(["message-1"])}
        searchQuery="Search"
      />,
    );

    expect(markup).toContain('data-timeline-row-id="message-1"');
    expect(markup).toContain('data-search-match-state="active"');
    expect(markup).toContain('data-thread-search-highlight="active"');
    expect(markup).toContain("<mark");
    expect(markup).not.toContain("bg-warning/12");
  });

  it("exposes hidden work log matches while searching overflowed groups", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const rows = buildTimelineRows({
      timelineEntries: [
        {
          id: "work-entry-1",
          kind: "work",
          createdAt: "2026-03-17T19:12:28.000Z",
          entry: {
            id: "work-1",
            createdAt: "2026-03-17T19:12:28.000Z",
            label: "Seeded hidden match",
            tone: "info",
          },
        },
        ...Array.from({ length: 6 }, (_, index) => ({
          id: `work-entry-${index + 2}`,
          kind: "work" as const,
          createdAt: `2026-03-17T19:12:${String(29 + index).padStart(2, "0")}.000Z`,
          entry: {
            id: `work-${index + 2}`,
            createdAt: `2026-03-17T19:12:${String(29 + index).padStart(2, "0")}.000Z`,
            label: `Visible filler ${index + 1}`,
            tone: "info" as const,
          },
        })),
      ],
      completionDividerBeforeEntryId: null,
      isWorking: false,
      activeTurnStartedAt: null,
    });
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        rows={rows}
        activeTurnInProgress={false}
        activeTurnStartedAt={null}
        scrollContainer={null}
        completionSummary={null}
        turnDiffSummaryByAssistantMessageId={new Map()}
        nowIso="2026-03-17T19:12:30.000Z"
        expandedWorkGroups={{}}
        onToggleWorkGroup={() => {}}
        onOpenTurnDiff={() => {}}
        revertTurnCountByUserMessageId={new Map()}
        onRevertUserMessage={() => {}}
        isRevertingCheckpoint={false}
        onImageExpand={() => {}}
        markdownCwd={undefined}
        resolvedTheme="light"
        timestampFormat="locale"
        workspaceRoot={undefined}
        activeSearchRowId="work-entry-1"
        matchedSearchRowIds={new Set(["work-entry-1"])}
        searchQuery="Seeded"
      />,
    );

    expect(markup).toContain("Seeded hidden match");
    expect(markup).toContain('data-thread-search-highlight="active"');
    expect(markup).not.toContain("Show 1 more");
  });

  it("renders assistant markdown search highlights", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const rows = buildTimelineRows({
      timelineEntries: [
        {
          id: "assistant-row-1",
          kind: "message",
          createdAt: "2026-03-17T19:12:28.000Z",
          message: {
            id: MessageId.makeUnsafe("assistant-message-1"),
            role: "assistant",
            text: "The **highlight** should also appear in assistant markdown.",
            createdAt: "2026-03-17T19:12:28.000Z",
            streaming: false,
          },
        },
      ],
      completionDividerBeforeEntryId: null,
      isWorking: false,
      activeTurnStartedAt: null,
    });
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        rows={rows}
        activeTurnInProgress={false}
        activeTurnStartedAt={null}
        scrollContainer={null}
        completionSummary={null}
        turnDiffSummaryByAssistantMessageId={new Map()}
        nowIso="2026-03-17T19:12:30.000Z"
        expandedWorkGroups={{}}
        onToggleWorkGroup={() => {}}
        onOpenTurnDiff={() => {}}
        revertTurnCountByUserMessageId={new Map()}
        onRevertUserMessage={() => {}}
        isRevertingCheckpoint={false}
        onImageExpand={() => {}}
        markdownCwd={undefined}
        resolvedTheme="light"
        timestampFormat="locale"
        workspaceRoot={undefined}
        activeSearchRowId="assistant-row-1"
        matchedSearchRowIds={new Set(["assistant-row-1"])}
        searchQuery="highlight"
      />,
    );

    expect(markup).toContain('data-timeline-row-id="assistant-row-1"');
    expect(markup).toContain('data-thread-search-highlight="active"');
    expect(markup).toContain("<mark");
    expect(markup).toContain(">highlight<");
  });

  it("renders a copy control for completed assistant messages", async () => {
    const markup = await renderTimelineWithCopyFormat({
      timelineEntries: [
        {
          id: "entry-1",
          kind: "message",
          createdAt: "2026-03-17T19:12:28.000Z",
          message: {
            id: MessageId.makeUnsafe("assistant-complete"),
            role: "assistant",
            text: "Completed response",
            createdAt: "2026-03-17T19:12:28.000Z",
            completedAt: "2026-03-17T19:12:30.000Z",
            streaming: false,
          },
        },
      ],
    });

    expect(markup).toContain("Copy response");
  });

  it("does not render a copy control for streaming assistant messages", async () => {
    const markup = await renderTimelineWithCopyFormat({
      timelineEntries: [
        {
          id: "entry-1",
          kind: "message",
          createdAt: "2026-03-17T19:12:28.000Z",
          message: {
            id: MessageId.makeUnsafe("assistant-streaming"),
            role: "assistant",
            text: "Partial response",
            createdAt: "2026-03-17T19:12:28.000Z",
            streaming: true,
          },
        },
      ],
    });

    expect(markup).not.toContain("Copy response");
  });

  it("does not render a copy control for empty completed assistant messages", async () => {
    const markup = await renderTimelineWithCopyFormat({
      timelineEntries: [
        {
          id: "entry-1",
          kind: "message",
          createdAt: "2026-03-17T19:12:28.000Z",
          message: {
            id: MessageId.makeUnsafe("assistant-empty"),
            role: "assistant",
            text: "   ",
            createdAt: "2026-03-17T19:12:28.000Z",
            completedAt: "2026-03-17T19:12:30.000Z",
            streaming: false,
          },
        },
      ],
    });

    expect(markup).not.toContain("Copy response");
  });

  it("does not render a copy control when plain-text resolution is empty", async () => {
    const markup = await renderTimelineWithCopyFormat({
      timelineEntries: [
        {
          id: "entry-1",
          kind: "message",
          createdAt: "2026-03-17T19:12:28.000Z",
          message: {
            id: MessageId.makeUnsafe("assistant-plain-text-empty"),
            role: "assistant",
            text: "---",
            createdAt: "2026-03-17T19:12:28.000Z",
            completedAt: "2026-03-17T19:12:30.000Z",
            streaming: false,
          },
        },
      ],
      assistantResponseCopyFormat: "plain-text",
    });

    expect(markup).not.toContain("Copy response");
  });

  it("renders a copy control for html-only assistant messages in plain-text mode", async () => {
    const markup = await renderTimelineWithCopyFormat({
      timelineEntries: [
        {
          id: "entry-1",
          kind: "message",
          createdAt: "2026-03-17T19:12:28.000Z",
          message: {
            id: MessageId.makeUnsafe("assistant-html-only"),
            role: "assistant",
            text: "<details><summary>Example</summary></details>",
            createdAt: "2026-03-17T19:12:28.000Z",
            completedAt: "2026-03-17T19:12:30.000Z",
            streaming: false,
          },
        },
      ],
      assistantResponseCopyFormat: "plain-text",
    });

    expect(markup).toContain("Copy response");
  });
});
