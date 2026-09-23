import { planPinnedMove } from "@t3tools/client-runtime/state/thread-sort";
import {
  createPendingThreadOrder,
  createThreadMovePlanner,
  threadOrderAfterMove,
  threadDropLifecycle,
  reconcilePendingThreadOrder,
  computeThreadMoveAvailability,
  type PendingThreadOrder,
  type ThreadMoveAvailability,
} from "./threadOrder";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { threadSearchMatchKey } from "@t3tools/client-runtime/state/thread-search";
import { resolveSnoozePresets } from "@t3tools/client-runtime/state/thread-settled";
import {
  CommandId,
  EnvironmentId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import type { PendingNewTask } from "../../state/use-pending-new-tasks";
import { threadJumpTarget } from "../keyboard/threadKeyboardShortcuts";
import {
  buildThreadListV2Items,
  buildThreadListV2ListItems,
  getThreadListV2OrderedSection,
  isThreadListV2ListItem,
  resolveThreadListV2SnoozeMenuSelection,
  resolveThreadListV2SnoozeGateExpiryMs,
  resolveThreadListV2Status,
  resolveThreadListV2SwipeActions,
  sortThreadsForListV2,
  threadListV2ListItemsAreEqual,
  type ThreadListV2ListItem,
} from "./threadListV2";

const environmentId = EnvironmentId.make("environment-1");

function makeThread(
  input: Partial<EnvironmentThreadShell> & Pick<EnvironmentThreadShell, "id" | "title">,
): EnvironmentThreadShell {
  return {
    environmentId,
    projectId: ProjectId.make("project-1"),
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    pullRequests: [],
    latestTurn: null,
    createdAt: "2026-06-01T00:00:00.000Z",
    updatedAt: "2026-06-01T00:00:00.000Z",
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    session: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    ...input,
  };
}

const NOW = "2026-06-02T00:00:00.000Z";
const linkedPullRequest = {
  projectId: ProjectId.make("project-1"),
  repository: "pingdotgg/t3code",
  number: 42,
  url: "https://github.com/pingdotgg/t3code/pull/42",
};

describe("resolveThreadListV2SnoozeMenuSelection", () => {
  it("accepts a displayed evening preset while its wake time is still future", () => {
    const menuOpenedAt = new Date(2026, 4, 8, 16, 59, 30);
    const selectedAt = new Date(2026, 4, 8, 17, 0, 30);
    const displayedPresets = resolveSnoozePresets(menuOpenedAt);

    const selection = resolveThreadListV2SnoozeMenuSelection({
      event: "snooze:evening",
      displayedPresets,
      now: selectedAt,
    });

    expect(selection).toEqual({
      _tag: "selected",
      preset: displayedPresets.find((preset) => preset.id === "evening"),
    });
  });

  it("expires a displayed preset once its wake time has passed", () => {
    const displayedPresets = resolveSnoozePresets(new Date(2026, 4, 8, 16, 59, 30));

    expect(
      resolveThreadListV2SnoozeMenuSelection({
        event: "snooze:evening",
        displayedPresets,
        now: new Date(2026, 4, 8, 18, 0, 1),
      }),
    ).toEqual({ _tag: "expired" });
  });

  it("recomputes presets that remain available instead of using old timestamps", () => {
    const displayedPresets = resolveSnoozePresets(new Date(2026, 4, 8, 10));
    const selectedAt = new Date(2026, 4, 8, 10, 30);
    const selection = resolveThreadListV2SnoozeMenuSelection({
      event: "snooze:hour",
      displayedPresets,
      now: selectedAt,
    });

    expect(selection._tag).toBe("selected");
    if (selection._tag === "selected") {
      expect(selection.preset.snoozedUntil).toBe(
        new Date(selectedAt.getTime() + 60 * 60 * 1_000).toISOString(),
      );
    }
  });
});

describe("resolveThreadListV2Status", () => {
  it("prioritizes approval over a running session", () => {
    const thread = makeThread({
      id: ThreadId.make("t"),
      title: "t",
      hasPendingApprovals: true,
      session: {
        threadId: ThreadId.make("t"),
        status: "running",
        providerName: "Codex",
        providerInstanceId: ProviderInstanceId.make("codex"),
        runtimeMode: "full-access",
        activeTurnId: null,
        lastError: null,
        updatedAt: NOW,
      },
    });
    expect(resolveThreadListV2Status(thread)).toBe("approval");
  });

  it("resolves ready for quiescent threads", () => {
    expect(resolveThreadListV2Status(makeThread({ id: ThreadId.make("t"), title: "t" }))).toBe(
      "ready",
    );
  });
});

describe("queued messages keep a settled thread active", () => {
  const threads = [
    makeThread({ id: ThreadId.make("active"), title: "Active" }),
    makeThread({ id: ThreadId.make("settled"), title: "Settled", settledOverride: "settled" }),
    makeThread({
      id: ThreadId.make("settled-queued"),
      title: "Settled with outbox",
      settledOverride: "settled",
    }),
  ];
  const queuedThreadKeys = new Set([`${environmentId}:settled-queued`]);

  it("lists the thread in the active block instead of the settled shelf", () => {
    const layout = buildThreadListV2Items({
      threads,
      environmentId: null,
      searchQuery: "",
      now: NOW,
      queuedThreadKeys,
    });
    expect(layout.items.map((item) => [item.thread.id, item.variant] as const)).toEqual([
      ["active", "card"],
      ["settled-queued", "card"],
      ["settled", "slim"],
    ]);
    expect(layout.settledCount).toBe(1);
  });

  it("includes it in the reorderable active section", () => {
    expect(
      getThreadListV2OrderedSection({ threads, section: "active", now: NOW, queuedThreadKeys }).map(
        (thread) => thread.id,
      ),
    ).toEqual(["active", "settled-queued"]);
    expect(
      getThreadListV2OrderedSection({ threads, section: "active", now: NOW }).map(
        (thread) => thread.id,
      ),
    ).toEqual(["active"]);
  });
});

describe("resolveThreadListV2SwipeActions", () => {
  it("offers settle and snooze for an active snoozable thread", () => {
    expect(
      resolveThreadListV2SwipeActions({
        variant: "card",
        settlementSupported: true,
        snoozeSupported: true,
        snoozable: true,
      }),
    ).toEqual({ primary: "settle", secondary: "snooze" });
  });

  it("offers un-settle and snooze for settled history", () => {
    expect(
      resolveThreadListV2SwipeActions({
        variant: "slim",
        settlementSupported: true,
        snoozeSupported: true,
        snoozable: true,
      }),
    ).toEqual({ primary: "unsettle", secondary: "snooze" });
  });

  it("omits snooze when the server or thread does not allow it", () => {
    expect(
      resolveThreadListV2SwipeActions({
        variant: "card",
        settlementSupported: true,
        snoozeSupported: false,
        snoozable: true,
      }),
    ).toEqual({ primary: "settle", secondary: null });
    expect(
      resolveThreadListV2SwipeActions({
        variant: "card",
        settlementSupported: true,
        snoozeSupported: true,
        snoozable: false,
      }),
    ).toEqual({ primary: "settle", secondary: null });
  });

  it("falls back to archive only for a pre-lifecycle server", () => {
    expect(
      resolveThreadListV2SwipeActions({
        variant: "card",
        settlementSupported: false,
        snoozeSupported: false,
        snoozable: true,
      }),
    ).toEqual({ primary: "archive", secondary: null });
  });

  it("offers wake and no snooze on a snoozed row", () => {
    expect(
      resolveThreadListV2SwipeActions({
        variant: "slim",
        settlementSupported: true,
        snoozeSupported: true,
        snoozable: true,
        snoozed: true,
      }),
    ).toEqual({ primary: "unsnooze", secondary: null });
  });
});

describe("resolveThreadListV2SnoozeGateExpiryMs", () => {
  it("reports when an unadopted turn's grace window lapses", () => {
    const thread = makeThread({
      id: ThreadId.make("t"),
      title: "t",
      latestUserMessageAt: "2026-06-02T00:00:30.000Z",
    });
    expect(resolveThreadListV2SnoozeGateExpiryMs(thread, { now: "2026-06-02T00:01:00.000Z" })).toBe(
      Date.parse("2026-06-02T00:02:30.000Z"),
    );
  });

  it("returns null once the thread is snoozable or when only data can unblock it", () => {
    expect(
      resolveThreadListV2SnoozeGateExpiryMs(
        makeThread({ id: ThreadId.make("ready"), title: "Ready" }),
        { now: NOW },
      ),
    ).toBe(null);
    expect(
      resolveThreadListV2SnoozeGateExpiryMs(
        makeThread({
          id: ThreadId.make("blocked"),
          title: "Blocked",
          hasPendingApprovals: true,
          latestUserMessageAt: NOW,
        }),
        { now: NOW },
      ),
    ).toBe(null);
  });
});

describe("sortThreadsForListV2", () => {
  it("honors a saved active order and leaves new threads above it", () => {
    const sorted = sortThreadsForListV2([
      { id: "newer-arranged", createdAt: "2026-06-01T12:00:00.000Z", activeOrderKey: "t" },
      { id: "older-arranged", createdAt: "2026-06-01T08:00:00.000Z", activeOrderKey: "f" },
      { id: "new", createdAt: "2026-06-01T13:00:00.000Z" },
    ]);
    expect(sorted.map((thread) => thread.id)).toEqual(["new", "older-arranged", "newer-arranged"]);
  });

  it("orders by creation time, newest first, ignoring activity", () => {
    const sorted = sortThreadsForListV2([
      { id: "oldest", createdAt: "2026-06-01T08:00:00.000Z" },
      { id: "newest", createdAt: "2026-06-01T12:00:00.000Z" },
      { id: "middle", createdAt: "2026-06-01T10:00:00.000Z" },
    ]);
    expect(sorted.map((thread) => thread.id)).toEqual(["newest", "middle", "oldest"]);
  });

  it("surfaces an un-settled thread at the top via its re-entry stamp", () => {
    const sorted = sortThreadsForListV2([
      {
        id: "old-unsettled",
        createdAt: "2026-06-01T08:00:00.000Z",
        unsettledAt: "2026-06-01T13:00:00.000Z",
      },
      { id: "newest", createdAt: "2026-06-01T12:00:00.000Z" },
      { id: "middle", createdAt: "2026-06-01T10:00:00.000Z" },
    ]);
    expect(sorted.map((thread) => thread.id)).toEqual(["old-unsettled", "newest", "middle"]);
  });
});

describe("getThreadListV2OrderedSection", () => {
  it("uses each saved order and excludes settled, snoozed, and archived rows", () => {
    const threads = [
      makeThread({ id: ThreadId.make("active-later"), title: "Later", activeOrderKey: "t" }),
      makeThread({ id: ThreadId.make("active-first"), title: "First", activeOrderKey: "f" }),
      makeThread({ id: ThreadId.make("active-new"), title: "New" }),
      makeThread({
        id: ThreadId.make("pinned-later"),
        title: "Pinned later",
        pinnedAt: NOW,
        pinOrderKey: "t",
        activeOrderKey: "f",
      }),
      makeThread({
        id: ThreadId.make("pinned-first"),
        title: "Pinned first",
        pinnedAt: NOW,
        pinOrderKey: "f",
        activeOrderKey: "t",
      }),
      makeThread({ id: ThreadId.make("settled"), title: "Settled", settledOverride: "settled" }),
      makeThread({ id: ThreadId.make("archived"), title: "Archived", archivedAt: NOW }),
      makeThread({
        id: ThreadId.make("snoozed"),
        title: "Snoozed",
        snoozedUntil: "2026-06-03T10:00:00.000Z",
        snoozedAt: NOW,
      }),
      makeThread({
        id: ThreadId.make("pinned-snoozed"),
        title: "Pinned snoozed",
        pinnedAt: NOW,
        snoozedUntil: "2026-06-03T10:00:00.000Z",
        snoozedAt: NOW,
      }),
    ];
    expect(
      getThreadListV2OrderedSection({ threads, section: "active", now: NOW }).map(
        (thread) => thread.id,
      ),
    ).toEqual(["active-new", "active-first", "active-later"]);
    expect(
      getThreadListV2OrderedSection({ threads, section: "pinned", now: NOW }).map(
        (thread) => thread.id,
      ),
    ).toEqual(["pinned-first", "pinned-later"]);
  });
});

describe("buildThreadListV2Items", () => {
  it("places a persisted settled thread in the settled shelf", () => {
    const thread = makeThread({
      id: ThreadId.make("linked-merged"),
      title: "Linked merged pull request",
      linkedPullRequest,
      settledOverride: "settled",
      settledAt: NOW,
    });
    const layout = buildThreadListV2Items({
      threads: [thread],
      environmentId: null,
      searchQuery: "",
      now: NOW,
    });

    expect(layout.settledCount).toBe(1);
    expect(layout.items[0]?.variant).toBe("slim");
  });

  it("hides snoozed threads and counts them — visibility parity with web", () => {
    const layout = buildThreadListV2Items({
      threads: [
        makeThread({ id: ThreadId.make("active"), title: "Active" }),
        makeThread({
          id: ThreadId.make("snoozed"),
          title: "Snoozed",
          snoozedUntil: "2026-06-03T09:00:00.000Z",
          snoozedAt: "2026-06-01T12:00:00.000Z",
        }),
        makeThread({
          id: ThreadId.make("woken"),
          title: "Woken",
          // Wake time already passed: back in the active list.
          snoozedUntil: "2026-06-01T18:00:00.000Z",
          snoozedAt: "2026-06-01T12:00:00.000Z",
        }),
      ],
      environmentId: null,
      searchQuery: "",
      now: NOW,
    });

    // Same createdAt → static sort tiebreaks by id; the point is the woken
    // thread is BACK in the card block and the snoozed one is gone.
    expect(layout.items.map((item) => item.thread.id)).toEqual(["active", "woken"]);
    expect(layout.snoozedCount).toBe(1);
  });

  it("places settled pinned threads in the settled shelf", () => {
    const layout = buildThreadListV2Items({
      threads: [
        makeThread({ id: ThreadId.make("active"), title: "Active" }),
        makeThread({
          id: ThreadId.make("pinned-settled"),
          title: "Pinned while settled",
          pinnedAt: "2026-06-01T12:00:00.000Z",
          settledOverride: "settled",
          settledAt: "2026-06-01T12:00:00.000Z",
        }),
      ],
      environmentId: null,
      searchQuery: "",
      now: NOW,
    });

    expect(layout.items.map((item) => item.thread.id)).toEqual(["active", "pinned-settled"]);
    expect(layout.items.map((item) => item.pinned)).toEqual([false, false]);
    expect(layout.settledCount).toBe(1);
  });

  it("keeps active pinned threads in the pinned block", () => {
    const pinned = makeThread({
      id: ThreadId.make("pinned"),
      title: "Pinned thread",
      pinnedAt: "2026-06-01T12:00:00.000Z",
    });
    const layout = buildThreadListV2Items({
      threads: [pinned],
      environmentId: null,
      searchQuery: "",
      now: NOW,
    });

    expect(layout.items[0]).toMatchObject({
      thread: { id: "pinned" },
      variant: "card",
      pinned: true,
    });
    expect(layout.settledCount).toBe(0);
  });

  it("snooze hides a pinned thread and wake restores it to the pinned block", () => {
    const snoozedInput = {
      threads: [
        makeThread({ id: ThreadId.make("active"), title: "Active" }),
        makeThread({
          id: ThreadId.make("pinned-snoozed"),
          title: "Pinned and snoozed",
          pinnedAt: "2026-06-01T12:00:00.000Z",
          snoozedUntil: "2026-06-03T09:00:00.000Z",
          snoozedAt: "2026-06-01T11:00:00.000Z",
        }),
      ],
      environmentId: null,
      searchQuery: "",
    };

    // Before the wake time: the snooze wins; the pin holds underneath.
    const whileSnoozed = buildThreadListV2Items({ ...snoozedInput, now: NOW });
    expect(whileSnoozed.items.map((item) => item.thread.id)).toEqual(["active"]);
    expect(whileSnoozed.snoozedCount).toBe(1);

    // After the wake time: the thread returns pinned, back on top.
    const afterWake = buildThreadListV2Items({ ...snoozedInput, now: "2026-06-03T10:00:00.000Z" });
    expect(afterWake.items.map((item) => item.thread.id)).toEqual(["pinned-snoozed", "active"]);
    expect(afterWake.items[0]?.pinned).toBe(true);
    expect(afterWake.snoozedCount).toBe(0);
  });

  it("classifies snooze with the second-precise clock and reports the next wake", () => {
    const layout = buildThreadListV2Items({
      threads: [
        makeThread({
          id: ThreadId.make("just-woke"),
          title: "Just woke",
          // Woke 30s ago: hidden under the minute-floored clock, visible
          // under the precise one.
          snoozedUntil: "2026-06-02T00:00:30.000Z",
          snoozedAt: "2026-06-01T12:00:00.000Z",
        }),
        makeThread({
          id: ThreadId.make("still-snoozed"),
          title: "Still snoozed",
          snoozedUntil: "2026-06-02T09:00:00.000Z",
          snoozedAt: "2026-06-01T12:00:00.000Z",
        }),
      ],
      environmentId: null,
      searchQuery: "",
      now: "2026-06-02T00:01:07.500Z",
    });

    expect(layout.items.map((item) => item.thread.id)).toEqual(["just-woke"]);
    expect(layout.snoozedCount).toBe(1);
    expect(layout.nextSnoozeWakeAt).toBe("2026-06-02T09:00:00.000Z");
  });

  it("builds snoozed rows between active and settled when the shelf is expanded", () => {
    const layout = buildThreadListV2Items({
      threads: [
        makeThread({ id: ThreadId.make("active"), title: "Active" }),
        makeThread({
          id: ThreadId.make("settled"),
          title: "Settled",
          settledOverride: "settled",
          settledAt: NOW,
        }),
        makeThread({
          id: ThreadId.make("later"),
          title: "Wakes later",
          snoozedUntil: "2026-06-03T09:00:00.000Z",
          snoozedAt: "2026-06-01T12:00:00.000Z",
        }),
        makeThread({
          id: ThreadId.make("sooner"),
          title: "Wakes sooner",
          snoozedUntil: "2026-06-02T09:00:00.000Z",
          snoozedAt: "2026-06-01T12:00:00.000Z",
        }),
      ],
      environmentId: null,
      searchQuery: "",
      now: NOW,
      snoozedShelfExpanded: true,
    });

    expect(layout.items.map((item) => item.thread.id)).toEqual([
      "active",
      "sooner",
      "later",
      "settled",
    ]);
    expect(layout.items.map((item) => item.snoozed)).toEqual([false, true, true, false]);
    expect(layout.snoozedShelfHeaderIndex).toBe(1);
    expect(layout.snoozedCount).toBe(2);
  });

  it("collapses to a header-only shelf", () => {
    const layout = buildThreadListV2Items({
      threads: [
        makeThread({
          id: ThreadId.make("snoozed"),
          title: "Snoozed",
          snoozedUntil: "2026-06-03T09:00:00.000Z",
          snoozedAt: "2026-06-01T12:00:00.000Z",
        }),
      ],
      environmentId: null,
      searchQuery: "",
      now: NOW,
    });

    expect(layout.items).toEqual([]);
    expect(layout.snoozedCount).toBe(1);
    expect(layout.snoozedShelfHeaderIndex).toBe(0);
  });

  it("keeps the selected thread on a collapsed shelf", () => {
    const layout = buildThreadListV2Items({
      threads: [
        makeThread({
          id: ThreadId.make("open"),
          title: "Open",
          snoozedUntil: "2026-06-03T09:00:00.000Z",
          snoozedAt: "2026-06-01T12:00:00.000Z",
        }),
        makeThread({
          id: ThreadId.make("other"),
          title: "Other",
          snoozedUntil: "2026-06-03T10:00:00.000Z",
          snoozedAt: "2026-06-01T12:00:00.000Z",
        }),
      ],
      environmentId: null,
      searchQuery: "",
      now: NOW,
      selectedThreadKey: `${environmentId}:open`,
    });

    expect(layout.items.map((item) => item.thread.id)).toEqual(["open"]);
    expect(layout.items[0]?.snoozed).toBe(true);
    expect(layout.snoozedCount).toBe(2);
  });

  it("keeps snoozed threads visible on environments without the snooze capability", () => {
    const layout = buildThreadListV2Items({
      threads: [
        makeThread({
          id: ThreadId.make("snoozed"),
          title: "Snoozed",
          snoozedUntil: "2026-06-03T09:00:00.000Z",
          snoozedAt: "2026-06-01T12:00:00.000Z",
        }),
      ],
      environmentId: null,
      searchQuery: "",
      snoozeEnvironmentIds: new Set(),
      now: NOW,
    });

    expect(layout.items.map((item) => item.thread.id)).toEqual(["snoozed"]);
    expect(layout.snoozedCount).toBe(0);
  });

  it("partitions settled threads into a slim shelf", () => {
    const layout = buildThreadListV2Items({
      threads: [
        makeThread({ id: ThreadId.make("active"), title: "Active" }),
        makeThread({
          id: ThreadId.make("settled"),
          title: "Settled",
          settledOverride: "settled",
          settledAt: NOW,
        }),
        makeThread({
          id: ThreadId.make("settled-2"),
          title: "Settled 2",
          settledOverride: "settled",
          settledAt: NOW,
        }),
      ],
      environmentId: null,
      searchQuery: "",
      now: NOW,
    });

    expect(layout.items.map((item) => [item.thread.id, item.variant])).toEqual([
      ["active", "card"],
      ["settled", "slim"],
      ["settled-2", "slim"],
    ]);
    expect(layout.items.map((item) => item.isLast)).toEqual([false, false, true]);
    expect(layout.settledCount).toBe(2);
    expect(layout.settledShelfHeaderIndex).toBe(1);
  });

  it("collapses settled threads to a counted shelf header", () => {
    const layout = buildThreadListV2Items({
      threads: [
        makeThread({ id: ThreadId.make("active"), title: "Active" }),
        makeThread({
          id: ThreadId.make("settled"),
          title: "Settled",
          settledOverride: "settled",
          settledAt: NOW,
        }),
      ],
      environmentId: null,
      searchQuery: "",
      now: NOW,
      settledShelfExpanded: false,
    });

    expect(layout.items.map((item) => item.thread.id)).toEqual(["active"]);
    expect(layout.settledCount).toBe(1);
    expect(layout.settledShelfHeaderIndex).toBe(1);
  });

  it("keeps the selected settled thread visible when its shelf is collapsed", () => {
    const layout = buildThreadListV2Items({
      threads: [
        makeThread({
          id: ThreadId.make("selected"),
          title: "Selected",
          settledOverride: "settled",
          settledAt: NOW,
        }),
        makeThread({
          id: ThreadId.make("other"),
          title: "Other",
          settledOverride: "settled",
          settledAt: NOW,
        }),
      ],
      environmentId: null,
      searchQuery: "",
      now: NOW,
      settledShelfExpanded: false,
      selectedThreadKey: `${environmentId}:selected`,
    });

    expect(layout.items.map((item) => item.thread.id)).toEqual(["selected"]);
    expect(layout.settledCount).toBe(2);
    expect(layout.settledShelfHeaderIndex).toBe(0);
  });

  it("keeps cards in creation order while settled sorts by recency", () => {
    const { items } = buildThreadListV2Items({
      threads: [
        makeThread({
          id: ThreadId.make("older-created"),
          title: "Older",
          createdAt: "2026-06-01T08:00:00.000Z",
          updatedAt: NOW, // recent activity must NOT promote it
        }),
        makeThread({
          id: ThreadId.make("newer-created"),
          title: "Newer",
          createdAt: "2026-06-01T12:00:00.000Z",
        }),
      ],
      environmentId: null,
      searchQuery: "",
      now: NOW,
    });

    expect(items.map((item) => item.thread.id)).toEqual(["newer-created", "older-created"]);
  });

  it("sorts settled threads by their persisted settlement timestamp", () => {
    const { items } = buildThreadListV2Items({
      threads: [
        makeThread({
          id: ThreadId.make("settled-newer"),
          title: "Settled newer",
          settledOverride: "settled",
          settledAt: "2026-06-01T12:00:00.000Z",
          latestUserMessageAt: "2026-06-01T08:00:00.000Z",
        }),
        makeThread({
          id: ThreadId.make("settled-older"),
          title: "Settled older",
          settledOverride: "settled",
          settledAt: "2026-06-01T10:00:00.000Z",
          latestUserMessageAt: "2026-06-01T09:00:00.000Z",
        }),
      ],
      environmentId: null,
      searchQuery: "",
      now: NOW,
    });

    expect(items.map((item) => item.thread.id)).toEqual(["settled-newer", "settled-older"]);
  });

  it("keeps settled threads in the tail and filters by search query", () => {
    const { items } = buildThreadListV2Items({
      threads: [
        makeThread({ id: ThreadId.make("match"), title: "Fix login bug" }),
        makeThread({ id: ThreadId.make("miss"), title: "Greeting" }),
        makeThread({
          id: ThreadId.make("settled"),
          title: "Fix login again",
          settledOverride: "settled",
          settledAt: NOW,
        }),
      ],
      environmentId: null,
      searchQuery: "login",
      now: NOW,
    });

    expect(items.map((item) => [item.thread.id, item.variant])).toEqual([
      ["match", "card"],
      ["settled", "slim"],
    ]);
  });

  it("includes a thread matched by message content", () => {
    const thread = makeThread({
      id: ThreadId.make("content-match"),
      title: "Unrelated title",
    });
    const { items } = buildThreadListV2Items({
      threads: [thread],
      environmentId: null,
      searchQuery: "relay reconnect",
      matchedThreadKeys: new Set([
        threadSearchMatchKey({
          environmentId,
          threadId: thread.id,
        }),
      ]),
      now: NOW,
    });

    expect(items.map((item) => item.thread.id)).toEqual(["content-match"]);
  });

  it("scopes the flat list to one project", () => {
    const otherProjectId = ProjectId.make("project-2");
    const { items } = buildThreadListV2Items({
      threads: [
        makeThread({ id: ThreadId.make("included"), title: "Included" }),
        makeThread({
          id: ThreadId.make("excluded"),
          projectId: otherProjectId,
          title: "Excluded",
        }),
      ],
      environmentId: null,
      projectRefs: [{ environmentId, projectId: ProjectId.make("project-1") }],
      searchQuery: "",
      now: NOW,
    });

    expect(items.map((item) => item.thread.id)).toEqual(["included"]);
  });

  it("scopes the flat list to every environment member of a logical project", () => {
    const remoteEnvironmentId = EnvironmentId.make("environment-remote");
    const { items } = buildThreadListV2Items({
      threads: [
        makeThread({ id: ThreadId.make("local"), title: "Local" }),
        makeThread({
          environmentId: remoteEnvironmentId,
          id: ThreadId.make("remote"),
          title: "Remote",
        }),
      ],
      environmentId: null,
      projectRefs: [
        { environmentId, projectId: ProjectId.make("project-1") },
        { environmentId: remoteEnvironmentId, projectId: ProjectId.make("project-1") },
      ],
      searchQuery: "",
      now: NOW,
    });

    expect(items.map((item) => item.thread.id)).toEqual(["local", "remote"]);
  });
});

describe("buildThreadListV2Items settled paging", () => {
  it("caps the settled tail at settledLimit and reports the hidden count", () => {
    const threads = [
      makeThread({ id: ThreadId.make("active"), title: "Active" }),
      ...Array.from({ length: 4 }, (_, index) =>
        makeThread({
          id: ThreadId.make(`settled-${index}`),
          title: `Settled ${index}`,
          settledOverride: "settled",
          settledAt: `2026-06-01T0${index}:10:00.000Z`,
          latestUserMessageAt: `2026-06-01T0${index}:00:00.000Z`,
          // A turn adopted the message (same requestedAt): without it the
          // thread reads as a queued turn start, which never settles.
          latestTurn: {
            turnId: TurnId.make(`turn-${index}`),
            state: "completed",
            requestedAt: `2026-06-01T0${index}:00:00.000Z`,
            startedAt: `2026-06-01T0${index}:00:00.000Z`,
            completedAt: `2026-06-01T0${index}:10:00.000Z`,
            assistantMessageId: null,
          },
        }),
      ),
    ];

    const layout = buildThreadListV2Items({
      threads,
      environmentId: null,
      searchQuery: "",
      settledLimit: 2,
      now: NOW,
    });

    expect(layout.hiddenSettledCount).toBe(2);
    expect(layout.items.filter((item) => item.variant === "slim")).toHaveLength(2);
    // Most recent settled first — the hidden ones are the oldest.
    expect(layout.items.map((item) => item.thread.id)).toEqual([
      "active",
      "settled-3",
      "settled-2",
    ]);
  });
});

function makePendingTask(id: string): PendingNewTask {
  const creation = {
    projectId: ProjectId.make("project-1"),
    workspaceMode: "worktree" as const,
    branch: null,
    worktreePath: null,
  };
  return {
    kind: "pending",
    key: `pending-task:${id}`,
    environmentId,
    projectId: creation.projectId,
    projectTitle: undefined,
    projectCwd: undefined,
    branch: null,
    title: id,
    createdAt: NOW,
    message: {
      environmentId,
      threadId: ThreadId.make(`thread-${id}`),
      messageId: MessageId.make(id),
      commandId: CommandId.make(`command-${id}`),
      text: id,
      attachments: [],
      createdAt: NOW,
      creation,
    },
    creation,
  };
}

describe("buildThreadListV2ListItems", () => {
  const layout = buildThreadListV2Items({
    threads: [
      makeThread({ id: ThreadId.make("active"), title: "active" }),
      makeThread({
        id: ThreadId.make("settled"),
        title: "settled",
        settledOverride: "settled",
        settledAt: NOW,
      }),
    ],
    environmentId: null,
    searchQuery: "",
    now: NOW,
  });

  it("splices queued tasks between the active block and the settled tail", () => {
    const items = buildThreadListV2ListItems({
      items: layout.items,
      pendingTasks: [makePendingTask("queued-1"), makePendingTask("queued-2")],
      settledCount: layout.settledCount,
      settledShelfHeaderIndex: layout.settledShelfHeaderIndex,
    });

    expect(
      items.map((item) =>
        item.type === "v2-pending"
          ? item.pendingTask.title
          : item.type === "v2-thread"
            ? item.item.thread.id
            : item.type === "v2-snoozed-shelf"
              ? "snoozed-shelf"
              : "settled-shelf",
      ),
    ).toEqual(["active", "queued-1", "queued-2", "settled-shelf", "settled"]);
    // Only the leading queued row labels the section, exactly like Settled.
    expect(
      items.filter((item) => item.type === "v2-pending" && item.showPendingDivider),
    ).toHaveLength(1);
  });

  it("ends the list with queued tasks when nothing has settled yet", () => {
    const activeOnly = buildThreadListV2Items({
      threads: [makeThread({ id: ThreadId.make("active"), title: "active" })],
      environmentId: null,
      searchQuery: "",
      now: NOW,
    });
    const items = buildThreadListV2ListItems({
      items: activeOnly.items,
      pendingTasks: [makePendingTask("queued-1")],
    });

    expect(items.map((item) => item.type)).toEqual(["v2-thread", "v2-pending"]);
  });

  it("keeps the settled shelf between active and settled rows when nothing is queued", () => {
    const items = buildThreadListV2ListItems({
      items: layout.items,
      pendingTasks: [],
      settledCount: layout.settledCount,
      settledShelfHeaderIndex: layout.settledShelfHeaderIndex,
    });

    expect(items.map((item) => item.key)).toEqual([
      `v2-thread:${environmentId}:active`,
      "v2-settled-shelf",
      `v2-thread:${environmentId}:settled`,
    ]);
  });

  it("places queued tasks before a collapsed snoozed shelf", () => {
    const snoozedLayout = buildThreadListV2Items({
      threads: [
        makeThread({ id: ThreadId.make("active"), title: "active" }),
        makeThread({
          id: ThreadId.make("snoozed"),
          title: "snoozed",
          snoozedUntil: "2026-06-03T09:00:00.000Z",
          snoozedAt: "2026-06-01T12:00:00.000Z",
        }),
        makeThread({
          id: ThreadId.make("settled"),
          title: "settled",
          settledOverride: "settled",
          settledAt: NOW,
        }),
      ],
      environmentId: null,
      searchQuery: "",
      now: NOW,
    });
    const items = buildThreadListV2ListItems({
      items: snoozedLayout.items,
      pendingTasks: [makePendingTask("queued")],
      snoozedCount: snoozedLayout.snoozedCount,
      snoozedShelfExpanded: false,
      snoozedShelfHeaderIndex: snoozedLayout.snoozedShelfHeaderIndex,
      settledCount: snoozedLayout.settledCount,
      settledShelfHeaderIndex: snoozedLayout.settledShelfHeaderIndex,
    });

    expect(items.map((item) => item.type)).toEqual([
      "v2-thread",
      "v2-pending",
      "v2-snoozed-shelf",
      "v2-settled-shelf",
      "v2-thread",
    ]);
    expect(threadJumpTarget(items, "thread.jump.1")?.id).toBe("active");
    expect(threadJumpTarget(items, "thread.jump.2")?.id).toBe("settled");
    expect(threadJumpTarget(items, "thread.jump.3")).toBeNull();
  });
});

describe("pending mobile thread moves", () => {
  function fixture(section: "active" | "pinned" = "active") {
    const rows = ["a", "b", "c"].map((id, index) =>
      makeThread({
        id: ThreadId.make(id),
        title: id === "a" ? "hidden" : "match",
        createdAt: `2026-06-01T0${3 - index}:00:00.000Z`,
        pinnedAt: section === "pinned" ? `2026-06-01T0${3 - index}:00:00.000Z` : null,
      }),
    );
    const ordered = getThreadListV2OrderedSection({ threads: rows, section, now: NOW });
    const orderedIds = ordered.map((row) => `${row.environmentId}:${row.id}`);
    const movedId = orderedIds[2]!;
    const assignments = planPinnedMove({
      orderedIds,
      keysById: new Map(orderedIds.map((id) => [id, null])),
      movedId,
      direction: "up",
    })!;
    const pending = createPendingThreadOrder({
      section,
      ordered,
      movedId,
      direction: "up",
      assignments,
    });
    const update = (current: EnvironmentThreadShell[], assignment: (typeof assignments)[number]) =>
      current.map((row) =>
        `${row.environmentId}:${row.id}` === assignment.id
          ? {
              ...row,
              [section === "pinned" ? "pinOrderKey" : "activeOrderKey"]: assignment.orderKey,
            }
          : row,
      );
    return { rows, assignments, pending, update };
  }

  function layout(
    rows: EnvironmentThreadShell[],
    pendingOrder: PendingThreadOrder | null,
    searchQuery = "",
  ) {
    return buildThreadListV2Items({
      threads: rows,
      pendingOrder,
      environmentId: null,
      searchQuery,
      now: NOW,
    }).items.map((item) => item.thread.id);
  }

  it.each(["active", "pinned"] as const)(
    "holds %s order through every intermediate key upsert",
    (section) => {
      const { rows, assignments, pending, update } = fixture(section);
      let current = rows;
      let hold: PendingThreadOrder | null = pending;
      const desired = pending.orderedIds.map((id) => id.split(":")[1]);
      expect(layout(current, hold)).toEqual(desired);
      for (const assignment of assignments) {
        current = update(current, assignment);
        hold = reconcilePendingThreadOrder(
          hold!,
          getThreadListV2OrderedSection({ threads: current, section, now: NOW }),
        );
        expect(hold).not.toBeNull();
        expect(layout(current, hold)).toEqual(desired);
      }
      expect(reconcilePendingThreadOrder({ ...hold!, commandsComplete: true }, current)).toBeNull();
      expect(layout(current, null)).toEqual(desired);
    },
  );

  it("keeps the action guard pending when receipts precede canonical shells", () => {
    const { rows, assignments, pending, update } = fixture();
    let hold: PendingThreadOrder | null = { ...pending, commandsComplete: true };
    let current = rows;
    expect(reconcilePendingThreadOrder(hold, current)).toBe(hold);
    for (const [index, assignment] of assignments.entries()) {
      current = update(current, assignment);
      hold = reconcilePendingThreadOrder(hold!, current);
      expect(hold === null).toBe(index === assignments.length - 1);
      expect(layout(current, hold)).toEqual(["a", "c", "b"]);
    }
  });

  it("keeps search results in the full pending section order", () => {
    const { rows, assignments, pending, update } = fixture();
    const current = update(update(rows, assignments[0]!), assignments[1]!);
    expect(layout(current, pending, "match")).toEqual(["c", "b"]);
  });

  it("releases for real section membership and foreign key changes", () => {
    const { rows, pending } = fixture();
    expect(reconcilePendingThreadOrder(pending, rows.slice(1))).toBeNull();
    const newRow = makeThread({ id: ThreadId.make("new"), title: "new" });
    expect(reconcilePendingThreadOrder(pending, [...rows, newRow])).toBeNull();
    expect(
      reconcilePendingThreadOrder(
        pending,
        rows.map((row, index) => (index === 0 ? { ...row, activeOrderKey: "zz" } : row)),
      ),
    ).toBeNull();
    const settled = rows.map((row, index) =>
      index === 0 ? { ...row, settledOverride: "settled" as const } : row,
    );
    expect(layout(settled, pending)).toEqual(layout(settled, null));
  });

  it("does not hide a concurrent return to a previously confirmed key", () => {
    const { rows, assignments, pending, update } = fixture();
    const confirmed = reconcilePendingThreadOrder(pending, update(rows, assignments[0]!))!;
    expect(reconcilePendingThreadOrder(confirmed, rows)).toBeNull();
  });

  it("preserves the hold for activity but releases for a reopened sort anchor", () => {
    const { rows, pending } = fixture();
    expect(
      reconcilePendingThreadOrder(
        pending,
        rows.map((row) => ({ ...row, updatedAt: NOW })),
      ),
    ).toBe(pending);
    expect(
      reconcilePendingThreadOrder(
        pending,
        rows.map((row, index) => (index === 0 ? { ...row, unsettledAt: NOW } : row)),
      ),
    ).toBeNull();
  });
});

describe("mobile move availability", () => {
  const oldEnvironment = EnvironmentId.make("older-server");
  function rows(section: "active" | "pinned", keys: readonly (string | null)[]) {
    return keys.map((key, index) =>
      makeThread({
        id: ThreadId.make(`move-${index}`),
        title: `Move ${index}`,
        environmentId: index === 1 ? oldEnvironment : environmentId,
        activeOrderKey: section === "active" ? key : null,
        pinOrderKey: section === "pinned" ? key : null,
        pinnedAt: section === "pinned" ? NOW : null,
      }),
    );
  }

  it.each(["active", "pinned"] as const)(
    "keeps unsupported keyed %s neighbors as usable anchors",
    (section) => {
      const ordered = rows(section, ["bb", "dd", "ff"]);
      const plan = createThreadMovePlanner({
        ordered,
        section,
        reorderableEnvironmentIds: new Set([environmentId]),
      });
      const assignments = plan(`${environmentId}:move-0`, "down");
      expect(assignments).toHaveLength(1);
      expect(assignments![0]!.id).toBe(`${environmentId}:move-0`);
      expect(assignments![0]!.orderKey > "dd").toBe(true);
      expect(assignments![0]!.orderKey < "ff").toBe(true);
      expect(plan(`${oldEnvironment}:move-1`, "up")).toBeNull();
      expect(plan(`${environmentId}:move-0`, "up")).toBeNull();
    },
  );

  it.each(["active", "pinned"] as const)(
    "disables %s moves requiring unsupported keyless materialization",
    (section) => {
      const ordered = rows(section, [null, null, null]);
      const plan = createThreadMovePlanner({
        ordered,
        section,
        reorderableEnvironmentIds: new Set([environmentId]),
      });
      expect(plan(`${environmentId}:move-0`, "down")).toBeNull();
      expect(plan(`${environmentId}:move-2`, "up")).toBeNull();
      const supported = createThreadMovePlanner({
        ordered,
        section,
        reorderableEnvironmentIds: new Set([environmentId, oldEnvironment]),
      });
      expect(supported(`${environmentId}:move-0`, "down")).toHaveLength(3);
    },
  );

  it.each(["active", "pinned"] as const)(
    "reserves snoozed %s keys when moving visible rows",
    (section) => {
      const ordered = rows(section, ["bb", "dd", "ff"]);
      const input = { ordered, section, reorderableEnvironmentIds: new Set([environmentId]) };
      const collision = createThreadMovePlanner(input)(`${environmentId}:move-0`, "down")![0]!
        .orderKey;
      const hidden = {
        ...ordered[0]!,
        id: ThreadId.make("snoozed"),
        snoozedAt: NOW,
        snoozedUntil: "2099-01-01T00:00:00.000Z",
        pinOrderKey: section === "pinned" ? collision : null,
        activeOrderKey: section === "active" ? collision : null,
      };
      const assignments = createThreadMovePlanner({ ...input, allThreads: [...ordered, hidden] })(
        `${environmentId}:move-0`,
        "down",
      );
      expect(assignments).toHaveLength(1);
      expect(assignments![0]!.orderKey).not.toBe(collision);
      expect(assignments![0]!.orderKey > "dd" && assignments![0]!.orderKey < "ff").toBe(true);
    },
  );

  it("allows an independent keyed move despite an unsupported keyless row elsewhere", () => {
    const ordered = rows("active", [null, null, "bb", "dd", "ff"]);
    const plan = createThreadMovePlanner({
      ordered,
      section: "active",
      reorderableEnvironmentIds: new Set([environmentId]),
    });
    const assignments = plan(`${environmentId}:move-4`, "up");
    expect(assignments).toHaveLength(1);
    expect(assignments![0]!.id).toBe(`${environmentId}:move-4`);
    expect(assignments![0]!.orderKey > "bb").toBe(true);
    expect(assignments![0]!.orderKey < "dd").toBe(true);
  });
});

describe("thread drag destinations", () => {
  it("moves across multiple rows while keeping hidden anchors in place", () => {
    expect(
      threadOrderAfterMove(["a", "hidden", "b", "c"], "c", {
        targetId: "a",
        placement: "before",
      }),
    ).toEqual(["c", "a", "hidden", "b"]);
    expect(
      threadOrderAfterMove(["a", "hidden", "b", "c"], "a", {
        targetId: "b",
        placement: "after",
      }),
    ).toEqual(["hidden", "b", "a", "c"]);
  });

  it("rejects missing, self, and unchanged destinations", () => {
    for (const targetId of ["missing", "a", "b"]) {
      expect(
        threadOrderAfterMove(["a", "b", "c"], "a", {
          targetId,
          placement: "before",
        }),
      ).toBeNull();
    }
    expect(threadOrderAfterMove(["a", "b"], "missing", "down")).toBeNull();
  });

  it.each(["active", "pinned"] as const)(
    "persists a dropped %s row and holds its order until confirmed",
    (section) => {
      const ordered = ["a", "b", "c", "d"].map((id) =>
        makeThread({
          id: ThreadId.make(id),
          title: id,
          pinnedAt: section === "pinned" ? NOW : null,
        }),
      );
      const ids = ordered.map((row) => `${row.environmentId}:${row.id}`);
      const direction = { targetId: ids[0]!, placement: "before" as const };
      const assignments = createThreadMovePlanner({
        ordered,
        section,
        reorderableEnvironmentIds: new Set([environmentId]),
      })(ids[3]!, direction)!;
      const pending = createPendingThreadOrder({
        section,
        ordered,
        movedId: ids[3]!,
        direction,
        assignments,
      });
      expect(pending.orderedIds).toEqual([ids[3], ids[0], ids[1], ids[2]]);
      const confirmed = ordered.map((row) => ({
        ...row,
        [section === "pinned" ? "pinOrderKey" : "activeOrderKey"]: assignments.find(
          (a) => a.id === `${row.environmentId}:${row.id}`,
        )!.orderKey,
      }));
      expect(
        getThreadListV2OrderedSection({ threads: confirmed, section, now: NOW }).map(
          (row) => `${row.environmentId}:${row.id}`,
        ),
      ).toEqual(pending.orderedIds);
      expect(
        reconcilePendingThreadOrder({ ...pending, commandsComplete: true }, confirmed),
      ).toBeNull();
    },
  );

  it("refuses a drop that would need to rewrite an old server's keyless row", () => {
    const old = EnvironmentId.make("old-server");
    const ordered = [environmentId, old, environmentId].map((env, index) =>
      makeThread({
        id: ThreadId.make(String(index)),
        title: String(index),
        environmentId: env,
      }),
    );
    expect(
      createThreadMovePlanner({
        ordered,
        section: "active",
        reorderableEnvironmentIds: new Set([environmentId]),
      })(`${environmentId}:2`, { targetId: `${environmentId}:0`, placement: "before" }),
    ).toBeNull();
  });
});

it("allows a long drop past an old server even when both adjacent moves fail", () => {
  const old = EnvironmentId.make("old-server");
  const ordered = [
    makeThread({ id: ThreadId.make("a"), title: "a" }),
    makeThread({ id: ThreadId.make("b"), title: "b", environmentId: old }),
    makeThread({ id: ThreadId.make("c"), title: "c", activeOrderKey: "h" }),
    makeThread({ id: ThreadId.make("d"), title: "d", activeOrderKey: "p" }),
  ];
  const planner = createThreadMovePlanner({
    ordered,
    section: "active",
    reorderableEnvironmentIds: new Set([environmentId]),
  });
  const movedId = `${environmentId}:a`;
  expect(planner(movedId, "up")).toBeNull();
  expect(planner(movedId, "down")).toBeNull();
  const assignments = planner(movedId, { targetId: `${environmentId}:d`, placement: "after" });
  expect(assignments).toHaveLength(1);
  expect(assignments![0]!.id).toBe(movedId);
  expect(assignments![0]!.orderKey > "p").toBe(true);
});

describe("cross-section thread drops", () => {
  it.each(["pinned", "active"] as const)("inserts into an empty %s section", (section) => {
    const thread = makeThread({ id: ThreadId.make("source"), title: "source" });
    const id = `${thread.environmentId}:${thread.id}`;
    const destination = { section, targetId: null, placement: "before" as const };
    expect(threadOrderAfterMove([], id, destination)).toEqual([id]);
    const plan = createThreadMovePlanner({
      ordered: [],
      allThreads: [thread],
      section,
      reorderableEnvironmentIds: new Set([environmentId]),
    })(id, destination);
    expect(plan).toHaveLength(1);
    expect(plan![0]!.id).toBe(id);
  });
  it("places an incoming row between existing anchors without rewriting them", () => {
    const a = makeThread({ id: ThreadId.make("a"), title: "a", pinOrderKey: "h" });
    const b = makeThread({ id: ThreadId.make("b"), title: "b", pinOrderKey: "z" });
    const source = makeThread({ id: ThreadId.make("source"), title: "source" });
    const id = `${environmentId}:source`;
    const destination = {
      section: "pinned" as const,
      targetId: `${environmentId}:b`,
      placement: "before" as const,
    };
    const plan = createThreadMovePlanner({
      ordered: [a, b],
      allThreads: [a, b, source],
      section: "pinned",
      reorderableEnvironmentIds: new Set([environmentId]),
    })(id, destination);
    expect(plan).toHaveLength(1);
    expect(plan![0]!.orderKey > "h" && plan![0]!.orderKey < "z").toBe(true);
    expect(
      threadOrderAfterMove([`${environmentId}:a`, `${environmentId}:b`], id, destination),
    ).toEqual([`${environmentId}:a`, id, `${environmentId}:b`]);
  });
  it("rejects removed targets and unsupported incoming sources", () => {
    expect(
      threadOrderAfterMove(["a"], "source", {
        section: "active",
        targetId: "gone",
        placement: "before",
      }),
    ).toBeNull();
    const source = makeThread({ id: ThreadId.make("source"), title: "source" });
    expect(
      createThreadMovePlanner({
        ordered: [],
        allThreads: [source],
        section: "active",
        reorderableEnvironmentIds: new Set(),
      })(`${environmentId}:source`, { section: "active", targetId: null, placement: "before" }),
    ).toBeNull();
  });
  it("clears pinning, settlement and snooze when returning a parked thread to Active", () => {
    const thread = makeThread({
      id: ThreadId.make("parked"),
      title: "parked",
      pinnedAt: NOW,
      settledOverride: "settled",
      snoozedAt: NOW,
      snoozedUntil: "2099-01-01T00:00:00.000Z",
    });
    expect(threadDropLifecycle(thread, "active", NOW)).toEqual({
      pin: false,
      unpin: true,
      unsettle: true,
      unsnooze: true,
    });
    expect(threadDropLifecycle(thread, "pinned", NOW)).toEqual({
      pin: true,
      unpin: false,
      unsettle: false,
      unsnooze: false,
    });
  });
  it("does not send lifecycle commands for an ordinary Active reorder", () => {
    expect(
      threadDropLifecycle(
        makeThread({ id: ThreadId.make("active"), title: "active" }),
        "active",
        NOW,
      ),
    ).toEqual({ pin: false, unpin: false, unsettle: false, unsnooze: false });
  });
});

/* ─── Recycled-list equality + per-row clock scoping ─────────────────── */

const BASE_MS = Date.parse(NOW);
const isoAt = (ms: number) => new Date(ms).toISOString();
const MINUTE_MS = 60_000;

function runningSession(threadId: string) {
  return {
    threadId: ThreadId.make(threadId),
    status: "running" as const,
    providerName: "Codex",
    providerInstanceId: ProviderInstanceId.make("codex"),
    runtimeMode: "full-access" as const,
    activeTurnId: null,
    lastError: null,
    updatedAt: NOW,
  };
}

function buildTickThreads() {
  return {
    ready: makeThread({
      id: ThreadId.make("tick-ready"),
      title: "tick ready",
      latestUserMessageAt: isoAt(BASE_MS - 5 * MINUTE_MS),
    }),
    approval: makeThread({
      id: ThreadId.make("tick-approval"),
      title: "tick approval",
      hasPendingApprovals: true,
      latestUserMessageAt: isoAt(BASE_MS - 5 * MINUTE_MS),
    }),
    settled: makeThread({
      id: ThreadId.make("tick-settled"),
      title: "tick settled",
      settledOverride: "settled",
      settledAt: isoAt(BASE_MS - 3 * 24 * 60 * MINUTE_MS),
    }),
    snoozed: makeThread({
      id: ThreadId.make("tick-snoozed"),
      title: "tick snoozed",
      snoozedAt: isoAt(BASE_MS - MINUTE_MS),
      snoozedUntil: isoAt(BASE_MS + 2 * 60 * MINUTE_MS),
    }),
  };
}

function buildTickList(
  threads: ReadonlyArray<EnvironmentThreadShell>,
  clockMs: number,
  pendingTasks: ReadonlyArray<PendingNewTask>,
  options?: {
    readonly snoozeEnvironmentIds?: ReadonlySet<EnvironmentId>;
    readonly queuedThreadKeys?: ReadonlySet<string>;
    readonly moveAvailability?: ReadonlyMap<string, ThreadMoveAvailability>;
    readonly shelfPreferencesLoading?: boolean;
  },
): ThreadListV2ListItem[] {
  const now = isoAt(clockMs);
  const layout = buildThreadListV2Items({
    threads,
    environmentId: null,
    searchQuery: "",
    now,
    snoozedShelfExpanded: true,
  });
  return buildThreadListV2ListItems({
    items: layout.items,
    pendingTasks,
    snoozedCount: layout.snoozedCount,
    snoozedShelfExpanded: true,
    snoozedShelfHeaderIndex: layout.snoozedShelfHeaderIndex,
    settledCount: layout.settledCount,
    settledShelfHeaderIndex: layout.settledShelfHeaderIndex,
    snoozeLabelNow: now,
    ...(options?.snoozeEnvironmentIds
      ? { snoozeEnvironmentIds: options.snoozeEnvironmentIds }
      : {}),
    ...(options?.queuedThreadKeys ? { queuedThreadKeys: options.queuedThreadKeys } : {}),
    ...(options?.moveAvailability ? { moveAvailability: options.moveAvailability } : {}),
    ...(options?.shelfPreferencesLoading !== undefined
      ? { shelfPreferencesLoading: options.shelfPreferencesLoading }
      : {}),
  });
}

function itemsByThreadKey(items: ReadonlyArray<ThreadListV2ListItem>) {
  const byKey = new Map<string, ThreadListV2ListItem>();
  for (const item of items) byKey.set(item.key, item);
  return byKey;
}

describe("threadListV2ListItemsAreEqual", () => {
  const thread = makeThread({
    id: ThreadId.make("eq"),
    title: "eq",
    latestUserMessageAt: isoAt(BASE_MS - 5 * MINUTE_MS),
  });
  const layout = buildThreadListV2Items({
    threads: [thread],
    environmentId: null,
    searchQuery: "",
    now: NOW,
  });
  // One queued task object shared across builds: identity, not content, is
  // what the row equality compares (mirrors the store's stable references).
  const queued = makePendingTask("eq-queued");
  const build = () =>
    buildThreadListV2ListItems({
      items: layout.items,
      pendingTasks: [queued],
      snoozeLabelNow: NOW,
    });

  it("treats rebuilt wrappers over identical rows as equal", () => {
    const first = build();
    const second = build();
    expect(first.length).toBe(second.length);
    for (let index = 0; index < first.length; index += 1) {
      expect(first[index]).not.toBe(second[index]);
      expect(threadListV2ListItemsAreEqual(first[index]!, second[index]!)).toBe(true);
    }
  });

  it("notices a replaced thread shell", () => {
    const replacement = makeThread({ id: ThreadId.make("eq"), title: "renamed" });
    const rebuilt = buildThreadListV2Items({
      threads: [replacement],
      environmentId: null,
      searchQuery: "",
      now: NOW,
    });
    const next = buildThreadListV2ListItems({
      items: rebuilt.items,
      pendingTasks: [],
      snoozeLabelNow: NOW,
    });
    const previousThread = build().find((item) => item.type === "v2-thread")!;
    const nextThread = next.find((item) => item.type === "v2-thread")!;
    expect(threadListV2ListItemsAreEqual(previousThread, nextThread)).toBe(false);
  });

  it("notices a changed wake countdown label", () => {
    const snoozedLayout = buildThreadListV2Items({
      threads: [
        makeThread({
          id: ThreadId.make("wake"),
          title: "wake",
          snoozedAt: NOW,
          snoozedUntil: isoAt(BASE_MS + 61 * MINUTE_MS),
        }),
      ],
      environmentId: null,
      searchQuery: "",
      now: NOW,
      snoozedShelfExpanded: true,
    });
    const earlier = buildThreadListV2ListItems({
      items: snoozedLayout.items,
      pendingTasks: [],
      snoozedShelfExpanded: true,
      snoozeLabelNow: NOW,
    });
    const later = buildThreadListV2ListItems({
      items: snoozedLayout.items,
      pendingTasks: [],
      snoozedShelfExpanded: true,
      snoozeLabelNow: isoAt(BASE_MS + MINUTE_MS),
    });
    const rows = (items: ThreadListV2ListItem[]) => {
      const row = items.find((item) => item.key === `v2-thread:${environmentId}:wake`);
      expect(row?.type).toBe("v2-thread");
      if (row?.type !== "v2-thread") throw new Error("missing snoozed row");
      return row;
    };
    expect(rows(earlier).snoozeWakeLabelText).toBe("2h");
    expect(rows(later).snoozeWakeLabelText).toBe("1h");
    expect(threadListV2ListItemsAreEqual(rows(earlier), rows(later))).toBe(false);
  });

  it("notices shelf count, expansion, and loading-disabled changes", () => {
    const shelf = {
      type: "v2-settled-shelf",
      key: "v2-settled-shelf",
      count: 2,
      expanded: true,
      disabled: false,
    } as const;
    expect(threadListV2ListItemsAreEqual(shelf, { ...shelf })).toBe(true);
    expect(threadListV2ListItemsAreEqual(shelf, { ...shelf, count: 3 })).toBe(false);
    expect(threadListV2ListItemsAreEqual(shelf, { ...shelf, expanded: false })).toBe(false);
    // A recycled cell ignores the render closure, so the shelf header's
    // preference-loading disabled state has to ride on the item too.
    expect(threadListV2ListItemsAreEqual(shelf, { ...shelf, disabled: true })).toBe(false);
  });

  it("treats different item kinds as unequal", () => {
    const built = build();
    const threadItem = built.find((item) => item.type === "v2-thread")!;
    const pendingItem = built.find((item) => item.type === "v2-pending")!;
    expect(threadListV2ListItemsAreEqual(threadItem, pendingItem)).toBe(false);
  });

  it("notices a trailing-divider flip caused by a neighbour change", () => {
    const threadA = makeThread({ id: ThreadId.make("flip-a"), title: "flip a" });
    const threadB = makeThread({ id: ThreadId.make("flip-b"), title: "flip b" });
    const bare = buildThreadListV2ListItems({
      items: buildThreadListV2Items({
        threads: [threadA, threadB],
        environmentId: null,
        searchQuery: "",
        now: NOW,
      }).items,
      pendingTasks: [],
      snoozeLabelNow: NOW,
    });
    // The same shells with B settled: A now sits above the Settled section
    // rule instead of another row, so A's hairline must flip through the
    // recycled equality — its own shell reference never changed.
    const settledB = makeThread({
      id: ThreadId.make("flip-b"),
      title: "flip b",
      settledOverride: "settled",
      settledAt: NOW,
    });
    const withSettled = buildThreadListV2ListItems({
      items: buildThreadListV2Items({
        threads: [threadA, settledB],
        environmentId: null,
        searchQuery: "",
        now: NOW,
      }).items,
      pendingTasks: [],
      settledCount: 1,
      settledShelfHeaderIndex: 1,
      snoozeLabelNow: NOW,
    });
    const firstA = bare[0]!;
    const secondA = withSettled[0]!;
    expect(firstA.type === "v2-thread" && firstA.showTrailingDivider).toBe(true);
    expect(secondA.type === "v2-thread" && secondA.showTrailingDivider).toBe(false);
    expect(threadListV2ListItemsAreEqual(firstA, secondA)).toBe(false);
  });
});

describe("isThreadListV2ListItem", () => {
  it("narrows the v2 kinds and rejects the legacy discriminators", () => {
    expect(isThreadListV2ListItem({ type: "v2-thread" })).toBe(true);
    expect(isThreadListV2ListItem({ type: "v2-pending" })).toBe(true);
    expect(isThreadListV2ListItem({ type: "v2-snoozed-shelf" })).toBe(true);
    expect(isThreadListV2ListItem({ type: "v2-settled-shelf" })).toBe(true);
    expect(isThreadListV2ListItem({ type: "thread" })).toBe(false);
    expect(isThreadListV2ListItem({ type: "v2-show-more" })).toBe(false);
  });
});

describe("buildThreadListV2ListItems clock scoping", () => {
  const allEnvironments = new Set<EnvironmentId>([environmentId]);
  const tickQueued = () => [makePendingTask("tick-queued")];

  it("carries the snooze menu clock on every row whose swipe menu offers presets", () => {
    const threads = buildTickThreads();
    const items = buildTickList(Object.values(threads), BASE_MS, tickQueued(), {
      snoozeEnvironmentIds: allEnvironments,
    });
    const byKey = itemsByThreadKey(items);
    const ready = byKey.get(`v2-thread:${environmentId}:tick-ready`)!;
    const approval = byKey.get(`v2-thread:${environmentId}:tick-approval`)!;
    const settled = byKey.get(`v2-thread:${environmentId}:tick-settled`)!;
    const snoozed = byKey.get(`v2-thread:${environmentId}:tick-snoozed`)!;
    expect(ready.type === "v2-thread" && ready.snoozePresetMinute).toBe(NOW);
    // The swipe-revealed snooze action exists on slim rows too (the variant
    // only swaps the primary action), so settled rows need the fresh clock.
    expect(settled.type === "v2-thread" && settled.snoozePresetMinute).toBe(NOW);
    // Approval rows are never snoozable; snoozed rows only offer Wake.
    expect(approval.type === "v2-thread" && approval.snoozePresetMinute).toBeUndefined();
    expect(snoozed.type === "v2-thread" && snoozed.snoozePresetMinute).toBeUndefined();
  });

  it("keeps the snooze menu clock off rows on servers without the capability", () => {
    const threads = buildTickThreads();
    const items = buildTickList([threads.ready], BASE_MS, [], {
      snoozeEnvironmentIds: new Set<EnvironmentId>(),
    });
    const ready = items.find((item) => item.type === "v2-thread")!;
    expect(ready.type === "v2-thread" && ready.snoozePresetMinute).toBeUndefined();
  });

  it("blanks the precomputed time for rows that render a label instead", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(BASE_MS);
      const working = makeThread({
        id: ThreadId.make("tick-working"),
        title: "tick working",
        latestUserMessageAt: isoAt(BASE_MS - 5 * MINUTE_MS),
        session: runningSession("tick-working"),
      });
      const threads = buildTickThreads();
      const items = buildTickList(
        [threads.ready, working, threads.settled, threads.snoozed],
        BASE_MS,
        tickQueued(),
      );
      const byKey = itemsByThreadKey(items);
      const label = (key: string) => {
        const item = byKey.get(key)!;
        return item.type === "v2-thread" ? item.timeLabel : "<shelf>";
      };
      // Ready cards and settled/snoozed slim rows draw a time; the wake
      // countdown outranks the time on snoozed rows; cards with a status
      // label never draw one.
      expect(label(`v2-thread:${environmentId}:tick-ready`)).toBe("5m");
      expect(label(`v2-thread:${environmentId}:tick-working`)).toBe("");
      expect(label(`v2-thread:${environmentId}:tick-settled`)).toBe("3d");
      expect(label(`v2-thread:${environmentId}:tick-snoozed`)).toBe("");
      const snoozed = byKey.get(`v2-thread:${environmentId}:tick-snoozed`)!;
      expect(snoozed.type === "v2-thread" && snoozed.snoozeWakeLabelText).toBe("2h");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("thread list v2 minute tick invalidation", () => {
  it("only invalidates rows whose clock-driven content moved", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(BASE_MS);
      const threads = buildTickThreads();
      const shellOrder = [threads.ready, threads.approval, threads.settled, threads.snoozed];
      // One queued-task reference shared by both builds: the store hands the
      // list the same pending-task objects between rebuilds.
      const pendingTasks = [makePendingTask("tick-queued")];
      const atStart = buildTickList(shellOrder, BASE_MS, pendingTasks);
      vi.setSystemTime(BASE_MS + MINUTE_MS);
      const atNextMinute = buildTickList(shellOrder, BASE_MS + MINUTE_MS, pendingTasks);

      expect(atStart.length).toBe(atNextMinute.length);
      const invalidated: string[] = [];
      for (let index = 0; index < atStart.length; index += 1) {
        if (!threadListV2ListItemsAreEqual(atStart[index]!, atNextMinute[index]!)) {
          invalidated.push(atStart[index]!.key);
        }
      }
      // The ready row draws a minute-granular time and carries the snooze
      // menu, and the settled slim row's swipe-revealed snooze menu shows
      // preset times too, so both rows' menu content moved. Every other row
      // — the approval card (status label, never snoozable), the snoozed
      // shelf row ("2h" unchanged, Wake only), the shelf headers, and the
      // queued row — survives the tick untouched.
      expect(invalidated).toEqual([
        `v2-thread:${environmentId}:tick-ready`,
        `v2-thread:${environmentId}:tick-settled`,
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps hour-granularity rows stable across a minute tick when they carry no snooze menu", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(BASE_MS);
      const staleReady = makeThread({
        id: ThreadId.make("tick-stale"),
        title: "tick stale",
        latestUserMessageAt: isoAt(BASE_MS - 3 * 60 * MINUTE_MS),
      });
      const atStart = buildTickList([staleReady], BASE_MS, [], {
        snoozeEnvironmentIds: new Set<EnvironmentId>(),
      });
      vi.setSystemTime(BASE_MS + MINUTE_MS);
      const atNextMinute = buildTickList([staleReady], BASE_MS + MINUTE_MS, [], {
        snoozeEnvironmentIds: new Set<EnvironmentId>(),
      });
      expect(threadListV2ListItemsAreEqual(atStart[0]!, atNextMinute[0]!)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("re-renders the snoozed countdown row when the wake label advances", () => {
    vi.useFakeTimers();
    try {
      const wakeAt = BASE_MS + 120 * MINUTE_MS;
      const snoozed = makeThread({
        id: ThreadId.make("tick-wake"),
        title: "tick wake",
        snoozedAt: isoAt(BASE_MS - MINUTE_MS),
        snoozedUntil: isoAt(wakeAt),
      });
      const wakeKey = `v2-thread:${environmentId}:tick-wake`;
      const wakeRow = (items: ThreadListV2ListItem[]) => itemsByThreadKey(items).get(wakeKey)!;
      vi.setSystemTime(BASE_MS);
      const atStart = buildTickList([snoozed], BASE_MS, []);
      vi.setSystemTime(BASE_MS + MINUTE_MS);
      const stillTwoHours = buildTickList([snoozed], BASE_MS + MINUTE_MS, []);
      expect(threadListV2ListItemsAreEqual(wakeRow(atStart), wakeRow(stillTwoHours))).toBe(true);
      // Minutes round up, so the countdown holds "2h" until the remaining
      // time drops to the hour boundary — and only that row flips when it
      // finally moves to minute granularity.
      vi.setSystemTime(BASE_MS + 61 * MINUTE_MS);
      const oneHour = buildTickList([snoozed], BASE_MS + 61 * MINUTE_MS, []);
      const oneHourRow = wakeRow(oneHour);
      expect(oneHourRow.type).toBe("v2-thread");
      expect(oneHourRow.type === "v2-thread" && oneHourRow.snoozeWakeLabelText).toBe("59m");
      expect(threadListV2ListItemsAreEqual(wakeRow(stillTwoHours), wakeRow(oneHour))).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("buildThreadListV2ListItems trailing dividers", () => {
  it("follows the final neighbour order, not the pre-splice blocks", () => {
    const activeA = makeThread({ id: ThreadId.make("div-a"), title: "a" });
    const activeB = makeThread({ id: ThreadId.make("div-b"), title: "b" });
    const layout = buildThreadListV2Items({
      threads: [activeA, activeB],
      environmentId: null,
      searchQuery: "",
      now: NOW,
    });
    const items = buildThreadListV2ListItems({
      items: layout.items,
      pendingTasks: [makePendingTask("div-q1"), makePendingTask("div-q2")],
      snoozeLabelNow: NOW,
    });
    const dividers = items.map((item) =>
      item.type === "v2-thread" || item.type === "v2-pending" ? item.showTrailingDivider : "n/a",
    );
    // thread A | thread B | queued 1 | queued 2: consecutive threads keep
    // their hairlines, the row before the Unsent section rule loses its own,
    // queued rows divide each other, and the last row has nothing under it.
    expect(dividers).toEqual([true, false, true, false]);
  });
});

describe("buildThreadListV2ListItems row-state stamps", () => {
  const readyThread = makeThread({
    id: ThreadId.make("stamp-ready"),
    title: "stamp ready",
    latestUserMessageAt: isoAt(BASE_MS - 5 * MINUTE_MS),
  });
  const settledThread = makeThread({
    id: ThreadId.make("stamp-settled"),
    title: "stamp settled",
    settledOverride: "settled",
    settledAt: isoAt(BASE_MS - 3 * 24 * 60 * MINUTE_MS),
  });
  const allEnvironments = new Set<EnvironmentId>([environmentId]);

  it("stamps queued outbox messages onto the matching row and notices removal", () => {
    // An outbox write never touches the thread shell, so the queued icon has
    // to ride on the item for the recycled cell to ever update it.
    const queued = buildTickList([readyThread, settledThread], BASE_MS, [], {
      queuedThreadKeys: new Set([`${environmentId}:stamp-ready`]),
      snoozeEnvironmentIds: allEnvironments,
    });
    const plain = buildTickList([readyThread, settledThread], BASE_MS, [], {
      queuedThreadKeys: new Set<string>(),
      snoozeEnvironmentIds: allEnvironments,
    });
    const byKey = (items: ThreadListV2ListItem[]) => itemsByThreadKey(items);
    const readyQueued = byKey(queued).get(`v2-thread:${environmentId}:stamp-ready`)!;
    const readyPlain = byKey(plain).get(`v2-thread:${environmentId}:stamp-ready`)!;
    const settledQueued = byKey(queued).get(`v2-thread:${environmentId}:stamp-settled`)!;
    const settledPlain = byKey(plain).get(`v2-thread:${environmentId}:stamp-settled`)!;
    expect(readyQueued.type === "v2-thread" && readyQueued.hasQueuedMessages).toBe(true);
    expect(readyPlain.type === "v2-thread" && readyPlain.hasQueuedMessages).toBe(false);
    expect(threadListV2ListItemsAreEqual(readyQueued, readyPlain)).toBe(false);
    // The neighbour row is untouched by the outbox change.
    expect(threadListV2ListItemsAreEqual(settledQueued, settledPlain)).toBe(true);
  });

  it("notices move-availability changes on card rows without a shell update", () => {
    const permissive = new Map([
      [`${environmentId}:stamp-ready`, { canMoveUp: true, canMoveDown: true }],
      [`${environmentId}:stamp-settled`, { canMoveUp: true, canMoveDown: true }],
    ]);
    const blocked = new Map([
      [`${environmentId}:stamp-settled`, { canMoveUp: true, canMoveDown: true }],
    ]);
    const open = buildTickList([readyThread, settledThread], BASE_MS, [], {
      moveAvailability: permissive,
      snoozeEnvironmentIds: allEnvironments,
    });
    const closed = buildTickList([readyThread, settledThread], BASE_MS, [], {
      moveAvailability: blocked,
      snoozeEnvironmentIds: allEnvironments,
    });
    const readyOpen = itemsByThreadKey(open).get(`v2-thread:${environmentId}:stamp-ready`)!;
    const readyClosed = itemsByThreadKey(closed).get(`v2-thread:${environmentId}:stamp-ready`)!;
    expect(readyOpen.type === "v2-thread" && readyOpen.canMoveUp).toBe(true);
    expect(readyClosed.type === "v2-thread" && readyClosed.canMoveUp).toBe(false);
    expect(threadListV2ListItemsAreEqual(readyOpen, readyClosed)).toBe(false);
    // Slim rows never carry the move actions, so availability is inert there.
    const settledOpen = itemsByThreadKey(open).get(`v2-thread:${environmentId}:stamp-settled`)!;
    const settledClosed = itemsByThreadKey(closed).get(`v2-thread:${environmentId}:stamp-settled`)!;
    expect(settledOpen.type === "v2-thread" && settledOpen.canMoveUp).toBe(false);
    expect(threadListV2ListItemsAreEqual(settledOpen, settledClosed)).toBe(true);
  });

  it("keeps the settled slim row's swipe snooze menu fresh across a tick", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(BASE_MS);
      const atStart = buildTickList([settledThread], BASE_MS, [], {
        snoozeEnvironmentIds: allEnvironments,
      });
      vi.setSystemTime(BASE_MS + MINUTE_MS);
      const atNextMinute = buildTickList([settledThread], BASE_MS + MINUTE_MS, [], {
        snoozeEnvironmentIds: allEnvironments,
      });
      const rowAtStart = atStart.find((item) => item.type === "v2-thread")!;
      const rowAtNext = atNextMinute.find((item) => item.type === "v2-thread")!;
      // The swipe-revealed secondary action carries the snooze preset menu on
      // slim rows; its minute clock must move, or the displayed wake times
      // drift while the row is recycled-stable.
      expect(rowAtStart.type === "v2-thread" && rowAtStart.item.variant).toBe("slim");
      expect(rowAtStart.type === "v2-thread" && rowAtStart.snoozePresetMinute).toBe(isoAt(BASE_MS));
      expect(rowAtNext.type === "v2-thread" && rowAtNext.snoozePresetMinute).toBe(
        isoAt(BASE_MS + MINUTE_MS),
      );
      expect(threadListV2ListItemsAreEqual(rowAtStart, rowAtNext)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("stamps the shelf loading-disabled state so recycled headers refresh", () => {
    const loading = buildTickList([settledThread], BASE_MS, [], {
      shelfPreferencesLoading: true,
      snoozeEnvironmentIds: allEnvironments,
    });
    const loaded = buildTickList([settledThread], BASE_MS, [], {
      shelfPreferencesLoading: false,
      snoozeEnvironmentIds: allEnvironments,
    });
    const shelfLoading = loading.find((item) => item.type === "v2-settled-shelf")!;
    const shelfLoaded = loaded.find((item) => item.type === "v2-settled-shelf")!;
    expect(shelfLoading.type === "v2-settled-shelf" && shelfLoading.disabled).toBe(true);
    expect(shelfLoaded.type === "v2-settled-shelf" && shelfLoaded.disabled).toBe(false);
    expect(threadListV2ListItemsAreEqual(shelfLoading, shelfLoaded)).toBe(false);
  });
});
