import { threadSearchMatchKey } from "@t3tools/client-runtime/state/thread-search";
import { createInboxReturnTracker } from "@t3tools/client-runtime/state/thread-inbox";
import { presentThreadShell } from "@t3tools/client-runtime/state/models";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import { planPinnedReorder } from "@t3tools/client-runtime/state/thread-sort";
import {
  createPendingThreadOrder,
  createThreadMovePlanner,
  threadOrderAfterMove,
  threadDropLifecycle,
  reconcilePendingThreadOrder,
  type PendingThreadOrder,
  type ThreadMoveAvailability,
} from "./threadOrder";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { resolveSnoozePresets } from "@t3tools/client-runtime/state/thread-settled";
import {
  CommandId,
  EnvironmentId,
  MessageId,
  OrchestrationV2ThreadShell,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import type { PendingNewTask } from "../../state/use-pending-new-tasks";
import { makeRawThreadShell, makeThreadShellFixture } from "../../test-fixtures";
import { threadJumpTarget } from "../keyboard/threadKeyboardShortcuts";
import {
  buildThreadListV2Items,
  buildThreadListV2ListItems,
  getThreadListV2OrderedSection,
  resolveThreadListV2SnoozeMenuSelection,
  resolveThreadListV2SnoozePresets,
  resolveThreadListV2Status,
  resolveThreadListV2WokeAt,
  sortThreadsForListV2,
  threadListV2ListItemsAreEqual,
  threadHasUnseenCompletion,
  type ThreadListV2ListItem,
} from "./threadListV2";
import { NOW, decodeThreadShell, environmentId, makeThread } from "./threadListV2.testkit";

describe("resolveThreadListV2SnoozeMenuSelection", () => {
  it("recomputes the environment's presets instead of using old timestamps", () => {
    const presets = [{ kind: "after", minutes: 360 }] as const;
    const displayedPresets = resolveSnoozePresets(new Date(2026, 4, 8, 10), { presets });
    const selectedAt = new Date(2026, 4, 8, 10, 30);
    const selection = resolveThreadListV2SnoozeMenuSelection({
      event: "snooze:after:360",
      displayedPresets,
      now: selectedAt,
      presets,
    });

    expect(selection._tag).toBe("selected");
    if (selection._tag === "selected") {
      expect(selection.preset.snoozedUntil).toBe(
        new Date(selectedAt.getTime() + 6 * 60 * 60 * 1_000).toISOString(),
      );
    }
  });
});

describe("resolveThreadListV2SnoozePresets", () => {
  it("reads preset times from the list minute, not the clock at first render", () => {
    using _timers = { [Symbol.dispose]: () => vi.useRealTimers() };
    vi.useFakeTimers({ now: new Date(2026, 4, 8, 10) });
    const laterMinute = new Date(2026, 4, 8, 19, 15).toISOString();

    const presets = resolveThreadListV2SnoozePresets({
      secondary: "snooze",
      now: laterMinute,
      presets: undefined,
    });

    expect(presets.find((preset) => preset.id === "after:60")?.snoozedUntil).toBe(
      new Date(2026, 4, 8, 20, 15).toISOString(),
    );
    // The evening preset is gone by 19:15; a reading from 10:00 would still offer it.
    expect(presets.map((preset) => preset.id)).not.toContain("at:today:18:00");
  });
});

describe("resolveThreadListV2Status", () => {
  it("presents decoded thread waits as Waiting while preserving requests and older servers", () => {
    const raw = makeRawThreadShell({
      status: "running",
      activeRunId: RunId.make("run-wait"),
      latestRunId: RunId.make("run-wait"),
    });
    const present = (shell: unknown) => presentThreadShell(environmentId, decodeThreadShell(shell));

    expect(resolveThreadListV2Status(present(raw))).toBe("working");
    const blocked = present({ ...raw, blockedOnThreadWait: true });
    expect(
      resolveThreadListV2Status({
        ...blocked,
        hasPendingApprovals: true,
        hasPendingUserInput: true,
      }),
    ).toBe("approval");
    expect(resolveThreadListV2Status({ ...blocked, hasPendingUserInput: true })).toBe("input");
    expect(resolveThreadListV2Status(blocked)).toBe("waiting");
    expect(resolveThreadListV2Status(present({ ...raw, blockedOnThreadWait: false }))).toBe(
      "working",
    );
  });

  it("shows a waiting guest message as Request, after the agent's own requests", () => {
    const thread = presentThreadShell(
      environmentId,
      decodeThreadShell(makeRawThreadShell({ status: "running" })),
    );
    const guest = { ...thread, pendingGuestMessageCount: 1 };

    expect(resolveThreadListV2Status(guest)).toBe("request");
    expect(resolveThreadListV2Status({ ...guest, hasPendingUserInput: true })).toBe("input");
    expect(resolveThreadListV2Status({ ...guest, hasPendingApprovals: true })).toBe("approval");
  });

  it.each([
    { roster: "dev server", task: { kind: "command" }, status: "ready" },
    { roster: "dev server watchdog", task: { kind: "monitor" }, status: "ready" },
    { roster: "awaited command", task: { kind: "command", awaited: true }, status: "waiting" },
  ] as const)(
    "presents an unseen completion with a $roster roster as $status",
    ({ task, status }) => {
      const thread = presentThreadShell(
        environmentId,
        makeRawThreadShell({
          latestRunId: RunId.make("run-background-completion"),
          status: "completed",
          latestRunCompletedAt: DateTime.makeUnsafe(NOW),
          lastVisitedAt: DateTime.makeUnsafe("2026-06-01T23:59:00.000Z"),
          pendingBackgroundTasks: [{ taskId: "background-work", ...task }],
        }),
      );

      expect(resolveThreadListV2Status(thread)).toBe(status);
      expect(threadHasUnseenCompletion(thread)).toBe(true);
    },
  );
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
});

describe("search lists ranked matches", () => {
  const matchKey = (id: string) =>
    threadSearchMatchKey({ environmentId, threadId: ThreadId.make(id) });

  it("lists matches by rank across shelves, then threads listed for their messages", () => {
    const layout = buildThreadListV2Items({
      threads: [
        makeThread({ id: ThreadId.make("notes"), title: "Deploy notes" }),
        makeThread({ id: ThreadId.make("mentioned"), title: "Weekly notes" }),
        makeThread({ id: ThreadId.make("exact"), title: "Deploy", settledOverride: "settled" }),
      ],
      environmentId: null,
      searchQuery: "deploy",
      matchedThreadKeys: new Set([matchKey("mentioned"), matchKey("notes")]),
      settledShelfExpanded: false,
      now: NOW,
    });
    // The exact title leads even from a collapsed Settled shelf, and keeps its look.
    expect(layout.items.map((item) => [item.thread.id, item.variant])).toEqual([
      ["exact", "slim"],
      ["notes", "card"],
      ["mentioned", "card"],
    ]);
    expect([...layout.contentOnlyThreadKeys]).toEqual([matchKey("mentioned")]);
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
          snoozedUntil: "2026-06-01T18:00:00.000Z",
          snoozedAt: "2026-06-01T12:00:00.000Z",
        }),
      ],
      environmentId: null,
      searchQuery: "",
      now: NOW,
    });

    expect(layout.items.map((item) => item.thread.id)).toEqual(["active", "woken"]);
    expect(layout.snoozedCount).toBe(1);
  });

  it("moves a settled pinned thread into the settled shelf — parity with web (#7969)", () => {
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

    const whileSnoozed = buildThreadListV2Items({ ...snoozedInput, now: NOW });
    expect(whileSnoozed.items.map((item) => item.thread.id)).toEqual(["active"]);
    expect(whileSnoozed.snoozedCount).toBe(1);

    const afterWake = buildThreadListV2Items({ ...snoozedInput, now: "2026-06-03T10:00:00.000Z" });
    expect(afterWake.items.map((item) => item.thread.id)).toEqual(["pinned-snoozed", "active"]);
    expect(afterWake.items[0]?.pinned).toBe(true);
    expect(afterWake.snoozedCount).toBe(0);
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

  it("forgives a typo even when a hidden thread matches the query exactly", () => {
    const { items } = buildThreadListV2Items({
      threads: [
        makeThread({ id: ThreadId.make("visible"), title: "Restore drag handles" }),
        makeThread({ id: ThreadId.make("archived"), title: "Drga notes", archivedAt: NOW }),
      ],
      environmentId: null,
      searchQuery: "drga",
      now: NOW,
    });

    expect(items.map((item) => item.thread.id)).toEqual(["visible"]);
  });

  it("scopes the flat list to every environment member of a logical project", () => {
    const remoteEnvironmentId = EnvironmentId.make("environment-remote");
    const projectId = ProjectId.make("project-1");
    const { items } = buildThreadListV2Items({
      threads: [
        makeThread({ id: ThreadId.make("local"), projectId, title: "Local" }),
        makeThread({
          environmentId: remoteEnvironmentId,
          id: ThreadId.make("remote"),
          projectId,
          title: "Remote",
        }),
      ],
      environmentId: null,
      projectRefs: [
        { environmentId, projectId },
        { environmentId: remoteEnvironmentId, projectId },
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
          latestRun: {
            runId: RunId.make(`run-${index}`),
            status: "completed",
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
    expect(layout.items.map((item) => item.thread.id)).toEqual([
      "active",
      "settled-3",
      "settled-2",
    ]);
  });

  it("lists only loaded settled rows and counts the threads the shell left out", () => {
    const settled = (index: number) =>
      makeThread({
        id: ThreadId.make(`settled-${index}`),
        title: `Settled ${index}`,
        settledOverride: "settled",
        settledAt: `2026-06-0${index}T00:00:00.000Z`,
      });
    const threads = [settled(1), settled(2), settled(3)];
    const layout = buildThreadListV2Items({
      threads,
      environmentId: null,
      searchQuery: "",
      settledLimit: 10,
      now: NOW,
      // settled-1 came back mid-session, below the loaded range; the route keeps it visible.
      isListedSettled: (thread) => thread.id !== "settled-1",
      unloadedSettledCount: 40,
      selectedThreadKey: `${threads[0]!.environmentId}:settled-1`,
    });
    expect(layout.items.map((item) => item.thread.id)).toEqual([
      "settled-3",
      "settled-2",
      "settled-1",
    ]);
    expect(layout.settledCount).toBe(43);
    expect(layout.hiddenSettledCount).toBe(40);

    // A scope whose settled threads are all older still shows its Settled header.
    const unloadedOnly = buildThreadListV2Items({
      threads: [],
      environmentId: null,
      searchQuery: "",
      settledLimit: 10,
      now: NOW,
      unloadedSettledCount: 5,
    });
    expect(unloadedOnly.settledCount).toBe(5);
    expect(unloadedOnly.settledShelfHeaderIndex).toBe(0);
  });
});

describe("buildThreadListV2Items settled sort reuse", () => {
  const otherEnvironmentId = EnvironmentId.make("environment-2");

  function makeSettled(
    id: string,
    settledAt: string,
    overrides: Partial<EnvironmentThreadShell> = {},
  ): EnvironmentThreadShell {
    return makeThread({
      id: ThreadId.make(id),
      title: id,
      settledOverride: "settled",
      settledAt,
      ...overrides,
    });
  }

  function settledOrder(
    threads: ReadonlyArray<EnvironmentThreadShell>,
    scope: EnvironmentId | null = null,
  ) {
    return buildThreadListV2Items({
      threads,
      environmentId: scope,
      searchQuery: "",
      now: NOW,
    })
      .items.filter((item) => item.variant === "slim")
      .map((item) => `${item.thread.environmentId}:${item.thread.id}`);
  }

  const older = makeSettled("older", "2026-06-01T01:00:00.000Z");
  const newer = makeSettled("newer", "2026-06-01T03:00:00.000Z");
  const middle = makeSettled("middle", "2026-06-01T02:00:00.000Z");

  it("re-sorts when a settled row is replaced, added, or removed", () => {
    expect(settledOrder([older, newer])).toEqual([
      `${environmentId}:newer`,
      `${environmentId}:older`,
    ]);
    const resettledOlder = makeSettled("older", "2026-06-01T04:00:00.000Z");
    expect(settledOrder([resettledOlder, newer])).toEqual([
      `${environmentId}:older`,
      `${environmentId}:newer`,
    ]);
    expect(settledOrder([resettledOlder, newer, middle])).toEqual([
      `${environmentId}:older`,
      `${environmentId}:newer`,
      `${environmentId}:middle`,
    ]);
    expect(settledOrder([newer, middle])).toEqual([
      `${environmentId}:newer`,
      `${environmentId}:middle`,
    ]);
  });

  it("recomputes when builds alternate between environments", () => {
    const remoteOlder = makeSettled("remote-older", "2026-06-01T01:30:00.000Z", {
      environmentId: otherEnvironmentId,
    });
    const remoteNewer = makeSettled("remote-newer", "2026-06-01T05:00:00.000Z", {
      environmentId: otherEnvironmentId,
    });
    const threads = [older, newer, remoteOlder, remoteNewer];

    for (let round = 0; round < 2; round += 1) {
      expect(settledOrder(threads, environmentId)).toEqual([
        `${environmentId}:newer`,
        `${environmentId}:older`,
      ]);
      expect(settledOrder(threads, otherEnvironmentId)).toEqual([
        `${otherEnvironmentId}:remote-newer`,
        `${otherEnvironmentId}:remote-older`,
      ]);
    }
  });
});

