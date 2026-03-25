import { MessageId } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { TimelineEntry } from "../../session-logic";

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

async function renderTimelineMarkup(timelineEntries: TimelineEntry[]) {
  const { MessagesTimeline } = await import("./MessagesTimeline");
  return renderToStaticMarkup(
    <MessagesTimeline
      hasMessages
      isWorking={false}
      activeTurnInProgress={false}
      activeTurnStartedAt={null}
      scrollContainer={null}
      timelineEntries={timelineEntries}
      completionDividerBeforeEntryId={null}
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
    />,
  );
}

describe("MessagesTimeline", () => {
  it("renders inline terminal labels with the composer chip UI", async () => {
    const markup = await renderTimelineMarkup([
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
    ]);

    expect(markup).toContain("Terminal 1 lines 1-5");
    expect(markup).toContain("lucide-terminal");
    expect(markup).toContain("yoo what&#x27;s ");
  });

  it("renders context compaction entries in the normal work log", async () => {
    const markup = await renderTimelineMarkup([
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
    ]);

    expect(markup).toContain("Context compacted");
    expect(markup).toContain("Work log");
  });

  it("uses the activity label as the icon fallback when toolTitle is absent", async () => {
    const markup = await renderTimelineMarkup([
      {
        id: "entry-read-no-title",
        kind: "work",
        createdAt: "2026-03-17T19:12:28.000Z",
        entry: {
          id: "work-read-no-title",
          createdAt: "2026-03-17T19:12:28.000Z",
          label: "Read file",
          itemType: "dynamic_tool_call",
          detail:
            "/Users/zortos/t3code/apps/server/src/orchestration/Services/OrchestrationEngine.ts",
          tone: "tool",
        },
      },
      {
        id: "entry-glob-no-title",
        kind: "work",
        createdAt: "2026-03-17T19:12:29.000Z",
        entry: {
          id: "work-glob-no-title",
          createdAt: "2026-03-17T19:12:29.000Z",
          label: "Glob",
          itemType: "dynamic_tool_call",
          detail: "/Users/zortos/t3code/apps/server/src",
          tone: "tool",
        },
      },
    ]);

    expect(markup).toContain("Read file");
    expect(markup).toContain("Glob");
    expect(markup).toContain("lucide-eye");
    expect(markup).toContain("lucide-search");
    expect(markup).not.toContain("lucide-hammer");
  });

  it("prefers changed file paths over raw diff text in file change rows", async () => {
    const markup = await renderTimelineMarkup([
      {
        id: "entry-file-change",
        kind: "work",
        createdAt: "2026-03-17T19:12:28.000Z",
        entry: {
          id: "work-file-change",
          createdAt: "2026-03-17T19:12:28.000Z",
          label: "Tool call",
          toolTitle: "File change",
          itemType: "file_change",
          detail: "diff --git a/TESTING.md b/TESTING.md\n--- a/dev/null\n+++ b/TESTING.md",
          changedFiles: ["/Users/zortos/t3code/TESTING.md"],
          tone: "tool",
        },
      },
    ]);

    expect(markup).toContain("File change");
    expect(markup).toContain("/Users/zortos/t3code/TESTING.md");
    expect(markup).not.toContain("diff --git");
    expect(markup).toContain("lucide-square-pen");
  });
});
