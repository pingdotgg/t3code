import {
  DEFAULT_CLIENT_SETTINGS,
  EnvironmentId,
  MessageId,
  type OrchestrationV2ProjectedTurnItem,
  type OrchestrationV2TurnItem,
  RunId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import { LegendListRef } from "@legendapp/list/react";
import { CHAT_REPLIES_DISPLAY_MODE, NORMAL_DISPLAY_MODE } from "@t3tools/shared/displayModes";
import * as DateTime from "effect/DateTime";
import { createRef, type ComponentProps } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";

import { render } from "../../../test/render";
import { MessagesTimeline } from "../../components/chat/MessagesTimeline";
import { deriveMessagesTimelineRows } from "../../components/chat/MessagesTimeline.logic";
import { __setClientSettingsForTests } from "../../hooks/useSettings";
import { deriveTimelineEntriesFromVisibleTurnItems } from "../../session-logic";
import { formatChatTimestampTooltip, formatDayAwareTimestamp } from "../../timestampFormat";
import { applyDisplayMode } from "./displayModeTimeline";

const threadId = ThreadId.make("display-mode-thread");
const runId = RunId.make("display-mode-run");
const time = (second: number) => new Date(Date.UTC(2026, 10, 3, 0, 0, second)).toISOString();
const base = (id: string, second: number) => ({
  id: TurnItemId.make(id),
  threadId,
  runId,
  nodeId: null,
  providerThreadId: null,
  providerTurnId: null,
  nativeItemRef: null,
  parentItemId: null,
  ordinal: second,
  status: "completed" as const,
  title: null,
  startedAt: DateTime.makeUnsafe(time(second)),
  completedAt: DateTime.makeUnsafe(time(second)),
  updatedAt: DateTime.makeUnsafe(time(second)),
});
const userMessage = (id: string, second: number, text: string, extra = {}) => ({
  ...base(id, second),
  type: "user_message" as const,
  messageId: MessageId.make(id),
  text,
  attachments: [],
  inputIntent: "turn_start" as const,
  createdBy: "user" as const,
  creationSource: "web" as const,
  ...extra,
});

const items: OrchestrationV2TurnItem[] = [
  userMessage("ask", 0, "Please fix the login bug."),
  { ...base("thinking", 1), type: "reasoning", text: "Looking at auth code", streaming: false },
  {
    ...base("read", 2),
    type: "dynamic_tool",
    toolName: "Read",
    input: { path: "a.ts" },
    output: "x",
  },
  { ...base("run", 3), type: "command_execution", input: "vp test", output: "ok", exitCode: 0 },
  {
    ...base("draft", 4),
    type: "assistant_message",
    messageId: MessageId.make("draft"),
    text: "I found the cause in the token check.",
    streaming: false,
  },
  {
    ...base("sent", 5),
    type: "dynamic_tool",
    toolName: "mcp__t3-code__send_to_user",
    input: { text: "Fixed: the token check now allows clock skew." },
    output: { ok: true, message: "Shown to the user." },
  },
  userMessage("bot", 6, "Status from the build bot", {
    createdBy: "agent",
    senderThreadId: ThreadId.make("bot-thread"),
  }),
  userMessage("retry", 7, "Continue where you left off.", { creationSource: "server" }),
];
const entriesOf = (turnItems: ReadonlyArray<OrchestrationV2TurnItem>) =>
  deriveTimelineEntriesFromVisibleTurnItems({
    visibleTurnItems: turnItems.map((item, position): OrchestrationV2ProjectedTurnItem => ({
      position,
      visibility: "local",
      sourceThreadId: threadId,
      sourceItemId: item.id,
      item,
    })),
    optimisticMessages: [],
  });
const entries = entriesOf(items);

type TimelineProps = ComponentProps<typeof MessagesTimeline>;

function props(): Omit<TimelineProps, "timelineEntries"> {
  return {
    isWorking: false,
    listRef: createRef<LegendListRef | null>(),
    latestRun: null,
    turnDiffSummaries: [],
    runs: [],
    routeThreadKey: `environment-local:display-mode-${Math.random().toString(36).slice(2)}`,
    onOpenTurnDiff: () => {},
    onOpenThread: () => {},
    onForkFromRun: async () => {},
    supportsConversationRollback: false,
    onRevertToTurnCount: () => {},
    isRevertingCheckpoint: false,
    onImageExpand: () => {},
    activeThreadEnvironmentId: EnvironmentId.make("environment-local"),
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
  };
}

async function renderTimeline(
  timelineEntries: TimelineProps["timelineEntries"],
  repliesChosen = false,
  extra: Partial<TimelineProps> = {},
) {
  const container = document.createElement("div");
  container.style.cssText = "height: 900px; width: 800px; display: flex; flex-direction: column;";
  return render(
    <MessagesTimeline
      {...props()}
      {...extra}
      timelineEntries={timelineEntries}
      repliesChosen={repliesChosen}
    />,
    { container },
  );
}

describe("display mode timeline", () => {
  it("shows the user's message and the sent message, drawn as a reply", async () => {
    await using screen = await renderTimeline([
      ...applyDisplayMode(CHAT_REPLIES_DISPLAY_MODE, entries),
    ]);
    await expect
      .element(screen.getByText("Fixed: the token check now allows clock skew."))
      .toBeVisible();
    const text = screen.container.textContent ?? "";
    expect(text).toContain("Please fix the login bug.");
    expect(text).toContain("T3 Code");
    for (const hidden of [
      "I found the cause in the token check.",
      "Status from the build bot",
      "Continue where you left off.",
      "vp test",
      "Sent a message",
      "Sent 1 message",
    ]) {
      expect(text).not.toContain(hidden);
    }
  });

  it("keeps every row in Normal and draws the sent message as a reply", async () => {
    const shown = applyDisplayMode(NORMAL_DISPLAY_MODE, entries);
    expect(shown.map((entry) => entry.id)).toEqual(entries.map((entry) => entry.id));
    await using screen = await renderTimeline([...shown]);
    await expect
      .element(screen.getByText("Fixed: the token check now allows clock skew."))
      .toBeVisible();
    const text = screen.container.textContent ?? "";
    expect(text).toContain("Worked for");
    expect(text).toContain("Status from the build bot");
    expect(text).not.toContain("Sent a message");
    expect(text).not.toContain("Sent 1 message");
  });

  describe("while the agent works", () => {
    const working = { isWorking: true, activeTurnStartedAt: time(0) };
    const asked = entriesOf([userMessage("work-ask", 0, "Please ship it.")]);
    const liveRow = (container: HTMLElement, kind: "working" | "thinking") =>
      container.querySelector(`[data-timeline-row-kind="${kind}"]`);

    it("draws the Working and Thinking rows in Normal", async () => {
      await using screen = await renderTimeline(
        [...applyDisplayMode(NORMAL_DISPLAY_MODE, asked)],
        false,
        working,
      );
      await vi.waitFor(() => {
        expect(liveRow(screen.container, "working")).not.toBeNull();
        expect(liveRow(screen.container, "thinking")).not.toBeNull();
      });
    });

    it("draws neither in a mode that chooses its replies", async () => {
      await using screen = await renderTimeline(
        [...applyDisplayMode(CHAT_REPLIES_DISPLAY_MODE, asked)],
        true,
        working,
      );
      await expect.element(screen.getByText("Please ship it.")).toBeVisible();
      expect(liveRow(screen.container, "working")).toBeNull();
      expect(liveRow(screen.container, "thinking")).toBeNull();
    });

    it("groups a steer with the message before it once the Working row is gone", () => {
      const rows = deriveMessagesTimelineRows({
        timelineEntries: entriesOf([
          userMessage("steer-ask", 0, "Please ship it."),
          userMessage("steer-more", 1, "Run the tests first.", { inputIntent: "steer" }),
        ]),
        isWorking: true,
        repliesChosen: true,
        turnDiffSummaries: [],
        supportsConversationRollback: false,
      });
      expect(rows.map((row) => row.kind)).toEqual(["message", "message"]);
      expect(rows[0]).toMatchObject({ groupedWithNext: true });
      expect(rows[1]).toMatchObject({ groupedWithPrevious: true });
    });
  });

  describe("in a finished turn with two sends", () => {
    const send = (id: string, second: number, text: string): OrchestrationV2TurnItem => ({
      ...base(id, second),
      type: "dynamic_tool",
      toolName: "mcp__t3-code__send_to_user",
      input: { text },
      output: { ok: true, message: "Shown to the user." },
    });
    const twoSends = entriesOf([
      userMessage("two-ask", 0, "Please ship it."),
      { ...base("two-run", 1), type: "command_execution", input: "vp test", exitCode: 0 },
      send("two-first", 2, "Tests pass, shipping now."),
      { ...base("two-push", 3), type: "command_execution", input: "git push", exitCode: 0 },
      send("two-last", 4, "It is shipped."),
    ]);

    it("shows both in Chat mode, with no fold", async () => {
      await using screen = await renderTimeline([
        ...applyDisplayMode(CHAT_REPLIES_DISPLAY_MODE, twoSends),
      ]);
      await expect.element(screen.getByText("Tests pass, shipping now.")).toBeVisible();
      await expect.element(screen.getByText("It is shipped.")).toBeVisible();
      expect(screen.container.textContent ?? "").not.toContain("Worked");
    });

    it("shows both in Chat mode when zen hides tool calls", async () => {
      __setClientSettingsForTests({ ...DEFAULT_CLIENT_SETTINGS, toolCallVisibility: "zen" });
      try {
        const chat = [...applyDisplayMode(CHAT_REPLIES_DISPLAY_MODE, twoSends)];
        {
          await using screen = await renderTimeline(chat);
          await expect.element(screen.getByText("It is shipped.")).toBeVisible();
          expect(screen.container.textContent ?? "").not.toContain("Tests pass, shipping now.");
        }
        await using screen = await renderTimeline(chat, true);
        await expect.element(screen.getByText("Tests pass, shipping now.")).toBeVisible();
        await expect.element(screen.getByText("It is shipped.")).toBeVisible();
      } finally {
        __setClientSettingsForTests(DEFAULT_CLIENT_SETTINGS);
      }
    });

    // A send made in Normal returns upstream's sentMessage, which upstream's row draws.
    const normalSends = entriesOf([
      userMessage("two-ask", 0, "Please ship it."),
      { ...base("two-run", 1), type: "command_execution", input: "vp test", exitCode: 0 },
      ...[
        send("two-first", 2, "Tests pass, shipping now."),
        {
          ...base("two-push", 3),
          type: "command_execution" as const,
          input: "git push",
          exitCode: 0,
        },
        send("two-last", 4, "It is shipped."),
      ].map((item) =>
        item.type === "dynamic_tool"
          ? {
              ...item,
              output: {
                ok: true,
                message: "Shown to the user. Don't repeat it.",
                sentMessage: (item.input as { readonly text: string }).text,
              },
            }
          : item,
      ),
    ]);

    it("shows each Normal-mode send once in Normal, outside the fold, and as replies in Chat mode", async () => {
      for (const [mode, repliesChosen] of [
        [NORMAL_DISPLAY_MODE, false],
        [CHAT_REPLIES_DISPLAY_MODE, true],
      ] as const) {
        await using screen = await renderTimeline(
          [...applyDisplayMode(mode, normalSends)],
          repliesChosen,
        );
        await expect.element(screen.getByText("Tests pass, shipping now.")).toBeVisible();
        await expect.element(screen.getByText("It is shipped.")).toBeVisible();
        const text = screen.container.textContent ?? "";
        for (const sent of ["Tests pass, shipping now.", "It is shipped."])
          expect(text.split(sent)).toHaveLength(2);
        expect(text).not.toContain("Sent a message");
      }
    });

    it("folds the earlier send in Normal, like any text before the turn's last reply", async () => {
      await using screen = await renderTimeline([
        ...applyDisplayMode(NORMAL_DISPLAY_MODE, twoSends),
      ]);
      await expect.element(screen.getByText("It is shipped.")).toBeVisible();
      const text = screen.container.textContent ?? "";
      expect(text).toContain("Worked for");
      expect(text).not.toContain("Tests pass, shipping now.");
    });
  });

  describe("with a rewritten send", () => {
    const send: OrchestrationV2TurnItem = {
      ...base("rewrite-send", 1),
      type: "dynamic_tool",
      toolName: "mcp__t3-code__send_to_user",
      input: { text: "The build is red." },
      output: { ok: true, message: "Shown to the user." },
    };
    const editedAt = new Date(Date.UTC(2026, 10, 3, 0, 47, 0)).toISOString();
    const replace = (id: string, status: "completed" | "running"): OrchestrationV2TurnItem => ({
      ...base(id, 3),
      completedAt: DateTime.makeUnsafe(editedAt),
      status,
      type: "dynamic_tool",
      toolName: "mcp__t3-code__replace_send_to_user",
      input: {
        user_message: "Is the build green?",
        old_text: "The build is red.",
        new_text: "The build is green again.",
      },
      output: { ok: true, message: "Shown to the user." },
    });
    const sent = entriesOf([userMessage("rewrite-ask", 0, "Is the build green?"), send]);

    it("redraws the send's row with the new text and time when the rewrite arrives", async () => {
      await using screen = await renderTimeline([
        ...applyDisplayMode(CHAT_REPLIES_DISPLAY_MODE, sent),
      ]);
      const shownTime = (at: string) => formatDayAwareTimestamp(at, "locale");
      const rowOf = (text: string) =>
        page.elementLocator(
          screen.getByText(text).element().closest('[data-timeline-row-kind="message"]')!,
        );
      await expect.element(screen.getByText("The build is red.")).toBeVisible();
      await expect
        .element(rowOf("The build is red.").getByText(shownTime(time(1)), { exact: true }))
        .toBeVisible();
      const rewritten = [...sent, ...entriesOf([replace("rewrite-call", "completed")])];
      await screen.rerender(
        <MessagesTimeline
          {...props()}
          timelineEntries={[...applyDisplayMode(CHAT_REPLIES_DISPLAY_MODE, rewritten)]}
          repliesChosen={false}
        />,
      );
      await expect.element(screen.getByText("The build is green again.")).toBeVisible();
      expect(screen.container.textContent ?? "").not.toContain("The build is red.");
      const reply = rowOf("The build is green again.");
      const shown = reply.getByText(shownTime(editedAt), { exact: true });
      await expect.element(shown).toBeVisible();
      expect(reply.element().textContent).not.toContain(shownTime(time(1)));
      await userEvent.hover(shown);
      await expect
        .element(page.getByText(formatChatTimestampTooltip(editedAt, "locale"), { exact: true }))
        .toBeVisible();
    });

    it("draws a Normal-mode send with its rewritten text back in Normal", () => {
      const normalSend: OrchestrationV2TurnItem = {
        ...send,
        output: {
          ok: true,
          message: "Shown to the user. Don't repeat it.",
          sentMessage: "The build is red.",
        },
      };
      const rewritten = entriesOf([
        userMessage("rewrite-ask", 0, "Is the build green?"),
        normalSend,
        replace("rewrite-call", "completed"),
      ]);
      const [, shown] = applyDisplayMode(NORMAL_DISPLAY_MODE, rewritten);
      expect(shown).toMatchObject({ kind: "sent-message", text: "The build is green again." });
      expect(applyDisplayMode(NORMAL_DISPLAY_MODE, rewritten)[1]).toBe(shown);
    });

    it("draws no row for a replace call in any mode, running or done", () => {
      for (const mode of [NORMAL_DISPLAY_MODE, CHAT_REPLIES_DISPLAY_MODE])
        for (const status of ["running", "completed"] as const) {
          const shown = applyDisplayMode(mode, [...sent, ...entriesOf([replace("call", status)])]);
          expect(shown.map((entry) => entry.id)).toEqual(["rewrite-ask", "rewrite-send"]);
        }
    });
  });

  it("returns the same rows when nothing changes, and a stable reply when it does", () => {
    const withoutSend = entries.filter((entry) => entry.id !== "sent");
    expect(applyDisplayMode(NORMAL_DISPLAY_MODE, withoutSend)).toBe(withoutSend);
    const reply = applyDisplayMode(NORMAL_DISPLAY_MODE, entries).find(
      (entry) => entry.id === "sent",
    );
    expect(reply?.kind).toBe("message");
    expect(applyDisplayMode(NORMAL_DISPLAY_MODE, [...entries]).find((e) => e.id === "sent")).toBe(
      reply,
    );
  });

  it("keeps a send that is running or failed as a work row", () => {
    const send = items.find((item) => item.id === "sent")!;
    for (const status of ["running", "failed"] as const) {
      const [entry] = deriveTimelineEntriesFromVisibleTurnItems({
        visibleTurnItems: [
          {
            position: 0,
            visibility: "local",
            sourceThreadId: threadId,
            sourceItemId: send.id,
            item: { ...send, status },
          },
        ],
        optimisticMessages: [],
      });
      expect(applyDisplayMode(NORMAL_DISPLAY_MODE, [entry!])[0]?.kind).toBe("work");
    }
  });
});
