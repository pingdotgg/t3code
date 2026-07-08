import { describe, expect, it } from "vite-plus/test";

import type { ParsedClaudeMessage, ParsedClaudeSession } from "./claudeTranscript.ts";
import {
  buildOwnedSessionIdMap,
  detectForkCopy,
  isRalphSession,
  planThreadSync,
} from "./syncPlan.ts";

const message = (
  uuid: string,
  role: "user" | "assistant" = "user",
  text = `text-${uuid}`,
): ParsedClaudeMessage => ({
  uuid,
  role,
  text,
  timestamp: "2026-07-01T00:00:00.000Z",
});

const session = (messages: ParsedClaudeMessage[]): ParsedClaudeSession => ({
  sessionId: "11111111-2222-4333-8444-555555555555",
  cwd: "/home/user/project",
  gitBranch: "main",
  title: "Test session",
  startedAt: "2026-07-01T00:00:00.000Z",
  endedAt: "2026-07-01T01:00:00.000Z",
  messages,
});

const imported = (id: string) => ({ id, turnId: null });

describe("planThreadSync", () => {
  it("plans a full create when the thread does not exist", () => {
    const s = session([message("u-1"), message("a-1", "assistant")]);
    const plan = planThreadSync({ session: s, existingThread: null });
    expect(plan.kind).toBe("create");
    if (plan.kind === "create") {
      expect(plan.messages.map((m) => m.uuid)).toEqual(["u-1", "a-1"]);
    }
  });

  it("appends only the messages that are not imported yet, preserving order", () => {
    const s = session([
      message("u-1"),
      message("a-1", "assistant"),
      message("u-2"),
      message("a-2", "assistant"),
    ]);
    const plan = planThreadSync({
      session: s,
      existingThread: {
        deletedAt: null,
        hasTurns: false,
        messages: [imported("u-1"), imported("a-1")],
      },
    });
    expect(plan.kind).toBe("append");
    if (plan.kind === "append") {
      expect(plan.newMessages.map((m) => m.uuid)).toEqual(["u-2", "a-2"]);
    }
  });

  it("is unchanged when every transcript message is already imported (idempotence)", () => {
    const s = session([message("u-1"), message("a-1", "assistant")]);
    const plan = planThreadSync({
      session: s,
      existingThread: {
        deletedAt: null,
        hasTurns: false,
        messages: [imported("u-1"), imported("a-1")],
      },
    });
    expect(plan.kind).toBe("unchanged");
  });

  it("skips a thread that has provider turns (continued in T3)", () => {
    const s = session([message("u-1"), message("u-2")]);
    const plan = planThreadSync({
      session: s,
      existingThread: {
        deletedAt: null,
        hasTurns: true,
        messages: [imported("u-1")],
      },
    });
    expect(plan.kind).toBe("skip-forked");
  });

  it("skips a thread with a turn-bound message", () => {
    const s = session([message("u-1"), message("u-2")]);
    const plan = planThreadSync({
      session: s,
      existingThread: {
        deletedAt: null,
        hasTurns: false,
        messages: [imported("u-1"), { id: "u-1b", turnId: "turn-1" }],
      },
    });
    expect(plan.kind).toBe("skip-forked");
  });

  it("skips a thread containing a message the transcript cannot explain", () => {
    const s = session([message("u-1"), message("u-2")]);
    const plan = planThreadSync({
      session: s,
      existingThread: {
        deletedAt: null,
        hasTurns: false,
        messages: [imported("u-1"), imported("not-in-transcript")],
      },
    });
    expect(plan.kind).toBe("skip-forked");
    if (plan.kind === "skip-forked") {
      expect(plan.reason).toContain("not-in-transcript");
    }
  });

  it("skips a deleted thread", () => {
    const s = session([message("u-1")]);
    const plan = planThreadSync({
      session: s,
      existingThread: {
        deletedAt: "2026-07-02T00:00:00.000Z",
        hasTurns: false,
        messages: [imported("u-1")],
      },
    });
    expect(plan.kind).toBe("skip-deleted");
  });

  it("skips (tombstone) when the projection row is gone but the thread stream ever existed", () => {
    const s = session([message("u-1")]);
    const plan = planThreadSync({
      session: s,
      existingThread: null,
      threadStreamEverExisted: true,
    });
    expect(plan.kind).toBe("skip-deleted");
  });

  it("still creates when the thread stream never existed", () => {
    const s = session([message("u-1")]);
    const plan = planThreadSync({
      session: s,
      existingThread: null,
      threadStreamEverExisted: false,
    });
    expect(plan.kind).toBe("create");
  });

  it("tombstone flag does not disturb incremental sync of a live thread", () => {
    const s = session([message("u-1"), message("u-2")]);
    const plan = planThreadSync({
      session: s,
      existingThread: {
        deletedAt: null,
        hasTurns: false,
        messages: [imported("u-1")],
      },
      // A live imported thread's stream trivially exists in the event log.
      threadStreamEverExisted: true,
    });
    expect(plan.kind).toBe("append");
  });

  it("skips a soft-deleted thread even without the tombstone flag", () => {
    const s = session([message("u-1"), message("u-2")]);
    const plan = planThreadSync({
      session: s,
      existingThread: {
        deletedAt: "2026-07-02T00:00:00.000Z",
        hasTurns: false,
        messages: [imported("u-1")],
      },
      threadStreamEverExisted: true,
    });
    expect(plan.kind).toBe("skip-deleted");
  });

  it("prefers skip-forked over unchanged/append when both would match", () => {
    const s = session([message("u-1"), message("u-2")]);
    const plan = planThreadSync({
      session: s,
      existingThread: {
        deletedAt: null,
        hasTurns: true,
        messages: [imported("u-1"), imported("u-2")],
      },
    });
    expect(plan.kind).toBe("skip-forked");
  });
});

describe("isRalphSession", () => {
  it.each([
    "You are the generator agent",
    "You are the evaluator agent",
    "You are the rescue agent",
  ])("detects a first user prompt starting with '%s'", (prefix) => {
    const s = session([
      message("u-1", "user", `${prefix} for iteration 3. Do the thing.`),
      message("a-1", "assistant", "ok"),
    ]);
    expect(isRalphSession(s)).toBe(true);
  });

  it("ignores leading whitespace before the marker", () => {
    const s = session([message("u-1", "user", "\n  You are the generator agent, go.")]);
    expect(isRalphSession(s)).toBe(true);
  });

  it("does not flag normal sessions", () => {
    const s = session([
      message("u-1", "user", "Please refactor the parser."),
      message("a-1", "assistant", "You are the generator agent — just kidding."),
    ]);
    expect(isRalphSession(s)).toBe(false);
  });

  it("only inspects the FIRST user message", () => {
    const s = session([
      message("u-1", "user", "hello"),
      message("u-2", "user", "You are the generator agent"),
    ]);
    expect(isRalphSession(s)).toBe(false);
  });

  it("does not flag sessions without user messages", () => {
    const s = session([message("a-1", "assistant", "You are the generator agent")]);
    expect(isRalphSession(s)).toBe(false);
  });
});

describe("buildOwnedSessionIdMap", () => {
  const SID = "11111111-2222-4333-8444-555555555555";
  const FORK_SID = "99999999-8888-4777-8666-555555555555";

  it("marks a session owned when a native thread's cursor points at it", () => {
    const owned = buildOwnedSessionIdMap([
      { threadId: "f60fe000-c2c7-447a-92de-61e0c372208b", resumeSessionId: SID },
    ]);
    expect(owned.get(SID)).toBe("f60fe000-c2c7-447a-92de-61e0c372208b");
  });

  it("does not mark a session owned by its own import mirror thread", () => {
    const owned = buildOwnedSessionIdMap([
      { threadId: `claude-import-${SID}`, resumeSessionId: SID },
    ]);
    expect(owned.has(SID)).toBe(false);
  });

  it("marks a forkSession target owned by the continued import thread", () => {
    // Continuing claude-import-<SID> forked to FORK_SID; the fork transcript
    // must not be imported as its own thread.
    const owned = buildOwnedSessionIdMap([
      { threadId: `claude-import-${SID}`, resumeSessionId: FORK_SID },
    ]);
    expect(owned.has(SID)).toBe(false);
    expect(owned.get(FORK_SID)).toBe(`claude-import-${SID}`);
  });

  it("ignores bindings without a resume session id", () => {
    const owned = buildOwnedSessionIdMap([
      { threadId: "some-thread", resumeSessionId: null },
      { threadId: "other-thread", resumeSessionId: "  " },
    ]);
    expect(owned.size).toBe(0);
  });
});

describe("detectForkCopy", () => {
  const msgs = (uuids: string[]) => uuids.map((uuid) => ({ uuid }));
  const index = (entries: Array<[string, string]>) => new Map(entries);

  it("flags a transcript whose messages all belong to another thread", () => {
    const copy = detectForkCopy({
      sessionMessages: msgs(["m-1", "m-2", "m-3"]),
      threadId: "claude-import-fork",
      messageOwnerIndex: index([
        ["m-1", "claude-import-original"],
        ["m-2", "claude-import-original"],
        ["m-3", "claude-import-original"],
      ]),
    });
    expect(copy).toEqual({ ownerThreadId: "claude-import-original", sharedRatio: 1 });
  });

  it("flags a fork copy with a short new tail (ratio above threshold)", () => {
    const copy = detectForkCopy({
      sessionMessages: msgs(["m-1", "m-2", "m-3", "new-1"]),
      threadId: "claude-import-fork",
      messageOwnerIndex: index([
        ["m-1", "claude-import-original"],
        ["m-2", "claude-import-original"],
        ["m-3", "claude-import-original"],
      ]),
    });
    expect(copy?.ownerThreadId).toBe("claude-import-original");
    expect(copy?.sharedRatio).toBe(0.75);
  });

  it("does not flag a long-diverged fork (mostly new content)", () => {
    const copy = detectForkCopy({
      sessionMessages: msgs(["m-1", "new-1", "new-2", "new-3", "new-4"]),
      threadId: "claude-import-fork",
      messageOwnerIndex: index([["m-1", "claude-import-original"]]),
    });
    expect(copy).toBeNull();
  });

  it("ignores messages owned by the transcript's own thread", () => {
    const copy = detectForkCopy({
      sessionMessages: msgs(["m-1", "m-2"]),
      threadId: "claude-import-self",
      messageOwnerIndex: index([
        ["m-1", "claude-import-self"],
        ["m-2", "claude-import-self"],
      ]),
    });
    expect(copy).toBeNull();
  });

  it("attributes the copy to the majority owner", () => {
    const copy = detectForkCopy({
      sessionMessages: msgs(["m-1", "m-2", "m-3"]),
      threadId: "claude-import-fork",
      messageOwnerIndex: index([
        ["m-1", "claude-import-a"],
        ["m-2", "claude-import-b"],
        ["m-3", "claude-import-b"],
      ]),
    });
    expect(copy?.ownerThreadId).toBe("claude-import-b");
  });

  it("returns null for an empty transcript", () => {
    const copy = detectForkCopy({
      sessionMessages: [],
      threadId: "claude-import-fork",
      messageOwnerIndex: index([]),
    });
    expect(copy).toBeNull();
  });
});
