import { RegistryProvider } from "@effect/atom-react";
import {
  ApprovalRequestId,
  CheckpointRef,
  EnvironmentId,
  MessageId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import type { LegendListRef } from "@legendapp/list/react";
import { act, createRef, Profiler, useState, type ComponentProps, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import "~/index.css";

import { serverEnvironment } from "../../state/server";
import { PullRequestLinkPreview } from "../pullRequest/PullRequestLinkPreview";
import { Tooltip, TooltipPopup, TooltipScrollDismissArea, TooltipTrigger } from "../ui/tooltip";
import { MessagesTimeline } from "./MessagesTimeline";
import { readTimelinePosition } from "./timelineScrollAnchoring";
import { useComposerFocusState } from "./useComposerFocusState";

const pullRequestQuery = vi.hoisted(() => ({ error: "Pull request not found" }));
vi.mock(import("~/state/query"), async (original) => ({
  ...(await original()),
  useEnvironmentQuery: (() => ({
    data: null,
    dataUpdatedAt: 0,
    error: pullRequestQuery.error,
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
let threadCount = 0;

function baseProps(): Omit<TimelineProps, "timelineEntries"> {
  threadCount += 1;
  return {
    isWorking: false,
    activeTurnInProgress: false,
    listRef: createRef<LegendListRef | null>(),
    latestRun: null,
    turnDiffSummaries: [],
    runs: [],
    routeThreadKey: `environment-local:thread-${threadCount}`,
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

function work(id: string, entry: Record<string, unknown>): Entry {
  return {
    id,
    kind: "work",
    createdAt: CREATED_AT,
    entry: { id, createdAt: CREATED_AT, ...entry },
  } as Entry;
}

function v2Item(type: string, fields: Record<string, unknown>) {
  const id = (fields.id as string | undefined) ?? type;
  return {
    position: 0,
    visibility: "local",
    sourceThreadId: "thread-1",
    sourceItemId: id,
    item: {
      id,
      threadId: "thread-1",
      runId: "run-1",
      nodeId: null,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: 0,
      status: "completed",
      title: null,
      startedAt: null,
      completedAt: null,
      updatedAt: {},
      type,
      ...fields,
    },
  } as never;
}

function longText(tail = "deep hidden detail only after expand") {
  return Array.from({ length: 9 }, (_, index) =>
    index === 8 ? tail : `Line ${index + 1}: ${"verbose prompt content ".repeat(8).trim()}`,
  ).join("\n");
}

const roots: Root[] = [];
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
});

afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount());
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

async function renderElement(element: ReactElement) {
  container = document.body.appendChild(document.createElement("div"));
  container.style.cssText = "height: 1200px; width: 900px; display: flex; flex-direction: column;";
  const root = createRoot(container);
  roots.push(root);
  await act(async () => root.render(element));
  return container;
}

function renderTimeline(entries: ReadonlyArray<Entry>, props: Partial<TimelineProps> = {}) {
  return renderElement(
    <MessagesTimeline {...baseProps()} timelineEntries={entries as Entry[]} {...props} />,
  );
}

function text() {
  return container.textContent ?? "";
}

function buttons(name: string | RegExp) {
  return [...container.querySelectorAll<HTMLElement>("button, [role=button]")].filter((button) => {
    const label = button.getAttribute("aria-label") ?? button.textContent ?? "";
    return typeof name === "string" ? label === name : name.test(label);
  });
}

function button(name: string | RegExp) {
  const [match] = buttons(name);
  if (!match) throw new Error(`Missing button: ${String(name)}`);
  return match;
}

async function click(element: HTMLElement) {
  await act(async () => element.click());
}

describe("MessagesTimeline work rows", () => {
  it("shows dynamic tool input without cached output when the row is expanded", async () => {
    await renderTimeline([
      work("tool-with-cached-output", {
        label: "Example tool",
        toolTitle: "Example tool",
        tone: "tool",
        itemType: "dynamic_tool",
        toolLifecycleStatus: "completed",
        toolData: {
          input: { query: "KEEP_TOOL_INPUT" },
          output: { text: "RAW_CACHED_TOOL_OUTPUT" },
        },
      }),
    ]);
    await click(button("Example tool"));
    expect(text()).toContain("KEEP_TOOL_INPUT");
    expect(text()).not.toContain("RAW_CACHED_TOOL_OUTPUT");
    await click(button("Example tool"));
    await vi.waitFor(() => expect(text()).not.toContain("KEEP_TOOL_INPUT"));
  });

  it("expands and collapses a tool call through its header", async () => {
    await renderTimeline([
      work("work-standalone", {
        toolCallId: "call-standalone",
        label: "Run lint",
        tone: "tool",
        itemType: "command_execution",
        command: "pnpm lint",
        toolLifecycleStatus: "completed",
      }),
    ]);
    const header = () => container.querySelector<HTMLElement>("[aria-expanded]")!;
    expect(header().getAttribute("aria-expanded")).toBe("false");
    await click(header());
    expect(header().getAttribute("aria-expanded")).toBe("true");
    await click(header());
    expect(header().getAttribute("aria-expanded")).toBe("false");
  });

  it("leads an unanswered question row with the question text", async () => {
    await renderTimeline([
      work("question-work", {
        label: "User input requested",
        tone: "tool",
        questionAnswer: {
          requestId: ApprovalRequestId.make("question-request"),
          answers: {},
          questionTextById: { scope: "Which repository?" },
          attachmentsByQuestionId: {},
        },
      }),
    ]);
    const toggle = button("Which repository?");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    const before = text().match(/Which repository\?/g)?.length ?? 0;
    expect(before).toBeGreaterThan(0);
    await click(toggle);
    expect(text().match(/Which repository\?/g)?.length).toBe(before + 1);
  });

  it("collapses settled tool runs behind a generated summary and names a failure", async () => {
    await renderTimeline([
      work("work-1", {
        label: "Ran command",
        command: "vp lint",
        tone: "tool",
        itemType: "command_execution",
        toolLifecycleStatus: "completed",
      }),
      work("work-2", {
        label: "Run lint",
        command: "vp test run",
        tone: "tool",
        itemType: "command_execution",
        toolLifecycleStatus: "failed",
      }),
    ]);
    const summary = button(/^Ran 2 commands/);
    expect(summary.getAttribute("aria-label")).toContain("tool call failed");
    expect(text()).not.toContain("vp lint");
    await click(summary);
    await vi.waitFor(() => expect(text()).toContain("vp lint"));
  });

  it("keeps mixed work logs neutral after a later tool call succeeds", async () => {
    await renderTimeline([
      work("work-failed", {
        label: "Run search",
        tone: "tool",
        itemType: "command_execution",
        toolLifecycleStatus: "failed",
      }),
      work("work-info", { label: "Status updated", tone: "info" }),
      work("work-completed", {
        label: "Run tests",
        tone: "tool",
        itemType: "command_execution",
        toolLifecycleStatus: "completed",
      }),
    ]);
    expect(button("Ran 2 commands and received 1 update")).toBeDefined();
  });

  it("marks a failed tool inside an expanded work log", async () => {
    await renderTimeline([
      work("work-info", { label: "Status updated", tone: "info" }),
      work("work-1", {
        label: "Glob",
        tone: "tool",
        toolLifecycleStatus: "failed",
        detail: "No files found",
      }),
    ]);
    await click(button(/^Received 1 update/));
    await vi.waitFor(() =>
      expect(container.querySelector('[aria-label="Tool call failed"]')).not.toBeNull(),
    );
  });

  it("renders context compaction entries in the normal work log", async () => {
    await renderTimeline([work("work-1", { label: "Context compacted", tone: "info" })]);
    expect(text()).toContain("Context compacted");
  });

  it("formats changed file paths from the workspace root", async () => {
    await renderTimeline(
      [
        work("context-info", { label: "Session started", tone: "info" }),
        work("work-1", {
          label: "Updated files",
          tone: "tool",
          itemType: "file_change",
          toolLifecycleStatus: "completed",
          changedFiles: ["C:/Users/mike/dev-stuff/t3code/apps/web/src/session-logic.ts"],
        }),
      ],
      { workspaceRoot: "C:/Users/mike/dev-stuff/t3code" },
    );
    await click(button(/^Received 1 update/));
    await vi.waitFor(() => expect(text()).toContain("t3code/apps/web/src/session-logic.ts"));
    expect(text()).not.toContain("C:/Users/mike/dev-stuff/t3code/apps/web/src/session-logic.ts");
  });

  it("renders T3 MCP dynamic tools with their pretty name", async () => {
    const item = {
      id: "tool-t3-thread-read",
      type: "dynamic_tool",
      toolName: "mcp__t3-code__t3_thread_read",
      input: { threadId: "thread-child" },
      output: { messages: [] },
    };
    await renderTimeline([
      work("context-info", { label: "Session started", tone: "info" }),
      work(item.id, {
        runId: null,
        label: item.toolName,
        tone: "tool",
        itemType: item.type,
        toolTitle: item.toolName,
        toolLifecycleStatus: "completed",
        toolData: { input: item.input, output: item.output },
        structuredPayload: v2Item("dynamic_tool", item),
        projectedItem: v2Item("dynamic_tool", item),
      }),
    ]);
    await click(button(/^Received 1 update/));
    await vi.waitFor(() => expect(text()).toContain("Read a T3 thread"));
    expect(text()).not.toContain("mcp__t3-code__t3_thread_read");
  });

  it("keeps a provider retry collapsed in the work log", async () => {
    const retryItem = {
      id: "provider-error",
      status: "running",
      title: "Provider retry",
      failure: {
        class: "transport_error",
        message: "The response stream disconnected.",
        code: "responseStreamDisconnected",
        retryable: true,
      },
      retry: { attempt: 2, maxAttempts: 5, retryDelayMs: null },
    };
    await renderTimeline(
      [
        work("provider-error", {
          runId: "run-1",
          label: "Retrying provider (2/5)",
          detail: retryItem.failure.message,
          tone: "info",
          itemType: "error",
          toolLifecycleStatus: "inProgress",
          projectedItem: v2Item("error", retryItem),
        }),
      ],
      {
        isWorking: true,
        activeTurnInProgress: true,
        latestRun: {
          runId: RunId.make("run-1"),
          status: "running",
          startedAt: CREATED_AT,
          completedAt: null,
        },
      },
    );
    expect(text()).toContain("Retrying provider (2/5)");
    expect(text()).not.toContain("Structured details");
  });

  it.each([
    [
      "**Viewing image first** with *care*, ~~old~~ `code` and [context](https://example.com)",
      "Viewing image first with care, old code and context",
      1,
    ],
    ["first paragraph\n\nsecond paragraph", "first paragraph second paragraph", 0],
    ["- first\n- second", "first second", 0],
    ["first  \nsecond", "first second", 0],
    ["![image description](image.png)", "image description", 0],
    ["![](image.png)", "Thought", 0],
    ["---", "Thought", 0],
  ] as const)(
    "shows plain text for a V2 reasoning preview: %s",
    async (markdown, expected, strongCount) => {
      await renderTimeline([
        work("reasoning-preview", {
          label: markdown,
          detail: markdown,
          tone: "thinking",
          itemType: "reasoning",
          toolLifecycleStatus: "completed",
        }),
      ]);
      const row = () => container.querySelector<HTMLElement>("[role=button][aria-expanded]")!;
      const preview = () => row().textContent!.replace(/\s+/g, " ");
      expect(preview()).toContain(expected);
      expect(container.querySelectorAll("strong")).toHaveLength(0);
      await click(row());
      expect(container.querySelectorAll("strong")).toHaveLength(strongCount);
      await click(row());
      expect(preview()).toContain(expected);
      await vi.waitFor(() => expect(container.querySelectorAll("strong")).toHaveLength(0));
    },
  );
});

describe("MessagesTimeline messages", () => {
  it("preserves XML-like tags and comparisons in user messages as text", async () => {
    const source = [
      'Without reading a file, do you have <global-agent-instructions scope="workspace">',
      'Before <nested data-value="a&b">inside</nested> after',
      "</global-agent-instructions> in your context?",
      "Comparison: 2 < 3 and 5 > 4.",
    ];
    await renderTimeline([message(source.join("\n"))]);
    for (const line of source) expect(text()).toContain(line);
    expect(container.querySelector("global-agent-instructions, nested")).toBeNull();
  });

  it("preserves XML-like source inside user code spans and fences", async () => {
    await renderTimeline([
      message(
        [
          'Inline `<tag attr="x">`',
          "",
          "```xml",
          '<root><child enabled="true" /></root>',
          "```",
        ].join("\n"),
      ),
    ]);
    expect(container.querySelector("code[data-inline-code]")?.textContent).toBe('<tag attr="x">');
    expect(text()).toContain('<root><child enabled="true" /></root>');
  });

  it("does not show markdown titles in user messages", async () => {
    await renderTimeline([
      message(
        '[link](https://example.com "link tip") ![image](https://example.com/image.png "image tip")',
      ),
    ]);
    expect(container.querySelector('a[href="https://example.com"]')).not.toBeNull();
    expect(container.querySelector('img[src="https://example.com/image.png"]')).not.toBeNull();
    expect(container.querySelector('[title="link tip"], [title="image tip"]')).toBeNull();
  });

  it("renders unsafe user HTML as inert source text", async () => {
    const source =
      '<script>globalThis.__t3Xss = 1</script><img src="x" onerror="globalThis.__t3Xss = 2">';
    await renderTimeline([message(source)]);
    expect(text()).toContain(source);
    expect(container.querySelector("script, img")).toBeNull();
    expect((globalThis as { __t3Xss?: number }).__t3Xss).toBeUndefined();
  });

  it("renders sanitized raw HTML in assistant messages", async () => {
    await renderTimeline([
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
    expect(container.querySelector("[data-markdown-details]")?.textContent).toContain(
      "Safe details",
    );
    expect(text()).not.toContain("<details");
    expect(container.querySelector("script, [onclick], [onerror]")).toBeNull();
    expect(container.innerHTML).not.toContain("javascript:");
    await click(button("Safe details"));
    expect((globalThis as { __t3Xss?: number }).__t3Xss).toBeUndefined();
  });

  it("collapses long user messages behind a toggle and keeps their copy button", async () => {
    await renderTimeline([message(longText())]);
    const toggle = button("Show full message");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(buttons("Copy message")).toHaveLength(1);
    await click(toggle);
    expect(button("Show less").getAttribute("aria-expanded")).toBe("true");
  });

  it("does not offer a collapse toggle for short user messages", async () => {
    await renderTimeline([message("Short prompt.")]);
    expect(buttons(/Show full message|Show less/)).toHaveLength(0);
  });

  it("identifies user-role messages sent by another agent", async () => {
    await renderTimeline([
      message("Review this area", { createdBy: "agent", creationSource: "provider" }),
    ]);
    expect(text()).toContain("Sent by another agent");
    await act(async () => roots.pop()!.unmount());
    await renderTimeline([message("Review this area")]);
    expect(text()).not.toContain("Sent by another agent");
  });

  it("shows steer intent ahead of committed user messages", async () => {
    await renderTimeline([message("Adjust the current turn", { inputIntent: "steer" })]);
    expect(text().indexOf("Steer")).toBeGreaterThanOrEqual(0);
    expect(text().indexOf("Steer")).toBeLessThan(text().indexOf("Adjust the current turn"));
  });

  it("renders inline terminal labels as chips", async () => {
    await renderTimeline([
      message(
        [
          longText("yoo what's @terminal-1:1-5 mean"),
          "",
          "<terminal_context>",
          "- Terminal 1 lines 1-5:",
          "  1 | julius@mac effect-http-ws-cli % bun i",
          "  2 | bun install v1.3.9 (cf6cdbbb)",
          "</terminal_context>",
        ].join("\n"),
      ),
    ]);
    expect(text()).toContain("Terminal 1 lines 1-5");
    expect(text()).toContain("yoo what's");
    expect(text()).not.toContain("terminal_context");
    expect(buttons("Show full message")).toHaveLength(1);
  });

  it("renders chips for standalone element-pick context messages", async () => {
    await renderTimeline([
      message(
        [
          "<element_context>",
          "- <SubmitButton> (Button.tsx:12):",
          "  url: https://example.com/dashboard",
          "  selector: button.submit",
          "  source: /repo/src/Button.tsx:12:5",
          "  html:",
          '  <button class="submit">Save</button>',
          "</element_context>",
        ].join("\n"),
      ),
    ]);
    expect(text()).toContain("SubmitButton");
    expect(text()).not.toContain("element_context");
  });

  it("renders review comment contexts as structured cards instead of raw tags", async () => {
    await renderTimeline([
      message(
        [
          '<review_comment sectionId="turn:2" sectionTitle="Turn 2" filePath="apps/web/src/lib/contextWindow.test.ts" startIndex="3" endIndex="14" rangeLabel="+47 to +58">',
          "Wadduo",
          "```diff",
          "@@ -0,0 +47,2 @@",
          '+  it("keeps valid zero-usage snapshots", () => {',
          "+    expect(snapshot).not.toBeNull();",
          "```",
          "</review_comment>",
        ].join("\n"),
      ),
    ]);
    expect(text()).toContain("contextWindow.test.ts L47 to L58");
    expect(text()).not.toContain("review_comment");
  });

  it("renders file review comments as source code", async () => {
    await renderTimeline([
      message(
        [
          '<review_comment sectionId="file:docs/plan.md" sectionTitle="File comment" filePath="docs/plan.md" startIndex="0" endIndex="1" rangeLabel="L1 to L2">',
          "Clarify this.",
          "```md",
          "# Plan",
          "- Step one",
          "```",
          "</review_comment>",
        ].join("\n"),
      ),
    ]);
    expect(text()).toContain("plan.md L1 to L2");
    expect(text()).not.toContain("review_comment");
  });

  it("collapses superseded attempt output behind a disclosure", async () => {
    const runId = RunId.make("run-steered");
    const attempt = (id: string, ordinal: number, status: string) =>
      ({
        id,
        runId,
        attemptOrdinal: ordinal,
        rootNodeId: `node-${id}`,
        status,
        completedAt: null,
      }) as never;
    await renderTimeline(
      [
        {
          ...message(
            "Partial response from the old attempt",
            { role: "assistant", runId },
            "superseded-response",
          ),
          attempt: attempt("attempt-1", 1, "superseded"),
        } as Entry,
        {
          ...message(
            "Current response remains visible",
            { role: "assistant", runId, streaming: true },
            "active-response",
          ),
          attempt: attempt("attempt-2", 2, "running"),
        } as Entry,
      ],
      {
        latestRun: { runId, status: "running", startedAt: CREATED_AT, completedAt: null },
      },
    );
    expect(text()).toContain("Current response remains visible");
    expect(text()).not.toContain("Partial response from the old attempt");
    const disclosure = button(/Superseded attempt/);
    expect(disclosure.textContent).toContain("Cut off by a steer");
    await click(disclosure);
    expect(text()).toContain("Partial response from the old attempt");
  });

  it("forks from a completed assistant response", async () => {
    const onForkFromRun = vi.fn(async () => {});
    await renderTimeline(
      [
        {
          ...message("Done", { role: "assistant", runId: RunId.make("run-1") }, "assistant-1"),
          projectedItem: v2Item("assistant_message", {
            id: "assistant-item-1",
            messageId: "assistant-1",
            text: "Done",
            streaming: false,
          }),
        } as Entry,
      ],
      { onForkFromRun },
    );
    await click(button("Fork from this response"));
    expect(onForkFromRun).toHaveBeenCalledWith({ sourceThreadId: "thread-1", runId: "run-1" });
  });

  it("opens the changed files of an assistant response", async () => {
    const assistantMessageId = MessageId.make("assistant-with-files");
    const runId = RunId.make("run-with-files");
    const onOpenTurnDiff = vi.fn();
    await renderTimeline(
      [message("Updated the fixture.", { role: "assistant", runId }, assistantMessageId)],
      {
        onOpenTurnDiff,
        latestRun: { runId, status: "completed", startedAt: CREATED_AT, completedAt: CREATED_AT },
        turnDiffSummaries: [
          {
            runId,
            checkpointTurnCount: 1,
            checkpointRef: CheckpointRef.make("checkpoint-with-files"),
            status: "ready",
            files: [{ path: "README.md", kind: "modified", additions: 2, deletions: 1 }],
            assistantMessageId,
            completedAt: CREATED_AT,
          },
        ],
      },
    );
    expect(text()).toContain("1 changed file");
    await click(button("Open diff"));
    expect(onOpenTurnDiff).toHaveBeenCalledWith(runId, "README.md");
  });
});

describe("MessagesTimeline attachments", () => {
  const withAttachment = (attachment: Record<string, unknown>) =>
    message("Read the report.", {
      attachments: [
        {
          type: "file",
          name: "report.pdf",
          mimeType: "application/pdf",
          sizeBytes: 42,
          ...attachment,
        },
      ] as never,
    });

  it("offers preview and download actions for PDF attachments", async () => {
    await renderTimeline([
      withAttachment({
        id: "attachment-report-pdf",
        previewUrl: "https://environment.test/api/assets/report.pdf",
      }),
    ]);
    expect(buttons("Preview report.pdf")).toHaveLength(1);
    expect(buttons("Download report.pdf")).toHaveLength(1);
    expect(container.querySelector('img[alt="report.pdf"]')).toBeNull();
  });

  it("does not create a download URL before the download is requested", async () => {
    await renderTimeline([withAttachment({ id: "attachment-report-pdf" })]);
    expect(buttons("Download report.pdf")).toHaveLength(1);
    expect(container.querySelector("a[href]")).toBeNull();
  });

  it("does not download an optimistic file before the server supplies its attachment ID", async () => {
    await renderTimeline([withAttachment({ id: "composer-local-report", downloadable: false })]);
    expect(text()).toContain("report.pdf");
    expect(buttons("Download report.pdf")).toHaveLength(0);
  });

  it("renders unknown attachment types as inert rows instead of crashing", async () => {
    await renderTimeline([
      withAttachment({
        type: "recording",
        id: "attachment-voice-memo",
        name: "voice-memo.ogg",
        mimeType: "audio/ogg",
      }),
    ]);
    expect(text()).toContain("voice-memo.ogg");
    expect(buttons("Download voice-memo.ogg")).toHaveLength(0);
    expect(container.querySelector("a[href], img")).toBeNull();
  });

  it("shows SnapShot window details only after the preview resolves", async () => {
    const snapShot = (previewUrl?: string) =>
      message("First prompt.", {
        attachments: [
          {
            type: "image",
            id: "attachment-1",
            name: "screenshot.png",
            mimeType: "image/png",
            sizeBytes: 1,
            ...(previewUrl ? { previewUrl } : {}),
            source: {
              kind: "snap-shot",
              capturedAt: CREATED_AT,
              appName: "Terminal",
              windowTitle: "t3code — Tests",
              appIconDataUrl: "data:image/png;base64,aWNvbg==",
            },
          },
        ] as never,
      });
    await renderTimeline([snapShot()]);
    expect(text()).toContain("screenshot.png");
    expect(text()).not.toContain("t3code — Tests");
    await act(async () => roots.pop()!.unmount());
    await renderTimeline([snapShot("data:image/png;base64,iVBORw0KGgo=")]);
    expect(text()).toContain("Terminal");
    expect(text()).toContain("t3code — Tests");
  });
});

describe("MessagesTimeline history and thread links", () => {
  it("loads earlier turns from a control ahead of the bounded timeline", async () => {
    const onLoadEarlier = vi.fn();
    await renderTimeline([message("Recent activity")], {
      historyControls: {
        hasMoreHistory: true,
        loading: false,
        error: "Earlier activity could not be loaded.",
        onLoadEarlier,
      },
    });
    expect(text()).toContain("Earlier activity could not be loaded.");
    expect(text().indexOf("Load earlier turns")).toBeLessThan(text().indexOf("Recent activity"));
    await click(button("Load earlier turns"));
    expect(onLoadEarlier).toHaveBeenCalledOnce();
  });

  it("keeps an empty bounded timeline busy while earlier history loads", async () => {
    await renderTimeline([], {
      historyControls: {
        hasMoreHistory: true,
        loading: true,
        error: null,
        onLoadEarlier: () => {},
      },
    });
    expect(text()).toContain("Loading earlier turns…");
    expect(button("Load earlier turns")).toHaveProperty("disabled", true);
    expect(text()).not.toContain("Send a message to start the conversation.");
  });

  it("opens the parent thread from the top of an empty subagent timeline", async () => {
    const onOpenThread = vi.fn();
    await renderTimeline([], {
      onOpenThread,
      parentThreadLink: { threadId: ThreadId.make("thread-parent"), title: "Architecture audit" },
    });
    expect(text()).toContain("Subagent of");
    expect(text()).toContain("Architecture audit");
    expect(text()).not.toContain("Send a message to start the conversation");
    await click(button("Open parent thread"));
    expect(onOpenThread).toHaveBeenCalledWith("thread-parent");
  });

  it("does not render the transient V2 interruption request", async () => {
    await renderTimeline([
      {
        id: "interrupt-request",
        kind: "event",
        createdAt: CREATED_AT,
        projectedItem: v2Item("run_interrupt_request", {
          id: "interrupt-request",
          message: "Waiting for the provider to stop.",
        }),
      } as Entry,
    ]);
    expect(text()).not.toContain("Interrupt requested");
    expect(text()).not.toContain("Waiting for the provider to stop.");
  });

  it("opens created threads from a lean row", async () => {
    const onOpenThread = vi.fn();
    await renderTimeline(
      [
        {
          id: "thread-created",
          kind: "event",
          createdAt: CREATED_AT,
          projectedItem: v2Item("thread_created", {
            id: "thread-created",
            nodeId: "node-1",
            ordinal: 1,
            title: "Claude research thread",
            targetThreadId: "thread-2",
            targetRunId: "run-2",
            targetProviderInstanceId: "claude-default",
            targetModel: "claude-sonnet-4-6",
          }),
        } as Entry,
      ],
      { onOpenThread },
    );
    expect(text()).toContain("Claude research thread");
    expect(text()).not.toContain("Work Log");
    await click(button("Open Claude research thread"));
    expect(onOpenThread).toHaveBeenCalledWith("thread-2");
  });

  it("renders context handoffs as from → to model endpoints instead of the summary", async () => {
    const provider = (instanceId: string, driver: string, slug: string, name: string) => ({
      instanceId,
      driver,
      enabled: true,
      installed: true,
      version: null,
      status: "ready",
      auth: {},
      checkedAt: CREATED_AT,
      models: [{ slug, name, isCustom: false, capabilities: null }],
      slashCommands: [],
      skills: [],
    });
    const providers = [
      provider("codex_personal", "codex", "gpt-5.6-sol", "GPT 5.6 Sol"),
      provider("claudeAgent", "claudeAgent", "claude-fable-5", "Claude Fable 5"),
    ] as never;
    const handoff = (fields: Record<string, unknown>) =>
      ({
        id: "handoff-1",
        kind: "event",
        createdAt: CREATED_AT,
        projectedItem: v2Item("handoff", {
          id: "handoff-1",
          runId: "run-2",
          title: "Provider handoff",
          contextHandoffId: "handoff-1",
          fromProviderThreadIds: ["provider-thread-1"],
          toProviderThreadId: "provider-thread-2",
          strategy: "full_thread_summary",
          summary: "Full conversation context for provider handoff.",
          fromProviderInstanceIds: ["codex_personal"],
          toProviderInstanceId: "claudeAgent",
          ...fields,
        }),
      }) as Entry;
    const show = async (entry: Entry, props: Partial<TimelineProps> = {}) => {
      for (const root of roots.splice(0)) await act(async () => root.unmount());
      await renderElement(
        <RegistryProvider
          initialValues={[[serverEnvironment.providersValueAtom(ENVIRONMENT_ID), providers]]}
        >
          <MessagesTimeline {...baseProps()} timelineEntries={[entry]} {...props} />
        </RegistryProvider>,
      );
    };

    await show(
      handoff({
        fromModelSelections: [{ instanceId: "codex_personal", model: "gpt-5.6-sol" }],
        toModel: "claude-fable-5",
      }),
    );
    expect(text()).toContain("Context handoff");
    expect(text()).toContain("GPT 5.6 Sol");
    expect(text()).toContain("Claude Fable 5");
    expect(text()).not.toContain("Full conversation context");

    await show(handoff({}), {
      runs: [
        {
          id: "run-1",
          ordinal: 1,
          providerInstanceId: "codex_personal",
          modelSelection: { instanceId: "codex_personal", model: "gpt-5.6-sol" },
        },
        {
          id: "run-2",
          ordinal: 2,
          providerInstanceId: "claudeAgent",
          modelSelection: { instanceId: "claudeAgent", model: "claude-fable-5" },
        },
      ] as never,
    });
    expect(text()).toContain("GPT 5.6 Sol");
    expect(text()).toContain("Claude Fable 5");

    await show(handoff({}));
    expect(text()).toContain("Codex Personal");
    expect(text()).not.toContain("Full conversation context");
  });
});

describe("MessagesTimeline subagents", () => {
  it.each(
    (
      [
        {
          status: "running",
          progress: "Reading src/index.ts",
          result: null,
          preview: "Reading src/index.ts",
        },
        {
          status: "completed",
          progress: "Reading src/index.ts",
          result: "Tests should be isolated.",
          preview: "Tests should be isolated.",
        },
        {
          status: "running",
          progress: "Reading src/index.ts",
          result: "Partial streamed answer",
          preview: "Reading src/index.ts",
        },
        {
          status: "running",
          progress: undefined,
          result: "Streaming answer so far",
          preview: "Streaming answer so far",
        },
        {
          status: "cancelled",
          progress: "Reading src/index.ts",
          result: "Partial output before cancel",
          preview: "Partial output before cancel",
        },
        {
          status: "completed",
          progress: "Audited 12 packages",
          result: "  \n\t  ",
          preview: "Audited 12 packages",
        },
      ] as const
    ).flatMap((scenario) => [1, 2].map((count) => ({ ...scenario, count }))),
  )(
    "shows $count $status subagents with '$preview', grouping only multiple agents",
    async ({ status, progress, result, preview, count }) => {
      const onOpenThread = vi.fn();
      await renderTimeline(
        Array.from(
          { length: count },
          (_, index) =>
            ({
              id: `subagent-progress-${index}`,
              kind: "event",
              createdAt: CREATED_AT,
              projectedItem: v2Item("subagent", {
                id: `subagent-progress-${index}`,
                nodeId: `node-subagent-${index}`,
                providerThreadId: "provider-thread-1",
                providerTurnId: "provider-turn-1",
                ordinal: 1,
                status,
                title: "Package audit",
                subagentId: `node-subagent-${index}`,
                origin: "provider_native",
                driver: "claudeAgent",
                providerInstanceId: "claudeAgent",
                childThreadId: "thread-subagent-1",
                prompt: "Inspect the package",
                progress,
                result,
              }),
            }) as Entry,
        ),
        { onOpenThread },
      );
      const children = () => buttons("Open Package audit");
      // A settled run folds its work behind a "Worked for" summary.
      const fold = buttons(/^Worked for/)[0];
      if (fold) await click(fold);
      if (count > 1) {
        expect(children()).toHaveLength(0);
        await click(button(`${count} subagents`));
      } else {
        expect(buttons(`${count} subagents`)).toHaveLength(0);
      }
      expect(children()).toHaveLength(count);
      expect(text()).toContain(preview);
      expect(text()).not.toContain("Inspect the package");
      if (result?.trim() && result !== preview) expect(text()).not.toContain(result);
      if (progress && progress !== preview) expect(text()).not.toContain(progress);
      await click(children()[0]!);
      expect(onOpenThread).toHaveBeenCalledWith("thread-subagent-1");
      if (count > 1) {
        await click(button(`${count} subagents`));
        await vi.waitFor(() => expect(children()).toHaveLength(0));
      }
    },
  );
});

describe("timeline tooltip scroll dismissal", () => {
  const openPopup = () =>
    document.querySelector('[data-slot="tooltip-popup"][data-open]')?.textContent ?? null;

  async function renderTooltip(pullRequest: boolean, outside: boolean) {
    const tooltip = pullRequest ? (
      <PullRequestLinkPreview
        link={<button>message link</button>}
        originalUrl="https://example.com"
        target={{
          environmentId: ENVIRONMENT_ID,
          input: { projectId: "project-1" as never, repository: "pingdotgg/t3code", number: 1 },
        }}
      />
    ) : (
      <Tooltip>
        <TooltipTrigger delay={50}>message link</TooltipTrigger>
        <TooltipPopup>https://example.com</TooltipPopup>
      </Tooltip>
    );
    await renderElement(
      <>
        <TooltipScrollDismissArea>
          <div data-testid="scrollable" className="h-[100px] overflow-auto">
            {outside ? null : tooltip}
            <div className="h-[1000px]" />
          </div>
        </TooltipScrollDismissArea>
        {outside ? tooltip : null}
      </>,
    );
    return {
      trigger: container.querySelector<HTMLButtonElement>("button")!,
      scrollable: container.querySelector<HTMLElement>('[data-testid="scrollable"]')!,
    };
  }

  async function scroll(scrollable: HTMLElement) {
    await act(async () => {
      scrollable.scrollTop += 50;
      scrollable.dispatchEvent(new Event("scroll"));
    });
  }

  it.each([false, true])(
    "closes a hovered tooltip on scroll but keeps a focused one (pull request=%s)",
    async (pullRequest) => {
      const { trigger, scrollable } = await renderTooltip(pullRequest, false);
      await userEvent.hover(trigger);
      await vi.waitFor(() => expect(openPopup()).toBe("https://example.com"));
      await scroll(scrollable);
      await vi.waitFor(() => expect(openPopup()).toBeNull());

      await userEvent.unhover(trigger);
      await userEvent.keyboard("{Tab}");
      expect(document.activeElement).toBe(trigger);
      await vi.waitFor(() => expect(openPopup()).toBe("https://example.com"));
      await scroll(scrollable);
      expect(openPopup()).toBe("https://example.com");
      expect(document.activeElement).toBe(trigger);
    },
  );

  it("leaves tooltips outside the timeline open when it scrolls", async () => {
    const { trigger, scrollable } = await renderTooltip(false, true);
    await userEvent.hover(trigger);
    await vi.waitFor(() => expect(openPopup()).toBe("https://example.com"));
    await scroll(scrollable);
    expect(openPopup()).toBe("https://example.com");
  });

  it("keeps a hovered tooltip open on a wheel that does not scroll", async () => {
    const { trigger, scrollable } = await renderTooltip(false, false);
    await userEvent.hover(trigger);
    await vi.waitFor(() => expect(openPopup()).toBe("https://example.com"));
    await act(async () => {
      scrollable.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: 100 }));
    });
    expect(openPopup()).toBe("https://example.com");
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

  it("settles when earlier short replies load above long ones", async () => {
    const props = baseProps();
    const short = Array.from({ length: 80 }, (_, index) =>
      message(`Short reply ${index}`, { role: "assistant" }, `short-${index}`),
    );
    const long = Array.from({ length: 4 }, (_, index) =>
      message(
        `${"Long handbook paragraph. ".repeat(40)}\n\n`.repeat(60),
        { role: "assistant" },
        `long-${index}`,
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
    await renderElement(timeline(long));
    const viewport = await waitForList(props);
    await act(async () => {
      viewport.scrollTop = 0;
      viewport.dispatchEvent(new Event("scroll"));
    });

    maxNestedCommits = 0;
    await act(async () => roots.at(-1)!.render(timeline([...short, ...long])));
    await vi.waitFor(async () => {
      await act(async () => {
        viewport.scrollTop = 0;
        viewport.dispatchEvent(new Event("scroll"));
      });
      expect(text()).toContain("Short reply 0");
    });
    expect(maxNestedCommits).toBeLessThan(8);
  });

  it("remembers a manual reading position when the chat closes", async () => {
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
    await renderElement(<Chat />);
    const viewport = await waitForList(props);
    await vi.waitFor(() => expect(readTimelinePosition(props.routeThreadKey)?.atEnd).toBe(true));

    await userEvent.wheel(viewport, { delta: { y: -600 } });
    await vi.waitFor(() => expect(readTimelinePosition(props.routeThreadKey)?.atEnd).toBe(false));
    const offset = viewport.scrollTop;
    await act(async () => roots.pop()!.unmount());
    expect(readTimelinePosition(props.routeThreadKey)).toMatchObject({
      atEnd: false,
      scrollOffset: offset,
    });
  });

  it("restores the composer after closing tool output only at the end", async () => {
    const props = baseProps();
    function Thread() {
      const composer = useComposerFocusState();
      return (
        <>
          <button onClick={() => composer.setIsComposerScrollCollapsed(true)}>Collapse</button>
          <output>{composer.isComposerScrollCollapsed ? "collapsed" : "resting"}</output>
          <MessagesTimeline
            {...props}
            onToolOutputCollapsedAtEnd={composer.restoreAfterTimelineReachedEnd}
            timelineEntries={[
              ...tallEntries,
              work("tool", {
                label: "Run command",
                tone: "tool",
                toolLifecycleStatus: "completed",
                detail: "Command output",
              }),
            ]}
          />
        </>
      );
    }
    await renderElement(<Thread />);
    const composerState = () => container.querySelector("output")!.textContent;
    const viewport = await waitForList(props);
    await click(button("Collapse"));
    const toggle = () => button("Command output");
    await click(toggle());
    await click(toggle());
    await vi.waitFor(() => expect(composerState()).toBe("resting"));

    await click(button("Collapse"));
    await userEvent.wheel(viewport, { delta: { y: -2000 } });
    await click(toggle());
    await click(toggle());
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    expect(composerState()).toBe("collapsed");
  });
});

describe("MessagesTimeline send anchor", () => {
  it("reports the anchored sent message once it is laid out", async () => {
    const onAnchorReady = vi.fn();
    const sent = message("Newest prompt.", {}, "message-2");
    await renderTimeline([message("Earlier reply.", { role: "assistant" }), sent], {
      anchorMessageId: MessageId.make("message-2"),
      onAnchorReady,
      contentInsetEndAdjustment: 144,
    });
    await vi.waitFor(() =>
      expect(onAnchorReady).toHaveBeenCalledWith(MessageId.make("message-2"), 1),
    );
  });

  it("does not anchor a follow-up user message that is not the newest turn", async () => {
    const onAnchorReady = vi.fn();
    await renderTimeline([message("First prompt."), message("Newest prompt.", {}, "message-2")], {
      anchorMessageId: MessageId.make("message-2"),
      onAnchorReady,
    });
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    expect(onAnchorReady).not.toHaveBeenCalled();
  });
});
