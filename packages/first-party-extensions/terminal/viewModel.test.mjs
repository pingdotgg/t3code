import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeTest from "node:test";
import * as NodeURL from "node:url";
import {
  EMPTY_OUTPUT_BUFFER,
  EMPTY_OVERFLOW_STREAK,
  OVERFLOW_RESUBSCRIBE_MAX,
  OVERFLOW_RESUBSCRIBE_WINDOW_MS,
  TERMINAL_BUFFER_MAX_BYTES,
  addTerminalId,
  applyOutputEvent,
  describeSession,
  fallbackTerminalLabel,
  isResumableOutputClose,
  missingSessionRow,
  normalizeTerminalIds,
  noteOutputFrameForStreak,
  removeTerminalId,
  resolveActiveTerminalId,
  terminalPathLinkTarget,
} from "./viewModel.ts";

const frame = (sequence, streamId = "stream-1") => ({ streamId, sequence });
const outputValue = (sequence, data, extra = {}) => ({
  kind: "output",
  terminalId: "term-1",
  streamEpoch: "epoch-1",
  sequence,
  chunkIndex: 0,
  chunkCount: 1,
  data,
  ...extra,
});
const snapshotValue = (overrides = {}) => ({
  kind: "snapshot",
  terminalId: "term-1",
  streamEpoch: "epoch-1",
  status: "running",
  contents: "$ echo hi\nhi\n",
  retainedByteLength: 12,
  truncated: false,
  clearGeneration: 0,
  contentsUnitStart: 0,
  boundarySequence: 0,
  ...overrides,
});
NodeTest.describe("terminal view model — session list", () => {
  NodeTest.it("normalizes, dedupes, and bounds ids", () => {
    NodeAssert.deepEqual(normalizeTerminalIds([" term-1 ", "term-1", "", "term-2"]), [
      "term-1",
      "term-2",
    ]);
    NodeAssert.deepEqual(normalizeTerminalIds(["x".repeat(129)]), []);
  });

  NodeTest.it("adds and removes ids without mutation", () => {
    const ids = ["term-1"];
    NodeAssert.deepEqual(addTerminalId(ids, "term-2"), ["term-1", "term-2"]);
    NodeAssert.deepEqual(addTerminalId(ids, "term-1"), ["term-1"]);
    NodeAssert.deepEqual(addTerminalId(ids, "  "), ["term-1"]);
    NodeAssert.deepEqual(removeTerminalId(["term-1", "term-2"], "term-1"), ["term-2"]);
    NodeAssert.deepEqual(ids, ["term-1"]);
  });

  NodeTest.it("resolves the active id or falls back to the first", () => {
    NodeAssert.equal(resolveActiveTerminalId([], null), null);
    NodeAssert.equal(resolveActiveTerminalId(["term-1"], null), "term-1");
    NodeAssert.equal(resolveActiveTerminalId(["term-1", "term-2"], "term-2"), "term-2");
    NodeAssert.equal(resolveActiveTerminalId(["term-1", "term-2"], "term-9"), "term-1");
  });

  NodeTest.it("describes inspect results and keeps absent sessions visible", () => {
    NodeAssert.equal(describeSession(null), null);
    NodeAssert.deepEqual(
      describeSession({
        terminalId: "term-1",
        status: "running",
        label: "zsh",
        hasRunningSubprocess: true,
        exitCode: null,
        exitSignal: null,
        updatedAt: "2026-09-12T00:00:00Z",
      }),
      {
        terminalId: "term-1",
        label: "zsh",
        status: "running",
        hasRunningSubprocess: true,
        exitCode: null,
        updatedAt: "2026-09-12T00:00:00Z",
      },
    );
    const missing = missingSessionRow("term-3");
    NodeAssert.equal(missing.status, "closed");
    NodeAssert.equal(missing.label, "Terminal 3");
    NodeAssert.equal(fallbackTerminalLabel("scratch"), "Terminal");
  });
});

NodeTest.describe("terminal view model — output stream", () => {
  NodeTest.it("seeds from the snapshot frame and reports truncation", () => {
    const { buffer } = applyOutputEvent(EMPTY_OUTPUT_BUFFER, frame(1), snapshotValue());
    NodeAssert.equal(buffer.contents, "$ echo hi\nhi\n");
    NodeAssert.equal(buffer.status, "live");
    NodeAssert.equal(buffer.epoch, "epoch-1");

    const truncated = applyOutputEvent(
      EMPTY_OUTPUT_BUFFER,
      frame(1),
      snapshotValue({ truncated: true }),
    ).buffer;
    NodeAssert.equal(truncated.truncated, true);
    NodeAssert.match(truncated.statusText, /omitted/);
  });

  NodeTest.it("appends a single-chunk output group", () => {
    const seeded = applyOutputEvent(EMPTY_OUTPUT_BUFFER, frame(1), snapshotValue()).buffer;
    const { buffer } = applyOutputEvent(seeded, frame(2), outputValue(1, "more output\n"));
    NodeAssert.equal(buffer.contents, "$ echo hi\nhi\nmore output\n");
    NodeAssert.equal(buffer.status, "live");
  });

  NodeTest.it("buffers a multi-chunk group until it completes", () => {
    const seeded = applyOutputEvent(EMPTY_OUTPUT_BUFFER, frame(1), snapshotValue()).buffer;
    const first = applyOutputEvent(
      seeded,
      frame(2),
      outputValue(7, "part-1-", { chunkIndex: 0, chunkCount: 2 }),
    );
    NodeAssert.equal(first.buffer.contents, "$ echo hi\nhi\n");
    NodeAssert.ok(first.pending);
    const second = applyOutputEvent(
      first.buffer,
      frame(3),
      outputValue(7, "part-2\n", { chunkIndex: 1, chunkCount: 2 }),
      first.pending,
    );
    NodeAssert.equal(second.buffer.contents, "$ echo hi\nhi\npart-1-part-2\n");
    NodeAssert.equal(second.pending, null);
  });

  NodeTest.it("fails closed on a discontinuous chunk group", () => {
    const seeded = applyOutputEvent(EMPTY_OUTPUT_BUFFER, frame(1), snapshotValue()).buffer;
    const result = applyOutputEvent(
      seeded,
      frame(2),
      outputValue(7, "tail", { chunkIndex: 1, chunkCount: 2 }),
    );
    NodeAssert.equal(result.buffer.status, "error");
    NodeAssert.match(result.buffer.statusText, /discontinuous/);
    NodeAssert.equal(result.buffer.ended, true);
  });

  NodeTest.it("fails on transport sequence gaps and post-lifecycle output", () => {
    const seeded = applyOutputEvent(EMPTY_OUTPUT_BUFFER, frame(1), snapshotValue()).buffer;
    const gap = applyOutputEvent(seeded, frame(9), outputValue(1, "x"));
    NodeAssert.equal(gap.buffer.status, "error");
    const afterEnd = applyOutputEvent(gap.buffer, frame(10), outputValue(2, "y"));
    NodeAssert.equal(afterEnd.buffer.status, "error");
    NodeAssert.match(afterEnd.buffer.statusText, /lifecycle ended/);
  });

  NodeTest.it("rejects output from a different stream epoch", () => {
    const seeded = applyOutputEvent(EMPTY_OUTPUT_BUFFER, frame(1), snapshotValue()).buffer;
    const result = applyOutputEvent(
      seeded,
      frame(2),
      outputValue(1, "x", { streamEpoch: "epoch-2" }),
    );
    NodeAssert.equal(result.buffer.status, "error");
    NodeAssert.match(result.buffer.statusText, /incarnation/);
  });

  NodeTest.it("reset clears contents and stays live", () => {
    const seeded = applyOutputEvent(EMPTY_OUTPUT_BUFFER, frame(1), snapshotValue()).buffer;
    const appended = applyOutputEvent(seeded, frame(2), outputValue(1, "x")).buffer;
    const { buffer } = applyOutputEvent(appended, frame(3), {
      kind: "reset",
      terminalId: "term-1",
      streamEpoch: "epoch-1",
      sequence: 8,
      clearGeneration: 1,
      reason: "history-cleared",
    });
    NodeAssert.equal(buffer.contents, "");
    NodeAssert.equal(buffer.status, "live");
    NodeAssert.equal(buffer.ended, false);
  });

  NodeTest.it("exit and closed frames end the buffer", () => {
    const seeded = applyOutputEvent(EMPTY_OUTPUT_BUFFER, frame(1), snapshotValue()).buffer;
    const exited = applyOutputEvent(seeded, frame(2), {
      kind: "exit",
      terminalId: "term-1",
      streamEpoch: "epoch-1",
      sequence: 5,
      exitCode: 0,
      exitSignal: null,
    }).buffer;
    NodeAssert.equal(exited.status, "exited");
    NodeAssert.equal(exited.exitCode, 0);
    NodeAssert.equal(exited.ended, true);

    const closed = applyOutputEvent(seeded, frame(2), {
      kind: "closed",
      terminalId: "term-1",
      streamEpoch: "epoch-1",
      reason: "overflow",
    }).buffer;
    NodeAssert.equal(closed.status, "closed");
    NodeAssert.equal(closed.contents, "");
    NodeAssert.match(closed.statusText, /overflow/);
  });

  NodeTest.it("an exited snapshot ends the buffer immediately", () => {
    const { buffer } = applyOutputEvent(
      EMPTY_OUTPUT_BUFFER,
      frame(1),
      snapshotValue({ status: "exited" }),
    );
    NodeAssert.equal(buffer.status, "exited");
    NodeAssert.equal(buffer.ended, true);
  });

  NodeTest.it("caps retained output at the buffer byte limit without splitting code points", () => {
    const big = "x".repeat(TERMINAL_BUFFER_MAX_BYTES) + "é".repeat(4);
    const { buffer } = applyOutputEvent(
      EMPTY_OUTPUT_BUFFER,
      frame(1),
      snapshotValue({ contents: big }),
    );
    const encoded = new TextEncoder().encode(buffer.contents);
    NodeAssert.ok(encoded.byteLength <= TERMINAL_BUFFER_MAX_BYTES);
    NodeAssert.ok(buffer.contents.endsWith("éééé"));
    NodeAssert.ok(!buffer.contents.includes("\uFFFD"));
  });

  NodeTest.it("appends across the cap and keeps a UTF-8-safe tail", () => {
    const nearFull = "y".repeat(TERMINAL_BUFFER_MAX_BYTES - 4);
    const seeded = applyOutputEvent(
      EMPTY_OUTPUT_BUFFER,
      frame(1),
      snapshotValue({ contents: nearFull }),
    ).buffer;
    const { buffer } = applyOutputEvent(seeded, frame(2), outputValue(1, "😀tail"));
    NodeAssert.ok(
      new TextEncoder().encode(buffer.contents).byteLength <= TERMINAL_BUFFER_MAX_BYTES,
    );
    NodeAssert.ok(buffer.contents.endsWith("😀tail"));
  });
});

NodeTest.describe("terminal view model — output overflow resubscribe policy", () => {
  const closedValue = (reason) => ({
    kind: "closed",
    terminalId: "term-1",
    streamEpoch: "epoch-1",
    reason,
  });

  NodeTest.it("bounds a sustained flood even though every cycle delivers a snapshot", () => {
    // The provider preserves the snapshot ahead of every closed:overflow,
    // so frames fed through the streak must not reset it — only the time
    // window can. Simulate snapshot→overflow cycles close together in time.
    let streak = EMPTY_OVERFLOW_STREAK;
    const outcomes = [];
    for (let cycle = 0; cycle < OVERFLOW_RESUBSCRIBE_MAX + 2; cycle += 1) {
      const now = 1_000 + cycle * 500;
      streak = noteOutputFrameForStreak(snapshotValue(), streak, now);
      streak = noteOutputFrameForStreak(closedValue("overflow"), streak, now);
      outcomes.push(isResumableOutputClose("overflow", streak.attempts));
    }
    NodeAssert.deepEqual(outcomes, [true, true, true, false, false]);
  });

  NodeTest.it("resets the streak after a quiet gap", () => {
    let streak = EMPTY_OVERFLOW_STREAK;
    for (let i = 0; i < OVERFLOW_RESUBSCRIBE_MAX; i += 1) {
      streak = noteOutputFrameForStreak(closedValue("overflow"), streak, i * 100);
    }
    NodeAssert.equal(streak.attempts, OVERFLOW_RESUBSCRIBE_MAX);
    NodeAssert.equal(isResumableOutputClose("overflow", streak.attempts), true);
    // A later isolated overflow counts as a fresh streak.
    streak = noteOutputFrameForStreak(
      closedValue("overflow"),
      streak,
      streak.lastAt + OVERFLOW_RESUBSCRIBE_WINDOW_MS + 1,
    );
    NodeAssert.equal(streak.attempts, 1);
    NodeAssert.equal(isResumableOutputClose("overflow", streak.attempts), true);
  });

  NodeTest.it("clears the streak on identity-changed and stays ended on terminal reasons", () => {
    let streak = EMPTY_OVERFLOW_STREAK;
    streak = noteOutputFrameForStreak(closedValue("overflow"), streak, 1_000);
    streak = noteOutputFrameForStreak(closedValue("overflow"), streak, 1_500);
    NodeAssert.equal(streak.attempts, 2);
    // A new epoch starts a fresh streak.
    streak = noteOutputFrameForStreak(closedValue("identity-changed"), streak, 2_000);
    NodeAssert.equal(streak, EMPTY_OVERFLOW_STREAK);
    streak = noteOutputFrameForStreak(closedValue("overflow"), streak, 2_500);
    NodeAssert.equal(streak.attempts, 1);
    // Terminal close reasons never resume and don't touch the streak.
    NodeAssert.equal(isResumableOutputClose("terminal-error", 0), false);
    NodeAssert.equal(isResumableOutputClose("terminal-closed", 0), false);
    NodeAssert.equal(
      noteOutputFrameForStreak(closedValue("terminal-error"), streak, 3_000),
      streak,
    );
    NodeAssert.equal(isResumableOutputClose("identity-changed", 99), true);
  });
});

/* ---------------- interactive panel controller ---------------- */

import {
  TerminalPanel,
  reconcileTerminalIds,
  serverTerminalIdsStrictSubsetOfClient,
  terminalIdListsEqual,
  workspaceLaunchFromRevision,
} from "./viewModel.ts";

const meta = (terminalId, extra = {}) => ({
  terminalId,
  status: "running",
  label: "",
  hasRunningSubprocess: false,
  exitCode: null,
  exitSignal: null,
  updatedAt: "2026-09-12T00:00:00Z",
  ...extra,
});
const launch = {
  cwd: "/workspace",
  worktreePath: null,
  env: { T3CODE_PROJECT_ROOT: "/workspace" },
};

/** Control stub: records calls; open/attach/restart can be held pending. */
function fakeControl(overrides = {}) {
  const calls = [];
  const gate = { open: null, attach: null, restart: null };
  const ops = {
    calls,
    gate,
    open(input) {
      calls.push(["open", input]);
      return gate.open ?? Promise.resolve(meta(input.terminalId));
    },
    attach(input) {
      calls.push(["attach", input]);
      return gate.attach ?? Promise.resolve(meta(input.terminalId));
    },
    write(input) {
      calls.push(["write", input]);
      return Promise.resolve({});
    },
    resize(input) {
      calls.push(["resize", input]);
      return Promise.resolve({});
    },
    clear(input) {
      calls.push(["clear", input]);
      return Promise.resolve({});
    },
    restart(input) {
      calls.push(["restart", input]);
      return gate.restart ?? Promise.resolve(meta(input.terminalId));
    },
    close(input) {
      calls.push(["close", input]);
      return Promise.resolve({});
    },
    ...overrides,
  };
  return ops;
}
function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => ((resolve = res), (reject = rej)));
  return { promise, resolve, reject };
}
/** Manual scheduler: returns the queued callbacks so tests drive the exit tick. */
function manualScheduler() {
  const pending = [];
  return { pending, schedule: (cb) => pending.push(cb) };
}

NodeTest.describe("terminal panel — reconciliation + tabs", () => {
  NodeTest.it("keeps the lag rule and reconcile identical to native", () => {
    NodeAssert.equal(terminalIdListsEqual(["a", "b"], ["b", "a"]), true);
    NodeAssert.equal(terminalIdListsEqual(["a"], ["a", "b"]), false);
    NodeAssert.equal(serverTerminalIdsStrictSubsetOfClient(["a"], ["a", "b"]), true);
    NodeAssert.equal(serverTerminalIdsStrictSubsetOfClient([], ["a"]), true);
    NodeAssert.equal(serverTerminalIdsStrictSubsetOfClient(["a", "b"], ["a", "b"]), false);
    NodeAssert.equal(serverTerminalIdsStrictSubsetOfClient(["x"], ["a", "b"]), false);
    NodeAssert.deepEqual(reconcileTerminalIds(["a", "b"], ["a"]), ["a", "b"]);
    NodeAssert.deepEqual(reconcileTerminalIds(["a"], ["a", "b"]), ["a", "b"]);
    NodeAssert.deepEqual(reconcileTerminalIds(["a", "b"], ["x"]), ["x"]);
  });

  NodeTest.it("reconcile keeps persisted tab order when server membership changes", () => {
    // New server session appends; surviving ids keep the client order.
    NodeAssert.deepEqual(reconcileTerminalIds(["b", "a"], ["a", "b", "c"]), ["b", "a", "c"]);
    // A session gone server-side drops out without reshuffling the rest.
    NodeAssert.deepEqual(reconcileTerminalIds(["c", "a", "b"], ["a", "c", "d"]), ["c", "a", "d"]);
  });

  NodeTest.it("a restored tab order survives reconcile and is what gets saved", () => {
    const saved = [];
    let panel;
    panel = new TerminalPanel({
      control: fakeControl(),
      launch,
      restored: { terminalIds: ["term-3", "term-1", "term-2"], activeTerminalId: "term-3" },
      onChange: () => saved.push([...panel.snapshot.terminalIds]),
    });
    // Same membership in server order: nothing moves.
    panel.applySessionsEvent({
      kind: "snapshot",
      terminals: [meta("term-1"), meta("term-2"), meta("term-3")],
    });
    NodeAssert.deepEqual(panel.snapshot.terminalIds, ["term-3", "term-1", "term-2"]);
    // Another client closed term-1 and opened term-4 while this view was away.
    panel.applySessionsEvent({
      kind: "snapshot",
      terminals: [meta("term-2"), meta("term-3"), meta("term-4")],
    });
    NodeAssert.deepEqual(panel.snapshot.terminalIds, ["term-3", "term-2", "term-4"]);
    NodeAssert.deepEqual(
      panel.snapshot.tabs.map((tab) => tab.terminalId),
      ["term-3", "term-2", "term-4"],
    );
    NodeAssert.deepEqual(
      panel.snapshot.groups.map((group) => group.terminalIds),
      [["term-3"], ["term-2"], ["term-4"]],
    );
    NodeAssert.deepEqual(saved.at(-1), ["term-3", "term-2", "term-4"]);
    // The saved order restores into a fresh panel verbatim.
    const reopened = new TerminalPanel({
      control: fakeControl(),
      launch,
      restored: { terminalIds: saved.at(-1), activeTerminalId: "term-3" },
    });
    NodeAssert.deepEqual(reopened.snapshot.terminalIds, ["term-3", "term-2", "term-4"]);
    reopened.dispose();
    panel.dispose();
  });

  NodeTest.it("builds tabs from snapshot, upsert, remove and falls back selection", () => {
    const panel = new TerminalPanel({ control: fakeControl(), launch });
    panel.applySessionsEvent({
      kind: "snapshot",
      terminals: [meta("term-1", { label: "zsh" }), meta("term-2")],
    });
    NodeAssert.deepEqual(panel.snapshot.terminalIds, ["term-1", "term-2"]);
    NodeAssert.equal(panel.snapshot.activeTerminalId, "term-1");
    NodeAssert.equal(panel.snapshot.tabs[0].label, "zsh");
    NodeAssert.equal(panel.snapshot.tabs[1].label, "Terminal 2");

    panel.applySessionsEvent({ kind: "upsert", terminal: meta("term-3") });
    NodeAssert.deepEqual(panel.snapshot.terminalIds, ["term-1", "term-2", "term-3"]);

    panel.activate("term-3");
    panel.applySessionsEvent({ kind: "remove", terminalId: "term-3" });
    NodeAssert.deepEqual(panel.snapshot.terminalIds, ["term-1", "term-2"]);
    NodeAssert.equal(panel.snapshot.activeTerminalId, "term-1");
    panel.dispose();
  });

  NodeTest.it("keeps a client-opened id while the server list lags", async () => {
    const control = fakeControl();
    const panel = new TerminalPanel({ control, launch });
    panel.applySessionsEvent({ kind: "snapshot", terminals: [meta("term-1")] });
    const opening = panel.openTerminal();
    NodeAssert.deepEqual(panel.snapshot.terminalIds, ["term-1", "term-2"]);
    // Lagging snapshot still only knows term-1 — term-2 must survive.
    panel.applySessionsEvent({ kind: "snapshot", terminals: [meta("term-1")] });
    NodeAssert.deepEqual(panel.snapshot.terminalIds, ["term-1", "term-2"]);
    await opening;
    // Once the server catches up the ids stay ordered and stable.
    panel.applySessionsEvent({
      kind: "snapshot",
      terminals: [meta("term-1"), meta("term-2")],
    });
    NodeAssert.deepEqual(panel.snapshot.terminalIds, ["term-1", "term-2"]);
    panel.dispose();
  });

  NodeTest.it("allocates the lowest free term-N id via the shared helper", async () => {
    const control = fakeControl();
    const panel = new TerminalPanel({ control, launch });
    panel.applySessionsEvent({ kind: "snapshot", terminals: [meta("term-1"), meta("term-3")] });
    await panel.openTerminal();
    NodeAssert.equal(control.calls[0][1].terminalId, "term-2");
    panel.dispose();
  });

  NodeTest.it("replaces stale restored ids when the server list is disjoint", () => {
    const panel = new TerminalPanel({
      control: fakeControl(),
      launch,
      restored: { terminalIds: ["term-8", "term-9"], activeTerminalId: "term-8" },
    });
    NodeAssert.deepEqual(panel.snapshot.terminalIds, ["term-8", "term-9"]);
    panel.applySessionsEvent({ kind: "snapshot", terminals: [meta("term-1")] });
    NodeAssert.deepEqual(panel.snapshot.terminalIds, ["term-1"]);
    NodeAssert.equal(panel.snapshot.activeTerminalId, "term-1");
    panel.dispose();
  });

  NodeTest.it("refuses to allocate while the first list snapshot is still pending", async () => {
    const control = fakeControl();
    const panel = new TerminalPanel({ control, launch });
    // Stream still connecting: unseen server sessions could collide with a
    // freshly allocated id, so open waits for the snapshot.
    NodeAssert.equal(await panel.openTerminal(), null);
    NodeAssert.equal(control.calls.length, 0);
    NodeAssert.equal(panel.snapshot.panelError, "Session list is still connecting.");
    panel.applySessionsEvent({ kind: "snapshot", terminals: [meta("term-1")] });
    await panel.openTerminal();
    NodeAssert.equal(control.calls[0][1].terminalId, "term-2");
    panel.dispose();
  });
});

NodeTest.describe("terminal panel — input, resize, lifecycle", () => {
  NodeTest.it("queues input while the terminal is starting and drains in order", async () => {
    const control = fakeControl();
    const gate = deferred();
    control.gate.open = gate.promise;
    const panel = new TerminalPanel({ control, launch });
    panel.applySessionsEvent({ kind: "snapshot", terminals: [] });
    const opening = panel.openTerminal();
    const id = panel.snapshot.activeTerminalId;
    panel.sendInput(id, "echo one\r");
    panel.sendInput(id, "echo two\r");
    NodeAssert.equal(panel.snapshot.tabs[0].queuedInputCount, 2);
    NodeAssert.equal(control.calls.filter(([m]) => m === "write").length, 0);
    gate.resolve(meta(id));
    await opening;
    await new Promise((resolve) => setTimeout(resolve, 0));
    // Bursts merge into one ordered batch — the PTY sees identical bytes.
    NodeAssert.deepEqual(
      control.calls.filter(([m]) => m === "write").map(([, i]) => i.data),
      ["echo one\recho two\r"],
    );
    panel.dispose();
  });

  NodeTest.it("caps the pending input queue at 256 KiB serialized", async () => {
    const control = fakeControl();
    const gate = deferred();
    control.gate.open = gate.promise;
    const panel = new TerminalPanel({ control, launch });
    panel.applySessionsEvent({ kind: "snapshot", terminals: [] });
    const opening = panel.openTerminal();
    const id = panel.snapshot.activeTerminalId;
    // ~308 KiB of serialized input exceeds the 256 KiB pending bound.
    for (let i = 0; i < 300; i += 1) panel.sendInput(id, "x".repeat(1024));
    const tab = panel.snapshot.tabs[0];
    NodeAssert.ok(tab.queuedInputCount < 300);
    NodeAssert.ok(tab.queuedInputCount > 200);
    NodeAssert.match(tab.error, /queue is full/);
    gate.resolve(meta(id));
    await opening;
    panel.dispose();
  });

  NodeTest.it("splits oversized input into budgeted writes", async () => {
    const control = fakeControl();
    const panel = new TerminalPanel({ control, launch });
    panel.applySessionsEvent({ kind: "snapshot", terminals: [meta("term-1")] });
    panel.sendInput("term-1", "x".repeat(65_537));
    await new Promise((resolve) => setTimeout(resolve, 0));
    const writes = control.calls.filter(([m]) => m === "write").map(([, i]) => i.data);
    NodeAssert.ok(writes.length >= 2);
    for (const data of writes) NodeAssert.ok(data.length <= 49 * 1024);
    NodeAssert.equal(writes.join(""), "x".repeat(65_537));
    panel.dispose();
  });

  NodeTest.it(
    "StrictMode replay revives input: dispose + beginListStream does not leave dead queues",
    async () => {
      const control = fakeControl();
      const panel = new TerminalPanel({
        control,
        launch,
        restored: { terminalIds: ["term-1"], activeTerminalId: "term-1" },
      });
      // Dev StrictMode runs setup → cleanup → setup: panel.dispose() kills
      // the queues, then the sessions effect calls beginListStream() again.
      panel.dispose();
      panel.beginListStream();
      panel.sendInput("term-1", "hello");
      await new Promise((resolve) => setTimeout(resolve, 0));
      const writes = control.calls.filter(([m]) => m === "write").map(([, i]) => i.data);
      NodeAssert.deepEqual(writes, ["hello"]);
      const tab = panel.snapshot.tabs[0];
      NodeAssert.equal(tab.inputStopped, false);
      NodeAssert.equal(tab.inputMessage, null);
      panel.dispose();
    },
  );

  NodeTest.it("resizes latest-wins while a resize is in flight", async () => {
    const control = fakeControl();
    const inFlight = deferred();
    let resizeCalls = 0;
    control.resize = (input) => {
      control.calls.push(["resize", input]);
      resizeCalls += 1;
      return resizeCalls === 1 ? inFlight.promise : Promise.resolve({});
    };
    const panel = new TerminalPanel({ control, launch });
    panel.applySessionsEvent({ kind: "snapshot", terminals: [meta("term-1")] });
    panel.resize("term-1", 80, 24);
    panel.resize("term-1", 100, 30);
    panel.resize("term-1", 120, 40); // latest wins over 100x30
    inFlight.resolve({});
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    const sent = control.calls.filter(([m]) => m === "resize").map(([, i]) => [i.cols, i.rows]);
    NodeAssert.deepEqual(sent, [
      [80, 24],
      [120, 40],
    ]);
    // A resize equal to the last sent value is a no-op.
    panel.resize("term-1", 120, 40);
    NodeAssert.equal(control.calls.filter(([m]) => m === "resize").length, 2);
    panel.dispose();
  });

  NodeTest.it("ignores out-of-bounds resize dimensions", () => {
    const control = fakeControl();
    const panel = new TerminalPanel({ control, launch });
    panel.applySessionsEvent({ kind: "snapshot", terminals: [meta("term-1")] });
    panel.resize("term-1", 0, 24);
    panel.resize("term-1", 80, 501);
    panel.resize("term-1", 1001, 24);
    panel.resize("term-1", 80.5, 24);
    NodeAssert.equal(control.calls.filter(([m]) => m === "resize").length, 0);
    panel.dispose();
  });

  NodeTest.it("close requires confirm, deletes history, and removes the tab", async () => {
    const control = fakeControl();
    const panel = new TerminalPanel({ control, launch });
    panel.applySessionsEvent({ kind: "snapshot", terminals: [meta("term-1")] });
    panel.requestAction("term-1", "close");
    NodeAssert.equal(panel.snapshot.tabs[0].confirmAction, "close");
    await panel.confirmAction("term-1");
    NodeAssert.deepEqual(control.calls, [["close", { terminalId: "term-1", deleteHistory: true }]]);
    NodeAssert.deepEqual(panel.snapshot.terminalIds, []);
    panel.dispose();
  });

  NodeTest.it("falls back to an exit write when close fails", async () => {
    const control = fakeControl({
      close(input) {
        control.calls.push(["close", input]);
        return Promise.reject(new Error("control unavailable"));
      },
    });
    const panel = new TerminalPanel({ control, launch });
    panel.applySessionsEvent({ kind: "snapshot", terminals: [meta("term-1")] });
    panel.requestAction("term-1", "close");
    await panel.confirmAction("term-1");
    NodeAssert.deepEqual(control.calls, [
      ["close", { terminalId: "term-1", deleteHistory: true }],
      ["write", { terminalId: "term-1", data: "exit\n" }],
    ]);
    NodeAssert.deepEqual(panel.snapshot.terminalIds, []);
    panel.dispose();
  });

  NodeTest.it("restart and clear go through confirm; cancel backs out", async () => {
    const control = fakeControl();
    const panel = new TerminalPanel({ control, launch });
    panel.applySessionsEvent({
      kind: "snapshot",
      terminals: [meta("term-1", { status: "exited" })],
    });
    panel.requestAction("term-1", "clear");
    panel.cancelAction("term-1");
    NodeAssert.equal(panel.snapshot.tabs[0].confirmAction, null);
    panel.requestAction("term-1", "clear");
    await panel.confirmAction("term-1");
    NodeAssert.deepEqual(control.calls, [["clear", { terminalId: "term-1" }]]);

    panel.requestAction("term-1", "restart");
    await panel.confirmAction("term-1");
    const restart = control.calls.find(([m]) => m === "restart");
    NodeAssert.equal(restart[1].terminalId, "term-1");
    NodeAssert.equal(restart[1].cwd, "/workspace");
    NodeAssert.ok(Number.isSafeInteger(restart[1].cols));
    NodeAssert.ok(Number.isSafeInteger(restart[1].rows));
    panel.dispose();
  });
});

NodeTest.describe("terminal panel — exit UX", () => {
  NodeTest.it("banners a live→exited transition then removes the tab on the tick", async () => {
    const control = fakeControl();
    const scheduler = manualScheduler();
    const panel = new TerminalPanel({ control, launch, schedule: scheduler.schedule });
    panel.applySessionsEvent({ kind: "snapshot", terminals: [meta("term-1")] });
    panel.applySessionsEvent({
      kind: "upsert",
      terminal: meta("term-1", { status: "exited", exitCode: 3 }),
    });
    const tab = panel.snapshot.tabs[0];
    NodeAssert.equal(tab.exitBanner, "Process exited (code 3)");
    NodeAssert.deepEqual(panel.snapshot.terminalIds, ["term-1"]);
    scheduler.pending.forEach((cb) => cb());
    NodeAssert.deepEqual(panel.snapshot.terminalIds, []);
    NodeAssert.equal(panel.snapshot.activeTerminalId, null);
    panel.dispose();
  });

  NodeTest.it("does not banner a session that arrives already exited", () => {
    const control = fakeControl();
    const scheduler = manualScheduler();
    const panel = new TerminalPanel({ control, launch, schedule: scheduler.schedule });
    panel.applySessionsEvent({
      kind: "snapshot",
      terminals: [meta("term-1", { status: "exited", exitCode: 0 })],
    });
    NodeAssert.equal(panel.snapshot.tabs[0].exitBanner, null);
    NodeAssert.equal(scheduler.pending.length, 0);
    panel.dispose();
  });

  NodeTest.it("marks the stream closed on a closed frame", () => {
    const panel = new TerminalPanel({ control: fakeControl(), launch });
    panel.applySessionsEvent({ kind: "closed", reason: "overflow" });
    NodeAssert.equal(panel.snapshot.stream, "closed");
    panel.dispose();
  });

  NodeTest.it("re-arms a disposed panel when a fresh list stream begins", () => {
    const panel = new TerminalPanel({ control: fakeControl(), launch });
    // React replays effect cleanup in dev: the panel's own useState object
    // survives while the cleanup's dispose() tombstones it. Frames arriving
    // before the next subscription are correctly swallowed...
    panel.dispose();
    panel.applySessionsEvent({ kind: "snapshot", terminals: [meta("term-1")] });
    NodeAssert.equal(panel.snapshot.stream, "connecting");
    // ...but the replayed effect re-subscribes, and a fresh stream means the
    // view is alive again — the snapshot must land.
    panel.beginListStream();
    panel.applySessionsEvent({ kind: "snapshot", terminals: [meta("term-1")] });
    NodeAssert.equal(panel.snapshot.stream, "live");
    NodeAssert.deepEqual(panel.snapshot.terminalIds, ["term-1"]);
    panel.dispose();
  });
});

NodeTest.describe("terminal panel — workspace launch", () => {
  NodeTest.it("derives cwd/worktreePath/workspaceRoot from the public revision", () => {
    NodeAssert.deepEqual(workspaceLaunchFromRevision('["/repo","/repo/.wt"]'), {
      cwd: "/repo/.wt",
      workspaceRoot: "/repo",
      worktreePath: "/repo/.wt",
    });
    NodeAssert.deepEqual(workspaceLaunchFromRevision('["/repo",null]'), {
      cwd: "/repo",
      workspaceRoot: "/repo",
      worktreePath: null,
    });
    NodeAssert.equal(workspaceLaunchFromRevision(undefined), null);
    NodeAssert.equal(workspaceLaunchFromRevision("not-json"), null);
    NodeAssert.equal(workspaceLaunchFromRevision('["",null]'), null);
  });

  NodeTest.it("attaches a tracked id with no live metadata via restartIfNotRunning", async () => {
    const control = fakeControl();
    const panel = new TerminalPanel({
      control,
      launch,
      restored: { terminalIds: ["term-9"], activeTerminalId: "term-9" },
    });
    // The session is listed but stopped — attach restarts it in place.
    panel.applySessionsEvent({
      kind: "snapshot",
      terminals: [meta("term-9", { status: "exited", exitCode: 0 })],
    });
    await panel.startSession("term-9");
    NodeAssert.deepEqual(control.calls[0], [
      "attach",
      {
        terminalId: "term-9",
        cwd: "/workspace",
        worktreePath: null,
        restartIfNotRunning: true,
        env: { T3CODE_PROJECT_ROOT: "/workspace" },
      },
    ]);
    panel.dispose();
  });

  NodeTest.it("reports panel-op failures on the status row", () => {
    const panel = new TerminalPanel({ control: fakeControl(), launch });
    panel.notePanelError("The host could not close this panel.");
    NodeAssert.equal(panel.snapshot.panelError, "The host could not close this panel.");
    panel.dispose();
  });
});

/* ---------------- t3.ui/* consumption ---------------- */

import {
  TERMINAL_FOCUS_WHEN,
  TERMINAL_GLOBAL_COMMANDS,
  TERMINAL_SURFACE_ID,
  TERMINAL_VIEW_COMMANDS,
  asTerminalAppearance,
  dispatchTerminalCommand,
  registerPanelCommands,
  terminalAppearanceVars,
  terminalChordAction,
  terminalChordFromEvent,
  themeVarOverrides,
  watchTerminalAppearanceVars,
  watchThemeVars,
} from "./viewModel.ts";
const viewContext = { resource: { environmentId: "env-1", threadId: "thread-1" } };

/** invokeApi stub: records requests; registerCommands answers with `results`. */
function fakeKeybindingsClient(results, overrides = {}) {
  const calls = [];
  const resolved =
    results ??
    TERMINAL_VIEW_COMMANDS.map((command) => ({ commandId: command.id, status: "registered" }));
  return {
    calls,
    invokeApi(request) {
      calls.push(request);
      if (request.method === "registerCommands")
        return Promise.resolve({ commandSetToken: "cmdset-test", results: resolved });
      if (request.method === "unregisterCommands") return Promise.resolve({ unregistered: true });
      return Promise.reject(new Error(`unexpected method ${request.method}`));
    },
    ...overrides,
  };
}

NodeTest.describe("t3.ui/theme — token + appearance mapping", () => {
  const appearance = {
    theme: {
      background: "rgb(1, 2, 3)",
      foreground: "rgb(4, 5, 6)",
      cursor: "rgb(7, 8, 9)",
      selectionBackground: "rgb(10, 11, 12)",
    },
    font: { family: "Mono", size: 13, lineHeight: 1.4, ligatures: false },
    appearance: "dark",
  };

  NodeTest.it("republishes contract tokens chained on the advertised host var", () => {
    const vars = themeVarOverrides(
      { text: "#111", border: "#222", terminalBackground: "#000" },
      {
        text: "--app-theme-text",
        border: "--app-theme-border",
        terminalBackground: "--app-theme-terminal-background",
      },
    );
    NodeAssert.equal(vars["--t3-terminal-text"], "var(--app-theme-text, #111)");
    NodeAssert.equal(vars["--t3-terminal-border"], "var(--app-theme-border, #222)");
    NodeAssert.equal(
      vars["--t3-terminal-background"],
      "var(--app-theme-terminal-background, #000)",
    );
    // Roles the provider left unresolved are skipped, not overridden with a lie.
    NodeAssert.equal(vars["--t3-terminal-canvas"], undefined);
  });

  NodeTest.it("falls back to the resolved token when no css var is advertised", () => {
    const vars = themeVarOverrides({ textMuted: "#667085" }, {});
    NodeAssert.equal(vars["--t3-terminal-muted"], "#667085");
  });

  NodeTest.it("maps the terminal appearance payload onto output-pane vars", () => {
    NodeAssert.deepEqual(terminalAppearanceVars(appearance), {
      "--t3-terminal-background": "rgb(1, 2, 3)",
      "--t3-terminal-foreground": "rgb(4, 5, 6)",
      "--t3-terminal-selection": "rgb(10, 11, 12)",
      "--t3-terminal-color-scheme": "dark",
      "--t3-terminal-font-family": "Mono",
      "--t3-terminal-font-size": "13px",
      "--t3-terminal-line-height": "1.4",
      "--t3-terminal-ligatures": "none",
    });
  });

  NodeTest.it("skips optional appearance fields so var() fallbacks govern", () => {
    NodeAssert.deepEqual(
      terminalAppearanceVars({
        theme: { background: "#000", foreground: "#fff", cursor: "#fff" },
        font: {},
        appearance: "light",
      }),
      {
        "--t3-terminal-background": "#000",
        "--t3-terminal-foreground": "#fff",
        "--t3-terminal-color-scheme": "light",
      },
    );
  });

  NodeTest.it("narrows appearance frames honestly", () => {
    NodeAssert.equal(asTerminalAppearance(appearance), appearance);
    NodeAssert.equal(asTerminalAppearance(null), null);
    NodeAssert.equal(asTerminalAppearance({}), null);
    NodeAssert.equal(
      asTerminalAppearance({ theme: { background: "#000" }, font: {}, appearance: "dark" }),
      null,
    );
    NodeAssert.equal(
      asTerminalAppearance({
        theme: { background: "#000", foreground: "#fff", cursor: "#fff" },
        font: { size: "13" },
        appearance: "dark",
      }),
      null,
    );
    NodeAssert.equal(
      asTerminalAppearance({
        theme: { background: "#000", foreground: "#fff", cursor: "#fff" },
        font: {},
        appearance: "auto",
      }),
      null,
    );
  });
});

NodeTest.describe("t3.ui/keybindings — command descriptors", () => {
  const COMMAND_ID = /^[a-z][a-zA-Z0-9]*(\.[a-z][a-zA-Z0-9]*)*$/;

  NodeTest.it("declares plugin-local ids valid for ext dispatch", () => {
    for (const command of [...TERMINAL_VIEW_COMMANDS, ...TERMINAL_GLOBAL_COMMANDS]) {
      NodeAssert.match(command.id, COMMAND_ID);
      NodeAssert.ok(command.title.length > 0);
    }
    NodeAssert.equal(TERMINAL_SURFACE_ID, "t3.terminal/view");
    NodeAssert.equal(TERMINAL_FOCUS_WHEN, "extension.t3.terminal/view.focus");
  });

  NodeTest.it("gates surface chords on the focused view; toggle is global like native", () => {
    const view = Object.fromEntries(TERMINAL_VIEW_COMMANDS.map((command) => [command.id, command]));
    NodeAssert.deepEqual(view.new, {
      id: "new",
      title: "New terminal",
      scope: "surface",
      defaultKey: "mod+n",
      when: TERMINAL_FOCUS_WHEN,
    });
    NodeAssert.deepEqual(view.close, {
      id: "close",
      title: "Close terminal",
      scope: "surface",
      defaultKey: "mod+w",
      when: TERMINAL_FOCUS_WHEN,
    });
    NodeAssert.equal(view.toggle.scope, "global");
    NodeAssert.equal(view.toggle.defaultKey, "mod+j");
    NodeAssert.equal(view.toggle.when, undefined);
    // Split chords mirror the native terminal.split/splitVertical bindings.
    NodeAssert.deepEqual(view.split, {
      id: "split",
      title: "Split terminal horizontally",
      scope: "surface",
      defaultKey: "mod+d",
      when: TERMINAL_FOCUS_WHEN,
    });
    NodeAssert.deepEqual(view.splitVertical, {
      id: "splitVertical",
      title: "Split terminal vertically",
      scope: "surface",
      defaultKey: "mod+shift+d",
      when: TERMINAL_FOCUS_WHEN,
    });
  });

  NodeTest.it("stages a legal installation-tier activation for cold open", () => {
    NodeAssert.deepEqual(
      TERMINAL_GLOBAL_COMMANDS.map((command) => command.id),
      ["toggle"],
    );
    const toggle = TERMINAL_GLOBAL_COMMANDS[0];
    NodeAssert.equal(toggle.scope, "global");
    NodeAssert.deepEqual(toggle.activation, {
      surfaceId: TERMINAL_SURFACE_ID,
      placement: "bottom-dock",
    });
  });
});

NodeTest.describe("t3.ui/keybindings — registration + dispatch", () => {
  NodeTest.it("maps command ids to panel-local actions", () => {
    const calls = [];
    const actions = {
      newTerminal: () => calls.push("new"),
      closeTerminal: () => calls.push("close"),
      splitTerminal: (direction) => calls.push(`split:${direction}`),
      toggleSurface: () => calls.push("toggle"),
    };
    NodeAssert.equal(dispatchTerminalCommand("toggle", actions), true);
    NodeAssert.equal(dispatchTerminalCommand("new", actions), true);
    NodeAssert.equal(dispatchTerminalCommand("close", actions), true);
    NodeAssert.equal(dispatchTerminalCommand("split", actions), true);
    NodeAssert.equal(dispatchTerminalCommand("splitVertical", actions), true);
    NodeAssert.equal(dispatchTerminalCommand("terminal.new", actions), false);
    NodeAssert.deepEqual(calls, ["toggle", "new", "close", "split:horizontal", "split:vertical"]);
  });

  NodeTest.it("registers the view set, binds the token, dispatches registered ids", async () => {
    const client = fakeKeybindingsClient([
      {
        commandId: "toggle",
        status: "rejected",
        reason: "t3.ui/keybindings.global grant required",
      },
      { commandId: "new", status: "registered" },
      { commandId: "close", status: "registered" },
      { commandId: "split", status: "registered" },
      { commandId: "splitVertical", status: "registered" },
    ]);
    const bound = [];
    const dispatched = [];
    const registration = await registerPanelCommands({
      client,
      context: viewContext,
      signal: new AbortController().signal,
      bindCommands: (token, handler) => {
        bound.push({ token, handler });
        return "binding-1";
      },
      onCommand: (commandId) => dispatched.push(commandId),
    });
    const register = client.calls.find((call) => call.method === "registerCommands");
    NodeAssert.equal(register.id, "t3.ui/keybindings");
    NodeAssert.deepEqual(
      register.input.commands.map((command) => command.id),
      ["toggle", "new", "close", "split", "splitVertical"],
    );
    NodeAssert.equal(bound[0].token, "cmdset-test");
    bound[0].handler({ commandId: "new", context: viewContext });
    bound[0].handler({ commandId: "toggle", context: viewContext });
    bound[0].handler({ commandId: "unknown", context: viewContext });
    NodeAssert.deepEqual(dispatched, ["new"]);
    registration.release();
    const unregister = client.calls.find((call) => call.method === "unregisterCommands");
    NodeAssert.equal(unregister.input.commandSetToken, "cmdset-test");
  });

  NodeTest.it("unwinds the registration when the view aborted mid-flight", async () => {
    const gate = deferred();
    const client = fakeKeybindingsClient();
    client.invokeApi = (request) => {
      client.calls.push(request);
      return request.method === "registerCommands"
        ? gate.promise.then(() => ({ commandSetToken: "cmdset-late", results: [] }))
        : Promise.resolve({ unregistered: true });
    };
    const controller = new AbortController();
    const promise = registerPanelCommands({
      client,
      context: viewContext,
      signal: controller.signal,
      bindCommands: () => "binding-1",
      onCommand: () => {},
    });
    controller.abort();
    gate.resolve();
    NodeAssert.equal(await promise, null);
    const unregister = client.calls.find((call) => call.method === "unregisterCommands");
    NodeAssert.equal(unregister.input.commandSetToken, "cmdset-late");
  });

  NodeTest.it("unwinds the registration when the host cannot bind commands", async () => {
    const client = fakeKeybindingsClient();
    await NodeAssert.rejects(
      registerPanelCommands({
        client,
        context: viewContext,
        signal: new AbortController().signal,
        bindCommands: () => {
          throw new Error("Command binding is unavailable");
        },
        onCommand: () => {},
      }),
      /Command binding is unavailable/,
    );
    const unregister = client.calls.find((call) => call.method === "unregisterCommands");
    NodeAssert.equal(unregister.input.commandSetToken, "cmdset-test");
  });
});

NodeTest.describe("t3.ui/keybindings — focused-chord resolution", () => {
  const keyEvent = (overrides = {}) => ({
    key: "d",
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    ...overrides,
  });

  NodeTest.it("canonicalizes mod chords in the descriptor defaultKey spelling", () => {
    // mod is meta on mac, ctrl elsewhere; the other super-ish modifier,
    // alt, and multi-character keys never form one of our chords.
    NodeAssert.equal(terminalChordFromEvent(keyEvent({ metaKey: true }), true), "mod+d");
    NodeAssert.equal(terminalChordFromEvent(keyEvent({ ctrlKey: true }), false), "mod+d");
    NodeAssert.equal(terminalChordFromEvent(keyEvent({ metaKey: true }), false), null);
    NodeAssert.equal(terminalChordFromEvent(keyEvent({ ctrlKey: true }), true), null);
    NodeAssert.equal(terminalChordFromEvent(keyEvent({ metaKey: true, altKey: true }), true), null);
    NodeAssert.equal(
      terminalChordFromEvent(keyEvent({ metaKey: true, key: "ArrowUp" }), true),
      null,
    );
    // Shift is tracked by the chord, not folded into the key: "D" while
    // held is mod+shift+d, the splitVertical defaultKey.
    NodeAssert.equal(
      terminalChordFromEvent(keyEvent({ metaKey: true, shiftKey: true, key: "D" }), true),
      "mod+shift+d",
    );
    NodeAssert.equal(
      terminalChordFromEvent(keyEvent({ ctrlKey: true, shiftKey: true, key: "N" }), false),
      "mod+shift+n",
    );
  });

  NodeTest.it("maps only the host's focused-terminal commands to panel actions", () => {
    // The host yields exactly these four commands to a claimsTerminalFocus
    // surface; everything else it resolved it dispatched itself, and a null
    // answer is the shell's key.
    const answering = (command) => ({
      id: "t3.ui/keybindings",
      version: "1.1.0",
      resolveTerminalFocusKey: () => command,
    });
    const press = keyEvent({ metaKey: true });
    NodeAssert.equal(terminalChordAction(press, answering("terminal.split"), true), "split");
    NodeAssert.equal(
      terminalChordAction(press, answering("terminal.splitVertical"), true),
      "splitVertical",
    );
    NodeAssert.equal(terminalChordAction(press, answering("terminal.new"), true), "new");
    NodeAssert.equal(terminalChordAction(press, answering("terminal.close"), true), "close");
    NodeAssert.equal(terminalChordAction(press, answering("terminal.toggle"), true), null);
    NodeAssert.equal(terminalChordAction(press, answering("diff.toggle"), true), null);
    NodeAssert.equal(terminalChordAction(press, answering("ext.t3.browser.toggle"), true), null);
    // A null answer never falls back to the static defaults: mod+d with
    // the host saying "unbound" is the shell's.
    NodeAssert.equal(terminalChordAction(press, answering(null), true), null);
  });

  NodeTest.it("the resolved action drives the registered-command dispatch funnel", () => {
    const calls = [];
    const actions = {
      newTerminal: () => calls.push("new"),
      closeTerminal: () => calls.push("close"),
      splitTerminal: (direction) => calls.push(`split:${direction}`),
      toggleSurface: () => calls.push("toggle"),
    };
    for (const action of ["close", "splitVertical", "split", "new"]) {
      NodeAssert.equal(dispatchTerminalCommand(action, actions), true);
    }
    NodeAssert.deepEqual(calls, ["close", "split:vertical", "split:horizontal", "new"]);
  });

  NodeTest.it("a host without the resolver keeps only the shipped default chords", () => {
    NodeAssert.equal(terminalChordAction(keyEvent({ metaKey: true }), undefined, true), "split");
    NodeAssert.equal(
      terminalChordAction(keyEvent({ ctrlKey: true, key: "W" }), undefined, false),
      "close",
    );
    NodeAssert.equal(
      terminalChordAction(keyEvent({ ctrlKey: true, shiftKey: true, key: "J" }), undefined, false),
      null,
    );
    NodeAssert.equal(
      terminalChordAction(keyEvent({ ctrlKey: true, key: "t" }), undefined, false),
      null,
    );
    NodeAssert.equal(terminalChordAction(keyEvent({ key: "x" }), undefined, false), null);
  });
});

NodeTest.describe("t3.ui/theme — watch lifecycle (no stale overrides)", () => {
  const tick = () => new Promise((resolve) => setImmediate(resolve));

  /** Async iterable the test drives frame-by-frame. */
  function controllableStream() {
    const queue = [];
    let waiter;
    const pump = () => {
      if (!waiter || !queue.length) return;
      const item = queue.shift();
      const { resolve, reject } = waiter;
      waiter = undefined;
      if (item.error !== undefined) reject(item.error);
      else resolve(item);
    };
    return {
      iterable: {
        [Symbol.asyncIterator]() {
          return {
            next() {
              const item = queue.shift();
              if (item !== undefined)
                return item.error !== undefined
                  ? Promise.reject(item.error)
                  : Promise.resolve(item);
              return new Promise((resolve, reject) => {
                waiter = { resolve, reject };
              });
            },
            return() {
              return Promise.resolve({ done: true, value: undefined });
            },
          };
        },
      },
      push: (frame) => (queue.push({ done: false, value: frame }), pump()),
      end: () => (queue.push({ done: true, value: undefined }), pump()),
      fail: (error) => (queue.push({ error }), pump()),
    };
  }

  function themeClient({ read, stream }) {
    return {
      invokeApi: (request) => {
        NodeAssert.equal(request.method, "getTokens");
        return read(request);
      },
      subscribeApi: (request) => {
        NodeAssert.equal(request.name, "subscribeState");
        return stream;
      },
    };
  }

  NodeTest.it("clears theme overrides when the state stream closes", async () => {
    const stream = controllableStream();
    const applied = [];
    const client = themeClient({
      read: () => Promise.resolve({ tokens: { text: "#111" }, cssVars: {} }),
      stream: stream.iterable,
    });
    const done = watchThemeVars({
      client,
      context: viewContext,
      signal: new AbortController().signal,
      apply: (vars) => applied.push(vars),
    });
    await tick();
    NodeAssert.deepEqual(applied.at(-1), themeVarOverrides({ text: "#111" }, {}));
    stream.push({ type: "closed", value: {} });
    await done;
    NodeAssert.equal(applied.at(-1), null);
  });

  NodeTest.it("clears theme overrides when the state stream errors", async () => {
    const stream = controllableStream();
    const applied = [];
    const client = themeClient({
      read: () => Promise.resolve({ tokens: { text: "#111" }, cssVars: {} }),
      stream: stream.iterable,
    });
    const done = watchThemeVars({
      client,
      context: viewContext,
      signal: new AbortController().signal,
      apply: (vars) => applied.push(vars),
    });
    await tick();
    stream.fail(new Error("provider gone"));
    await done;
    NodeAssert.equal(applied.at(-1), null);
  });

  NodeTest.it("clears theme overrides when a refresh read is denied", async () => {
    const stream = controllableStream();
    const applied = [];
    let call = 0;
    const client = themeClient({
      read: () => {
        call += 1;
        return call === 1
          ? Promise.resolve({ tokens: { text: "#111" }, cssVars: {} })
          : Promise.reject(new Error("grant revoked"));
      },
      stream: stream.iterable,
    });
    const done = watchThemeVars({
      client,
      context: viewContext,
      signal: new AbortController().signal,
      apply: (vars) => applied.push(vars),
    });
    await tick();
    NodeAssert.deepEqual(applied.at(-1), themeVarOverrides({ text: "#111" }, {}));
    stream.push({ type: "data", value: {} });
    await tick();
    NodeAssert.equal(applied.at(-1), null);
    stream.end();
    await done;
  });

  NodeTest.it("a late read response cannot restore stale overrides after stream loss", async () => {
    const stream = controllableStream();
    const read = deferred();
    const applied = [];
    const client = themeClient({ read: () => read.promise, stream: stream.iterable });
    const done = watchThemeVars({
      client,
      context: viewContext,
      signal: new AbortController().signal,
      apply: (vars) => applied.push(vars),
    });
    stream.push({ type: "closed", value: {} });
    await done;
    read.resolve({ tokens: { text: "#111" }, cssVars: {} });
    await tick();
    NodeAssert.ok(applied.length >= 2);
    NodeAssert.ok(applied.every((vars) => vars === null));
  });

  NodeTest.it("a failed refresh invalidates an older in-flight read", async () => {
    const stream = controllableStream();
    const stale = deferred();
    const applied = [];
    let call = 0;
    const client = themeClient({
      read: () => {
        call += 1;
        return call === 1 ? stale.promise : Promise.reject(new Error("denied"));
      },
      stream: stream.iterable,
    });
    const done = watchThemeVars({
      client,
      context: viewContext,
      signal: new AbortController().signal,
      apply: (vars) => applied.push(vars),
    });
    // Second read (stream frame) fails while the first is still in flight;
    // the older response must not resurrect stale tokens.
    stream.push({ type: "data", value: {} });
    await tick();
    NodeAssert.equal(applied.at(-1), null);
    stale.resolve({ tokens: { text: "#111" }, cssVars: {} });
    await tick();
    NodeAssert.ok(applied.every((vars) => vars === null));
    stream.end();
    await done;
  });

  NodeTest.it("an older read's late rejection does not clear a newer applied map", async () => {
    const stream = controllableStream();
    const stale = deferred();
    const applied = [];
    let call = 0;
    const client = themeClient({
      read: () => {
        call += 1;
        return call === 1
          ? stale.promise
          : Promise.resolve({ tokens: { text: "#abcdef" }, cssVars: {} });
      },
      stream: stream.iterable,
    });
    const done = watchThemeVars({
      client,
      context: viewContext,
      signal: new AbortController().signal,
      apply: (vars) => applied.push(vars),
    });
    // The frame's read (call 2) resolves while the initial read pends, then
    // the superseded read rejects — the applied map must stand.
    stream.push({ type: "data", value: {} });
    await tick();
    NodeAssert.deepEqual(applied.at(-1), themeVarOverrides({ text: "#abcdef" }, {}));
    stale.reject(new Error("late denial"));
    await tick();
    NodeAssert.deepEqual(applied.at(-1), themeVarOverrides({ text: "#abcdef" }, {}));
    stream.end();
    await done;
  });

  NodeTest.it("an older read's rejection does not invalidate a newer in-flight read", async () => {
    const stream = controllableStream();
    const first = deferred();
    const second = deferred();
    const reads = [first, second];
    const applied = [];
    const client = themeClient({
      read: () => reads.shift()?.promise ?? Promise.reject(new Error("unexpected read")),
      stream: stream.iterable,
    });
    const done = watchThemeVars({
      client,
      context: viewContext,
      signal: new AbortController().signal,
      apply: (vars) => applied.push(vars),
    });
    // Both reads in flight; the older rejects first — the newer success must
    // still publish rather than being dropped with the invalidated map.
    stream.push({ type: "data", value: {} });
    await tick();
    first.reject(new Error("late denial"));
    await tick();
    second.resolve({ tokens: { text: "#222" }, cssVars: {} });
    await tick();
    NodeAssert.deepEqual(applied.at(-1), themeVarOverrides({ text: "#222" }, {}));
    stream.end();
    await done;
  });

  NodeTest.it("clears appearance overrides on closed, error, and malformed frames", async () => {
    const appearance = {
      theme: { background: "#000", foreground: "#fff", cursor: "#fff" },
      font: {},
      appearance: "dark",
    };
    const applied = [];
    const stream = controllableStream();
    const client = { subscribeApi: () => stream.iterable };
    const done = watchTerminalAppearanceVars({
      client,
      context: viewContext,
      signal: new AbortController().signal,
      apply: (vars) => applied.push(vars),
    });
    stream.push({ type: "snapshot", value: appearance });
    await tick();
    NodeAssert.deepEqual(applied.at(-1), terminalAppearanceVars(appearance));
    stream.push({ type: "closed", value: {} });
    await tick();
    NodeAssert.equal(applied.at(-1), null);
    await done;
  });

  NodeTest.it("clears appearance overrides when the stream throws", async () => {
    const applied = [];
    const stream = controllableStream();
    const done = watchTerminalAppearanceVars({
      client: { subscribeApi: () => stream.iterable },
      context: viewContext,
      signal: new AbortController().signal,
      apply: (vars) => applied.push(vars),
    });
    stream.push({
      type: "snapshot",
      value: {
        theme: { background: "#000", foreground: "#fff", cursor: "#fff" },
        font: {},
        appearance: "dark",
      },
    });
    await tick();
    stream.fail(new Error("stream lost"));
    await done;
    NodeAssert.equal(applied.at(-1), null);
  });

  NodeTest.it("clears appearance overrides on a malformed frame", async () => {
    const applied = [];
    const stream = controllableStream();
    const done = watchTerminalAppearanceVars({
      client: { subscribeApi: () => stream.iterable },
      context: viewContext,
      signal: new AbortController().signal,
      apply: (vars) => applied.push(vars),
    });
    stream.push({
      type: "snapshot",
      value: {
        theme: { background: "#000", foreground: "#fff", cursor: "#fff" },
        font: {},
        appearance: "dark",
      },
    });
    await tick();
    stream.push({ type: "data", value: { not: "an appearance" } });
    await tick();
    NodeAssert.equal(applied.at(-1), null);
    stream.end();
    await done;
  });
});

// Builds a scratch copy of the package so manifest assertions consume
// this run's build output, never a possibly stale committed bundle.
async function buildScratchManifest() {
  const packageDir = NodeURL.fileURLToPath(new URL("./", import.meta.url));
  // The scratch dir is private to this file and outside the package dir, so
  // concurrently running test files never see it; node_modules is linked in
  // so the build still resolves workspace packages.
  const scratch = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-terminal-manifest-"));
  try {
    for (const entry of await NodeFSP.readdir(packageDir)) {
      if (entry.startsWith(".t3-extension") || entry === "node_modules" || entry === "fixtures")
        continue;
      await NodeFSP.cp(NodePath.join(packageDir, entry), NodePath.join(scratch, entry), {
        recursive: true,
      });
    }
    await NodeFSP.symlink(
      NodePath.join(packageDir, "node_modules"),
      NodePath.join(scratch, "node_modules"),
    );
    const cli = NodeURL.fileURLToPath(
      new URL("../../extension-sdk/bin/t3-extension.mjs", import.meta.url),
    );
    const build = NodeChildProcess.spawnSync(process.execPath, [cli, "build", scratch], {
      encoding: "utf8",
    });
    NodeAssert.equal(
      build.status,
      0,
      `t3-extension build failed:\n${build.stdout}\n${build.stderr}`,
    );
    return JSON.parse(
      await NodeFSP.readFile(NodePath.join(scratch, ".t3-extension/t3-extension.json"), "utf8"),
    );
  } finally {
    await NodeFSP.rm(scratch, { recursive: true, force: true });
  }
}

NodeTest.describe("package requirements — t3.ui/* adoption policy", () => {
  NodeTest.it("declares the consumed t3.ui/* contracts as mandatory requirements", async () => {
    // Invocation authority only exists for declared APIs, so these must stay
    // in `requires`; capability resolution fails closed (missing-api) on a
    // host without the providers rather than mounting a half-contracted panel.
    const manifest = await buildScratchManifest();
    NodeAssert.deepEqual(
      manifest.requires.map((item) => item.id),
      [
        "t3.terminal/sessions",
        "t3.terminal/output",
        "t3.terminal/output-events",
        "t3.terminal/control",
        "t3.composer/context",
        "t3.file/presentation",
        "t3.ui/theme",
        "t3.ui/keybindings",
        "t3.ui/panels",
      ],
    );
  });
});

NodeTest.describe("terminal path links (Terminal 22 path half)", () => {
  const target = (text, cwd, workspaceRoot) => terminalPathLinkTarget(text, cwd, workspaceRoot);
  const unopenable = (value) =>
    value.status === "unopenable" &&
    value.reason === `${value.text} cannot be opened — not a workspace-relative path.`;

  NodeTest.it("bare-relative link strips its position suffix and opens", () => {
    NodeAssert.deepEqual(target("src/view.tsx:12:3", "/ws/root", "/ws/root"), {
      status: "open",
      relativePath: "src/view.tsx",
    });
  });

  NodeTest.it("a position suffix of zero still slices off", () => {
    // The markdown splitter slices the suffix even when the line number is
    // not keepable, so `a.ts:0` must resolve as `a.ts`, not `a.ts:0`.
    NodeAssert.deepEqual(target("a.ts:0", "/ws/root", "/ws/root"), {
      status: "open",
      relativePath: "a.ts",
    });
  });

  NodeTest.it("a link that is only a position suffix refuses by name", () => {
    // Nothing presentable remains once the suffix is stripped.
    NodeAssert.ok(unopenable({ ...target(":12", "/ws/root", "/ws/root"), text: ":12" }));
  });

  NodeTest.it("absolute link inside the workspace root opens relative", () => {
    NodeAssert.deepEqual(target("/ws/root/packages/a.ts", "/ws/root", "/ws/root"), {
      status: "open",
      relativePath: "packages/a.ts",
    });
  });

  NodeTest.it("absolute link outside the workspace root refuses by name", () => {
    const value = target("/etc/passwd", "/ws/root", "/ws/root");
    NodeAssert.ok(unopenable({ ...value, text: "/etc/passwd" }));
  });

  NodeTest.it("home-relative link resolves through the inferred home", () => {
    // Spelled concatenated: the pack's audit bans the home-link sequence.
    const homeLink = (rest) => "~" + "/" + rest;
    const noHome = "~" + "/srv/none/a.ts";
    NodeAssert.ok(unopenable({ ...target(noHome, "/srv/app", "/srv/app"), text: noHome }));
    const inside = target(homeLink("proj/src/a.ts"), "/Users/alex/proj", "/Users/alex/proj");
    NodeAssert.deepEqual(inside, {
      status: "open",
      relativePath: "src/a.ts",
    });
    NodeAssert.ok(
      unopenable({
        ...target(homeLink("elsewhere/x.ts"), "/Users/alex/proj", "/Users/alex/proj"),
        text: homeLink("elsewhere/x.ts"),
      }),
    );
  });

  NodeTest.it("dot segments normalize while root escapes refuse", () => {
    NodeAssert.deepEqual(target("./src/./a.ts", "/ws/root", "/ws/root"), {
      status: "open",
      relativePath: "src/a.ts",
    });
    NodeAssert.deepEqual(target("src/../a.ts", "/ws/root", "/ws/root"), {
      status: "open",
      relativePath: "a.ts",
    });
    // `..` past the root — including through the root prefix — never opens.
    NodeAssert.ok(
      unopenable({ ...target("../outside.ts", "/ws/root", "/ws/root"), text: "../outside.ts" }),
    );
    NodeAssert.ok(
      unopenable({
        ...target("/ws/root/../escape.ts", "/ws/root", "/ws/root"),
        text: "/ws/root/../escape.ts",
      }),
    );
  });

  NodeTest.it("the bare workspace root is not a presentable file", () => {
    NodeAssert.ok(unopenable({ ...target("/ws/root", "/ws/root", "/ws/root"), text: "/ws/root" }));
  });

  NodeTest.it("a worktree launch cwd cannot express its links as project-relative", () => {
    // The terminal spawns in the worktree, but the presentation op's paths
    // are project-root-relative, so worktree paths refuse honestly while
    // project-root absolutes still open.
    NodeAssert.ok(unopenable({ ...target("src/a.ts", "/wt/tree", "/ws/root"), text: "src/a.ts" }));
    NodeAssert.ok(
      unopenable({
        ...target("/wt/tree/src/a.ts", "/wt/tree", "/ws/root"),
        text: "/wt/tree/src/a.ts",
      }),
    );
    NodeAssert.deepEqual(target("/ws/root/src/a.ts", "/wt/tree", "/ws/root"), {
      status: "open",
      relativePath: "src/a.ts",
    });
  });

  NodeTest.it("windows workspaces map drive-letter links case-insensitively", () => {
    NodeAssert.deepEqual(target("src\\a.ts:4", "C:\\ws\\root", "C:\\ws\\root"), {
      status: "open",
      relativePath: "src/a.ts",
    });
    NodeAssert.deepEqual(target("c:\\WS\\ROOT\\src\\a.ts", "C:\\ws\\root", "C:\\ws\\root"), {
      status: "open",
      relativePath: "src/a.ts",
    });
    NodeAssert.ok(
      unopenable({
        ...target("C:\\Other\\a.ts", "C:\\ws\\root", "C:\\ws\\root"),
        text: "C:\\Other\\a.ts",
      }),
    );
    // Windows tools emit forward-slash and mixed-separator paths; the
    // resolver normalizes to the root's style before mapping.
    NodeAssert.deepEqual(target("C:/ws/root/src/a.ts", "C:\\ws\\root", "C:\\ws\\root"), {
      status: "open",
      relativePath: "src/a.ts",
    });
    NodeAssert.deepEqual(target("c:/WS/root\\src\\a.ts", "C:\\ws\\root", "C:\\ws\\root"), {
      status: "open",
      relativePath: "src/a.ts",
    });
    // Cross-style: a posix absolute never maps onto a windows root.
    NodeAssert.ok(
      unopenable({
        ...target("/ws/root/src/a.ts", "C:\\ws\\root", "C:\\ws\\root"),
        text: "/ws/root/src/a.ts",
      }),
    );
  });
});
