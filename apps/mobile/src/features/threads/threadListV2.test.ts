import { buildMobileTaskListItems } from "./taskList";
import { planMobileTaskMove } from "./taskOrder";
import { taskOrderRow, threadOrderRow } from "@t3tools/client-runtime/state/task-grouping";
import type { EnvironmentTask } from "@t3tools/client-runtime/state/tasks";
import { planPinnedMove } from "@t3tools/client-runtime/state/thread-sort";
import {
  createPendingThreadOrder,
  createThreadMovePlanner,
  threadOrderAfterMove,
  threadDropLifecycle,
  reconcilePendingThreadOrder,
  type PendingThreadOrder,
} from "./threadOrder";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { threadSearchMatchKey } from "@t3tools/client-runtime/state/thread-search";
import {
  resolveSnoozePresets,
  snoozeWakeLabel,
} from "@t3tools/client-runtime/state/thread-settled";
import {
  CommandId,
  EnvironmentId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TaskId,
  TurnId,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { PendingNewTask } from "../../state/use-pending-new-tasks";
import {
  buildThreadListV2Items,
  buildThreadListV2ListItems,
  getThreadListV2OrderedSection,
  resolveThreadListV2Enabled,
  resolveThreadListV2SnoozeMenuSelection,
  resolveThreadListV2SnoozeGateExpiryMs,
  resolveThreadListV2Status,
  resolveThreadListV2SwipeActions,
  sortThreadsForListV2,
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

describe("resolveThreadListV2Enabled", () => {
  it("defaults on when the device has never chosen", () => {
    expect(
      resolveThreadListV2Enabled({ legacyPreference: undefined, preferencesLoaded: true }),
    ).toBe(true);
  });

  it("honors an explicit legacy opt-in", () => {
    expect(resolveThreadListV2Enabled({ legacyPreference: true, preferencesLoaded: true })).toBe(
      false,
    );
    expect(resolveThreadListV2Enabled({ legacyPreference: false, preferencesLoaded: true })).toBe(
      true,
    );
  });

  it("holds the default while preferences are still loading so the list does not remount", () => {
    expect(
      resolveThreadListV2Enabled({ legacyPreference: undefined, preferencesLoaded: false }),
    ).toBe(true);
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
    taskId: null,
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

function makeContainer(overrides: Partial<EnvironmentTask> = {}): EnvironmentTask {
  return {
    environmentId,
    id: TaskId.make("task-1"),
    name: "Task One",
    description: null,
    primaryProjectId: ProjectId.make("project-1"),
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    unsettledAt: null,
    snoozedUntil: null,
    snoozedAt: null,
    pinnedAt: null,
    pinOrderKey: null,
    activeOrderKey: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}
function taskListFixture(overrides: Partial<Parameters<typeof buildMobileTaskListItems>[0]> = {}) {
  const task = makeContainer();
  const threads = [
    makeThread({ id: ThreadId.make("member"), title: "Member", taskId: task.id }),
    makeThread({ id: ThreadId.make("loose"), title: "Loose" }),
  ];
  return {
    tasks: [task],
    projects: [],
    threads,
    pendingTasks: [],
    capableIds: new Set([environmentId]),
    collapsedTaskKeys: new Set<string>(),
    expandedTaskShelfKeys: new Set<string>(),
    environmentId: null,
    projectScoped: false,
    searchQuery: "",
    queuedThreadKeys: new Set<string>(),
    now: NOW,
    ...overrides,
  };
}

describe("native task groups", () => {
  it("keeps collapsed members inside a task and selected or searched members reachable", () => {
    const base = taskListFixture({ collapsedTaskKeys: new Set([`${environmentId}:task-1`]) });
    const collapsed = buildMobileTaskListItems(base).items;
    expect(collapsed.map((item) => item.key)).not.toContain(`v2-thread:${environmentId}:member`);
    expect(collapsed.some((item) => item.type === "task-card")).toBe(true);
    for (const extra of [
      { selectedThreadKey: `${environmentId}:member` },
      { searchQuery: "Member" },
    ]) {
      expect(
        buildMobileTaskListItems({ ...base, ...extra }).items.map((item) => item.key),
      ).toContain(`v2-thread:${environmentId}:member`);
    }
  });
  it("retains flat rows for project scopes, unsupported servers and unresolved parents", () => {
    for (const overrides of [
      { projectScoped: true },
      { capableIds: new Set<EnvironmentId>() },
      { tasks: [] },
    ]) {
      const rows = buildMobileTaskListItems(taskListFixture(overrides)).items;
      expect(rows.some((item) => item.type === "task-card")).toBe(false);
      expect(rows.map((item) => item.key)).toContain(`v2-thread:${environmentId}:member`);
    }
  });
  it("keeps queued creation within a parked task without overriding saved collapse", () => {
    const task = makeContainer({ settledOverride: "settled" });
    const pending = { ...makePendingTask("queued"), taskId: task.id };
    const threads = [
      makeThread({
        id: ThreadId.make("settled-member"),
        title: "Settled member",
        taskId: task.id,
        settledOverride: "settled",
        settledAt: NOW,
      }),
    ];
    const rows = buildMobileTaskListItems(
      taskListFixture({
        tasks: [task],
        threads,
        pendingTasks: [pending],
        collapsedTaskKeys: new Set([`${environmentId}:${task.id}`]),
      }),
    ).items;
    expect(rows.map((item) => item.type)).toEqual(["task-card", "v2-pending"]);
    expect(rows.filter((item) => item.type === "v2-pending")).toHaveLength(1);
  });
  it("defaults parked tasks to slim collapsed rows and wakes at the exact clock boundary", () => {
    const task = makeContainer({ snoozedUntil: "2026-06-12T09:30:20.000Z" });
    const base = taskListFixture({ tasks: [task], now: "2026-06-12T09:30:19.000Z" });
    const parked = buildMobileTaskListItems({ ...base, snoozedShelfExpanded: true }).items.find(
      (item) => item.type === "task-slim",
    );
    expect(parked?.type === "task-slim" && parked.expanded).toBe(false);
    const awakened = buildMobileTaskListItems({ ...base, now: "2026-06-12T09:30:20.000Z" }).items;
    expect(awakened.some((item) => item.type === "task-card")).toBe(true);
  });
  it("isolates identical task IDs across environments", () => {
    const otherId = EnvironmentId.make("other");
    const base = taskListFixture();
    const foreign = makeContainer({ environmentId: otherId });
    const rows = buildMobileTaskListItems({
      ...base,
      tasks: [...base.tasks, foreign],
      capableIds: new Set([environmentId, otherId]),
      environmentId: otherId,
    }).items;
    expect(rows.filter((item) => item.type === "task-card").map((item) => item.key)).toEqual([
      `task:${otherId}:task-1`,
    ]);
  });
});

describe("native task arrangement", () => {
  it("plans mixed task/thread keys while reserving hidden parked keys", () => {
    const task = makeContainer({ createdAt: "2026-06-02T00:00:00.000Z", activeOrderKey: "a1" });
    const thread = makeThread({ id: ThreadId.make("loose"), title: "Loose", activeOrderKey: "a0" });
    const hidden = makeContainer({
      id: TaskId.make("hidden"),
      activeOrderKey: "a2",
      settledOverride: "settled",
    });
    const plan = planMobileTaskMove({
      tasks: [task, hidden],
      threads: [thread],
      moved: taskOrderRow(task),
      destination: "up",
      capableIds: new Set([environmentId]),
      writableTaskIds: new Set([environmentId]),
      writableThreadIds: new Set([environmentId]),
      now: NOW,
      queued: new Set(),
    });
    expect(
      plan?.assignments.some((item) => item.kind === "task" && item.ref.taskId === task.id),
    ).toBe(true);
    expect(plan?.assignments.every((item) => item.orderKey !== "a2")).toBe(true);
  });
  it("limits member moves to siblings and rejects pinning a member", () => {
    const task = makeContainer();
    const first = makeThread({
      id: ThreadId.make("first"),
      title: "First",
      taskId: task.id,
      activeOrderKey: "a0",
    });
    const second = makeThread({
      id: ThreadId.make("second"),
      title: "Second",
      taskId: task.id,
      activeOrderKey: "a1",
    });
    const loose = makeThread({ id: ThreadId.make("loose"), title: "Loose" });
    const input = {
      tasks: [task],
      threads: [first, second, loose],
      moved: threadOrderRow(second),
      capableIds: new Set([environmentId]),
      writableTaskIds: new Set([environmentId]),
      writableThreadIds: new Set([environmentId]),
      now: NOW,
      queued: new Set<string>(),
    };
    const plan = planMobileTaskMove({ ...input, destination: "up" });
    expect(
      plan?.assignments.every((item) => item.kind === "thread" && item.ref.threadId !== loose.id),
    ).toBe(true);
    expect(
      planMobileTaskMove({
        ...input,
        destination: { section: "pinned", targetId: null, placement: "before" },
      }),
    ).toBeNull();
    expect(
      planMobileTaskMove({
        ...input,
        destination: { targetId: threadOrderRow(loose).id, placement: "before" },
      }),
    ).toBeNull();
  });
});

describe("native task shelf inventory", () => {
  const taskKey = `${environmentId}:task-1`;
  const future = "2026-06-13T12:00:00.000Z";
  const member = (id: string, overrides: Partial<EnvironmentThreadShell> = {}) =>
    makeThread({
      id: ThreadId.make(id),
      title: id,
      taskId: TaskId.make("task-1"),
      ...overrides,
    });
  const keys = (layout: ReturnType<typeof buildMobileTaskListItems>) =>
    layout.items.map((item) => item.key);

  it("interleaves pinned and active task/thread units in shared order", () => {
    const layout = buildMobileTaskListItems(
      taskListFixture({
        tasks: [
          makeContainer({ pinnedAt: NOW, pinOrderKey: "b" }),
          makeContainer({ id: TaskId.make("active-task"), activeOrderKey: "b" }),
        ],
        threads: [
          member("pinned", { taskId: null, pinnedAt: NOW, pinOrderKey: "a" }),
          member("active", { taskId: null, activeOrderKey: "a" }),
        ],
        collapsedTaskKeys: new Set([taskKey, `${environmentId}:active-task`]),
      }),
    );
    expect(keys(layout)).toEqual([
      `v2-thread:${environmentId}:pinned`,
      `task:${taskKey}`,
      `v2-thread:${environmentId}:active`,
      `task:${environmentId}:active-task`,
    ]);
    expect(layout.counts).toEqual({ pinned: 2, active: 2, snoozed: 0, settled: 0 });
  });

  it("shows a task-only Snoozed shelf and sorts wake times before scoped identities", () => {
    const base = taskListFixture({
      threads: [],
      tasks: [
        makeContainer({ snoozedUntil: future }),
        makeContainer({ id: TaskId.make("earlier"), snoozedUntil: "2026-06-13T11:00:00.000Z" }),
      ],
    });
    expect(keys(buildMobileTaskListItems(base))).toEqual(["v2-snoozed-shelf"]);
    const layout = buildMobileTaskListItems({ ...base, snoozedShelfExpanded: true });
    expect(keys(layout)).toEqual([
      "v2-snoozed-shelf",
      `task:${environmentId}:earlier`,
      `task:${taskKey}`,
    ]);
    expect(layout.counts.snoozed).toBe(2);
    expect(layout.nextSnoozeWakeAt).toBe("2026-06-13T11:00:00.000Z");
  });

  it("counts mixed task/thread shelves before collapse and top-level pagination", () => {
    const base = taskListFixture({
      tasks: [
        makeContainer({ snoozedUntil: future }),
        makeContainer({
          id: TaskId.make("settled-task"),
          settledOverride: "settled",
          settledAt: NOW,
        }),
      ],
      threads: [
        member("live"),
        member("snoozed-thread", { taskId: null, snoozedUntil: future }),
        member("settled-thread", {
          taskId: null,
          settledOverride: "settled",
          settledAt: "2026-06-01T00:00:00.000Z",
        }),
      ],
      snoozedShelfExpanded: false,
      settledShelfExpanded: false,
      settledLimit: 1,
    });
    const collapsed = buildMobileTaskListItems(base);
    expect(keys(collapsed)).toEqual(["v2-snoozed-shelf", "v2-settled-shelf"]);
    expect(collapsed.counts).toEqual({ pinned: 0, active: 0, snoozed: 2, settled: 2 });
    expect(collapsed.hiddenSettledCount).toBe(1);
    const expanded = buildMobileTaskListItems({
      ...base,
      snoozedShelfExpanded: true,
      settledShelfExpanded: true,
    });
    expect(keys(expanded)).toEqual([
      "v2-snoozed-shelf",
      `task:${taskKey}`,
      `v2-thread:${environmentId}:snoozed-thread`,
      "v2-settled-shelf",
      `task:${environmentId}:settled-task`,
    ]);
    const more = buildMobileTaskListItems({
      ...base,
      snoozedShelfExpanded: true,
      settledShelfExpanded: true,
      settledLimit: 2,
    });
    expect(keys(more).at(-1)).toBe(`v2-thread:${environmentId}:settled-thread`);
    expect(more.hiddenSettledCount).toBe(0);
  });

  it("renders task-only shelf headers and expands parked members as slim rows without consuming page slots", () => {
    const base = taskListFixture({
      tasks: [
        makeContainer({ settledOverride: "settled", settledAt: NOW }),
        makeContainer({
          id: TaskId.make("older"),
          settledOverride: "settled",
          settledAt: "2026-06-01T00:00:00.000Z",
        }),
      ],
      threads: [
        member("live"),
        member("snoozed", { snoozedUntil: future }),
        member("settled", { settledOverride: "settled" }),
      ],
      collapsedTaskKeys: new Set([`parked:${taskKey}`]),
      settledShelfExpanded: true,
      settledLimit: 1,
    });
    const layout = buildMobileTaskListItems(base);
    expect(keys(layout)).toEqual([
      "v2-settled-shelf",
      `task:${taskKey}`,
      `v2-thread:${environmentId}:live`,
      `v2-thread:${environmentId}:snoozed`,
      `v2-thread:${environmentId}:settled`,
    ]);
    expect(
      layout.items
        .filter((item) => item.type === "v2-thread")
        .every((item) => item.item.variant === "slim"),
    ).toBe(true);
    expect(layout.counts.settled).toBe(2);
    expect(layout.hiddenSettledCount).toBe(1);
    expect(layout.nextSnoozeWakeAt).toBe(future);
    expect(keys(buildMobileTaskListItems({ ...base, settledShelfExpanded: false }))).toEqual([
      "v2-settled-shelf",
    ]);
  });

  it("retains only the selected member through a collapsed task and outer shelf, including beyond the page", () => {
    const base = taskListFixture({
      tasks: [makeContainer({ settledOverride: "settled" })],
      threads: [member("selected"), member("sibling")],
      collapsedTaskKeys: new Set([`parked:${taskKey}`]),
      selectedThreadKey: `${environmentId}:selected`,
      settledShelfExpanded: false,
      settledLimit: 0,
    });
    const layout = buildMobileTaskListItems(base);
    expect(keys(layout)).toEqual([
      "v2-settled-shelf",
      `task:${taskKey}`,
      `v2-thread:${environmentId}:selected`,
    ]);
    expect(layout.counts.settled).toBe(1);
    expect(layout.hiddenSettledCount).toBe(0);
    expect(keys(buildMobileTaskListItems({ ...base, selectedThreadKey: null }))).toEqual([
      "v2-settled-shelf",
    ]);
    expect(base.collapsedTaskKeys).toEqual(new Set([`parked:${taskKey}`]));
  });

  it("keeps selected and queued members narrow while preserving saved task and sub-shelf collapse", () => {
    const base = taskListFixture({
      threads: [
        member("chosen", { settledOverride: "settled" }),
        member("other", { settledOverride: "settled" }),
        member("live"),
      ],
      collapsedTaskKeys: new Set([taskKey]),
      selectedThreadKey: `${environmentId}:chosen`,
    });
    expect(keys(buildMobileTaskListItems(base))).toEqual([
      `task:${taskKey}`,
      `task-settled:${taskKey}`,
      `v2-thread:${environmentId}:chosen`,
    ]);
    const queued = buildMobileTaskListItems({
      ...base,
      selectedThreadKey: null,
      queuedThreadKeys: new Set([`${environmentId}:chosen`]),
      tasks: [makeContainer({ settledOverride: "settled" })],
    });
    expect(keys(queued)).toEqual([`task:${taskKey}`, `v2-thread:${environmentId}:chosen`]);
    expect(queued.items[0]).toMatchObject({ type: "task-card", expanded: false, count: 3 });
    const expanded = buildMobileTaskListItems({ ...base, collapsedTaskKeys: new Set() });
    expect(keys(expanded)).toEqual([
      `task:${taskKey}`,
      `v2-thread:${environmentId}:live`,
      `task-settled:${taskKey}`,
      `v2-thread:${environmentId}:chosen`,
    ]);
    expect(expanded.items.find((item) => item.type === "task-subshelf-header")).toMatchObject({
      expanded: false,
      count: 2,
    });
    expect(keys(buildMobileTaskListItems({ ...base, selectedThreadKey: null }))).toEqual([
      `task:${taskKey}`,
    ]);
  });

  it("shares description, member and content search policy without narrowing member counts", () => {
    const base = taskListFixture({
      tasks: [makeContainer({ description: "Release checklist" })],
      threads: [member("one"), member("two")],
      collapsedTaskKeys: new Set([taskKey]),
    });
    expect(keys(buildMobileTaskListItems({ ...base, searchQuery: "checklist" }))).toEqual([
      `task:${taskKey}`,
    ]);
    for (const extra of [
      { searchQuery: "two" },
      { searchQuery: "content", matchedThreadKeys: new Set([`${environmentId}:two`]) },
    ]) {
      const layout = buildMobileTaskListItems({ ...base, ...extra });
      expect(keys(layout)).toEqual([`task:${taskKey}`, `v2-thread:${environmentId}:two`]);
      expect(layout.items[0]).toMatchObject({ count: 2, expanded: true });
    }
    expect(keys(buildMobileTaskListItems(base))).toEqual([`task:${taskKey}`]);
  });

  it("flattens project scopes and capability downgrades using complete inventories", () => {
    const other = EnvironmentId.make("other");
    const base = taskListFixture({
      tasks: [makeContainer(), makeContainer({ environmentId: other })],
      threads: [member("one"), member("one", { environmentId: other })],
      capableIds: new Set([environmentId, other]),
      projectScoped: true,
      projectRefs: [{ environmentId: other, projectId: ProjectId.make("project-1") }],
    });
    expect(keys(buildMobileTaskListItems(base))).toEqual([`v2-thread:${other}:one`]);
    const downgraded = buildMobileTaskListItems({
      ...base,
      projectScoped: false,
      projectRefs: null,
      capableIds: new Set([environmentId]),
    });
    expect(downgraded.counts.active).toBe(2);
    expect(keys(downgraded)).toContain(`v2-thread:${other}:one`);
    expect(keys(downgraded)).not.toContain(`task:${other}:task-1`);
  });

  it("keeps pending creation reachable under search without revealing siblings", () => {
    const base = taskListFixture({
      tasks: [makeContainer({ settledOverride: "settled" })],
      threads: [member("one"), member("two")],
      collapsedTaskKeys: new Set([taskKey]),
      pendingTasks: [{ ...makePendingTask("pending"), taskId: TaskId.make("task-1") }],
      searchQuery: "unrelated",
    });
    const layout = buildMobileTaskListItems(base);
    expect(keys(layout)).toEqual([`task:${taskKey}`, "v2-pending-task:pending"]);
    expect(layout.items[0]).toMatchObject({ count: 3, expanded: false });
    expect(layout.counts.active).toBe(1);
  });

  it("uses the member lifecycle for swipe actions when a parked task makes its row slim", () => {
    expect(
      resolveThreadListV2SwipeActions({
        variant: "slim",
        settled: false,
        settlementSupported: true,
        snoozeSupported: true,
        snoozable: true,
      }),
    ).toEqual({ primary: "settle", secondary: "snooze" });
    expect(
      resolveThreadListV2SwipeActions({
        variant: "slim",
        settled: true,
        settlementSupported: true,
        snoozeSupported: true,
        snoozable: true,
      }),
    ).toEqual({ primary: "unsettle", secondary: "snooze" });
  });
});

describe("native task row context", () => {
  const project = (env: EnvironmentId, title: string) => ({
    environmentId: env,
    id: ProjectId.make("project-1"),
    title,
    workspaceRoot: `/${title}`,
    repositoryIdentity: null,
    defaultModelSelection: null,
    scripts: [],
    createdAt: NOW,
    updatedAt: NOW,
  });
  it("resolves primary project identity by task scope, including empty and foreign-member tasks", () => {
    const other = EnvironmentId.make("other");
    const localProject = project(environmentId, "Primary");
    const otherProject = project(other, "Remote");
    const layout = buildMobileTaskListItems(
      taskListFixture({
        projects: [otherProject, localProject],
        tasks: [makeContainer(), makeContainer({ environmentId: other })],
        capableIds: new Set([environmentId, other]),
        threads: [
          makeThread({
            id: ThreadId.make("member"),
            title: "Foreign checkout",
            projectId: ProjectId.make("foreign"),
            taskId: TaskId.make("task-1"),
          }),
        ],
      }),
    );
    const rows = layout.items.filter((item) => item.type === "task-card");
    expect(rows.map((row) => [row.task.environmentId, row.primaryProject?.title]).sort()).toEqual(
      [
        [environmentId, "Primary"],
        [other, "Remote"],
      ].sort(),
    );
    expect(rows.find((row) => row.task.environmentId === other)?.members).toEqual([]);
    expect(rows.find((row) => row.task.environmentId === environmentId)?.members).toHaveLength(1);
    const missing = buildMobileTaskListItems(taskListFixture({ projects: [otherProject] })).items;
    expect(missing.find((row) => row.type === "task-card")).toMatchObject({ primaryProject: null });
  });
  it("derives each parked wake label from its own scoped task and the shared clock", () => {
    const other = EnvironmentId.make("other");
    const soon = "2026-06-02T00:15:00.000Z";
    const later = "2026-06-03T15:00:00.000Z";
    const base = taskListFixture({
      tasks: [
        makeContainer({ snoozedUntil: soon }),
        makeContainer({ environmentId: other, snoozedUntil: later }),
      ],
      capableIds: new Set([environmentId, other]),
      snoozedShelfExpanded: true,
    });
    const layout = buildMobileTaskListItems(base);
    expect(
      layout.items
        .filter((row) => row.type === "task-slim")
        .map((row) => [row.task.environmentId, row.snoozeWakeLabelText]),
    ).toEqual([
      [environmentId, snoozeWakeLabel(soon, { now: NOW })],
      [other, snoozeWakeLabel(later, { now: NOW })],
    ]);
    expect(layout.nextSnoozeWakeAt).toBe(soon);
    const woken = buildMobileTaskListItems({ ...base, now: soon }).items;
    expect(woken.find((row) => row.type === "task-card")).toMatchObject({
      snoozeWakeLabelText: undefined,
    });
    expect(woken.filter((row) => row.type === "task-slim")).toHaveLength(1);
  });
});

describe("retained native task expansion", () => {
  it.each(["settled", "snoozed"] as const)(
    "reveals a selected %s task and preserves the selected-child exception",
    (shelf) => {
      const task = makeContainer(
        shelf === "settled"
          ? { settledOverride: "settled" }
          : { snoozedUntil: "2099-01-01T00:00:00.000Z" },
      );
      const taskKey = `${environmentId}:${task.id}`;
      for (const threads of [
        [],
        [
          makeThread({ id: ThreadId.make("selected"), title: "Selected", taskId: task.id }),
          makeThread({ id: ThreadId.make("sibling"), title: "Sibling", taskId: task.id }),
        ],
      ]) {
        const input = taskListFixture({
          tasks: [task],
          threads,
          selectedTaskKey: taskKey,
          selectedThreadKey: threads.length ? `${environmentId}:selected` : null,
          collapsedTaskKeys: new Set([`parked:${taskKey}`]),
          settledShelfExpanded: false,
          snoozedShelfExpanded: false,
          settledLimit: 0,
        });
        const retained = buildMobileTaskListItems(input).items;
        const header = retained.find((item) => item.type === "task-slim")!;
        expect(header).toMatchObject({
          expanded: false,
          retainedShelfVisibleCount: shelf === "settled" ? 1 : 0,
        });
        expect(
          retained.filter((item) => item.type === "v2-thread").map((item) => item.item.thread.id),
        ).toEqual(threads.length ? ["selected"] : []);
        const revealed = buildMobileTaskListItems({
          ...input,
          settledShelfExpanded: true,
          snoozedShelfExpanded: true,
          settledLimit: header.retainedShelfVisibleCount ?? 0,
        }).items;
        expect(revealed.find((item) => item.type === "task-slim")).toMatchObject({
          expanded: true,
        });
        expect(revealed.filter((item) => item.type === "v2-thread")).toHaveLength(threads.length);
        const searched = buildMobileTaskListItems({
          ...input,
          searchQuery: "selected",
          settledShelfExpanded: true,
          snoozedShelfExpanded: true,
          settledLimit: 1,
        }).items;
        expect(
          searched.filter((item) => item.type === "v2-thread").map((item) => item.item.thread.id),
        ).not.toContain("sibling");
        expect(input.collapsedTaskKeys).toEqual(new Set([`parked:${taskKey}`]));
      }
    },
  );
  it("carries the selected task's position past the settled page", () => {
    const task = makeContainer({
      settledOverride: "settled",
      settledAt: "2026-01-01T00:00:00.000Z",
    });
    const newer = makeContainer({
      id: TaskId.make("newer"),
      settledOverride: "settled",
      settledAt: "2026-09-01T00:00:00.000Z",
    });
    const input = taskListFixture({
      tasks: [task, newer],
      selectedTaskKey: `${environmentId}:${task.id}`,
      settledShelfExpanded: true,
      settledLimit: 1,
    });
    expect(
      buildMobileTaskListItems(input).items.find(
        (item) => item.type === "task-slim" && item.task.id === task.id,
      ),
    ).toMatchObject({ expanded: false, retainedShelfVisibleCount: 2 });
  });
});

describe("native task previews", () => {
  const task = makeContainer();
  const key = `${environmentId}:${task.id}`;
  const threads = Array.from({ length: 8 }, (_, index) =>
    makeThread({
      id: ThreadId.make(`member-${index}`),
      title: `Member ${index}`,
      taskId: task.id,
      activeOrderKey: String.fromCharCode(98 + index),
    }),
  );
  const rows = (extra: Partial<Parameters<typeof buildMobileTaskListItems>[0]> = {}) =>
    buildMobileTaskListItems(taskListFixture({ threads, ...extra })).items;
  const members = (items: ReturnType<typeof rows>) =>
    items.filter((item) => item.type === "v2-thread");

  it("previews six in manual order and remembers show-all through task collapse", () => {
    expect(
      members(rows({ threads: threads.toReversed() })).map((item) => item.item.thread.id),
    ).toEqual(threads.slice(0, 6).map((thread) => thread.id));
    expect(rows().find((item) => item.type === "task-thread-limit")).toMatchObject({
      count: 8,
      expanded: false,
    });
    const showAllTaskKeys = new Set([key]);
    expect(members(rows({ showAllTaskKeys }))).toHaveLength(8);
    expect(members(rows({ showAllTaskKeys, collapsedTaskKeys: new Set([key]) }))).toHaveLength(0);
    expect(members(rows({ showAllTaskKeys }))).toHaveLength(8);
  });

  it("includes snoozed and settled in the budget while preserving the settled chevron", () => {
    const mixed = [
      ...threads.slice(0, 6),
      { ...threads[6]!, snoozedUntil: "2099-01-01T00:00:00.000Z" },
      { ...threads[7]!, settledOverride: "settled" as const },
    ];
    expect(members(rows({ threads: mixed }))).toHaveLength(6);
    expect(rows({ threads: mixed }).some((item) => item.type === "task-subshelf-header")).toBe(
      false,
    );
    const extra = { threads: mixed, showAllTaskKeys: new Set([key]) };
    expect(members(rows(extra))).toHaveLength(7);
    expect(rows(extra).find((item) => item.type === "task-subshelf-header")).toMatchObject({
      expanded: false,
    });
    expect(members(rows({ ...extra, expandedTaskShelfKeys: new Set([key]) }))).toHaveLength(8);
    const taskRows = rows({ ...extra, expandedTaskShelfKeys: new Set([key]) }).filter(
      (item) => !item.type.startsWith("v2-") || item.type === "v2-thread",
    );
    expect(taskRows.at(-1)).toMatchObject({ type: "task-thread-limit" });
  });

  it("keeps selected and queued members and searches beyond the limit", () => {
    expect(
      members(
        rows({
          taskThreadPreviewCount: 1,
          selectedThreadKey: `${environmentId}:member-7`,
          queuedThreadKeys: new Set([`${environmentId}:member-6`]),
        }),
      ),
    ).toHaveLength(3);
    expect(members(rows({ taskThreadPreviewCount: 1, searchQuery: "Member 7" }))).toHaveLength(1);
    expect(rows({ searchQuery: "Member" }).some((item) => item.type === "task-thread-limit")).toBe(
      false,
    );
    for (const count of [0, 2, 6])
      expect(
        rows({ threads: threads.slice(0, count) }).some(
          (item) => item.type === "task-thread-limit",
        ),
      ).toBe(false);
  });
});
