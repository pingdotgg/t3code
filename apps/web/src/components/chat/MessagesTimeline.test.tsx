import { EnvironmentId, MessageId, ThreadId, TurnId } from "@t3tools/contracts";
import { createRef } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { LegendListRef } from "@legendapp/list/react";

vi.mock("@legendapp/list/react", async () => {
  const React = await import("react");

  const LegendList = React.forwardRef(function MockLegendList(
    props: {
      data: Array<{ id: string }>;
      keyExtractor: (item: { id: string }) => string;
      renderItem: (args: { item: { id: string } }) => React.ReactNode;
      ListHeaderComponent?: React.ReactNode;
      ListFooterComponent?: React.ReactNode;
    },
    _ref: React.ForwardedRef<LegendListRef>,
  ) {
    return (
      <div data-testid="legend-list">
        {props.ListHeaderComponent}
        {props.data.map((item) => (
          <div key={props.keyExtractor(item)}>{props.renderItem({ item })}</div>
        ))}
        {props.ListFooterComponent}
      </div>
    );
  });

  return { LegendList };
});

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

const ACTIVE_THREAD_ENVIRONMENT_ID = EnvironmentId.make("environment-local");
const ACTIVE_THREAD_ID = ThreadId.make("thread-1");
const MESSAGE_CREATED_AT = "2026-03-17T19:12:28.000Z";

function buildProps() {
  return {
    isWorking: false,
    activeTurnInProgress: false,
    activeTurnId: null,
    activeTurnStartedAt: null,
    listRef: createRef<LegendListRef | null>(),
    completionDividerBeforeEntryId: null,
    completionSummary: null,
    copilotResumeCommand: null,
    turnDiffSummaryByAssistantMessageId: new Map(),
    routeThreadKey: "environment-local:thread-1",
    onOpenTurnDiff: () => {},
    revertTurnCountByUserMessageId: new Map(),
    onRevertUserMessage: () => {},
    isRevertingCheckpoint: false,
    onImageExpand: () => {},
    activeThreadEnvironmentId: ACTIVE_THREAD_ENVIRONMENT_ID,
    activeThreadId: ACTIVE_THREAD_ID,
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

describe("MessagesTimeline", () => {
  it("renders collapse controls for long user messages", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[buildUserTimelineEntry(buildLongUserMessageText())]}
      />,
    );

    expect(markup).toContain("Show full message");
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).toContain('data-user-message-collapsible="true"');
    expect(markup).toContain('data-user-message-collapsed="true"');
    expect(markup).toContain('data-user-message-fade="true"');
    expect(markup).toContain('data-user-message-footer="true"');
  });

  it("does not render collapse controls for short user messages", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline {...buildProps()} timelineEntries={[buildUserTimelineEntry("Short.")]} />,
    );

    expect(markup).not.toContain("Show full message");
    expect(markup).toContain('data-user-message-collapsible="false"');
  });

  it("forces active chat find user message rows expanded", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        activeChatFindRowId="entry-1"
        timelineEntries={[buildUserTimelineEntry(buildLongUserMessageText())]}
      />,
    );

    expect(markup).toContain("Show less");
    expect(markup).toContain('aria-expanded="true"');
    expect(markup).toContain('data-user-message-collapsed="false"');
    expect(markup).toContain('data-user-message-fade="false"');
  });

  it("keeps footer controls for collapsed long user messages", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
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

  it("renders text content that chat search can match against", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[
          {
            id: "entry-1",
            kind: "message",
            createdAt: "2026-03-17T19:12:28.000Z",
            message: {
              id: MessageId.make("message-user"),
              role: "user",
              text: "Needle alpha",
              createdAt: "2026-03-17T19:12:28.000Z",
              streaming: false,
            },
          },
          {
            id: "entry-2",
            kind: "message",
            createdAt: "2026-03-17T19:12:30.000Z",
            message: {
              id: MessageId.make("message-assistant"),
              role: "assistant",
              text: "Found another needle in markdown.",
              createdAt: "2026-03-17T19:12:30.000Z",
              streaming: false,
            },
          },
        ]}
      />,
    );

    // Text content renders as plain text (highlighting is via CSS Custom Highlight API)
    expect(markup).toContain("Needle alpha");
    expect(markup).toContain("needle");
  });

  it("renders inline terminal labels with the composer chip UI", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[
          {
            id: "entry-1",
            kind: "message",
            createdAt: "2026-03-17T19:12:28.000Z",
            message: {
              id: MessageId.make("message-2"),
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
        ]}
      />,
    );

    expect(markup).toContain("Terminal 1 lines 1-5");
    expect(markup).toContain("lucide-terminal");
    expect(markup).toContain("yoo what&#x27;s ");
  }, 20_000);

  it("renders context compaction entries in the normal work log", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
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

  it("collapses completed tool-call groups to an expandable header", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
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
              label: "Read file",
              tone: "tool",
              isComplete: true,
            },
          },
          {
            id: "entry-2",
            kind: "work",
            createdAt: "2026-03-17T19:12:29.000Z",
            entry: {
              id: "work-2",
              createdAt: "2026-03-17T19:12:29.000Z",
              label: "Ran command",
              tone: "tool",
              isComplete: true,
            },
          },
        ]}
      />,
    );

    expect(markup).toContain("Tool Calls (2)");
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).toContain('aria-label="Expand Tool Calls (2)"');
    expect(markup).not.toContain(">Expand<");
    expect(markup).not.toContain("Read file");
    expect(markup).not.toContain("Ran command");
  });

  it("keeps completed tool-call groups open while the response is still active", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        activeTurnInProgress
        activeTurnId={TurnId.make("turn-1")}
        timelineEntries={[
          {
            id: "entry-1",
            kind: "work",
            createdAt: "2026-03-17T19:12:28.000Z",
            entry: {
              id: "work-1",
              createdAt: "2026-03-17T19:12:28.000Z",
              label: "Read file",
              tone: "tool",
              isComplete: true,
            },
          },
          {
            id: "entry-2",
            kind: "work",
            createdAt: "2026-03-17T19:12:29.000Z",
            entry: {
              id: "work-2",
              createdAt: "2026-03-17T19:12:29.000Z",
              label: "Ran command",
              tone: "tool",
              isComplete: true,
            },
          },
        ]}
      />,
    );

    expect(markup).not.toContain("Tool Calls (2)");
    expect(markup).not.toContain('aria-expanded="false"');
    expect(markup).toContain("Read file");
    expect(markup).toContain("Ran command");
    expect(markup).toContain("work-group-section");
    expect(markup).toContain("text-[length:inherit]");
    expect(markup).not.toContain("truncate text-xs leading-5");
    expect(markup).not.toContain("truncate text-[11px] leading-5");
  });

  it("collapses active tool-call groups once following assistant text starts", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        activeTurnInProgress
        activeTurnId={TurnId.make("turn-1")}
        timelineEntries={[
          {
            id: "entry-1",
            kind: "work",
            createdAt: "2026-03-17T19:12:28.000Z",
            entry: {
              id: "work-1",
              createdAt: "2026-03-17T19:12:28.000Z",
              label: "Read file",
              tone: "tool",
            },
          },
          {
            id: "entry-2",
            kind: "work",
            createdAt: "2026-03-17T19:12:29.000Z",
            entry: {
              id: "work-2",
              createdAt: "2026-03-17T19:12:29.000Z",
              label: "Ran command",
              tone: "tool",
            },
          },
          {
            id: "assistant-entry",
            kind: "message",
            createdAt: "2026-03-17T19:12:35.000Z",
            message: {
              id: MessageId.make("assistant-1"),
              role: "assistant",
              text: "I have the screenshot symptom.",
              turnId: TurnId.make("turn-1"),
              createdAt: "2026-03-17T19:12:35.000Z",
              streaming: true,
            },
          },
        ]}
      />,
    );

    expect(markup).toContain("Tool Calls (2)");
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).not.toContain("Read file");
    expect(markup).not.toContain("Ran command");
    expect(markup).toContain("I have the screenshot symptom.");
  });

  it("collapses completed work-log groups to an expandable header", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
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
              label: "Plan updated",
              tone: "info",
              isComplete: true,
            },
          },
          {
            id: "entry-2",
            kind: "work",
            createdAt: "2026-03-17T19:12:29.000Z",
            entry: {
              id: "work-2",
              createdAt: "2026-03-17T19:12:29.000Z",
              label: "Read file",
              tone: "tool",
              isComplete: true,
            },
          },
        ]}
      />,
    );

    expect(markup).toContain("Work log (2)");
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).toContain('aria-label="Expand Work log (2)"');
    expect(markup).not.toContain(">Expand<");
    expect(markup).not.toContain("Plan updated");
    expect(markup).not.toContain("Read file");
  });

  it("collapses reasoning before the response into a worked-for divider", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        completionDividerBeforeEntryId="assistant-final-entry"
        timelineEntries={[
          {
            id: "user-entry",
            kind: "message",
            createdAt: "2026-03-17T19:12:00.000Z",
            message: {
              id: MessageId.make("message-user"),
              role: "user",
              text: "Review the plan",
              createdAt: "2026-03-17T19:12:00.000Z",
              streaming: false,
            },
          },
          {
            id: "work-entry",
            kind: "work",
            createdAt: "2026-03-17T19:12:20.000Z",
            entry: {
              id: "work-1",
              createdAt: "2026-03-17T19:12:20.000Z",
              label: "Read files",
              tone: "tool",
              isComplete: true,
            },
          },
          {
            id: "assistant-final-entry",
            kind: "message",
            createdAt: "2026-03-17T19:13:55.000Z",
            message: {
              id: MessageId.make("message-assistant"),
              role: "assistant",
              text: "Here is the review.",
              createdAt: "2026-03-17T19:13:55.000Z",
              completedAt: "2026-03-17T19:14:10.000Z",
              streaming: false,
            },
          },
        ]}
      />,
    );

    expect(markup).toContain("Worked for 1m 55s");
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).not.toContain("Read files");
    expect(markup).not.toContain(">Response<");
    expect(markup).toContain("Here is the review.");
  });

  it("keeps reasoning visible while the response is still active", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        activeTurnInProgress
        activeTurnId={TurnId.make("turn-1")}
        timelineEntries={[
          {
            id: "user-entry",
            kind: "message",
            createdAt: "2026-03-17T19:12:00.000Z",
            message: {
              id: MessageId.make("message-user"),
              role: "user",
              text: "Review the plan",
              createdAt: "2026-03-17T19:12:00.000Z",
              streaming: false,
            },
          },
          {
            id: "work-entry",
            kind: "work",
            createdAt: "2026-03-17T19:12:20.000Z",
            entry: {
              id: "work-1",
              createdAt: "2026-03-17T19:12:20.000Z",
              label: "Read files",
              tone: "tool",
              isComplete: true,
            },
          },
          {
            id: "assistant-final-entry",
            kind: "message",
            createdAt: "2026-03-17T19:13:55.000Z",
            message: {
              id: MessageId.make("message-assistant"),
              role: "assistant",
              text: "Here is the review.",
              createdAt: "2026-03-17T19:13:55.000Z",
              streaming: true,
            },
          },
        ]}
      />,
    );

    expect(markup).not.toContain("Worked for");
    expect(markup).toContain("Read files");
    expect(markup).toContain("Here is the review.");
  });

  it("keeps incomplete work-log groups expanded while the response is active", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        activeTurnInProgress
        activeTurnId={TurnId.make("turn-1")}
        timelineEntries={[
          {
            id: "entry-1",
            kind: "work",
            createdAt: "2026-03-17T19:12:28.000Z",
            entry: {
              id: "work-1",
              createdAt: "2026-03-17T19:12:28.000Z",
              label: "Plan updated",
              tone: "info",
              isComplete: true,
            },
          },
          {
            id: "entry-2",
            kind: "work",
            createdAt: "2026-03-17T19:12:29.000Z",
            entry: {
              id: "work-2",
              createdAt: "2026-03-17T19:12:29.000Z",
              label: "Reading file",
              tone: "tool",
              isComplete: false,
            },
          },
        ]}
      />,
    );

    expect(markup).toContain("Work log (2)");
    expect(markup).not.toContain('aria-expanded="false"');
    expect(markup).toContain("Plan updated");
    expect(markup).toContain("Reading file");
  });

  it("formats changed file paths from the workspace root", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
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

  it("renders the Copilot resume command only in terminal assistant message metadata", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const copilotResumeCommand = "copilot --resume=a7f0c803-7cce-4554-9ad6-dfd9df539e33";
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        copilotResumeCommand={copilotResumeCommand}
        timelineEntries={[
          {
            id: "entry-1",
            kind: "message",
            createdAt: "2026-04-22T19:00:45.000Z",
            message: {
              id: MessageId.make("message-assistant-1"),
              role: "assistant",
              text: "I am checking this.",
              createdAt: "2026-04-22T19:00:45.000Z",
              completedAt: "2026-04-22T19:01:00.000Z",
              turnId: TurnId.make("turn-1"),
              streaming: false,
            },
          },
          {
            id: "entry-2",
            kind: "message",
            createdAt: "2026-04-22T19:03:33.000Z",
            message: {
              id: MessageId.make("message-assistant-2"),
              role: "assistant",
              text: "All set.",
              createdAt: "2026-04-22T19:03:33.000Z",
              completedAt: "2026-04-22T19:03:40.000Z",
              turnId: TurnId.make("turn-1"),
              streaming: false,
            },
          },
        ]}
      />,
    );

    expect(markup.match(new RegExp(`>${copilotResumeCommand}</span>`, "g"))).toHaveLength(1);
    expect(markup.indexOf(copilotResumeCommand)).toBeGreaterThan(markup.indexOf("All set."));
  });

  it("hides the Copilot resume command while the terminal assistant message is still active", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const copilotResumeCommand = "copilot --resume=a7f0c803-7cce-4554-9ad6-dfd9df539e33";
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        activeTurnInProgress
        activeTurnId={TurnId.make("turn-1")}
        copilotResumeCommand={copilotResumeCommand}
        timelineEntries={[
          {
            id: "entry-1",
            kind: "message",
            createdAt: "2026-04-22T19:03:33.000Z",
            message: {
              id: MessageId.make("message-assistant-1"),
              role: "assistant",
              text: "Still working.",
              createdAt: "2026-04-22T19:03:33.000Z",
              completedAt: "2026-04-22T19:03:40.000Z",
              turnId: TurnId.make("turn-1"),
              streaming: false,
            },
          },
        ]}
      />,
    );

    expect(markup).not.toContain(copilotResumeCommand);
  });

  it("renders the fork action only on the last assistant metadata row for a response", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[
          {
            id: "entry-1",
            kind: "message",
            createdAt: "2026-04-22T19:00:45.000Z",
            message: {
              id: MessageId.make("message-assistant-1"),
              role: "assistant",
              text: "I am checking this.",
              createdAt: "2026-04-22T19:00:45.000Z",
              completedAt: "2026-04-22T19:01:00.000Z",
              turnId: TurnId.make("turn-1"),
              streaming: false,
            },
          },
          {
            id: "entry-2",
            kind: "message",
            createdAt: "2026-04-22T19:03:33.000Z",
            message: {
              id: MessageId.make("message-assistant-2"),
              role: "assistant",
              text: "All set.",
              createdAt: "2026-04-22T19:03:33.000Z",
              completedAt: "2026-04-22T19:03:40.000Z",
              turnId: TurnId.make("turn-1"),
              streaming: false,
            },
          },
        ]}
      />,
    );

    expect(markup.match(/aria-label="Fork chat from this response"/g)).toHaveLength(1);
    expect(markup.indexOf("Fork chat")).toBeGreaterThan(markup.indexOf("All set."));
  });

  it("renders turn-scoped changed files by default", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const { useUiStateStore } = await import("../../uiStateStore");
    useUiStateStore.setState({ changedFilesDiffScope: "turn" });
    const assistantMessageId = MessageId.make("message-assistant");
    const turnId = TurnId.make("turn-1");

    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[
          {
            id: "entry-1",
            kind: "message",
            createdAt: "2026-04-22T19:00:45.000Z",
            message: {
              id: assistantMessageId,
              role: "assistant",
              text: "All set.",
              createdAt: "2026-04-22T19:00:45.000Z",
              completedAt: "2026-04-22T19:03:33.000Z",
              streaming: false,
            },
          },
        ]}
        turnDiffSummaryByAssistantMessageId={
          new Map([
            [
              assistantMessageId,
              {
                turnId,
                completedAt: "2026-04-22T19:03:33.000Z",
                files: [
                  { path: "src/plan.md", additions: 5, deletions: 1 },
                  { path: "src/unrelated.ts", additions: 10, deletions: 0 },
                ],
                turnFiles: [{ path: "src/plan.md", additions: 5, deletions: 1 }],
              },
            ],
          ])
        }
      />,
    );

    expect(markup).not.toContain("Changed files");
    expect(markup).toContain("+5");
    expect(markup).toContain("-1");
    expect(markup).toContain("plan.md");
    expect(markup).not.toContain("unrelated.ts");
  });

  it("renders explicit empty-turn state without falling back to snapshot", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const { useUiStateStore } = await import("../../uiStateStore");
    useUiStateStore.setState({ changedFilesDiffScope: "turn" });
    const assistantMessageId = MessageId.make("message-assistant");

    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[
          {
            id: "entry-1",
            kind: "message",
            createdAt: "2026-04-22T19:00:45.000Z",
            message: {
              id: assistantMessageId,
              role: "assistant",
              text: "All set.",
              createdAt: "2026-04-22T19:00:45.000Z",
              completedAt: "2026-04-22T19:03:33.000Z",
              streaming: false,
            },
          },
        ]}
        turnDiffSummaryByAssistantMessageId={
          new Map([
            [
              assistantMessageId,
              {
                turnId: TurnId.make("turn-1"),
                completedAt: "2026-04-22T19:03:33.000Z",
                files: [{ path: "src/snapshot.ts", additions: 2, deletions: 0 }],
                turnFiles: [],
              },
            ],
          ])
        }
      />,
    );

    expect(markup).not.toContain("Changed files");
    expect(markup).not.toContain("No turn-scoped file changes detected");
    expect(markup).toContain("+0");
    expect(markup).toContain("-0");
    expect(markup).not.toContain("snapshot.ts");
    expect(markup).toMatch(/<button[^>]*disabled=""[^>]*aria-label="View diff"/);
    expect(markup).toContain("lucide-diff");
    expect(markup).not.toContain(">View diff<");
  });
});
