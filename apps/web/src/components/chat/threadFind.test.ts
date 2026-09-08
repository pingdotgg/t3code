import { MessageId, TurnId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import type { TimelineEntry } from "../../session-logic";
import { deriveMessagesTimelineRows } from "./MessagesTimeline.logic";
import {
  buildThreadFindMatches,
  clampThreadFindIndex,
  formatThreadFindCount,
  searchableThreadEntryText,
  stepThreadFindIndex,
} from "./threadFind";

const CREATED_AT = "2026-01-01T00:00:00.000Z";

function messageEntry(
  id: string,
  role: "user" | "assistant" | "system",
  text: string,
  turnId: TurnId | null = null,
): TimelineEntry {
  return {
    id,
    kind: "message",
    createdAt: CREATED_AT,
    message: {
      id: MessageId.make(id),
      role,
      text,
      turnId,
      streaming: false,
      createdAt: CREATED_AT,
      updatedAt: CREATED_AT,
    },
  };
}

function workEntry(id: string): TimelineEntry {
  return {
    id,
    kind: "work",
    createdAt: CREATED_AT,
    entry: {
      id,
      label: "deploy sentinel",
      tone: "tool",
      createdAt: CREATED_AT,
    },
  };
}

function proposedPlanEntry(id: string, planMarkdown: string, turnId: TurnId | null): TimelineEntry {
  return {
    id,
    kind: "proposed-plan",
    createdAt: CREATED_AT,
    proposedPlan: {
      id,
      turnId,
      planMarkdown,
      implementedAt: null,
      implementationThreadId: null,
      createdAt: CREATED_AT,
      updatedAt: CREATED_AT,
    },
  };
}

describe("searchableThreadEntryText", () => {
  it("searches displayed user text without appended context payloads", () => {
    const prompt = [
      "check the build",
      "",
      "<terminal_context>",
      "- pnpm build:",
      "  secret sentinel output",
      "</terminal_context>",
    ].join("\n");

    expect(searchableThreadEntryText(messageEntry("m1", "user", prompt))).toBe("check the build");
  });

  it("excludes terminal labels that render as non-searchable chips", () => {
    const prompt = [
      "check @terminal-1:12",
      "",
      "<terminal_context>",
      "- Terminal 1 line 12:",
      "  12 | output",
      "</terminal_context>",
    ].join("\n");

    expect(searchableThreadEntryText(messageEntry("m1", "user", prompt))).toBe("check");
  });

  it("keeps repeated terminal labels that are still visible after the chip", () => {
    const prompt =
      "check @terminal-1:12 and @terminal-1:12\n\n<terminal_context>\n- Terminal 1 line 12:\n  12 | output\n</terminal_context>";
    expect(
      buildThreadFindMatches([messageEntry("m1", "user", prompt)], "@terminal-1:12"),
    ).toHaveLength(1);
  });

  it("keeps the original text when terminal labels are out of context order", () => {
    const prompt =
      "@terminal-2:12 then @terminal-1:12\n\n<terminal_context>\n- Terminal 1 line 12:\n  12 | first\n- Terminal 2 line 12:\n  12 | second\n</terminal_context>";
    expect(buildThreadFindMatches([messageEntry("m1", "user", prompt)], "@terminal-")).toHaveLength(
      2,
    );
  });

  it.each(["user", "assistant"] as const)(
    "searches rendered %s Markdown, not link destinations or formatting",
    (role) => {
      const entries = [
        messageEntry(
          "m1",
          role,
          "[documentation](https://hidden.example/path) foo**bar** and `inline code`",
        ),
      ];
      expect(buildThreadFindMatches(entries, "hidden.example")).toHaveLength(0);
      expect(buildThreadFindMatches(entries, "documentation")).toHaveLength(1);
      expect(buildThreadFindMatches(entries, "foobar")).toHaveLength(1);
      expect(buildThreadFindMatches(entries, "inline code")).toHaveLength(1);
    },
  );

  it("searches code, escaped punctuation, entities and sanitized HTML as displayed", () => {
    const entries = [
      messageEntry(
        "m1",
        "assistant",
        "```ts\nconst value = 1;\n```\n\n\\*literal\\* &amp; <strong>bold</strong><script>hidden</script>",
      ),
    ];
    for (const query of ["const value", "*literal* & bold"]) {
      expect(buildThreadFindMatches(entries, query)).toHaveLength(1);
    }
    for (const query of ["hidden", "strong", "```ts"]) {
      expect(buildThreadFindMatches(entries, query)).toHaveLength(0);
    }
  });

  it("preserves literal HTML in user messages", () => {
    expect(
      buildThreadFindMatches([messageEntry("m1", "user", "<strong>bold</strong>")], "<strong>"),
    ).toHaveLength(1);
  });

  it("searches plan titles before body matches, including the default title", () => {
    const entries = [proposedPlanEntry("p1", "# Release\n\n## Summary\n\nRelease **ready**", null)];
    expect(buildThreadFindMatches(entries, "Release").map((match) => match.occurrence)).toEqual([
      0, 1,
    ]);
    expect(buildThreadFindMatches(entries, "Summary")).toHaveLength(0);
    expect(
      buildThreadFindMatches([proposedPlanEntry("p2", "Body", null)], "Proposed plan"),
    ).toHaveLength(1);
  });

  it("does not join separate blocks or the plan title and body into a phrase", () => {
    expect(
      buildThreadFindMatches([messageEntry("m1", "assistant", "first\n\nsecond")], "firstsecond"),
    ).toHaveLength(0);
    expect(
      buildThreadFindMatches([proposedPlanEntry("p1", "# first\n\nsecond", null)], "firstsecond"),
    ).toHaveLength(0);
  });

  it("indexes the rendered placeholder for empty assistant responses", () => {
    expect(searchableThreadEntryText(messageEntry("m1", "assistant", ""))).toBe("(empty response)");
  });

  it("skips work rows and system messages", () => {
    expect(searchableThreadEntryText(workEntry("w1"))).toBeNull();
    expect(searchableThreadEntryText(messageEntry("s1", "system", "sentinel"))).toBeNull();
  });

  it("uses the displayed proposed-plan title and body", () => {
    expect(
      searchableThreadEntryText(
        proposedPlanEntry("p1", "# Visible title\n\n## Summary\n\nship it", null),
      ),
    ).toBe("Visible title\nship it");
  });
});

describe("buildThreadFindMatches", () => {
  it("carries turn ownership for folded messages and plans", () => {
    const turnId = TurnId.make("turn-1");
    const entries = [
      messageEntry("m1", "assistant", "deploy twice: deploy", turnId),
      proposedPlanEntry("p1", "deploy the plan", turnId),
    ];

    expect(buildThreadFindMatches(entries, "deploy")).toEqual([
      { entryId: "m1", turnId, occurrence: 0 },
      { entryId: "m1", turnId, occurrence: 1 },
      { entryId: "p1", turnId, occurrence: 0 },
    ]);
  });

  it("reveals a search result inside a settled turn and restores its fold afterward", () => {
    const turnId = TurnId.make("settled-turn");
    const entries = [
      messageEntry("prompt", "user", "Check the release"),
      messageEntry("progress", "assistant", "Found the sentinel", turnId),
      messageEntry("final", "assistant", "Done", turnId),
    ];
    const input = {
      timelineEntries: entries,
      isWorking: false,
      activeTurnStartedAt: null,
      turnDiffSummaries: [],
      supportsConversationRollback: false,
    };
    const collapsed = deriveMessagesTimelineRows(input);
    expect(collapsed.some((row) => row.id === "progress")).toBe(false);

    const match = buildThreadFindMatches(entries, "sentinel")[0]!;
    const expanded = deriveMessagesTimelineRows({
      ...input,
      expandedTurnIds: new Set(match.turnId ? [match.turnId] : []),
    });
    expect(expanded.some((row) => row.id === match.entryId)).toBe(true);
    expect(deriveMessagesTimelineRows(input).map((row) => row.id)).toEqual(
      collapsed.map((row) => row.id),
    );
  });

  it("ignores blank queries", () => {
    expect(buildThreadFindMatches([messageEntry("m1", "user", "deploy")], "   ")).toEqual([]);
  });
});

describe("thread find navigation", () => {
  it("clamps, wraps, and formats positions", () => {
    expect(clampThreadFindIndex(4, 2)).toBe(1);
    expect(stepThreadFindIndex(2, 3, 1)).toBe(0);
    expect(stepThreadFindIndex(0, 3, -1)).toBe(2);
    expect(formatThreadFindCount(4, 2)).toBe("2/2");
    expect(formatThreadFindCount(0, 0)).toBe("0/0");
  });
});
