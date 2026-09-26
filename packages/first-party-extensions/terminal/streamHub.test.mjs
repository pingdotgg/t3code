// TerminalStreamHub unit contracts: the installation-wide stream budget.
// Fixed feeds (sessions/theme/appearance) must be shared refcounted across
// placements; pane slots must pool the remaining budget with mandatory
// pinning, LRU eviction of optional (hidden-pane) slots, and one-shot
// slot-free waiters. The hub itself stays SDK-free; the late-joiner
// regression test wires real TerminalPanels to it like the view does.

import * as NodeAssert from "node:assert/strict";
import * as NodeTest from "node:test";

import {
  BROKER_STREAM_CAP,
  FEED_REPLAY_MAX_FRAMES,
  TerminalStreamHub,
  isBrokerStreamRefusal,
} from "./streamHub.ts";
import { TerminalPanel } from "./viewModel.ts";

// Deterministic eviction order: each demotion stamps a later clock tick.
function clockHub() {
  let now = 0;
  const hub = new TerminalStreamHub({ now: () => now });
  return {
    hub,
    advance: (ticks = 1) => {
      now += ticks;
    },
  };
}

NodeTest.test("broker cap is 8 and the pane budget shrinks with live fixed feeds", () => {
  NodeAssert.equal(BROKER_STREAM_CAP, 8);
  const { hub } = clockHub();
  NodeAssert.equal(hub.paneStreamBudget(), 8);
  const detachFeed = hub.acquireFixedFeed(
    "sessions:t:1",
    { onFrame() {}, onStatus() {} },
    () => {},
  );
  NodeAssert.equal(hub.paneStreamBudget(), 7);
  detachFeed();
  NodeAssert.equal(hub.paneStreamBudget(), 8);
});

NodeTest.test("isBrokerStreamRefusal matches only the broker's capacity refusals", () => {
  // R6: the broker's own accounting is authoritative — another client of
  // the installation or another plugin in the environment spends the same
  // caps. Exactly these messages mean capacity (wait and retry), never a
  // transport failure.
  for (const message of [
    "Plugin stream limit reached",
    "Environment stream limit reached",
    "Worker stream limit reached",
  ]) {
    NodeAssert.equal(isBrokerStreamRefusal(new Error(message)), true, message);
  }
  NodeAssert.equal(isBrokerStreamRefusal(new Error("WebSocket dropped")), false);
  NodeAssert.equal(isBrokerStreamRefusal(new Error("Plugin stream limit reached: extra")), false);
  NodeAssert.equal(isBrokerStreamRefusal("Plugin stream limit reached"), false);
  NodeAssert.equal(isBrokerStreamRefusal(null), false);
});

NodeTest.test("fixed feed runs one driver for many listeners and fans out", () => {
  const { hub } = clockHub();
  const started = [];
  const a = { frames: [], statuses: [] };
  const b = { frames: [], statuses: [] };
  let sink = null;
  const first = hub.acquireFixedFeed(
    "sessions:t:1",
    {
      onFrame: (frame) => a.frames.push(frame),
      onStatus: (status, message) => a.statuses.push([status, message]),
    },
    (feedSink) => {
      started.push("driver");
      sink = feedSink;
      sink.status("connecting", null);
    },
  );
  NodeAssert.deepEqual(started, ["driver"]);
  sink.frame("f1");
  // A second placement joins the SAME subscription — no second driver. It
  // hears the replayed status immediately, then the replayed frames (the
  // last frame by default — each frame supersedes the one before it).
  const second = hub.acquireFixedFeed(
    "sessions:t:1",
    {
      onFrame: (frame) => b.frames.push(frame),
      onStatus: (status, message) => b.statuses.push([status, message]),
    },
    () => {
      started.push("driver-2");
    },
  );
  NodeAssert.deepEqual(started, ["driver"]);
  NodeAssert.deepEqual(b.frames, ["f1"]);
  NodeAssert.deepEqual(b.statuses, [["connecting", null]]);
  sink.frame("f2");
  NodeAssert.deepEqual(a.frames, ["f1", "f2"]);
  NodeAssert.deepEqual(b.frames, ["f1", "f2"]);
  // Dropping one listener keeps the shared driver alive.
  first();
  sink.frame("f3");
  NodeAssert.equal(started.length, 1);
  NodeAssert.deepEqual(a.frames, ["f1", "f2"]);
  NodeAssert.deepEqual(b.frames, ["f1", "f2", "f3"]);
  // The last listener leaving aborts the driver — a fresh join restarts it.
  second();
  NodeAssert.equal(started.length, 1);
  hub.acquireFixedFeed("sessions:t:1", { onFrame() {}, onStatus() {} }, () => {
    started.push("driver-3");
  });
  NodeAssert.deepEqual(started, ["driver", "driver-3"]);
});

NodeTest.test("driver aborts when the last listener leaves", () => {
  const { hub } = clockHub();
  let aborted = false;
  const detachFeed = hub.acquireFixedFeed(
    "theme:e1",
    { onFrame() {}, onStatus() {} },
    (_sink, signal) => {
      signal.addEventListener("abort", () => {
        aborted = true;
      });
    },
  );
  NodeAssert.equal(aborted, false);
  detachFeed();
  NodeAssert.equal(aborted, true);
});

NodeTest.test("detach is idempotent and a stale detach does not abort a newer feed", () => {
  const { hub } = clockHub();
  let aborted = 0;
  const make = () =>
    hub.acquireFixedFeed("theme:e1", { onFrame() {}, onStatus() {} }, (_sink, signal) => {
      signal.addEventListener("abort", () => {
        aborted += 1;
      });
    });
  const first = make();
  first();
  first();
  NodeAssert.equal(aborted, 1);
  const second = make();
  first(); // stale handle
  NodeAssert.equal(aborted, 1);
  second();
  NodeAssert.equal(aborted, 2);
});

NodeTest.describe("fixed feed late-joiner replay", () => {
  const sessionsPolicy = { isStateFrame: (frame) => frame.kind === "snapshot" };

  NodeTest.test("a late joiner replays [snapshot … deltas] in delivery order", () => {
    const { hub } = clockHub();
    let sink = null;
    hub.acquireFixedFeed(
      "sessions:t:1",
      { onFrame() {}, onStatus() {} },
      (feedSink) => {
        sink = feedSink;
        sink.status("connecting", null);
      },
      sessionsPolicy,
    );
    sink.frame({ kind: "snapshot", terminals: ["term-1"] });
    sink.frame({ kind: "upsert", terminal: "term-2" });
    const joined = { frames: [], statuses: [] };
    hub.acquireFixedFeed(
      "sessions:t:1",
      {
        onFrame: (frame) => joined.frames.push(frame),
        onStatus: (status, message) => joined.statuses.push([status, message]),
      },
      () => {},
      sessionsPolicy,
    );
    // Status first (the panel's stream gate), then the replayed history.
    NodeAssert.deepEqual(joined.statuses, [["connecting", null]]);
    NodeAssert.deepEqual(joined.frames, [
      { kind: "snapshot", terminals: ["term-1"] },
      { kind: "upsert", terminal: "term-2" },
    ]);
    // Live frames continue after the replay.
    sink.frame({ kind: "remove", terminalId: "term-1" });
    NodeAssert.equal(joined.frames.at(-1).kind, "remove");
  });

  NodeTest.test("deltas with no state frame yet are not replayed", () => {
    const { hub } = clockHub();
    let sink = null;
    hub.acquireFixedFeed(
      "sessions:t:1",
      { onFrame() {}, onStatus() {} },
      (feedSink) => {
        sink = feedSink;
        sink.status("connecting", null);
      },
      sessionsPolicy,
    );
    // The subscription delivered an upsert before its first snapshot —
    // replaying it to a fresh panel would fabricate a one-id session list.
    sink.frame({ kind: "upsert", terminal: "term-2" });
    const joined = { frames: [], statuses: [] };
    hub.acquireFixedFeed(
      "sessions:t:1",
      {
        onFrame: (frame) => joined.frames.push(frame),
        onStatus: (status, message) => joined.statuses.push([status, message]),
      },
      () => {},
      sessionsPolicy,
    );
    NodeAssert.deepEqual(joined.frames, []);
  });

  NodeTest.test(
    "overflow slides the window; the next join restarts the feed for a fresh anchor",
    async () => {
      const { hub } = clockHub();
      let sink = null;
      const starts = [];
      const driver = (feedSink) => {
        starts.push(`start-${starts.length + 1}`);
        sink = feedSink;
        sink.status("connecting", null);
        // Each (re)subscription opens with its snapshot — as the real sessions
        // feed does at establishment.
        sink.frame({ kind: "snapshot", terminals: starts.length === 1 ? [] : ["fresh"] });
      };
      hub.acquireFixedFeed("sessions:t:1", { onFrame() {}, onStatus() {} }, driver, sessionsPolicy);
      sink.frame({ kind: "snapshot", terminals: [] });
      for (let i = 0; i < FEED_REPLAY_MAX_FRAMES; i += 1)
        sink.frame({ kind: "upsert", terminal: `term-${i}` });
      const overflowed = { frames: [] };
      hub.acquireFixedFeed(
        "sessions:t:1",
        {
          onFrame: (frame) => overflowed.frames.push(frame),
          onStatus() {},
        },
        driver,
        sessionsPolicy,
      );
      // The window slid past its state anchor, so the join restarted the
      // shared subscription instead of replaying deltas that anchor nothing.
      await new Promise((resolve) => queueMicrotask(resolve));
      NodeAssert.equal(starts.length, 2);
      NodeAssert.deepEqual(overflowed.frames, [{ kind: "snapshot", terminals: ["fresh"] }]);
      // Live frames continue after the re-anchored restart.
      sink.frame({ kind: "upsert", terminal: "live" });
      NodeAssert.equal(overflowed.frames.at(-1).kind, "upsert");
    },
  );

  NodeTest.test("a second placement goes live through the replay (dual-mount regression)", () => {
    const { hub } = clockHub();
    const meta = (terminalId) => ({
      terminalId,
      status: "running",
      label: "",
      hasRunningSubprocess: false,
      exitCode: null,
      exitSignal: null,
      updatedAt: "2026-09-12T00:00:00Z",
    });
    const control = {
      open: async () => {},
      attach: async () => {},
      write: async () => ({}),
      resize: async () => ({}),
      clear: async () => ({}),
      restart: async () => {},
      close: async () => ({}),
    };
    const launch = { cwd: "/workspace", worktreePath: null };
    let sink = null;
    const join = (panel) =>
      hub.acquireFixedFeed(
        "sessions:e:t",
        {
          onFrame: (frame) => panel.applySessionsEvent(frame),
          onStatus: (status, message) => {
            if (status === "connecting") panel.beginListStream();
            else panel.markStreamDisconnected(message);
          },
        },
        (feedSink) => {
          sink = feedSink;
          sink.status("connecting", null);
        },
        sessionsPolicy,
      );
    // First placement mounts, the feed snapshots and goes live.
    const firstPanel = new TerminalPanel({ control, launch });
    const first = join(firstPanel);
    sink.frame({ kind: "snapshot", terminals: [meta("term-1")] });
    sink.frame({ kind: "upsert", terminal: meta("term-2") });
    NodeAssert.equal(firstPanel.snapshot.stream, "live");
    NodeAssert.deepEqual(firstPanel.snapshot.terminalIds, ["term-1", "term-2"]);
    // Second placement of the same thread mounts later: before the replay
    // fix it joined the live feed blind and sat on "connecting" forever —
    // the shared subscription never re-emits its snapshot.
    const secondPanel = new TerminalPanel({ control, launch });
    const second = join(secondPanel);
    NodeAssert.equal(secondPanel.snapshot.stream, "live");
    NodeAssert.deepEqual(secondPanel.snapshot.terminalIds, ["term-1", "term-2"]);
    first();
    second();
    firstPanel.dispose();
    secondPanel.dispose();
  });

  NodeTest.test("a late joiner after 64 upserts goes live via a feed restart", async () => {
    // The sessions feed snapshots only at subscription establishment, and
    // repeated activity upserts (no new terminals needed) overflowed the replay
    // history. The overflow restarts the shared subscription so the second
    // placement's panel goes live — open/split must not stay gated while its
    // tabs keep receiving live metadata.
    const { hub } = clockHub();
    const meta = (terminalId, label = "") => ({
      terminalId,
      status: "running",
      label,
      hasRunningSubprocess: false,
      exitCode: null,
      exitSignal: null,
      updatedAt: "2026-09-12T00:00:00Z",
    });
    const control = {
      open: async () => {},
      attach: async () => {},
      write: async () => ({}),
      resize: async () => ({}),
      clear: async () => ({}),
      restart: async () => {},
      close: async () => ({}),
    };
    const launch = { cwd: "/workspace", worktreePath: null };
    let sink = null;
    const starts = [];
    const join = (panel) =>
      hub.acquireFixedFeed(
        "sessions:e:t",
        {
          onFrame: (frame) => panel.applySessionsEvent(frame),
          onStatus: (status, message) => {
            if (status === "connecting") panel.beginListStream();
            else panel.markStreamDisconnected(message);
          },
        },
        (feedSink) => {
          starts.push(`start-${starts.length + 1}`);
          sink = feedSink;
          sink.status("connecting", null);
          sink.frame({ kind: "snapshot", terminals: [meta("term-1")] });
        },
        sessionsPolicy,
      );
    const firstPanel = new TerminalPanel({ control, launch });
    const first = join(firstPanel);
    // Sixty-four metadata upserts for the SAME terminal — plain activity,
    // not session churn.
    for (let i = 0; i < FEED_REPLAY_MAX_FRAMES; i += 1)
      sink.frame({ kind: "upsert", terminal: meta("term-1", `tick-${i}`) });
    NodeAssert.equal(firstPanel.snapshot.stream, "live");
    const secondPanel = new TerminalPanel({ control, launch });
    const second = join(secondPanel);
    await new Promise((resolve) => queueMicrotask(resolve));
    // The join restarted the shared subscription; its fresh snapshot took
    // the second placement live.
    NodeAssert.equal(starts.length, 2);
    NodeAssert.equal(secondPanel.snapshot.stream, "live");
    NodeAssert.deepEqual(secondPanel.snapshot.terminalIds, ["term-1"]);
    NodeAssert.equal(firstPanel.snapshot.stream, "live");
    // Live deltas still flow to both placements after the restart.
    sink.frame({ kind: "upsert", terminal: meta("term-1", "live") });
    const tabOf = (panel) => panel.snapshot.tabs.find((tab) => tab.terminalId === "term-1");
    NodeAssert.equal(tabOf(secondPanel)?.label, "live");
    NodeAssert.equal(tabOf(firstPanel)?.label, "live");
    first();
    second();
    firstPanel.dispose();
    secondPanel.dispose();
  });
});

NodeTest.test("mandatory pane slots fill the pool; further acquisition fails", () => {
  const { hub } = clockHub();
  const leases = [];
  for (let index = 0; index < BROKER_STREAM_CAP; index += 1) {
    const lease = hub.acquirePaneStream(`p${index}`, { mandatory: true, onEvicted() {} });
    NodeAssert.ok(lease !== null);
    leases.push(lease);
  }
  NodeAssert.equal(hub.paneSlotAvailable(), false);
  NodeAssert.equal(hub.acquirePaneStream("p-extra", { mandatory: true, onEvicted() {} }), null);
  // Closing any pane frees its slot exactly for one new pane.
  leases[3].release();
  NodeAssert.equal(hub.paneSlotAvailable(), true);
  NodeAssert.ok(hub.acquirePaneStream("p-extra", { mandatory: true, onEvicted() {} }) !== null);
});

NodeTest.test("full pool of optional slots evicts least-recently-demoted", () => {
  const { hub, advance } = clockHub();
  const evicted = [];
  hub.acquirePaneStream("a", { mandatory: false, onEvicted: () => evicted.push("a") });
  advance();
  hub.acquirePaneStream("b", { mandatory: false, onEvicted: () => evicted.push("b") });
  advance();
  hub.acquirePaneStream("c", { mandatory: false, onEvicted: () => evicted.push("c") });
  // Budget is 8; only 3 held, so pool is not full — fill it.
  const filler = [];
  for (let index = 0; index < 5; index += 1) {
    filler.push(hub.acquirePaneStream(`f${index}`, { mandatory: true, onEvicted() {} }));
  }
  // All 8 slots held with only optional "a"/"b"/"c" evictable.
  NodeAssert.equal(hub.paneSlotAvailable(), true); // optional slots evictable
  const late = hub.acquirePaneStream("late", { mandatory: true, onEvicted() {} });
  NodeAssert.ok(late !== null);
  NodeAssert.deepEqual(evicted, ["a"]); // oldest demotion
  // The evicted key is gone from the pool — the next pressure evicts "b".
  NodeAssert.ok(hub.acquirePaneStream("late2", { mandatory: true, onEvicted() {} }) !== null);
  NodeAssert.deepEqual(evicted, ["a", "b"]);
});

NodeTest.test("demoting a mandatory slot wakes waiters so a visible pane can take it", () => {
  // A group switch demotes the old group's panes AFTER the newly visible pane
  // already failed to acquire. The demotion wakes the waiter, so the visible
  // pane connects over the evictable slot.
  const { hub } = clockHub();
  const leases = [];
  for (let index = 0; index < BROKER_STREAM_CAP; index += 1) {
    leases.push(hub.acquirePaneStream(`f${index}`, { mandatory: true, onEvicted() {} }));
  }
  NodeAssert.equal(hub.acquirePaneStream("visible", { mandatory: true, onEvicted() {} }), null);
  const fired = [];
  hub.onPaneSlotFree(() => fired.push("woken"));
  leases[0].setPriority(false);
  NodeAssert.deepEqual(fired, ["woken"]);
  NodeAssert.ok(hub.acquirePaneStream("visible", { mandatory: true, onEvicted() {} }) !== null);
});

NodeTest.test("re-demoting an already-optional slot wakes no one", () => {
  const { hub } = clockHub();
  for (let index = 0; index < BROKER_STREAM_CAP - 1; index += 1) {
    hub.acquirePaneStream(`f${index}`, { mandatory: true, onEvicted() {} });
  }
  const optional = hub.acquirePaneStream("hidden", { mandatory: false, onEvicted() {} });
  NodeAssert.ok(optional !== null);
  const fired = [];
  hub.onPaneSlotFree(() => fired.push("woken"));
  optional.setPriority(false); // no mandatory → optional transition
  NodeAssert.deepEqual(fired, []);
});

NodeTest.test("re-acquiring a held key as optional wakes waiters on the demotion", () => {
  const { hub } = clockHub();
  for (let index = 0; index < BROKER_STREAM_CAP - 1; index += 1) {
    hub.acquirePaneStream(`f${index}`, { mandatory: true, onEvicted() {} });
  }
  const lease = hub.acquirePaneStream("pane", { mandatory: true, onEvicted() {} });
  NodeAssert.ok(lease !== null);
  const fired = [];
  hub.onPaneSlotFree(() => fired.push("woken"));
  NodeAssert.ok(hub.acquirePaneStream("pane", { mandatory: false, onEvicted() {} }) !== null);
  NodeAssert.deepEqual(fired, ["woken"]);
});

NodeTest.test("mandatory slots are never evicted; setPriority demotes to evictable", () => {
  const { hub, advance } = clockHub();
  const evicted = [];
  const mandatory = hub.acquirePaneStream("pinned", {
    mandatory: true,
    onEvicted: () => evicted.push("pinned"),
  });
  const filler = [];
  for (let index = 0; index < 7; index += 1) {
    filler.push(hub.acquirePaneStream(`f${index}`, { mandatory: true, onEvicted() {} }));
  }
  // All 8 mandatory — nothing evictable, acquisition fails.
  NodeAssert.equal(hub.acquirePaneStream("late", { mandatory: true, onEvicted() {} }), null);
  NodeAssert.deepEqual(evicted, []);
  // Demote one slot and the pending pane fits.
  mandatory.setPriority(false);
  advance();
  NodeAssert.ok(hub.acquirePaneStream("late", { mandatory: true, onEvicted() {} }) !== null);
  NodeAssert.deepEqual(evicted, ["pinned"]);
});

NodeTest.test("an eviction-granted slot admits only after the victim reports settled", async () => {
  // R5 stream admission order: the subscription for a pane that evicted a
  // victim must not open while the victim's host-level teardown is still
  // resolving — under a full broker the two would contend for one slot. The
  // victim's teardown resolves on the microtask queue but is only PROVEN
  // drained when its caller reports `streamSettled`; the admission gate
  // holds for that report, not for any fixed microtask count.
  const { hub } = clockHub();
  const order = [];
  const victim = hub.acquirePaneStream("victim", {
    mandatory: false,
    onEvicted: () => order.push("evicted"),
  });
  for (let index = 0; index < BROKER_STREAM_CAP - 1; index += 1) {
    hub.acquirePaneStream(`f${index}`, { mandatory: true, onEvicted() {} });
  }
  const replacement = hub.acquirePaneStream("replacement", {
    mandatory: true,
    onEvicted() {},
  });
  NodeAssert.ok(replacement !== null);
  NodeAssert.deepEqual(order, ["evicted"]);
  void replacement.admitted.then(() => order.push("admitted"));
  // Microtasks alone never open the gate — only the victim's settle does.
  await new Promise((resolve) => queueMicrotask(resolve));
  await new Promise((resolve) => queueMicrotask(resolve));
  NodeAssert.deepEqual(order, ["evicted"]);
  victim.streamSettled();
  await replacement.admitted;
  NodeAssert.deepEqual(order, ["evicted", "admitted"]);
  // The report is one-shot: a later settle by the same (dead) lease is a
  // no-op, so no future admission can be released by a stale report.
  victim.streamSettled();
  NodeAssert.deepEqual(order, ["evicted", "admitted"]);
});

NodeTest.test("a settle reported synchronously inside onEvicted still admits", async () => {
  // The eviction callback may run synchronous teardown that reports the
  // victim's stream settled in the same tick. The drain must be registered
  // before the callback runs, or that report no-ops and the replacement's
  // admission never resolves — a mandatory pane stuck on "connecting"
  // forever, holding a slot nothing can evict.
  const { hub } = clockHub();
  let victimLease = null;
  victimLease = hub.acquirePaneStream("victim", {
    mandatory: false,
    onEvicted: () => victimLease.streamSettled(),
  });
  for (let index = 0; index < BROKER_STREAM_CAP - 1; index += 1) {
    hub.acquirePaneStream(`f${index}`, { mandatory: true, onEvicted() {} });
  }
  const replacement = hub.acquirePaneStream("replacement", {
    mandatory: true,
    onEvicted() {},
  });
  NodeAssert.ok(replacement !== null);
  let admitted = false;
  void replacement.admitted.then(() => {
    admitted = true;
  });
  await new Promise((resolve) => queueMicrotask(resolve));
  await new Promise((resolve) => queueMicrotask(resolve));
  NodeAssert.equal(admitted, true);
});

NodeTest.test("a chained eviction settles gate-to-gate without a hang", async () => {
  // B holds a slot gated on C's drain, then demotes and is evicted by A.
  // When C settles, B's caller (its gated-start guard) reports B settled —
  // exactly the report A's admission waits on. The chain must terminate
  // through the per-victim gates instead of deadlocking.
  const { hub, advance } = clockHub();
  const c = hub.acquirePaneStream("c", { mandatory: false, onEvicted() {} });
  advance();
  for (let index = 0; index < BROKER_STREAM_CAP - 1; index += 1) {
    hub.acquirePaneStream(`f${index}`, { mandatory: true, onEvicted() {} });
  }
  const b = hub.acquirePaneStream("b", { mandatory: true, onEvicted() {} });
  NodeAssert.ok(b !== null); // evicted c; b gated on c's drain
  b.setPriority(false); // b demotes — evictable while still gated
  advance();
  const a = hub.acquirePaneStream("a", { mandatory: true, onEvicted() {} });
  NodeAssert.ok(a !== null); // evicted b; a gated on b's drain
  const order = [];
  void a.admitted.then(() => order.push("a"));
  void b.admitted.then(() => {
    // b's gated start never ran (it was evicted while gated): its guard
    // reports settled — the report a's admission waits on.
    order.push("b-gate-open");
    b.streamSettled();
  });
  c.streamSettled();
  await new Promise((resolve) => queueMicrotask(resolve));
  await new Promise((resolve) => queueMicrotask(resolve));
  NodeAssert.deepEqual(order, ["b-gate-open", "a"]);
});

NodeTest.test("admission settles immediately when no eviction happened", async () => {
  const { hub } = clockHub();
  const plain = hub.acquirePaneStream("plain", { mandatory: true, onEvicted() {} });
  const order = [];
  void plain.admitted.then(() => order.push("admitted"));
  await Promise.resolve();
  NodeAssert.deepEqual(order, ["admitted"]);
});

NodeTest.test("a fixed feed that preempted a pane starts after the victim settles", async () => {
  // The same admission race as pane eviction, from the feed side: a fixed
  // feed reclaiming an optional pane slot must not start its subscription
  // while the evicted pane's host-level teardown is still resolving.
  const { hub, advance } = clockHub();
  const started = [];
  const victims = [];
  for (let index = 0; index < BROKER_STREAM_CAP; index += 1) {
    victims.push(hub.acquirePaneStream(`h${index}`, { mandatory: false, onEvicted() {} }));
    advance();
  }
  hub.acquireFixedFeed("sessions:e:t", { onFrame() {}, onStatus() {} }, () => {
    started.push("driver");
  });
  await new Promise((resolve) => queueMicrotask(resolve));
  NodeAssert.deepEqual(started, []); // the evicted pane's drain is owed
  victims[0].streamSettled();
  await new Promise((resolve) => queueMicrotask(resolve));
  NodeAssert.deepEqual(started, ["driver"]);
});

NodeTest.test("optional slot promotes on re-prioritization", () => {
  const { hub, advance } = clockHub();
  const evicted = [];
  const optional = hub.acquirePaneStream("hidden", {
    mandatory: false,
    onEvicted: () => evicted.push("hidden"),
  });
  // Hidden pane is reshown: its slot becomes mandatory.
  optional.setPriority(true);
  const filler = [];
  for (let index = 0; index < 7; index += 1) {
    filler.push(hub.acquirePaneStream(`f${index}`, { mandatory: true, onEvicted() {} }));
  }
  advance();
  // Pool is full and the promoted pane is pinned — nothing evictable.
  NodeAssert.equal(hub.acquirePaneStream("late", { mandatory: true, onEvicted() {} }), null);
  NodeAssert.deepEqual(evicted, []);
});

NodeTest.test("re-acquiring a held key updates priority in place", () => {
  const { hub, advance } = clockHub();
  const evicted = [];
  const first = hub.acquirePaneStream("k", { mandatory: false, onEvicted() {} });
  const second = hub.acquirePaneStream("k", {
    mandatory: true,
    onEvicted: () => evicted.push("k"),
  });
  NodeAssert.ok(first !== null && second !== null);
  for (let index = 0; index < 6; index += 1) {
    hub.acquirePaneStream(`f${index}`, { mandatory: true, onEvicted() {} });
  }
  advance();
  // 7 held; the 8th fits without eviction — the re-acquired key is pinned.
  NodeAssert.ok(hub.acquirePaneStream("late", { mandatory: true, onEvicted() {} }) !== null);
  NodeAssert.deepEqual(evicted, []);
  // Releasing either handle frees the one slot exactly once.
  first.release();
  second.release(); // idempotent — the map entry is already gone
  NodeAssert.equal(hub.paneSlotAvailable(), true);
});

NodeTest.test("slot-free waiters fire once per freed slot and re-register on failure", () => {
  const { hub } = clockHub();
  for (let index = 0; index < 8; index += 1) {
    hub.acquirePaneStream(`f${index}`, { mandatory: true, onEvicted() {} });
  }
  const fired = [];
  hub.onPaneSlotFree(() => fired.push("once"));
  NodeAssert.equal(hub.acquirePaneStream("blocked", { mandatory: true, onEvicted() {} }), null);
  hub.acquirePaneStream("f0", { mandatory: true, onEvicted() {} })?.release();
  NodeAssert.deepEqual(fired, ["once"]);
  // One-shot: a second free does not re-fire the consumed waiter.
  hub.acquirePaneStream("f1", { mandatory: true, onEvicted() {} })?.release();
  NodeAssert.deepEqual(fired, ["once"]);
  // A released waiter never fires.
  let cancelled = 0;
  const unregister = hub.onPaneSlotFree(() => {
    cancelled += 1;
  });
  unregister();
  hub.acquirePaneStream("f2", { mandatory: true, onEvicted() {} })?.release();
  NodeAssert.equal(cancelled, 0);
});

NodeTest.test("dock + panel with a split in each stays inside the cap", () => {
  // Two placements of the same thread each render a 2-pane split. Pre-hub, each
  // placement paid its own sessions/theme/ appearance feeds (6) plus 4 pane
  // streams = 10 > 8 — the first split anywhere hit "Plugin stream limit
  // reached". With shared feeds the math is 3 + 4 = 7, one slot to spare.
  const { hub } = clockHub();
  for (const key of ["sessions:e1:t1", "theme:e1", "appearance:e1"]) {
    // Both placements join each feed — one subscription per key.
    hub.acquireFixedFeed(key, { onFrame() {}, onStatus() {} }, () => {});
    hub.acquireFixedFeed(key, { onFrame() {}, onStatus() {} }, () => {});
  }
  NodeAssert.equal(hub.paneStreamBudget(), 5);
  for (const pane of ["dock-1", "dock-2", "panel-1", "panel-2"]) {
    NodeAssert.ok(hub.acquirePaneStream(pane, { mandatory: true, onEvicted() {} }) !== null);
  }
  NodeAssert.equal(hub.paneSlotAvailable(), true); // one slot still spare
});

NodeTest.test(
  "fixed feeds evict optional pane slots when panes registered first (cold restore)",
  () => {
    // A cold eight-session restore runs pane effects before the view's
    // fixed-feed effects, so hidden panes take optional slots first. Each
    // fixed-feed admission then evicts one optional slot, so the
    // sessions/theme/appearance subscriptions land inside the cap.
    const { hub, advance } = clockHub();
    const evicted = [];
    NodeAssert.ok(hub.acquirePaneStream("active", { mandatory: true, onEvicted() {} }) !== null);
    for (let index = 1; index <= 7; index += 1) {
      NodeAssert.ok(
        hub.acquirePaneStream(`hidden${index}`, {
          mandatory: false,
          onEvicted: () => evicted.push(`hidden${index}`),
        }) !== null,
      );
      advance();
    }
    for (const key of ["sessions:e:t", "theme:e", "appearance:e"]) {
      hub.acquireFixedFeed(key, { onFrame() {}, onStatus() {} }, () => {});
    }
    // Each feed admission reclaimed one least-recently-demoted optional slot.
    NodeAssert.deepEqual(evicted, ["hidden1", "hidden2", "hidden3"]);
    NodeAssert.equal(hub.paneStreamBudget(), 5);
    // Five panes still hold slots and a new terminal can still be allocated.
    NodeAssert.equal(hub.paneSlotAvailable(), true);
    NodeAssert.ok(hub.acquirePaneStream("split", { mandatory: true, onEvicted() {} }) !== null);
    NodeAssert.deepEqual(evicted, ["hidden1", "hidden2", "hidden3", "hidden4"]);
  },
);

NodeTest.test("a new thread's fixed feed evicts optional panes from a full pool", () => {
  // Adding a second thread's sessions feed to an already-full installation must
  // reclaim an optional pane slot rather than start over the cap.
  const { hub, advance } = clockHub();
  for (const key of ["sessions:A", "theme", "appearance"]) {
    hub.acquireFixedFeed(key, { onFrame() {}, onStatus() {} }, () => {});
  }
  const evicted = [];
  NodeAssert.ok(hub.acquirePaneStream("p0", { mandatory: true, onEvicted() {} }) !== null);
  for (let index = 1; index <= 4; index += 1) {
    hub.acquirePaneStream(`p${index}`, {
      mandatory: false,
      onEvicted: () => evicted.push(`p${index}`),
    });
    advance();
  }
  NodeAssert.equal(hub.paneStreamBudget(), 5);
  hub.acquireFixedFeed("sessions:B", { onFrame() {}, onStatus() {} }, () => {});
  NodeAssert.deepEqual(evicted, ["p1"]);
  NodeAssert.equal(hub.paneStreamBudget(), 4); // 4 feeds + 4 panes = 8
});

NodeTest.test("fixed feeds never evict mandatory pane slots", () => {
  const { hub } = clockHub();
  const evicted = [];
  for (let index = 0; index < BROKER_STREAM_CAP; index += 1) {
    hub.acquirePaneStream(`m${index}`, {
      mandatory: true,
      onEvicted: () => evicted.push(`m${index}`),
    });
  }
  hub.acquireFixedFeed("sessions:e:t", { onFrame() {}, onStatus() {} }, () => {});
  // A fully mandatory pool is the disclosed multi-client limit — the feed
  // starts anyway and the broker may reject it, but pinned panes survive.
  NodeAssert.deepEqual(evicted, []);
});

NodeTest.test("a nested acquire inside onEvicted cannot steal the evicted slot", () => {
  const { hub, advance } = clockHub();
  let stolen = null;
  hub.acquirePaneStream("hidden", {
    mandatory: false,
    onEvicted: () => {
      // The victim's synchronous teardown tries to grab the freed slot
      // first — it must see a full pool, not the transient gap.
      stolen = hub.acquirePaneStream("steal", { mandatory: true, onEvicted() {} });
    },
  });
  for (let index = 0; index < 7; index += 1) {
    hub.acquirePaneStream(`f${index}`, { mandatory: true, onEvicted() {} });
  }
  advance();
  const evicted = [];
  NodeAssert.ok(
    hub.acquirePaneStream("late", {
      mandatory: true,
      onEvicted: () => evicted.push("late"),
    }) !== null,
  );
  NodeAssert.equal(stolen, null);
  NodeAssert.deepEqual(evicted, []);
});

NodeTest.test("eviction does not wake waiters — the slot is consumed by the acquiring pane", () => {
  const { hub, advance } = clockHub();
  const evicted = [];
  hub.acquirePaneStream("hidden", { mandatory: false, onEvicted: () => evicted.push("hidden") });
  const filler = [];
  for (let index = 0; index < 7; index += 1) {
    filler.push(hub.acquirePaneStream(`f${index}`, { mandatory: true, onEvicted() {} }));
  }
  advance();
  const fired = [];
  hub.onPaneSlotFree(() => fired.push("woken"));
  NodeAssert.ok(hub.acquirePaneStream("late", { mandatory: true, onEvicted() {} }) !== null);
  // The freed-by-eviction slot went straight to "late" — no net free.
  NodeAssert.deepEqual(fired, []);
  NodeAssert.deepEqual(evicted, ["hidden"]);
  // A true release still wakes the waiter.
  filler[0].release();
  NodeAssert.deepEqual(fired, ["woken"]);
});
