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
  OutputReattach,
  missingSessionRow,
  normalizeTerminalIds,
  noteOutputFrameForStreak,
  removeTerminalId,
  resolveActiveTerminalId,
  openTerminalPath,
  openTerminalUrl,
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
import * as TerminalViewModel from "./viewModel.ts";

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

  NodeTest.it("starts shown restored ids only once the live list lacks them", async () => {
    const control = fakeControl();
    const panel = new TerminalPanel({
      control,
      launch,
      restored: { terminalIds: ["term-1", "term-2", "term-3"], activeTerminalId: "term-1" },
    });
    // Before the first snapshot nothing is known to be missing.
    panel.startMissingSessions(["term-1", "term-2", "term-3"]);
    NodeAssert.deepEqual(control.calls, []);
    // The restarted server still has term-2 (exited); term-1 and term-3 are gone.
    panel.applySessionsEvent({
      kind: "snapshot",
      terminals: [{ ...meta("term-2"), status: "exited" }],
    });
    panel.startMissingSessions(["term-1", "term-2"]);
    await Promise.resolve();
    NodeAssert.deepEqual(
      control.calls.map(([op, input]) => [op, input.terminalId, input.cwd]),
      [["attach", "term-1", launch.cwd]],
    );
    panel.dispose();
  });

  NodeTest.it(
    "a live pane the restarted server no longer has starts again once, like a restored one",
    async () => {
      const control = fakeControl();
      const panel = new TerminalPanel({ control, launch });
      panel.applySessionsEvent({ kind: "snapshot", terminals: [meta("term-1")] });
      NodeAssert.equal(panel.snapshot.tabs[0]?.status, "running");
      // The backend died and restarted: the resumed list has no term-1.
      panel.beginListStream();
      panel.applySessionsEvent({ kind: "snapshot", terminals: [] });
      NodeAssert.deepEqual(panel.snapshot.terminalIds, ["term-1"]);
      NodeAssert.equal(panel.snapshot.tabs[0]?.status, "closed");
      panel.startMissingSessions(["term-1"]);
      panel.startMissingSessions(["term-1"]);
      await new Promise(setImmediate);
      NodeAssert.deepEqual(
        control.calls.map(([op, input]) => [op, input.terminalId, input.restartIfNotRunning]),
        [["attach", "term-1", undefined]],
      );
      NodeAssert.equal(panel.snapshot.tabs[0]?.status, "running");
      panel.dispose();
    },
  );

  NodeTest.it("a reconnect during a confirmed Close does not start the pane again", async () => {
    const close = deferred();
    const attach = deferred();
    const control = fakeControl({
      close(input) {
        control.calls.push(["close", input]);
        return close.promise;
      },
    });
    control.gate.attach = attach.promise;
    const panel = new TerminalPanel({ control, launch });
    panel.applySessionsEvent({ kind: "snapshot", terminals: [meta("term-1")] });
    panel.requestAction("term-1", "close");
    const closing = panel.confirmAction("term-1");
    // The list reconnects while Close is on the wire; the server already dropped term-1.
    panel.beginListStream();
    panel.applySessionsEvent({ kind: "snapshot", terminals: [] });
    // The view auto-starts every shown pane that reads as closed.
    panel.startMissingSessions(
      panel.snapshot.tabs.filter((tab) => tab.status === "closed").map((tab) => tab.terminalId),
    );
    close.resolve({});
    await closing;
    attach.resolve(meta("term-1"));
    await new Promise(setImmediate);
    const autoAttaches = control.calls.filter(([op]) => op === "attach").length;
    NodeAssert.deepEqual(
      { autoAttaches, finalTabIds: panel.snapshot.terminalIds },
      { autoAttaches: 0, finalTabIds: [] },
    );
    panel.dispose();
  });

  NodeTest.it(
    "an automatic attach that lands after another client closed the pane does not bring it back",
    async () => {
      const attach = deferred();
      const control = fakeControl();
      control.gate.attach = attach.promise;
      const panel = new TerminalPanel({
        control,
        launch,
        restored: { terminalIds: ["term-1"], activeTerminalId: "term-1" },
      });
      panel.applySessionsEvent({ kind: "snapshot", terminals: [] });
      panel.startMissingSessions(["term-1"]);
      panel.applySessionsEvent({ kind: "remove", terminalId: "term-1" });
      attach.resolve(meta("term-1"));
      await new Promise(setImmediate);
      NodeAssert.deepEqual(panel.snapshot.terminalIds, []);
      panel.dispose();
    },
  );

  NodeTest.it("racing restores never relaunch a session another restore just failed", async () => {
    // One server, two clients. The fake mirrors Manager.openOrAttach: an
    // absent session launches; an existing one without a process relaunches
    // only for restartIfNotRunning. Every launch fails and is retained as an
    // error row, as the server does.
    let launches = 0;
    const sessions = new Map();
    const serverAttach = (input) => {
      const existing = sessions.get(input.terminalId);
      if (existing && input.restartIfNotRunning !== true) return Promise.resolve(existing);
      launches += 1;
      const failed = meta(input.terminalId, { status: "error" });
      sessions.set(input.terminalId, failed);
      return Promise.resolve(failed);
    };
    const clients = [0, 1].map(
      () =>
        new TerminalPanel({
          control: fakeControl({ attach: serverAttach }),
          launch,
          restored: { terminalIds: ["term-1"], activeTerminalId: "term-1" },
        }),
    );
    // Both see the restarted server's empty list before either attach lands.
    for (const panel of clients) panel.applySessionsEvent({ kind: "snapshot", terminals: [] });
    for (const panel of clients) panel.startMissingSessions(["term-1"]);
    await new Promise(setImmediate);
    NodeAssert.equal(launches, 1);
    for (const panel of clients) {
      NodeAssert.equal(
        panel.snapshot.tabs.find((tab) => tab.terminalId === "term-1")?.status,
        "error",
      );
      // Observed now: a repeated restore is a no-op; only Start relaunches.
      panel.startMissingSessions(["term-1"]);
    }
    await new Promise(setImmediate);
    NodeAssert.equal(launches, 1);
    await clients[1].startSession("term-1");
    NodeAssert.equal(launches, 2);
    for (const panel of clients) panel.dispose();
  });

  NodeTest.it(
    "t36: a resize that failed across a backend restart does not keep the shown pane from starting",
    async () => {
      const control = fakeControl({
        resize(input) {
          control.calls.push(["resize", input]);
          return Promise.reject(new Error("Environment is not connected"));
        },
      });
      const panel = new TerminalPanel({ control, launch });
      panel.applySessionsEvent({ kind: "snapshot", terminals: [meta("term-1")] });
      // The backend dies; the shown pane's status line changes height, so it
      // re-fits and the resize fails while no connection is usable.
      panel.beginListStream();
      panel.resize("term-1", 80, 21);
      await new Promise(setImmediate);
      NodeAssert.equal(panel.snapshot.tabs[0]?.error, "Environment is not connected");
      // The restarted server lists no term-1: the shown pane starts on its own.
      panel.applySessionsEvent({ kind: "snapshot", terminals: [] });
      panel.startMissingSessions(["term-1"]);
      await new Promise(setImmediate);
      NodeAssert.deepEqual(
        control.calls.filter(([op]) => op === "attach").map(([, input]) => input.terminalId),
        ["term-1"],
      );
      NodeAssert.equal(panel.snapshot.tabs[0]?.status, "running");
      panel.dispose();
    },
  );

  NodeTest.it(
    "t36: a failed automatic start waits for Start, and the next restart's missing observation retries it once",
    async () => {
      let failNext = true;
      const control = fakeControl({
        attach(input) {
          control.calls.push(["attach", input]);
          if (!failNext) return Promise.resolve(meta(input.terminalId));
          failNext = false;
          return Promise.reject(new Error("Environment is not connected"));
        },
      });
      const attaches = () => control.calls.filter(([op]) => op === "attach").length;
      const panel = new TerminalPanel({ control, launch });
      panel.applySessionsEvent({ kind: "snapshot", terminals: [meta("term-1")] });
      panel.beginListStream();
      panel.applySessionsEvent({ kind: "snapshot", terminals: [] });
      panel.startMissingSessions(["term-1"]);
      await new Promise(setImmediate);
      NodeAssert.equal(attaches(), 1);
      NodeAssert.equal(panel.snapshot.tabs[0]?.status, "closed");
      // Same observation: the failure waits for Start.
      panel.startMissingSessions(["term-1"]);
      panel.applySessionsEvent({ kind: "upsert", terminal: meta("term-2") });
      panel.startMissingSessions(["term-1"]);
      await new Promise(setImmediate);
      NodeAssert.equal(attaches(), 1);
      // The backend restarts again and still has no term-1: one more start.
      panel.beginListStream();
      panel.applySessionsEvent({ kind: "snapshot", terminals: [meta("term-2")] });
      panel.startMissingSessions(["term-1"]);
      panel.startMissingSessions(["term-1"]);
      await new Promise(setImmediate);
      NodeAssert.equal(attaches(), 2);
      NodeAssert.equal(panel.snapshot.tabs[0]?.status, "running");
      NodeAssert.equal(panel.snapshot.tabs[0]?.error, null);
      panel.dispose();
    },
  );

  NodeTest.it(
    "t36: Start clears input stopped by writes to a session the server did not have",
    async () => {
      const control = fakeControl({
        write(input) {
          control.calls.push(["write", input]);
          return this.server
            ? Promise.resolve({})
            : Promise.reject(new Error("Terminal control operation failed."));
        },
        server: false,
      });
      const panel = new TerminalPanel({ control, launch });
      panel.applySessionsEvent({ kind: "snapshot", terminals: [meta("term-1")] });
      panel.beginListStream();
      panel.applySessionsEvent({ kind: "snapshot", terminals: [] });
      // Typed into the pane while it had no session: the write fails.
      panel.sendInput("term-1", "echo lost\r");
      await new Promise(setImmediate);
      NodeAssert.equal(panel.snapshot.tabs[0]?.inputStopped, true);
      control.server = true;
      await panel.startSession("term-1");
      NodeAssert.equal(panel.snapshot.tabs[0]?.inputStopped, false);
      panel.sendInput("term-1", "echo ok\r");
      await new Promise(setImmediate);
      NodeAssert.deepEqual(
        control.calls.filter(([op]) => op === "write").map(([, input]) => input.data),
        ["echo lost\r", "echo ok\r"],
      );
      panel.dispose();
    },
  );

  NodeTest.it(
    "t36 (a): a pane waiting to start when shown is not announced as closed; a failed start is",
    async () => {
      const control = fakeControl({
        attach(input) {
          control.calls.push(["attach", input]);
          return Promise.reject(new Error("spawn failed"));
        },
      });
      const panel = new TerminalPanel({ control, launch });
      panel.applySessionsEvent({ kind: "snapshot", terminals: [meta("term-1"), meta("term-2")] });
      NodeAssert.equal(TerminalViewModel.sessionStatusText(panel.snapshot.tabs[1]), null);
      panel.beginListStream();
      panel.applySessionsEvent({ kind: "snapshot", terminals: [] });
      // Out of view after the restart: it starts when shown, as native does.
      NodeAssert.equal(TerminalViewModel.sessionStatusText(panel.snapshot.tabs[1]), null);
      panel.startMissingSessions(["term-2"]);
      await new Promise(setImmediate);
      NodeAssert.equal(
        TerminalViewModel.sessionStatusText(panel.snapshot.tabs[1]),
        "closed · spawn failed",
      );
      panel.dispose();
    },
  );

  NodeTest.it(
    "t36: a missing observation re-arms a failed start but never starts a pane the user closed",
    async () => {
      const closeResult = deferred();
      const control = fakeControl({
        attach(input) {
          control.calls.push(["attach", input]);
          return Promise.reject(new Error("spawn failed"));
        },
        close(input) {
          control.calls.push(["close", input]);
          return closeResult.promise;
        },
      });
      const attaches = () => control.calls.filter(([op]) => op === "attach").length;
      const panel = new TerminalPanel({ control, launch });
      panel.applySessionsEvent({ kind: "snapshot", terminals: [meta("term-1")] });
      panel.beginListStream();
      panel.applySessionsEvent({ kind: "snapshot", terminals: [] });
      panel.startMissingSessions(["term-1"]);
      await new Promise(setImmediate);
      NodeAssert.equal(attaches(), 1);
      // The user closes the failed pane; the close is still on the wire when
      // the backend restarts and reports it missing, which re-arms a start.
      panel.requestAction("term-1", "close");
      const closing = panel.confirmAction("term-1");
      panel.beginListStream();
      panel.applySessionsEvent({ kind: "snapshot", terminals: [] });
      NodeAssert.equal(panel.snapshot.tabs[0]?.startsWhenShown, false);
      panel.startMissingSessions(["term-1"]);
      await new Promise(setImmediate);
      NodeAssert.equal(attaches(), 1);
      // The close fails: the `exit\n` fallback runs and the pane stays gone.
      closeResult.reject(new Error("net::ERR_ABORTED"));
      await closing;
      panel.applySessionsEvent({ kind: "snapshot", terminals: [] });
      panel.startMissingSessions(["term-1"]);
      await new Promise(setImmediate);
      NodeAssert.equal(attaches(), 1);
      NodeAssert.deepEqual(panel.snapshot.terminalIds, []);
      NodeAssert.deepEqual(
        control.calls.filter(([op]) => op === "close" || op === "write").map(([op]) => op),
        ["close", "write"],
      );
      panel.dispose();
    },
  );

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

  /**
   * A server that owns sessions and their history files, shared by several
   * clients. A session's `updatedAt` names its process incarnation, and its
   * history records the incarnation that wrote it. An offline client's
   * requests abort like a dropped network; `exit\n` ends the shell but leaves
   * the session listed (exited) with its history, as the real server does.
   */
  function fakeServer(ids) {
    const server = { sessions: new Map(), history: new Map(), clients: [], spawned: 0 };
    const spawn = (terminalId) => {
      const session = meta(terminalId, { updatedAt: `incarnation-${++server.spawned}` });
      server.sessions.set(terminalId, session);
      server.history.set(terminalId, session.updatedAt);
      return session;
    };
    for (const id of ids) spawn(id);
    const broadcast = (event) => {
      for (const client of server.clients) client.panel?.applySessionsEvent(event);
    };
    server.client = () => {
      const client = { offline: false, panel: null };
      const aborted = () => Promise.reject(new Error("net::ERR_ABORTED"));
      const control = fakeControl({
        open(input) {
          control.calls.push(["open", input]);
          if (client.offline) return aborted();
          const session = spawn(input.terminalId);
          broadcast({ kind: "upsert", terminal: session });
          return Promise.resolve(session);
        },
        restart(input) {
          control.calls.push(["restart", input]);
          if (client.offline) return aborted();
          const session = spawn(input.terminalId);
          broadcast({ kind: "upsert", terminal: session });
          return Promise.resolve(session);
        },
        close(input) {
          control.calls.push(["close", input]);
          if (client.offline) return aborted();
          server.sessions.delete(input.terminalId);
          if (input.deleteHistory) server.history.delete(input.terminalId);
          broadcast({ kind: "remove", terminalId: input.terminalId });
          return Promise.resolve({});
        },
        write(input) {
          control.calls.push(["write", input]);
          if (client.offline) return aborted();
          const session = server.sessions.get(input.terminalId);
          if (input.data === "exit\n" && session) {
            const exited = { ...session, status: "exited", exitCode: 0 };
            server.sessions.set(input.terminalId, exited);
            broadcast({ kind: "upsert", terminal: exited });
          }
          return Promise.resolve({});
        },
      });
      client.control = control;
      client.connect = (panel) => {
        client.offline = false;
        client.panel = panel;
        panel.beginListStream();
        panel.applySessionsEvent({ kind: "snapshot", terminals: [...server.sessions.values()] });
      };
      client.drop = () => {
        client.offline = true;
        client.panel?.markStreamDisconnected("offline");
        client.panel = null;
      };
      server.clients.push(client);
      return client;
    };
    return server;
  }
  const closesSince = (control, mark) =>
    control.calls.slice(mark).filter(([kind]) => kind === "close");

  for (const restored of [false, true]) {
    NodeTest.it(
      `r2 close intent completes server cleanup once${restored ? " after reload" : " after reconnect"}`,
      async () => {
        const server = fakeServer(["term-1", "term-6"]);
        const client = server.client();
        let panel = new TerminalPanel({ control: client.control, launch });
        client.connect(panel);
        const abortedClose = deferred();
        const close = client.control.close;
        client.control.close = (input) => {
          client.control.calls.push(["close", input]);
          return abortedClose.promise;
        };
        panel.requestAction("term-6", "close");
        const closing = panel.confirmAction("term-6");
        client.drop();
        abortedClose.reject(new Error("net::ERR_ABORTED"));
        await closing;
        client.control.close = close;
        server.sessions.set("term-6", {
          ...server.sessions.get("term-6"),
          status: "exited",
          exitCode: 0,
        });
        if (restored) {
          const saved = panel.snapshot;
          panel.dispose();
          panel = new TerminalPanel({ control: client.control, launch, restored: saved });
        }
        const mark = client.control.calls.length;
        try {
          client.connect(panel);
          await new Promise(setImmediate);
          client.connect(panel);
          await new Promise(setImmediate);
          NodeAssert.deepEqual(closesSince(client.control, mark), [
            ["close", { terminalId: "term-6", deleteHistory: true }],
          ]);
          NodeAssert.equal(server.sessions.has("term-6"), false);
          NodeAssert.equal(server.history.has("term-6"), false);
          NodeAssert.deepEqual(panel.snapshot.suppressedTerminalIds, []);
          await client.control.open({ terminalId: "term-6" });
          NodeAssert.deepEqual(panel.snapshot.terminalIds, ["term-1", "term-6"]);
          NodeAssert.equal(closesSince(client.control, mark).length, 1);
        } finally {
          panel.dispose();
        }
      },
    );
  }

  NodeTest.it(
    "a Close aborted by a network drop stays hidden after reconnect (web-r5 Terminal 11)",
    async () => {
      const server = fakeServer(["term-1", "term-6"]);
      const a = server.client();
      const panel = new TerminalPanel({ control: a.control, launch });
      a.connect(panel);
      const release = deferred();
      const close = a.control.close;
      a.control.close = (input) => release.promise.then(() => close(input));
      panel.requestAction("term-6", "close");
      const closing = panel.confirmAction("term-6");
      // The drop aborts the in-flight close; the exit fallback is lost too.
      a.drop();
      release.resolve();
      await closing;
      a.control.close = close;
      const mark = a.control.calls.length;
      a.connect(panel);
      await new Promise(setImmediate);
      // Native suppression: the row stays hidden and nothing is re-sent.
      NodeAssert.deepEqual(
        {
          rows: panel.snapshot.terminalIds,
          serverSessions: [...server.sessions.keys()],
          resent: closesSince(a.control, mark),
        },
        { rows: ["term-1"], serverSessions: ["term-1", "term-6"], resent: [] },
      );
      panel.dispose();
    },
  );

  NodeTest.it(
    "a Close aborted after the list already reconnected stays hidden on the exit upsert",
    async () => {
      const server = fakeServer(["term-1", "term-6"]);
      const a = server.client();
      const panel = new TerminalPanel({ control: a.control, launch });
      a.connect(panel);
      const abort = deferred();
      const close = a.control.close;
      a.control.close = (input) => {
        a.control.calls.push(["close", input]);
        return abort.promise;
      };
      panel.requestAction("term-6", "close");
      const closing = panel.confirmAction("term-6");
      a.drop();
      a.connect(panel);
      a.control.close = close;
      const mark = a.control.calls.length;
      // The aborted request only settles now; the exit fallback reaches the server.
      abort.reject(new Error("net::ERR_ABORTED"));
      await closing;
      await new Promise(setImmediate);
      NodeAssert.deepEqual(
        {
          rows: panel.snapshot.terminalIds,
          status: server.sessions.get("term-6")?.status,
          resent: closesSince(a.control, mark),
        },
        {
          rows: ["term-1"],
          status: undefined,
          resent: [["close", { terminalId: "term-6", deleteHistory: true }]],
        },
      );
      panel.dispose();
    },
  );

  for (const replacement of [false, true]) {
    NodeTest.it(
      `an aborted Close followed by exit stays absent after reload${replacement ? " without hiding a replacement" : ""} (web-r7 S1)`,
      async () => {
        const server = fakeServer(["term-1", "term-6"]);
        const client = server.client();
        const panel = new TerminalPanel({ control: client.control, launch });
        client.connect(panel);
        const abortedClose = deferred();
        const close = client.control.close;
        client.control.close = (input) => {
          client.control.calls.push(["close", input]);
          return abortedClose.promise;
        };
        panel.requestAction("term-6", "close");
        const closing = panel.confirmAction("term-6");
        client.drop();
        client.connect(panel);
        client.control.close = close;
        abortedClose.reject(new Error("net::ERR_ABORTED"));
        await closing;
        await new Promise(setImmediate);
        NodeAssert.equal(server.sessions.has("term-6"), false);
        NodeAssert.equal(server.history.has("term-6"), false);
        NodeAssert.deepEqual(panel.snapshot.suppressedTerminalIds, []);
        NodeAssert.deepEqual(panel.snapshot.terminalIds, ["term-1"]);
        const saved = panel.snapshot;
        panel.dispose();
        if (replacement) await client.control.restart({ terminalId: "term-6" });
        const mark = client.control.calls.length;
        const reloaded = new TerminalPanel({ control: client.control, launch, restored: saved });
        try {
          client.connect(reloaded);
          NodeAssert.deepEqual(
            reloaded.snapshot.terminalIds,
            replacement ? ["term-1", "term-6"] : ["term-1"],
          );
          NodeAssert.deepEqual(client.control.calls.slice(mark), []);
        } finally {
          reloaded.dispose();
        }
      },
    );
  }

  for (const [name, replace] of [
    [
      "another client closes and reopens the id",
      async (b) => {
        b.panel.requestAction("term-2", "close");
        await b.panel.confirmAction("term-2");
        NodeAssert.equal(await b.panel.openTerminal(), "term-2");
      },
    ],
    [
      "another client restarts the id",
      async (b) => {
        b.panel.requestAction("term-2", "restart");
        await b.panel.confirmAction("term-2");
      },
    ],
  ]) {
    NodeTest.it(
      `a failed Close never kills the replacement when ${name} during the outage`,
      async () => {
        const server = fakeServer(["term-1", "term-2"]);
        const a = server.client();
        const b = server.client();
        const panelA = new TerminalPanel({ control: a.control, launch });
        const panelB = new TerminalPanel({ control: b.control, launch });
        a.connect(panelA);
        b.connect(panelB);
        const original = server.sessions.get("term-2").updatedAt;
        a.drop();
        panelA.requestAction("term-2", "close");
        await panelA.confirmAction("term-2");
        await replace(b);
        const replacement = server.sessions.get("term-2")?.updatedAt;
        NodeAssert.notEqual(replacement, undefined);
        NodeAssert.notEqual(replacement, original);
        const mark = a.control.calls.length;
        a.connect(panelA);
        // The replacement's own later upserts must not trigger a close either.
        const session = server.sessions.get("term-2");
        panelA.applySessionsEvent({ kind: "upsert", terminal: { ...session, label: "busy" } });
        await new Promise(setImmediate);
        NodeAssert.deepEqual(
          {
            sessionIncarnation: server.sessions.get("term-2")?.updatedAt,
            historyIncarnation: server.history.get("term-2"),
            closesFromA: closesSince(a.control, mark),
            rowsB: panelB.snapshot.terminalIds,
          },
          {
            sessionIncarnation: replacement,
            historyIncarnation: replacement,
            closesFromA: [],
            rowsB: ["term-1", "term-2"],
          },
        );
        panelA.dispose();
        panelB.dispose();
      },
    );
  }

  NodeTest.it(
    "a shell exit during the Close fallback sends at most one close and stays hidden",
    async () => {
      const server = fakeServer(["term-1", "term-2"]);
      const a = server.client();
      const panel = new TerminalPanel({ control: a.control, launch });
      a.connect(panel);
      let inFlight = 0;
      let maxInFlight = 0;
      const pendingCloses = [];
      a.control.close = (input) => {
        a.control.calls.push(["close", input]);
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        const settle = deferred();
        pendingCloses.push(settle);
        return settle.promise.finally(() => (inFlight -= 1));
      };
      const writeResponse = deferred();
      const write = a.control.write;
      a.control.write = (input) => write(input).then(() => writeResponse.promise);
      panel.requestAction("term-2", "close");
      const closing = panel.confirmAction("term-2");
      pendingCloses[0].reject(new Error("net::ERR_ABORTED"));
      await new Promise(setImmediate);
      // The shell exits while the fallback's response is still pending: the
      // pane's output stream reports it, then the metadata upsert follows.
      NodeAssert.equal(server.sessions.get("term-2")?.status, "exited");
      panel.noteOutputSnapshot("term-2", "exited");
      panel.applySessionsEvent({ kind: "upsert", terminal: server.sessions.get("term-2") });
      await new Promise(setImmediate);
      writeResponse.resolve({});
      await closing;
      for (const settle of pendingCloses.slice(1)) settle.reject(new Error("net::ERR_ABORTED"));
      await new Promise(setImmediate);
      // Any later listing still keeps the suppressed id hidden.
      panel.applySessionsEvent({ kind: "snapshot", terminals: [...server.sessions.values()] });
      NodeAssert.ok(maxInFlight <= 1, `concurrent closes: ${maxInFlight}`);
      NodeAssert.deepEqual(panel.snapshot.terminalIds, ["term-1"]);
      panel.dispose();
    },
  );

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
  /** Lets any deferred (zero-delay timer) exit handling run. */
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

  NodeTest.it("list rows never close a session; its output snapshot does", async () => {
    // Native closes only from the attached terminal's own stream. An exited
    // list row is metadata: it may describe an older process than the one
    // running now, so the pane's fresh output snapshot decides.
    const control = fakeControl();
    const panel = new TerminalPanel({ control, launch });
    panel.applySessionsEvent({ kind: "snapshot", terminals: [meta("term-1")] });
    panel.applySessionsEvent({
      kind: "upsert",
      terminal: meta("term-1", { status: "exited", exitCode: 3 }),
    });
    panel.applySessionsEvent({
      kind: "snapshot",
      terminals: [meta("term-1"), meta("term-2", { status: "exited", exitCode: 0 })],
    });
    await tick();
    NodeAssert.deepEqual(control.calls, []);
    NodeAssert.deepEqual(panel.snapshot.terminalIds, ["term-1", "term-2"]);
    // The pane (re)subscribed and the server says this id's process is exited.
    panel.noteOutputSnapshot("term-2", "exited");
    NodeAssert.deepEqual(control.calls, [["close", { terminalId: "term-2", deleteHistory: true }]]);
    NodeAssert.deepEqual(panel.snapshot.terminalIds, ["term-1"]);
    panel.dispose();
  });

  NodeTest.it(
    "a delayed old exit after the list reconnects never closes the new process",
    async () => {
      // The list reconnects and reports a newer
      // running process before the pane delivers the old process's exit.
      const control = fakeControl();
      const panel = new TerminalPanel({ control, launch });
      panel.applySessionsEvent({ kind: "snapshot", terminals: [meta("term-1")] });
      panel.markStreamDisconnected("list dropped");
      panel.beginListStream();
      panel.applySessionsEvent({ kind: "snapshot", terminals: [meta("term-1")] });
      panel.noteExit("term-1", 0);
      NodeAssert.equal(panel.snapshot.tabs[0].exitBanner, "Process exited (code 0)");
      await tick();
      NodeAssert.deepEqual(control.calls, []);
      NodeAssert.deepEqual(panel.snapshot.terminalIds, ["term-1"]);
      // The pane's resubscription finds the replacement running: the banner
      // belonged to the old process.
      panel.noteOutputSnapshot("term-1", "running");
      NodeAssert.equal(panel.snapshot.tabs[0].exitBanner, null);
      await tick();
      NodeAssert.deepEqual(control.calls, []);
      // The replacement's own exit still closes it.
      panel.noteExit("term-1", 7);
      panel.noteOutputSnapshot("term-1", "exited");
      NodeAssert.deepEqual(control.calls, [
        ["close", { terminalId: "term-1", deleteHistory: true }],
      ]);
      NodeAssert.deepEqual(panel.snapshot.terminalIds, []);
      panel.dispose();
    },
  );

  NodeTest.it("a closing session's stale rows stay closed until the server removes it", () => {
    const control = fakeControl();
    const panel = new TerminalPanel({ control, launch });
    panel.applySessionsEvent({ kind: "snapshot", terminals: [meta("term-1")] });
    panel.noteOutputSnapshot("term-1", "exited");
    NodeAssert.deepEqual(panel.snapshot.terminalIds, []);
    NodeAssert.equal(panel.snapshot.activeTerminalId, null);
    panel.applySessionsEvent({
      kind: "upsert",
      terminal: meta("term-1", { status: "exited", exitCode: 3 }),
    });
    panel.applySessionsEvent({
      kind: "snapshot",
      terminals: [meta("term-1", { status: "exited", exitCode: 3 })],
    });
    NodeAssert.deepEqual(panel.snapshot.terminalIds, []);
    NodeAssert.equal(control.calls.length, 1);
    NodeAssert.ok(panel.allocatableTerminalIds.includes("term-1"));
    panel.applySessionsEvent({ kind: "remove", terminalId: "term-1" });
    NodeAssert.ok(!panel.allocatableTerminalIds.includes("term-1"));
    panel.dispose();
  });

  NodeTest.it("an exited snapshot during Start keeps the session", async () => {
    const attach = deferred();
    const control = fakeControl({
      attach(input) {
        control.calls.push(["attach", input]);
        return attach.promise;
      },
    });
    const panel = new TerminalPanel({ control, launch });
    panel.applySessionsEvent({
      kind: "snapshot",
      terminals: [meta("term-1", { status: "exited", exitCode: 0 })],
    });
    const starting = panel.startSession("term-1");
    panel.noteOutputSnapshot("term-1", "exited");
    attach.resolve(meta("term-1"));
    await starting;
    NodeAssert.deepEqual(panel.snapshot.terminalIds, ["term-1"]);
    NodeAssert.equal(panel.snapshot.tabs[0].status, "running");
    NodeAssert.deepEqual(
      control.calls.map(([method]) => method),
      ["attach"],
    );
    panel.dispose();
  });

  NodeTest.it("a failed-start session keeps its error and retry", async () => {
    const control = fakeControl();
    const panel = new TerminalPanel({ control, launch });
    panel.applySessionsEvent({
      kind: "snapshot",
      terminals: [meta("term-1", { status: "error" }), meta("term-2")],
    });
    panel.applySessionsEvent({ kind: "upsert", terminal: meta("term-2", { status: "error" }) });
    panel.noteOutputSnapshot("term-1", "error");
    await tick();
    NodeAssert.deepEqual(panel.snapshot.terminalIds, ["term-1", "term-2"]);
    NodeAssert.deepEqual(
      panel.snapshot.tabs.map((tab) => [tab.status, tab.exitBanner]),
      [
        ["error", null],
        ["error", null],
      ],
    );
    NodeAssert.deepEqual(control.calls, []);
    await panel.startSession("term-1");
    NodeAssert.deepEqual(
      control.calls.map(([method]) => method),
      ["attach"],
    );
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

NodeTest.test("unknown output recovery is bounded until fresh output re-arms it", async () => {
  const control = fakeControl();
  const panel = new TerminalPanel({ control, launch });
  panel.applySessionsEvent({ kind: "snapshot", terminals: [meta("term-1")] });
  const unknown = new Error("Unknown terminal thread: t, terminal: term-1");
  try {
    for (let outage = 1; outage <= 2; outage++) {
      panel.noteOutputError("term-1", unknown);
      NodeAssert.equal(panel.snapshot.tabs[0].outputRecoveryPending, true);
      panel.startMissingSessions(["term-1"]);
      await new Promise(setImmediate);
      NodeAssert.equal(panel.snapshot.tabs[0].status, "running");
      NodeAssert.equal(panel.snapshot.tabs[0].outputRecoveryPending, true);
      panel.noteOutputError("term-1", unknown);
      NodeAssert.equal(panel.snapshot.tabs[0].outputRecoveryPending, false);
      panel.startMissingSessions(["term-1"]);
      NodeAssert.equal(control.calls.filter(([method]) => method === "attach").length, outage);
      panel.noteOutputSnapshot("term-1", "running");
    }
    panel.noteOutputError("term-1", new Error("permission denied"));
    NodeAssert.equal(panel.snapshot.tabs[0].startsWhenShown, false);
    NodeAssert.equal(control.calls.filter(([method]) => method === "attach").length, 2);
  } finally {
    panel.dispose();
  }
});

for (const status of ["error", "exited"]) {
  NodeTest.test(`r2 recovery settles a non-running attach receipt (${status})`, async () => {
    const control = fakeControl();
    control.attach = async () => meta("term-1", { status });
    const panel = new TerminalPanel({ control, launch });
    try {
      panel.applySessionsEvent({ kind: "snapshot", terminals: [meta("term-1")] });
      panel.noteOutputError("term-1", new Error("Unknown terminal thread: t, terminal: term-1"));
      panel.startMissingSessions(["term-1"]);
      await new Promise(setImmediate);
      NodeAssert.equal(panel.snapshot.tabs[0].status, status);
      NodeAssert.equal(panel.snapshot.tabs[0].outputRecoveryPending, false);
    } finally {
      panel.dispose();
    }
  });
}

NodeTest.test("r2 close receipt releases the saved marker without a remove event", async () => {
  const closing = deferred();
  const control = fakeControl();
  control.close = (input) => {
    control.calls.push(["close", input]);
    return closing.promise;
  };
  const panel = new TerminalPanel({
    control,
    launch,
    restored: {
      terminalIds: ["term-6"],
      activeTerminalId: "term-6",
      suppressedTerminalIds: ["term-6"],
    },
  });
  try {
    const event = { kind: "snapshot", terminals: [meta("term-6", { status: "exited" })] };
    panel.applySessionsEvent(event);
    panel.applySessionsEvent(event);
    NodeAssert.deepEqual(control.calls, [["close", { terminalId: "term-6", deleteHistory: true }]]);
    NodeAssert.deepEqual(panel.snapshot.suppressedTerminalIds, ["term-6"]);
    closing.resolve({});
    await new Promise(setImmediate);
    NodeAssert.deepEqual(panel.snapshot.suppressedTerminalIds, []);
    panel.applySessionsEvent({ kind: "upsert", terminal: meta("term-6") });
    NodeAssert.deepEqual(panel.snapshot.terminalIds, ["term-6"]);
  } finally {
    panel.dispose();
  }
});

NodeTest.test("r2 failed close replay stays bounded and scoped to its panel", async () => {
  const control = fakeControl();
  control.close = async (input) => {
    control.calls.push(["close", input]);
    throw new Error("offline");
  };
  const panel = new TerminalPanel({
    control,
    launch,
    restored: {
      terminalIds: ["term-6"],
      activeTerminalId: "term-6",
      suppressedTerminalIds: Array.from({ length: 5000 }, (_, index) => `term-${index}`),
    },
  });
  const otherControl = fakeControl();
  const otherPanel = new TerminalPanel({ control: otherControl, launch });
  try {
    const snapshot = { kind: "snapshot", terminals: [meta("term-6", { status: "exited" })] };
    panel.applySessionsEvent(snapshot);
    await new Promise(setImmediate);
    panel.applySessionsEvent(snapshot);
    panel.applySessionsEvent({ kind: "upsert", terminal: snapshot.terminals[0] });
    await new Promise(setImmediate);
    NodeAssert.deepEqual(control.calls, [
      ["close", { terminalId: "term-6", deleteHistory: true }],
      ["close", { terminalId: "term-6", deleteHistory: true }],
    ]);
    NodeAssert.deepEqual(panel.snapshot.suppressedTerminalIds, ["term-6"]);
    otherPanel.applySessionsEvent({ kind: "snapshot", terminals: [meta("term-6")] });
    NodeAssert.deepEqual(otherPanel.snapshot.terminalIds, ["term-6"]);
    NodeAssert.deepEqual(otherPanel.snapshot.suppressedTerminalIds, []);
    NodeAssert.deepEqual(otherControl.calls, []);
    panel.applySessionsEvent({ kind: "remove", terminalId: "term-6" });
    panel.applySessionsEvent({ kind: "upsert", terminal: meta("term-6") });
    NodeAssert.deepEqual(panel.snapshot.suppressedTerminalIds, []);
    NodeAssert.deepEqual(panel.snapshot.terminalIds, ["term-6"]);
  } finally {
    panel.dispose();
    otherPanel.dispose();
  }
});

NodeTest.test("recovery subscribes once when another client supplies the running session", () => {
  const control = fakeControl();
  const panel = new TerminalPanel({ control, launch });
  try {
    panel.applySessionsEvent({ kind: "snapshot", terminals: [meta("term-1")] });
    const revision = panel.snapshot.tabs[0].attachmentRevision;
    panel.noteOutputError("term-1", new Error("Unknown terminal thread: t, terminal: term-1"));
    panel.applySessionsEvent({ kind: "upsert", terminal: meta("term-1") });
    panel.startMissingSessions(["term-1"]);
    NodeAssert.deepEqual(control.calls, []);
    NodeAssert.equal(panel.snapshot.tabs[0].attachmentRevision, revision + 1);
    panel.applySessionsEvent({ kind: "upsert", terminal: meta("term-1") });
    NodeAssert.equal(panel.snapshot.tabs[0].attachmentRevision, revision + 1);
    panel.noteOutputSnapshot("term-1", "running");
    NodeAssert.equal(panel.snapshot.tabs[0].outputRecoveryPending, false);
  } finally {
    panel.dispose();
  }
});

NodeTest.test("r2 a starting attach receipt settles when the session reports failure", async () => {
  const control = fakeControl();
  control.attach = async () => meta("term-1", { status: "starting" });
  const panel = new TerminalPanel({ control, launch });
  try {
    panel.applySessionsEvent({ kind: "snapshot", terminals: [meta("term-1")] });
    panel.noteOutputError("term-1", new Error("Unknown terminal thread: t, terminal: term-1"));
    panel.startMissingSessions(["term-1"]);
    await new Promise(setImmediate);
    NodeAssert.equal(panel.snapshot.tabs[0].outputRecoveryPending, true);
    panel.applySessionsEvent({ kind: "upsert", terminal: meta("term-1", { status: "error" }) });
    NodeAssert.equal(panel.snapshot.tabs[0].outputRecoveryPending, false);
    NodeAssert.equal(panel.snapshot.tabs[0].status, "error");
  } finally {
    panel.dispose();
  }
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
        "t3.ui/theme",
        "t3.ui/keybindings",
        "t3.ui/panels",
        "t3.ui/external",
        "t3.ui/editor",
      ],
    );
    // No requirement needs a newer contract than its 1.0.0 baseline.
    for (const item of manifest.requires.filter((entry) => entry.id.startsWith("t3.ui/")))
      NodeAssert.equal(item.versionRange, "^1.0.0", item.id);
  });
});

NodeTest.describe("terminal URL links (Terminal 22 URL half)", () => {
  const openLink =
    (answer, calls = []) =>
    async (url) => {
      calls.push(url);
      if (answer instanceof Error) throw answer;
      return answer;
    };

  NodeTest.it("opens silently wherever the host sent the link", async () => {
    const calls = [];
    for (const opener of ["desktop-shell", "in-app-browser"])
      NodeAssert.equal(
        await openTerminalUrl(
          openLink({ status: "opened", url: "https://t3.codes/", opener }, calls),
          "https://t3.codes",
        ),
        null,
      );
    NodeAssert.deepEqual(calls, ["https://t3.codes", "https://t3.codes"]);
  });

  NodeTest.it("names a refusal and a denied invoke", async () => {
    NodeAssert.equal(
      await openTerminalUrl(
        openLink({ status: "refused", reason: "scheme-not-allowed" }),
        "ftp://x",
      ),
      "ftp://x was not opened (scheme-not-allowed).",
    );
    NodeAssert.equal(
      await openTerminalUrl(
        openLink(new Error("API capability denied: t3.ui/external.open")),
        "https://t3.codes",
      ),
      "https://t3.codes could not be opened — Needs permission t3.ui/external.open. Grant it in Settings → Extensions.",
    );
  });
});

NodeTest.describe("terminal path links (Terminal 22 path half)", () => {
  const signal = new AbortController().signal;
  const editor = (answer, calls = []) => ({
    invoke: async (method, input) => {
      calls.push({ method, input });
      if (answer instanceof Error) throw answer;
      return answer;
    },
  });

  NodeTest.it("hands the raw link and launch cwd to t3.ui/editor and opens silently", async () => {
    const calls = [];
    const opened = editor({ status: "opened", path: "/ws/root/a.ts:3:5", editor: "zed" }, calls);
    NodeAssert.equal(await openTerminalPath(opened, "a.ts:3:5", "/ws/root", signal), null);
    NodeAssert.deepEqual(calls, [
      { method: "openPath", input: { path: "a.ts:3:5", cwd: "/ws/root" } },
    ]);
  });

  NodeTest.it("writes the host's refusal and names a denied invoke", async () => {
    NodeAssert.equal(
      await openTerminalPath(
        editor({ status: "refused", reason: "no-editor", message: "No available editor." }),
        "a.ts",
        "/ws/root",
        signal,
      ),
      "No available editor.",
    );
    NodeAssert.equal(
      await openTerminalPath(
        editor(new Error("API capability denied: t3.ui/editor.open")),
        "a.ts",
        "/ws/root",
        signal,
      ),
      "a.ts could not be opened — Needs permission t3.ui/editor.open. Grant it in Settings → Extensions.",
    );
  });
});

NodeTest.describe("OutputReattach (native durable-attach port)", () => {
  // Each step: a running report ("run:<bool>"), a subscription ("sub"), or a
  // stream end asking take() — expected result in the table.
  const cases = [
    { name: "a healthy mount never reattaches", running: true, steps: [["take", false]] },
    {
      name: "a stale running row spends nothing",
      running: true,
      steps: [
        ["take", false],
        ["take", false],
      ],
    },
    {
      name: "Retry after the stream ended",
      running: false,
      steps: [["run:true"], ["take", true], ["take", false]],
    },
    {
      name: "an edge latched while the old stream drains",
      running: false,
      steps: [["run:true"], ["take", true]],
    },
    {
      name: "transport drop, then starting → running",
      running: true,
      steps: [["take", false], ["run:false"], ["run:true"], ["take", true]],
    },
    {
      name: "a later Start after a stale row re-arms",
      running: true,
      steps: [["take", false], ["run:false"], ["run:true"], ["take", true]],
    },
    {
      name: "a subscription consumes the edge it read",
      running: true,
      steps: [["run:false"], ["run:true"], ["sub"], ["take", false]],
    },
    {
      name: "running → running is no edge",
      running: false,
      steps: [["run:true"], ["sub"], ["run:true"], ["take", false]],
    },
  ];
  for (const { name, running, steps } of cases)
    NodeTest.test(name, () => {
      const reattach = new OutputReattach(running);
      for (const [step, expected] of steps) {
        if (step === "sub") reattach.subscribed();
        else if (step === "take") NodeAssert.equal(reattach.take(), expected, `${name}: take`);
        else reattach.noteRunning(step === "run:true");
      }
    });
});
