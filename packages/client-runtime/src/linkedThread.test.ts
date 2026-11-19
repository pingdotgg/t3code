import { EnvironmentId, type PeerLinkThreadPage, ThreadId, TurnItemId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  createLinkedThreadSession,
  type LinkedThreadCursor,
  type LinkedThreadReadResult,
  presentLinkedThreadItem,
  LINKED_THREAD_ACTIVE_POLL_MS,
  LINKED_THREAD_IDLE_POLL_MS,
  linkedThreadFailure,
  linkedThreadPollDelayMs,
  linkedThreadRefreshCursor,
  mergeLinkedThreadPage,
  resolveLinkedThreadOpen,
} from "./linkedThread.ts";

const nucbox = EnvironmentId.make("environment-nucbox");
const vm = EnvironmentId.make("environment-vm");
const threadId = ThreadId.make("thread:vm");

const item = (
  position: number,
  text: string,
  status: PeerLinkThreadPage["items"][number]["status"] = "completed",
): PeerLinkThreadPage["items"][number] => ({
  position,
  visibility: "local",
  sourceThreadId: threadId,
  itemId: TurnItemId.make(`item:${position}`),
  runId: null,
  messageId: null,
  createdBy: null,
  creationSource: null,
  type: "assistant_message",
  status,
  title: null,
  text,
  textTruncated: false,
  updatedAt: "2026-11-19T00:00:00.000Z",
});

const page = (
  items: PeerLinkThreadPage["items"],
  overrides: Partial<PeerLinkThreadPage> = {},
): PeerLinkThreadPage => ({
  label: "VM",
  thread: { threadId, title: "Fix the build", status: "running", model: "gpt-5" },
  items,
  earlierPosition: null,
  hasMore: false,
  ...overrides,
});

describe("resolveLinkedThreadOpen", () => {
  const open = (own: { connected: boolean } | undefined, linked: boolean) =>
    resolveLinkedThreadOpen({ environmentId: vm, viaEnvironmentId: nucbox, own, linked });

  it("keeps the client's own connection when it has one", () => {
    expect(open({ connected: true }, true)).toBe("direct");
  });

  it("reads through the link when the client is not connected to that environment", () => {
    expect(open(undefined, true)).toBe("linked");
    expect(open({ connected: false }, true)).toBe("linked");
  });

  it("falls back to what the client can do alone when nothing links there", () => {
    expect(open({ connected: false }, false)).toBe("direct");
    expect(open(undefined, false)).toBe("unavailable");
  });

  it("never routes an environment's own thread through a link", () => {
    expect(
      resolveLinkedThreadOpen({
        environmentId: nucbox,
        viaEnvironmentId: nucbox,
        own: undefined,
        linked: true,
      }),
    ).toBe("direct");
  });
});

describe("mergeLinkedThreadPage", () => {
  const newest = mergeLinkedThreadPage(
    null,
    page([item(10, "ten"), item(11, "eleven", "running")], { earlierPosition: 10 }),
    "later",
  );

  it("moves the start back with an earlier page and keeps the forward state", () => {
    const merged = mergeLinkedThreadPage(
      newest,
      page([item(8, "eight"), item(9, "nine")], { earlierPosition: null, hasMore: true }),
      "earlier",
    );
    expect(merged.items.map((entry) => entry.position)).toEqual([8, 9, 10, 11]);
    expect(merged.earlierPosition).toBeNull();
    expect(merged.hasMore).toBe(false);
  });

  it("replaces a re-read item and appends what followed, without moving the start", () => {
    const merged = mergeLinkedThreadPage(
      newest,
      page([item(11, "eleven, finished"), item(12, "twelve")], {
        earlierPosition: 11,
        thread: { threadId, title: "Fix the build", status: "completed", model: "gpt-5" },
      }),
      "later",
    );
    expect(merged.items.map((entry) => entry.text)).toEqual(["ten", "eleven, finished", "twelve"]);
    expect(merged.earlierPosition).toBe(10);
    expect(merged.thread.status).toBe("completed");
  });
});

describe("linkedThreadRefreshCursor", () => {
  const linkedThreadRefreshCursorOf = (shown: PeerLinkThreadPage) =>
    linkedThreadRefreshCursor(mergeLinkedThreadPage(null, shown, "later"));
  it("reads after the last item once everything shown has settled", () => {
    expect(linkedThreadRefreshCursorOf(page([item(4, "a"), item(5, "b")]))).toBe(5);
    expect(linkedThreadRefreshCursorOf(page([]))).toBe(-1);
  });

  it("re-reads from an item that is still being written", () => {
    expect(
      linkedThreadRefreshCursorOf(page([item(4, "a"), item(5, "b", "running"), item(6, "c")])),
    ).toBe(4);
  });

  it("continues from the last item while a page left more behind it", () => {
    expect(
      linkedThreadRefreshCursorOf(page([item(4, "a", "running"), item(5, "b")], { hasMore: true })),
    ).toBe(5);
  });

  it("continues from where a page cut short ended, not from the items it left untouched", () => {
    const shown = mergeLinkedThreadPage(
      mergeLinkedThreadPage(
        null,
        page([item(80, "a", "running"), item(81, "b"), item(99, "z")]),
        "later",
      ),
      page([item(80, "a, done")], { hasMore: true }),
      "later",
    );
    expect(shown.items.map((entry) => entry.position)).toEqual([80, 81, 99]);
    expect(linkedThreadRefreshCursor(shown)).toBe(80);
    // An earlier page leaves the forward continuation alone.
    const earlier = mergeLinkedThreadPage(shown, page([item(79, "y")]), "earlier");
    expect(linkedThreadRefreshCursor(earlier)).toBe(80);
    expect(
      linkedThreadRefreshCursor(mergeLinkedThreadPage(earlier, page([item(81, "b2")]), "later")),
    ).toBe(99);
  });

  it("stops re-reading an item that stays unsettled once it is far behind", () => {
    const items = [
      item(0, "stuck", "waiting"),
      ...Array.from({ length: 30 }, (_, i) => item(i + 1, "x")),
    ];
    expect(linkedThreadRefreshCursorOf(page(items))).toBe(30);
  });
});

describe("linkedThreadPollDelayMs", () => {
  it("reads again at once while catching up, soon while working, and rarely when idle", () => {
    expect(linkedThreadPollDelayMs(page([], { hasMore: true }))).toBe(0);
    expect(linkedThreadPollDelayMs(page([]))).toBe(LINKED_THREAD_ACTIVE_POLL_MS);
    expect(
      linkedThreadPollDelayMs(
        page([], { thread: { threadId, title: "Done", status: "idle", model: "gpt-5" } }),
      ),
    ).toBe(LINKED_THREAD_IDLE_POLL_MS);
  });
});

describe("linkedThreadFailure", () => {
  const names = { via: "nucbox", label: "VM" };
  const failure = (reason: string, label: string | null = "fs-17") =>
    linkedThreadFailure(
      { _tag: "PeerLinkThreadReadError", reason, label, message: "From the server." },
      names,
    );

  it("names the environment that has to change, and only retries what can recover", () => {
    expect(failure("disabled", null)).toMatchObject({
      title: "Linked environments is off on nucbox",
      retryable: false,
    });
    expect(failure("expired")).toMatchObject({
      title: "The link from nucbox to fs-17 expired",
      retryable: false,
    });
    expect(failure("thread_not_found")).toMatchObject({
      title: "This thread is no longer on fs-17",
      retryable: false,
    });
    expect(failure("incompatible")).toEqual({
      title: "fs-17 needs an update",
      detail: "From the server.",
      retryable: false,
    });
    expect(failure("unreachable")).toEqual({
      title: "fs-17 is not answering nucbox",
      detail: "From the server.",
      retryable: true,
    });
  });

  it("falls back to the client's name for the linked environment, and explains an old host", () => {
    expect(failure("unknown_link", null).title).toBe("nucbox is no longer linked to VM");
    expect(linkedThreadFailure(new Error(""), names)).toMatchObject({
      title: "Could not read this thread through nucbox",
      detail: "nucbox may need an update before it can read linked threads.",
      retryable: true,
    });
  });
});

describe("presentLinkedThreadItem", () => {
  const present = (
    type: string,
    text: string | null,
    extra: Partial<ReturnType<typeof item>> = {},
  ) => presentLinkedThreadItem({ ...item(0, ""), type, text, ...extra });

  it("shows messages in full and tool work as a row that opens", () => {
    expect(present("user_message", "Fix it")).toMatchObject({ kind: "user", text: "Fix it" });
    expect(present("command_execution", "$ vp test\n3 passed")).toEqual({
      kind: "activity",
      summary: "$ vp test",
      body: "3 passed",
      failed: false,
      truncated: false,
    });
    expect(present("dynamic_tool", "{}", { title: "t3_thread_read" })).toMatchObject({
      summary: "Tool call · t3_thread_read",
      body: "{}",
    });
    expect(present("error", "Rate limited")).toMatchObject({ summary: "Error", failed: true });
    expect(present("system_notice", "Session restarted")).toMatchObject({
      summary: "Session restarted",
      body: null,
    });
  });

  it("hides items with nothing to read", () => {
    expect(present("checkpoint", "[]")).toBeNull();
    expect(present("assistant_message", " ")).toBeNull();
    expect(present("system_notice", null)).toBeNull();
  });
});

describe("createLinkedThreadSession", () => {
  /** Reads answer when the test says so, and timers run when the test runs them. */
  const harness = (active = { current: true }) => {
    const reads: Array<{
      readonly cursor: LinkedThreadCursor;
      readonly answer: (result: LinkedThreadReadResult) => Promise<void>;
    }> = [];
    const timers: Array<{ readonly run: () => void; readonly delayMs: number; live: boolean }> = [];
    const session = createLinkedThreadSession({
      read: (cursor) =>
        new Promise((resolve) => {
          reads.push({
            cursor,
            answer: async (result) => {
              resolve(result);
              await Promise.resolve();
            },
          });
        }),
      schedule: (run, delayMs) => {
        const timer = { run, delayMs, live: true };
        timers.push(timer);
        return () => {
          timer.live = false;
        };
      },
      isActive: () => active.current,
    });
    const pending = () => timers.filter((timer) => timer.live);
    const fire = () => {
      const timer = pending()[0]!;
      timer.live = false;
      timer.run();
    };
    return { session, reads, pending, fire };
  };

  it("reads the newest page on open, then follows the thread at its pace", async () => {
    const { session, reads, pending, fire } = harness();
    session.subscribe(() => {});
    expect(reads.map((read) => read.cursor)).toEqual([{}]);
    await reads[0]!.answer({
      ok: true,
      page: page([item(4, "a"), item(5, "b", "running")], { earlierPosition: 4 }),
    });
    expect(pending().map((timer) => timer.delayMs)).toEqual([LINKED_THREAD_ACTIVE_POLL_MS]);

    fire();
    expect(reads[1]!.cursor).toEqual({ afterPosition: 4 });
    await reads[1]!.answer({
      ok: true,
      page: page([item(5, "b, done")], {
        thread: { threadId, title: "Fix the build", status: "completed", model: "gpt-5" },
      }),
    });
    expect(session.getSnapshot().transcript?.items.map((entry) => entry.text)).toEqual([
      "a",
      "b, done",
    ]);
    expect(pending().map((timer) => timer.delayMs)).toEqual([LINKED_THREAD_IDLE_POLL_MS]);
  });

  it("ignores a read that a newer one overtook", async () => {
    const { session, reads } = harness();
    session.subscribe(() => {});
    session.retry();
    await reads[1]!.answer({ ok: true, page: page([item(4, "new")]) });
    await reads[0]!.answer({ ok: true, page: page([item(4, "old")]) });
    expect(session.getSnapshot().transcript?.items.map((entry) => entry.text)).toEqual(["new"]);
  });

  it("pages back without losing what a refresh brought in meanwhile", async () => {
    const { session, reads, fire } = harness();
    session.subscribe(() => {});
    await reads[0]!.answer({ ok: true, page: page([item(5, "five")], { earlierPosition: 5 }) });
    fire();
    void session.loadEarlier();
    expect(reads.slice(1).map((read) => read.cursor)).toEqual([
      { afterPosition: 5 },
      { beforePosition: 5 },
    ]);
    expect(session.getSnapshot().loadingEarlier).toBe(true);
    await reads[2]!.answer({ ok: true, page: page([item(4, "four")]) });
    await reads[1]!.answer({ ok: true, page: page([item(6, "six")]) });
    expect(session.getSnapshot()).toMatchObject({ loadingEarlier: false, error: null });
    expect(session.getSnapshot().transcript?.items.map((entry) => entry.position)).toEqual([
      4, 5, 6,
    ]);
    expect(session.getSnapshot().transcript?.earlierPosition).toBeNull();
  });

  it("forgets a failed earlier read once the next one succeeds", async () => {
    const { session, reads } = harness();
    session.subscribe(() => {});
    await reads[0]!.answer({ ok: true, page: page([item(5, "five")], { earlierPosition: 5 }) });
    void session.loadEarlier();
    await reads[1]!.answer({ ok: false, error: new Error("offline") });
    expect(session.getSnapshot()).toMatchObject({ loadingEarlier: false });
    expect(session.getSnapshot().error).not.toBeNull();
    void session.loadEarlier();
    await reads[2]!.answer({ ok: true, page: page([item(4, "four")]) });
    expect(session.getSnapshot().error).toBeNull();
  });

  it("stops asking once the view closes or the read cannot recover", async () => {
    const closing = harness();
    const close = closing.session.subscribe(() => {});
    await closing.reads[0]!.answer({ ok: true, page: page([item(1, "one")]) });
    close();
    expect(closing.pending()).toEqual([]);

    const late = harness();
    const closeLate = late.session.subscribe(() => {});
    closeLate();
    await late.reads[0]!.answer({ ok: true, page: page([item(1, "one")]) });
    expect(late.session.getSnapshot().transcript).toBeNull();
    expect(late.pending()).toEqual([]);

    const expired = harness();
    expired.session.subscribe(() => {});
    const error = { _tag: "PeerLinkThreadReadError", reason: "expired", label: "VM", message: "" };
    await expired.reads[0]!.answer({ ok: false, error });
    expect(expired.session.getSnapshot().error).toBe(error);
    expect(expired.pending()).toEqual([]);
  });

  it("keeps trying an environment that is out of reach, and waits while nobody is looking", async () => {
    const active = { current: true };
    const { session, reads, pending, fire } = harness(active);
    session.subscribe(() => {});
    await reads[0]!.answer({
      ok: false,
      error: { _tag: "PeerLinkThreadReadError", reason: "unreachable", label: "VM", message: "" },
    });
    expect(pending().map((timer) => timer.delayMs)).toEqual([LINKED_THREAD_IDLE_POLL_MS]);

    active.current = false;
    fire();
    expect(reads).toHaveLength(1);
    active.current = true;
    fire();
    expect(reads).toHaveLength(2);
    await reads[1]!.answer({ ok: true, page: page([item(1, "one")]) });
    expect(session.getSnapshot()).toMatchObject({ error: null });
  });
});
