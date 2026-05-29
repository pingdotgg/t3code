import { EnvironmentId, MessageId } from "@t3tools/contracts";
import { createRef, type ReactNode, type Ref } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { VirtualizedListHandle } from "../virtualization/VirtualizedList";

const virtualizedListMockState = vi.hoisted(() => ({
  latestProps: null as
    | null
    | (Record<string, unknown> & {
        readonly firstItemIndex?: never;
        readonly onStartReached?: never;
        readonly onVisibleRangeChange?: never;
      }),
}));

vi.mock("../virtualization/VirtualizedList", () => {
  const virtualizedListTestId = "virtualized-list";

  const VirtualizedList = (props: {
    data: Array<{ id: string }>;
    keyExtractor: (item: { id: string }) => string;
    renderItem: (args: { item: { id: string }; index: number }) => ReactNode;
    ListHeaderComponent?: ReactNode;
    ListFooterComponent?: ReactNode;
    maintainVisibleContentPosition?: unknown;
    ref?: Ref<VirtualizedListHandle>;
    "data-testid"?: string;
  }) => {
    virtualizedListMockState.latestProps = props;
    return (
      <div data-testid={props["data-testid"] ?? virtualizedListTestId}>
        {props.ListHeaderComponent}
        {props.data.map((item, index) => (
          <div key={props.keyExtractor(item)}>{props.renderItem({ item, index })}</div>
        ))}
        {props.ListFooterComponent}
      </div>
    );
  };

  return { VirtualizedList };
});

vi.mock("../ChatMarkdown", () => ({
  default: (props: { text: string; environmentId?: EnvironmentId }) => (
    <div data-chat-markdown-environment-id={props.environmentId ?? ""}>{props.text}</div>
  ),
}));

import { MessagesTimeline } from "./MessagesTimeline";

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
    requestAnimationFrame: (callback: FrameRequestCallback) => {
      callback(0);
      return 0;
    },
    cancelAnimationFrame: () => {},
    desktopBridge: undefined,
  });
  vi.stubGlobal("document", {
    documentElement: {
      classList,
      offsetHeight: 0,
    },
  });
});

function getLatestVirtualizedListProps() {
  if (!virtualizedListMockState.latestProps) {
    throw new Error("VirtualizedList was not rendered.");
  }
  return virtualizedListMockState.latestProps;
}

const ACTIVE_THREAD_ENVIRONMENT_ID = EnvironmentId.make("environment-local");
const MESSAGE_CREATED_AT = "2026-03-17T19:12:28.000Z";

function buildProps() {
  return {
    isWorking: false,
    activeTurnInProgress: false,
    activeTurnId: null,
    activeTurnStartedAt: null,
    listRef: createRef<VirtualizedListHandle | null>(),
    completionDividerBeforeEntryId: null,
    completionSummary: null,
    turnDiffSummaryByAssistantMessageId: new Map(),
    routeThreadKey: "environment-local:thread-1",
    onOpenTurnDiff: () => {},
    revertTurnCountByUserMessageId: new Map(),
    onRevertUserMessage: () => {},
    isRevertingCheckpoint: false,
    onImageExpand: () => {},
    activeThreadEnvironmentId: ACTIVE_THREAD_ENVIRONMENT_ID,
    markdownCwd: undefined,
    resolvedTheme: "light" as const,
    timestampFormat: "locale" as const,
    workspaceRoot: undefined,
    onIsAtEndChange: () => {},
  };
}

function buildLongUserMessageText(tail = "deep hidden detail only after expand") {
  return Array.from({ length: 9 }, (_, index) =>
    index === 8 ? tail : `Line ${index + 1}: ${"verbose prompt content ".repeat(8).trim()}`,
  ).join("\n");
}

function buildUserTimelineEntry(text: string) {
  return {
    id: "entry-1",
    kind: "message" as const,
    createdAt: MESSAGE_CREATED_AT,
    message: {
      id: MessageId.make("message-1"),
      role: "user" as const,
      text,
      createdAt: MESSAGE_CREATED_AT,
      streaming: false,
    },
  };
}

function buildAssistantTimelineEntry(text: string) {
  return {
    id: "entry-1",
    kind: "message" as const,
    createdAt: MESSAGE_CREATED_AT,
    message: {
      id: MessageId.make("message-1"),
      role: "assistant" as const,
      text,
      createdAt: MESSAGE_CREATED_AT,
      streaming: false,
    },
  };
}

describe("MessagesTimeline", () => {
  it("renders an older-page control when thread detail has more history", () => {
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        hasOlderThreadDetail
        onLoadOlderThreadDetail={() => {}}
        timelineEntries={[buildAssistantTimelineEntry("Recent answer.")]}
      />,
    );

    expect(markup).toContain("Older");
    expect(markup).toContain("lucide-chevron-up");
    expect(markup).not.toContain('disabled=""');
  });

  it("does not pass prepend or auto-load props into the timeline virtualizer", () => {
    renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[buildAssistantTimelineEntry("Recent answer.")]}
      />,
    );

    expect(getLatestVirtualizedListProps().firstItemIndex).toBeUndefined();
    expect(getLatestVirtualizedListProps().onStartReached).toBeUndefined();
    expect(getLatestVirtualizedListProps().onVisibleRangeChange).toBeUndefined();
    expect(getLatestVirtualizedListProps().maintainVisibleContentPosition).toEqual({
      data: true,
      size: true,
    });
  });

  it("shows the older-page control as busy while loading history", () => {
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        hasOlderThreadDetail
        isLoadingOlderThreadDetail
        onLoadOlderThreadDetail={() => {}}
        timelineEntries={[buildAssistantTimelineEntry("Recent answer.")]}
      />,
    );

    expect(markup).toContain("Loading earlier messages...");
    expect(markup).toContain("lucide-loader-circle");
    expect(markup).toContain('role="status"');
    expect(markup).not.toContain("lucide-chevron-up");
  });

  it("renders the manual older button without auto-calling the loader", () => {
    const onLoadOlderThreadDetail = vi.fn();
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        hasOlderThreadDetail
        onLoadOlderThreadDetail={onLoadOlderThreadDetail}
        timelineEntries={[buildAssistantTimelineEntry("Recent answer.")]}
      />,
    );

    expect(markup).toContain("Older");
    expect(onLoadOlderThreadDetail).not.toHaveBeenCalled();
  });

  it("does not wire automatic older history loading while loading or without older history", () => {
    renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        hasOlderThreadDetail
        isLoadingOlderThreadDetail
        onLoadOlderThreadDetail={() => {}}
        timelineEntries={[buildAssistantTimelineEntry("Recent answer.")]}
      />,
    );
    expect(getLatestVirtualizedListProps().onStartReached).toBeUndefined();
    expect(getLatestVirtualizedListProps().onVisibleRangeChange).toBeUndefined();

    renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        onLoadOlderThreadDetail={() => {}}
        timelineEntries={[buildAssistantTimelineEntry("Recent answer.")]}
      />,
    );
    expect(getLatestVirtualizedListProps().onStartReached).toBeUndefined();
    expect(getLatestVirtualizedListProps().onVisibleRangeChange).toBeUndefined();
  });

  it("renders collapse controls for long user messages", () => {
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[buildUserTimelineEntry(buildLongUserMessageText())]}
      />,
    );

    expect(markup).toContain("Show full message");
    expect(markup).toContain('data-user-message-collapsed="true"');
    expect(markup).toContain('data-user-message-fade="true"');
    expect(markup).toContain('data-user-message-footer="true"');
  });

  it("does not render collapse controls for short user messages", () => {
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[buildUserTimelineEntry("Short prompt.")]}
      />,
    );

    expect(markup).not.toContain("Show full message");
    expect(markup).toContain('data-user-message-collapsible="false"');
  });

  it("passes the active environment id into assistant markdown for file previews", () => {
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        markdownCwd="/repo/project"
        timelineEntries={[buildAssistantTimelineEntry("[index.ts](src/index.ts)")]}
      />,
    );

    expect(markup).toContain('data-chat-markdown-environment-id="environment-local"');
  });

  it("renders inline terminal labels with the composer chip UI", () => {
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[
          buildUserTimelineEntry(
            [
              buildLongUserMessageText("yoo what's @terminal-1:1-5 mean"),
              "",
              "<terminal_context>",
              "- Terminal 1 lines 1-5:",
              "  1 | julius@mac effect-http-ws-cli % bun i",
              "  2 | bun install v1.3.9 (cf6cdbbb)",
              "</terminal_context>",
            ].join("\n"),
          ),
        ]}
      />,
    );

    expect(markup).toContain("Terminal 1 lines 1-5");
    expect(markup).toContain("lucide-terminal");
    expect(markup).toContain("yoo what&#x27;s ");
    expect(markup).toContain("Show full message");
  }, 20_000);

  it("keeps the copy button for collapsed long user messages", () => {
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[buildUserTimelineEntry(buildLongUserMessageText())]}
      />,
    );

    expect(markup).toContain('aria-label="Copy link"');
    expect(markup).toContain('data-user-message-collapsed="true"');
    expect(markup).toContain('data-user-message-footer="true"');
  });

  it("renders context compaction entries in the normal work log", () => {
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[
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
        ]}
      />,
    );

    expect(markup).toContain("Context compacted");
    expect(markup).toContain("Work log");
  });

  it("formats changed file paths from the workspace root", () => {
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[
          {
            id: "entry-1",
            kind: "work",
            createdAt: "2026-03-17T19:12:28.000Z",
            entry: {
              id: "work-1",
              createdAt: "2026-03-17T19:12:28.000Z",
              label: "Updated files",
              tone: "tool",
              changedFiles: ["C:/Users/mike/dev-stuff/t3code/apps/web/src/session-logic.ts"],
            },
          },
        ]}
        workspaceRoot="C:/Users/mike/dev-stuff/t3code"
      />,
    );

    expect(markup).toContain("t3code/apps/web/src/session-logic.ts");
    expect(markup).not.toContain("C:/Users/mike/dev-stuff/t3code/apps/web/src/session-logic.ts");
  });
});
