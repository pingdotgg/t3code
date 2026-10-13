import { describe, expect, it } from "vite-plus/test";
import type { ThreadId } from "@t3tools/contracts";

import {
  isEmptySideChat,
  isPreviousSideChat,
  parseSideCommand,
  quoteForSideChat,
  sideChatActivity,
  sideChatsOf,
} from "./sideChat.logic";

const parent = "parent" as ThreadId;

const shell = (
  id: string,
  overrides: Record<string, unknown> = {},
): Parameters<typeof sideChatsOf>[0][number] =>
  ({
    id,
    sideChat: true,
    lineage: { parentThreadId: parent, relationshipToParent: null, rootThreadId: parent },
    archivedAt: null,
    deletedAt: null,
    createdAt: "2026-09-29T10:00:00.000Z",
    latestRun: null,
    itemCount: 0,
    ...overrides,
  }) as never;

describe("side chat logic", () => {
  it("lists only this parent's live side chats, newest first", () => {
    const rows = sideChatsOf(
      [
        shell("old", { createdAt: "2026-09-29T09:00:00.000Z" }),
        shell("new", { createdAt: "2026-09-29T11:00:00.000Z" }),
        shell("ordinary", { sideChat: false }),
        shell("other-parent", {
          lineage: {
            parentThreadId: "elsewhere",
            relationshipToParent: null,
            rootThreadId: "elsewhere",
          },
        }),
        shell("archived", { archivedAt: "2026-09-29T12:00:00.000Z" }),
        shell("deleted", { deletedAt: "2026-09-29T12:00:00.000Z" }),
      ],
      parent,
    );
    expect(rows.map((row) => row.id)).toEqual(["new", "old"]);
  });

  it("groups running side chats apart from finished ones and times the current run", () => {
    const running = shell("running", {
      latestRun: { status: "running", requestedAt: "a", startedAt: "b", completedAt: null },
    });
    const done = shell("done", {
      latestRun: { status: "completed", requestedAt: "a", startedAt: "b", completedAt: "c" },
    });
    expect(isPreviousSideChat(running)).toBe(false);
    expect(isPreviousSideChat(done)).toBe(true);
    expect(isPreviousSideChat(shell("fresh"))).toBe(true);
    expect(sideChatActivity(running)).toEqual({
      status: "running",
      startedAt: "b",
      completedAt: null,
    });
    expect(sideChatActivity(done)).toEqual({
      status: "completed",
      startedAt: "b",
      completedAt: "c",
    });
  });

  it("discards a side chat on close only while it has no messages", () => {
    expect(isEmptySideChat(shell("empty"))).toBe(true);
    expect(isEmptySideChat(shell("typed", { itemCount: 2 }))).toBe(false);
    expect(
      isEmptySideChat(
        shell("ran", {
          latestRun: { status: "running", requestedAt: "a", startedAt: null, completedAt: null },
        }),
      ),
    ).toBe(false);
  });

  it("quotes multi-line selections", () => {
    expect(quoteForSideChat("one\n\ntwo")).toBe("> one\n>\n> two\n\n");
  });

  it("parses /side and its /btw alias", () => {
    expect(parseSideCommand("/btw what does this do?")).toEqual({
      command: "btw",
      question: "what does this do?",
    });
    expect(parseSideCommand("/side")).toEqual({ command: "side", question: "" });
    expect(parseSideCommand("/sidebar")).toBeNull();
    expect(parseSideCommand("read /side")).toBeNull();
  });
});
