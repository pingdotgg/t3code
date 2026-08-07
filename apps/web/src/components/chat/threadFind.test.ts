import { MessageId, NodeId, PlanId, RunAttemptId, RunId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import type { TimelineEntry } from "../../session-logic";
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
  runId: RunId | null = null,
): TimelineEntry {
  return {
    id,
    kind: "message",
    createdAt: CREATED_AT,
    message: {
      id: MessageId.make(id),
      role,
      text,
      runId,
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

function proposedPlanEntry(id: string, planMarkdown: string, runId: RunId | null): TimelineEntry {
  return {
    id,
    kind: "proposed-plan",
    createdAt: CREATED_AT,
    proposedPlan: {
      id: PlanId.make(id),
      runId,
      planMarkdown,
      status: "active",
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

    expect(searchableThreadEntryText(messageEntry("m1", "user", prompt))).toBe("check ");
  });

  it("indexes the rendered placeholder for empty assistant responses", () => {
    expect(searchableThreadEntryText(messageEntry("m1", "assistant", ""))).toBe("(empty response)");
  });

  it("skips work rows and system messages", () => {
    expect(searchableThreadEntryText(workEntry("w1"))).toBeNull();
    expect(searchableThreadEntryText(messageEntry("s1", "system", "sentinel"))).toBeNull();
  });

  it("uses the displayed proposed-plan body", () => {
    expect(
      searchableThreadEntryText(
        proposedPlanEntry("p1", "# Hidden title\n\n## Summary\n\nship it", null),
      ),
    ).toBe("ship it");
  });
});

describe("buildThreadFindMatches", () => {
  it("carries V2 run and attempt ownership for folded navigation", () => {
    const runId = RunId.make("run-1");
    const attemptId = RunAttemptId.make("attempt-1");
    const assistant = messageEntry("m1", "assistant", "deploy twice: deploy", runId);
    const attemptedAssistant: TimelineEntry = {
      ...assistant,
      attempt: {
        id: attemptId,
        runId,
        attemptOrdinal: 1,
        rootNodeId: NodeId.make("node-1"),
        status: "superseded",
      },
    };

    expect(buildThreadFindMatches([attemptedAssistant], "deploy")).toEqual([
      { entryId: "m1", runId, attemptId, occurrence: 0 },
      { entryId: "m1", runId, attemptId, occurrence: 1 },
    ]);
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
