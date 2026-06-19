import { EnvironmentId, MessageId, ThreadId, TurnId } from "@t3tools/contracts";
import { createRef, type ReactNode, type Ref } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { LegendListRef } from "@legendapp/list/react";

vi.mock("@legendapp/list/react", async () => {
  const legendListTestId = "legend-list";

  const LegendList = (props: {
    data: Array<{ id: string }>;
    keyExtractor: (item: { id: string }) => string;
    renderItem: (args: { item: { id: string } }) => ReactNode;
    ListHeaderComponent?: ReactNode;
    ListFooterComponent?: ReactNode;
    ref?: Ref<LegendListRef>;
  }) => (
    <div data-testid={legendListTestId}>
      {props.ListHeaderComponent}
      {props.data.map((item) => (
        <div key={props.keyExtractor(item)}>{props.renderItem({ item })}</div>
      ))}
      {props.ListFooterComponent}
    </div>
  );

  return { LegendList };
});

function MockFileDiff(props: {
  fileDiff: { name?: string | null; prevName?: string | null };
  renderCustomHeader?: (fileDiff: {
    name?: string | null;
    prevName?: string | null;
  }) => React.ReactNode;
}) {
  return (
    <div data-testid="file-diff">
      {props.renderCustomHeader?.(props.fileDiff)}
      {props.fileDiff.name ?? props.fileDiff.prevName ?? "diff"}
    </div>
  );
}

vi.mock("@pierre/diffs/react", () => {
  return { FileDiff: MockFileDiff };
});

const storeMock = vi.hoisted(() => ({
  state: {
    environmentStateById: {},
  } as {
    environmentStateById: Record<string, unknown>;
  },
}));

vi.mock("../../state/entities", () => ({
  useActiveEnvironmentId: () => "environment-local",
  useThreadShell: (ref: { environmentId: string; threadId: string } | null) =>
    ref === null
      ? null
      : ((
          storeMock.state.environmentStateById[ref.environmentId] as
            | {
                threadShellById?: Record<string, unknown>;
              }
            | undefined
        )?.threadShellById?.[ref.threadId] ?? null),
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
      removeAttribute: () => {},
      setAttribute: () => {},
    },
  });
});

const ACTIVE_THREAD_ENVIRONMENT_ID = EnvironmentId.make("environment-local");
const MESSAGE_CREATED_AT = "2026-03-17T19:12:28.000Z";

beforeEach(() => {
  storeMock.state = {
    environmentStateById: {},
  };
});

function buildProps() {
  return {
    isWorking: false,
    activeTurnInProgress: false,
    activeTurnStartedAt: null,
    listRef: createRef<LegendListRef | null>(),
    latestTurn: null,
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
      turnId: null,
      createdAt: MESSAGE_CREATED_AT,
      updatedAt: MESSAGE_CREATED_AT,
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
    expect(markup).toContain('data-user-message-collapsed="true"');
    expect(markup).toContain('data-user-message-fade="true"');
    expect(markup).toContain('data-user-message-footer="true"');
  });

  it("does not render collapse controls for short user messages", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[buildUserTimelineEntry("Short prompt.")]}
      />,
    );

    expect(markup).not.toContain("Show full message");
    expect(markup).toContain('data-user-message-collapsible="false"');
  });

  it("renders inline terminal labels with the composer chip UI", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
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
    expect(markup).toContain("yoo what&#x27;s</p>");
    expect(markup).toContain('<span aria-hidden="true"> </span>');
    expect(markup).toContain("Show full message");
  }, 20_000);

  it("keeps the copy button for collapsed long user messages", async () => {
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
    expect(markup).toContain("work log");
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

  it("renders command work entries as expandable rows", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const stdout = Array.from({ length: 45 }, (_, index) => `stdout ${index + 1}`).join("\n");
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
              label: "Ran command",
              tone: "tool",
              itemType: "command_execution",
              command: "vp test",
              stdout,
              stderr: "warning",
              exitCode: 0,
              durationMs: 1234,
            },
          },
        ]}
      />,
    );

    expect(markup).toContain("Ran command");
    expect(markup).toContain("vp test");
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).toContain('aria-label="Expand Ran command - vp test"');
  });

  it("renders dynamic tool command metadata as expandable command rows", async () => {
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
              label: "Dynamic tool",
              tone: "tool",
              itemType: "dynamic_tool_call",
              command: "vp test",
              stdout: "passed",
              exitCode: 0,
              durationMs: 1234,
            },
          },
        ]}
      />,
    );

    expect(markup).toContain("Dynamic tool");
    expect(markup).toContain("vp test");
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).toContain('aria-label="Expand Dynamic tool - vp test"');
  });

  it("renders MCP tool command metadata as expandable command rows", async () => {
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
              label: "MCP tool",
              tone: "tool",
              itemType: "mcp_tool_call",
              command: "rg TODO",
              stdout: "apps/web/src/session-logic.ts:1:TODO",
              exitCode: 0,
            },
          },
        ]}
      />,
    );

    expect(markup).toContain("MCP tool");
    expect(markup).toContain("rg TODO");
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).toContain('aria-label="Expand MCP tool - rg TODO"');
  });

  it("does not render typed non-command stdout as command details", async () => {
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
              label: "Web search",
              tone: "tool",
              itemType: "web_search",
              stdout: "search results",
              durationMs: 1234,
            },
          },
        ]}
      />,
    );

    expect(markup).toContain("Web search");
    expect(markup).not.toContain('aria-expanded="false"');
    expect(markup).not.toContain('aria-label="Expand Web search"');
  });

  it("renders file-change work entries as expandable rows", async () => {
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
              label: "Changed files",
              tone: "tool",
              itemType: "file_change",
              changedFiles: ["apps/web/src/session-logic.ts"],
              patch:
                "diff --git a/apps/web/src/session-logic.ts b/apps/web/src/session-logic.ts\n--- a/apps/web/src/session-logic.ts\n+++ b/apps/web/src/session-logic.ts\n@@ -1 +1 @@\n-old\n+new\n",
            },
          },
        ]}
      />,
    );

    expect(markup).toContain("Changed files");
    expect(markup).toContain("apps/web/src/session-logic.ts");
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).toContain('aria-label="Expand Changed files - apps/web/src/session-logic.ts"');
  });

  it("renders dynamic tool patch metadata as expandable file-change rows", async () => {
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
              label: "Dynamic patch tool",
              tone: "tool",
              itemType: "dynamic_tool_call",
              patch:
                "diff --git a/apps/web/src/session-logic.ts b/apps/web/src/session-logic.ts\n--- a/apps/web/src/session-logic.ts\n+++ b/apps/web/src/session-logic.ts\n@@ -1 +1 @@\n-old\n+new\n",
              stdout: "applied patch",
              exitCode: 0,
              durationMs: 1234,
            },
          },
        ]}
      />,
    );

    expect(markup).toContain("Dynamic patch tool");
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).toContain('aria-label="Expand Dynamic patch tool"');
  });

  it("renders dynamic tool output metadata as expandable command rows without a command", async () => {
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
              label: "Dynamic output tool",
              tone: "tool",
              itemType: "dynamic_tool_call",
              stdout: "updated files",
              exitCode: 0,
            },
          },
        ]}
      />,
    );

    expect(markup).toContain("Dynamic output tool");
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).toContain('aria-label="Expand Dynamic output tool"');
  });

  it("renders command execution patch metadata as expandable file-change rows", async () => {
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
              label: "Ran command",
              tone: "tool",
              itemType: "command_execution",
              changedFiles: ["apps/web/src/session-logic.ts"],
              patch:
                "diff --git a/apps/web/src/session-logic.ts b/apps/web/src/session-logic.ts\n--- a/apps/web/src/session-logic.ts\n+++ b/apps/web/src/session-logic.ts\n@@ -1 +1 @@\n-old\n+new\n",
            },
          },
        ]}
      />,
    );

    expect(markup).toContain("Ran command");
    expect(markup).toContain("apps/web/src/session-logic.ts");
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).toContain('aria-label="Expand Ran command - apps/web/src/session-logic.ts"');
  });

  it("renders mixed dynamic tool command and patch metadata", async () => {
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
              label: "Dynamic edit tool",
              tone: "tool",
              itemType: "dynamic_tool_call",
              command: "apply_patch",
              stdout: "updated files",
              changedFiles: ["apps/web/src/session-logic.ts"],
              patch:
                "diff --git a/apps/web/src/session-logic.ts b/apps/web/src/session-logic.ts\n--- a/apps/web/src/session-logic.ts\n+++ b/apps/web/src/session-logic.ts\n@@ -1 +1 @@\n-old\n+new\n",
              exitCode: 0,
            },
          },
        ]}
      />,
    );

    expect(markup).toContain("apply_patch");
    expect(markup).toContain("apps/web/src/session-logic.ts");
    expect(markup).toContain('aria-label="Expand Dynamic edit tool - apply_patch"');
  });

  it("renders review comment contexts as structured cards instead of raw tags", async () => {
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
                '<review_comment sectionId="turn:2" sectionTitle="Turn 2" filePath="apps/web/src/lib/contextWindow.test.ts" startIndex="3" endIndex="14" rangeLabel="+47 to +58">',
                "Wadduo",
                "```diff",
                "@@ -0,0 +47,2 @@",
                '+  it("keeps valid zero-usage snapshots", () => {',
                "+    expect(snapshot).not.toBeNull();",
                "```",
                "</review_comment>",
              ].join("\n"),
              turnId: null,
              createdAt: "2026-03-17T19:12:28.000Z",
              updatedAt: "2026-03-17T19:12:28.000Z",
              streaming: false,
            },
          },
        ]}
      />,
    );

    expect(markup).toContain("contextWindow.test.ts");
    expect(markup).toContain("Wadduo");
    expect(markup).toContain('data-testid="file-diff"');
    expect(markup).not.toContain(">Review comment<");
    expect(markup).not.toContain("&lt;review_comment");
    expect(markup).not.toContain("&lt;/review_comment&gt;");
  });

  it("renders expandable subagent rows without status labels", async () => {
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
              label: "Subagent",
              tone: "tool",
              itemType: "collab_agent_tool_call",
              subagentPrompt: "Create one original haiku in English. Return only the haiku text.",
              output:
                "Rain lifts from the wires\nA window gathers pale dawn\nFootsteps bloom below",
            },
          },
        ]}
      />,
    );

    expect(markup).toContain("Subagent");
    expect(markup).toContain("Create one original haiku in English");
    expect(markup).not.toContain("Done");
    expect(markup).not.toContain("Running");
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).toContain(
      'aria-label="Expand Subagent - Create one original haiku in English. Return only the haiku text."',
    );
  });

  it("renders a deduped resumed subagent block as working when the parent turn matches", async () => {
    const childThreadId = ThreadId.make("subagent-child-1");
    const parentTurnId = TurnId.make("turn-followup");
    storeMock.state = {
      environmentStateById: {
        [ACTIVE_THREAD_ENVIRONMENT_ID]: {
          threadShellById: {
            [childThreadId]: {
              id: childThreadId,
              title: "Say hi briefly",
              parentRelation: {
                kind: "subagent",
                rootThreadId: ThreadId.make("thread-1"),
                parentThreadId: ThreadId.make("thread-1"),
                parentTurnId,
                parentItemId: "call-send-input",
                parentActivitySequence: 2,
                providerThreadId: "provider-child-1",
                titleSeed: "Say hi in German",
                depth: 1,
                startedAt: "2026-03-17T19:12:30.000Z",
                completedAt: null,
                status: "running",
              },
            },
          },
        },
      },
    };

    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        activeTurnInProgress={true}
        latestTurn={{
          turnId: parentTurnId,
          state: "running",
          startedAt: "2026-03-17T19:12:30.000Z",
          completedAt: null,
        }}
        timelineEntries={[
          {
            id: "entry-1",
            kind: "work",
            createdAt: "2026-03-17T19:12:30.000Z",
            entry: {
              id: "work-1",
              createdAt: "2026-03-17T19:12:30.000Z",
              turnId: parentTurnId,
              label: "Subagent",
              tone: "tool",
              itemType: "collab_agent_tool_call",
              subagentChildren: [
                {
                  threadId: childThreadId,
                  parentItemId: "call-resume",
                  titleSeed: "Say hi in German",
                },
              ],
            },
          },
        ]}
      />,
    );

    expect(markup).toContain("Subagent - Say hi briefly");
    expect(markup).toContain("Working");
    expect(markup).not.toContain("Completed in");
  });

  it("renders file review comments as source code instead of diffs", async () => {
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
              id: MessageId.make("message-source-comment"),
              role: "user",
              text: [
                '<review_comment sectionId="file:docs/plan.md" sectionTitle="File comment" filePath="docs/plan.md" startIndex="0" endIndex="1" rangeLabel="L1 to L2">',
                "Clarify this.",
                "```md",
                "# Plan",
                "- Step one",
                "```",
                "</review_comment>",
              ].join("\n"),
              turnId: null,
              createdAt: "2026-03-17T19:12:28.000Z",
              updatedAt: "2026-03-17T19:12:28.000Z",
              streaming: false,
            },
          },
        ]}
      />,
    );

    expect(markup).toContain("plan.md");
    expect(markup).toContain("Clarify this.");
    expect(markup).toContain("# Plan");
    expect(markup).not.toContain('data-testid="file-diff"');
  });

  it("renders a failure marker for failed tool lifecycle entries", async () => {
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
              label: "Glob",
              tone: "tool",
              toolLifecycleStatus: "failed",
              detail: "No files found",
            },
          },
        ]}
      />,
    );

    expect(markup).toContain("lucide-x");
    expect(markup).toContain('aria-label="Tool call failed"');
  });
});
