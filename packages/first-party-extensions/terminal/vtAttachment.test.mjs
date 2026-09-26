import * as NodeAssert from "node:assert/strict";
import * as NodeTest from "node:test";

import { TerminalVtAttachment, pumpTerminalOutput } from "./vtAttachment.ts";
import { isBrokerStreamRefusal } from "./streamHub.ts";
import { OVERFLOW_RESUBSCRIBE_MAX } from "./viewModel.ts";

const EPOCH = "epoch-1";

function sink() {
  const calls = [];
  return {
    calls,
    resetAndWrite(data) {
      calls.push(["resetAndWrite", data]);
    },
    write(data) {
      calls.push(["write", data]);
    },
    clearScreen() {
      calls.push(["clearScreen"]);
    },
  };
}

function bracketedSink() {
  const calls = [];
  return {
    calls,
    resetAndWrite(data) {
      calls.push(["resetAndWrite", data]);
    },
    write(data) {
      calls.push(["write", data]);
    },
    clearScreen() {
      calls.push(["clearScreen"]);
    },
    beginReplay() {
      calls.push(["beginReplay"]);
    },
    endReplay() {
      calls.push(["endReplay"]);
    },
  };
}

function frame(sequence, value, streamId = "stream-1") {
  return { streamId, sequence, value };
}

function snapshot(overrides = {}) {
  return {
    kind: "snapshot",
    terminalId: "term-1",
    streamEpoch: EPOCH,
    status: "running",
    contents: "prompt$ ",
    retainedByteLength: 8,
    truncated: false,
    clearGeneration: 0,
    contentsUnitStart: 0,
    boundarySequence: 7,
    ...overrides,
  };
}

function output(sequence, data, chunkIndex = 0, chunkCount = 1, streamEpoch = EPOCH) {
  return {
    kind: "output",
    terminalId: "term-1",
    streamEpoch,
    sequence,
    chunkIndex,
    chunkCount,
    data,
  };
}

async function* iterate(frames) {
  for (const f of frames) yield f;
}

NodeTest.describe("TerminalVtAttachment — snapshot + attach", () => {
  NodeTest.it("a complete snapshot seeds the parser and reports live", () => {
    const vt = new TerminalVtAttachment("term-1");
    const s = sink();
    vt.attach(s);
    vt.beginStream();
    vt.applyFrame(frame(1, snapshot()), snapshot());
    NodeAssert.equal(vt.state.status, "live");
    NodeAssert.equal(vt.state.degraded, false);
    // R7 first-window boundary: a complete first snapshot is delivered
    // reply-enabled (its queries get answers), a plain write on the fresh
    // parser — no suppressed re-base.
    NodeAssert.deepEqual(s.calls, [["write", "prompt$ "]]);
  });

  NodeTest.it("a truncated snapshot is live but degraded — parity is unclaimed", () => {
    const vt = new TerminalVtAttachment("term-1");
    const s = sink();
    vt.attach(s);
    vt.beginStream();
    const snap = snapshot({ truncated: true, contents: "tail-only" });
    vt.applyFrame(frame(1, snap), snap);
    NodeAssert.equal(vt.state.status, "live");
    NodeAssert.equal(vt.state.degraded, true);
    NodeAssert.match(vt.state.statusText, /truncated/);
  });

  NodeTest.it("a program probing before first mount gets its answer at attach", () => {
    // R7 first-window gap boundary: the program sent a cursor-position
    // query (CSI 6n) before this client ever attached, so the probe bytes
    // sit in the FIRST snapshot's retained contents. The snapshot is
    // proven complete since process start (nothing truncated, zero
    // clears, window origin at unit 0), so it is claimed as the window's
    // first gap — the attach replays it with replies enabled instead of
    // suppressing the query until a reshow cycle re-delivers the bytes.
    const vt = new TerminalVtAttachment("term-1");
    vt.beginStream();
    const probe = snapshot({
      contents: "out\u001b[6n",
      retainedByteLength: 7,
      boundarySequence: 3,
    });
    vt.applyFrame(frame(1, probe), probe);
    const s = bracketedSink();
    vt.attach(s);
    // The query replayed OUTSIDE the suppression bracket — the PTY reply
    // writer is attached to exactly those bytes.
    NodeAssert.deepEqual(s.calls, [
      ["beginReplay"],
      ["resetAndWrite", ""],
      ["endReplay"],
      ["write", "out\u001b[6n"],
    ]);
  });

  NodeTest.it("a live surface answers the first snapshot's queries immediately", () => {
    // The same first-window claim on a pane whose surface mounted before
    // the stream began: the whole snapshot is the gap, delivered with a
    // plain reply-enabled write — no suppression bracket, and no RIS
    // re-base is owed by a parser that never parsed anything.
    const vt = new TerminalVtAttachment("term-1");
    const s = bracketedSink();
    vt.attach(s);
    vt.beginStream();
    const probe = snapshot({
      contents: "out\u001b[c",
      retainedByteLength: 6,
      boundarySequence: 3,
    });
    vt.applyFrame(frame(1, probe), probe);
    NodeAssert.deepEqual(s.calls, [["write", "out\u001b[c"]]);
    NodeAssert.equal(vt.state.status, "live");
    NodeAssert.equal(vt.state.degraded, false);
  });

  NodeTest.it(
    "a truncated first snapshot keeps the suppressed replay — coverage is not provable",
    () => {
      // Retention already evicted early bytes, so the first snapshot cannot
      // prove it carries the whole stream: no first-window claim, the replay
      // stays suppressed, and the pane degrades as before.
      const vt = new TerminalVtAttachment("term-1");
      vt.beginStream();
      const snap = snapshot({
        contents: "tail\u001b[6n",
        truncated: true,
        contentsUnitStart: 64,
        retainedByteLength: 8,
      });
      vt.applyFrame(frame(1, snap), snap);
      const s = bracketedSink();
      vt.attach(s);
      NodeAssert.deepEqual(s.calls, [
        ["beginReplay"],
        ["resetAndWrite", "tail\u001b[6n"],
        ["endReplay"],
      ]);
      NodeAssert.equal(vt.state.degraded, true);
    },
  );

  NodeTest.it("reassembles chunked output before it reaches the parser", () => {
    const vt = new TerminalVtAttachment("term-1");
    const s = sink();
    vt.attach(s);
    vt.beginStream();
    vt.applyFrame(frame(1, snapshot()), snapshot());
    vt.applyFrame(frame(2, output(10, "hello ", 0, 3)), output(10, "hello ", 0, 3));
    vt.applyFrame(frame(3, output(10, "wor", 1, 3)), output(10, "wor", 1, 3));
    // Only the first snapshot's reply-enabled delivery happened; no chunk
    // bytes reached the parser while the group was incomplete.
    NodeAssert.deepEqual(
      s.calls.filter(([m]) => m === "write"),
      [["write", "prompt$ "]],
    );
    vt.applyFrame(frame(4, output(10, "ld", 2, 3)), output(10, "ld", 2, 3));
    NodeAssert.deepEqual(s.calls.at(-1), ["write", "hello world"]);
  });

  NodeTest.it("buffers output while no surface is attached, then replays base + live", () => {
    const vt = new TerminalVtAttachment("term-1");
    vt.beginStream();
    vt.applyFrame(frame(1, snapshot()), snapshot());
    vt.applyFrame(frame(2, output(10, "live-1")), output(10, "live-1"));
    vt.applyFrame(frame(3, output(11, "live-2")), output(11, "live-2"));
    const s = sink();
    vt.attach(s);
    // R7: the first snapshot was claimed as the window's first gap and
    // extended by the detached bytes — one reply-enabled write over the
    // suppressed (empty-prefix) re-base, so queries inside still get their
    // response.
    NodeAssert.deepEqual(s.calls, [
      ["resetAndWrite", ""],
      ["write", "prompt$ live-1live-2"],
    ]);
  });

  NodeTest.it("history clear erases a live surface WITHOUT resetting parser modes", () => {
    // The server's `cleared` event only drops retained history — the
    // process keeps running with its negotiated modes. A live surface gets
    // a mode-preserving erase, not resetAndWrite (an RIS would wipe
    // application-cursor/bracketed-paste and mis-encode the next paste).
    const vt = new TerminalVtAttachment("term-1");
    const s = sink();
    vt.attach(s);
    vt.beginStream();
    vt.applyFrame(frame(1, snapshot()), snapshot());
    const reset = {
      kind: "reset",
      terminalId: "term-1",
      streamEpoch: EPOCH,
      sequence: 20,
      clearGeneration: 1,
      reason: "history-cleared",
    };
    vt.applyFrame(frame(2, reset), reset);
    NodeAssert.equal(vt.state.status, "live");
    NodeAssert.equal(vt.state.degraded, false);
    NodeAssert.deepEqual(s.calls.at(-1), ["clearScreen"]);
  });

  NodeTest.it(
    "history clear after a truncated attach stays degraded — clearing history is not a resync",
    () => {
      const vt = new TerminalVtAttachment("term-1");
      const s = sink();
      vt.attach(s);
      vt.beginStream();
      vt.applyFrame(frame(1, snapshot({ truncated: true })), snapshot({ truncated: true }));
      NodeAssert.equal(vt.state.degraded, true);
      const reset = {
        kind: "reset",
        terminalId: "term-1",
        streamEpoch: EPOCH,
        sequence: 20,
        clearGeneration: 1,
        reason: "history-cleared",
      };
      vt.applyFrame(frame(2, reset), reset);
      NodeAssert.equal(vt.state.degraded, true);
      NodeAssert.equal(vt.state.status, "live");
      NodeAssert.deepEqual(s.calls.at(-1), ["clearScreen"]);
      // Only a full-fidelity snapshot in a NEW epoch re-bases the parser —
      // a same-epoch post-clear snapshot still lacks the mode bytes.
      vt.beginStream();
      const snap2 = {
        ...snapshot({ contents: "fresh", boundarySequence: 40 }),
        streamEpoch: "epoch-2",
      };
      vt.applyFrame(frame(1, snap2), snap2);
      NodeAssert.equal(vt.state.degraded, false);
    },
  );

  NodeTest.it(
    "history clear with no surface leaves the replay base unfaithful — degraded until a full snapshot",
    () => {
      const vt = new TerminalVtAttachment("term-1");
      vt.beginStream();
      vt.applyFrame(frame(1, snapshot()), snapshot());
      const reset = {
        kind: "reset",
        terminalId: "term-1",
        streamEpoch: EPOCH,
        sequence: 20,
        clearGeneration: 1,
        reason: "history-cleared",
      };
      vt.applyFrame(frame(2, reset), reset);
      NodeAssert.equal(vt.state.degraded, true);
      NodeAssert.match(vt.state.statusText, /modes are unknown/);
    },
  );

  NodeTest.it(
    "a remount after history clear replays without mode history and flags degraded",
    () => {
      const vt = new TerminalVtAttachment("term-1");
      const s = sink();
      vt.attach(s);
      vt.beginStream();
      vt.applyFrame(frame(1, snapshot()), snapshot());
      const reset = {
        kind: "reset",
        terminalId: "term-1",
        streamEpoch: EPOCH,
        sequence: 20,
        clearGeneration: 1,
        reason: "history-cleared",
      };
      vt.applyFrame(frame(2, reset), reset);
      vt.applyFrame(frame(3, output(21, "post-clear")), output(21, "post-clear"));
      NodeAssert.equal(vt.state.degraded, false);
      // Detach + remount: the replay (empty base + post-clear bytes) cannot
      // reconstruct the pre-clear modes — honesty requires the banner.
      vt.detach();
      const s2 = sink();
      vt.attach(s2);
      NodeAssert.equal(vt.state.degraded, true);
      // "post-clear" was delivered to the live sink (already parsed), so it
      // replays inside the suppressed reset write — one contiguous stream.
      NodeAssert.deepEqual(s2.calls, [["resetAndWrite", "post-clear"]]);
    },
  );

  NodeTest.it(
    "a post-clear resubscribe keeps the surviving parser's modes; a remount degrades",
    () => {
      // The server reports truncated:false after a clear (retention dropped
      // nothing; history was explicitly cleared). The live pane OBSERVED
      // the clear, so its parser kept the pre-clear modes — the resubscribe
      // snapshot must deliver only the gap bytes and keep them. A REMOUNT
      // replays post-clear retention only; its replay cannot reconstruct
      // the pre-clear mode bytes, so honesty requires the degraded banner
      // until a new process epoch.
      const s = sink();
      const vt = new TerminalVtAttachment("term-1");
      vt.attach(s);
      vt.beginStream();
      vt.applyFrame(frame(1, snapshot()), snapshot());
      const reset = {
        kind: "reset",
        terminalId: "term-1",
        streamEpoch: EPOCH,
        sequence: 20,
        clearGeneration: 1,
        reason: "history-cleared",
      };
      vt.applyFrame(frame(2, reset), reset);
      NodeAssert.equal(vt.state.degraded, false); // live sink preserved modes
      // Resubscribe (same epoch): the snapshot's post-clear bytes arrived
      // in the subscription gap. The parser sits at the post-clear origin,
      // so it receives exactly the gap — no RIS re-base, no degradation.
      vt.beginStream();
      const snap2 = snapshot({
        contents: "post-clear",
        boundarySequence: 30,
        clearGeneration: 1,
      });
      vt.applyFrame(frame(1, snap2), snap2);
      NodeAssert.equal(vt.state.degraded, false);
      NodeAssert.deepEqual(s.calls.at(-1), ["write", "post-clear"]);
      // The first snapshot's delivery was the R7 reply-enabled write — no
      // suppressed re-base ever happened on this pane.
      NodeAssert.equal(s.calls.filter(([m]) => m === "resetAndWrite").length, 0);
      // Remount: the replay base is post-clear only — the pre-clear
      // mode-establishing bytes are gone from retention.
      vt.detach();
      const s2 = sink();
      vt.attach(s2);
      NodeAssert.equal(vt.state.degraded, true);
      // A new process epoch re-proves everything.
      vt.beginStream();
      const snap3 = {
        ...snapshot({ contents: "fresh epoch" }),
        streamEpoch: "epoch-2",
      };
      vt.applyFrame(frame(1, snap3), snap3);
      NodeAssert.equal(vt.state.degraded, false);
    },
  );

  NodeTest.it("exit records the code and ends the stream", () => {
    const vt = new TerminalVtAttachment("term-1");
    vt.attach(sink());
    vt.beginStream();
    vt.applyFrame(frame(1, snapshot()), snapshot());
    const exit = {
      kind: "exit",
      terminalId: "term-1",
      streamEpoch: EPOCH,
      sequence: 9,
      exitCode: 3,
      exitSignal: null,
    };
    vt.applyFrame(frame(2, exit), exit);
    NodeAssert.equal(vt.state.status, "exited");
    NodeAssert.equal(vt.state.exitCode, 3);
    NodeAssert.equal(vt.state.ended, true);
    // Late frames after an ended stream are ignored.
    vt.applyFrame(frame(3, output(10, "zombie")), output(10, "zombie"));
    NodeAssert.equal(vt.state.status, "exited");
  });
});

NodeTest.describe("TerminalVtAttachment — failure paths", () => {
  NodeTest.it("a discontinuous stream sequence fails the attachment", () => {
    const vt = new TerminalVtAttachment("term-1");
    vt.attach(sink());
    vt.beginStream();
    vt.applyFrame(frame(1, snapshot()), snapshot());
    vt.applyFrame(frame(5, output(10, "gap")), output(10, "gap"));
    NodeAssert.equal(vt.state.status, "error");
    NodeAssert.match(vt.state.statusText, /discontinuous/);
  });

  NodeTest.it("an incarnation change mid-stream fails rather than mixing bytes", () => {
    const vt = new TerminalVtAttachment("term-1");
    vt.attach(sink());
    vt.beginStream();
    vt.applyFrame(frame(1, snapshot()), snapshot());
    vt.applyFrame(frame(2, output(10, "x", 0, 1, "epoch-2")), output(10, "x", 0, 1, "epoch-2"));
    NodeAssert.equal(vt.state.status, "error");
    NodeAssert.match(vt.state.statusText, /incarnation/);
  });

  NodeTest.it("an exit with an incomplete chunk group is an error, not a clean exit", () => {
    const vt = new TerminalVtAttachment("term-1");
    vt.attach(sink());
    vt.beginStream();
    vt.applyFrame(frame(1, snapshot()), snapshot());
    vt.applyFrame(frame(2, output(10, "partial", 0, 2)), output(10, "partial", 0, 2));
    const exit = {
      kind: "exit",
      terminalId: "term-1",
      streamEpoch: EPOCH,
      sequence: 11,
      exitCode: 0,
      exitSignal: null,
    };
    vt.applyFrame(frame(3, exit), exit);
    NodeAssert.equal(vt.state.status, "error");
    NodeAssert.match(vt.state.statusText, /incomplete/);
  });

  NodeTest.it("an out-of-contract chunk is rejected", () => {
    const vt = new TerminalVtAttachment("term-1");
    const s = sink();
    vt.attach(s);
    vt.beginStream();
    vt.applyFrame(frame(1, snapshot()), snapshot());
    const seeded = s.calls.length; // the first snapshot's reply-enabled write
    const bad = output(10, "x".repeat(8193));
    vt.applyFrame(frame(2, bad), bad);
    NodeAssert.equal(vt.state.status, "error");
    NodeAssert.equal(s.calls.length, seeded);
  });

  NodeTest.it("a new group starting over an incomplete group fails instead of swapping", () => {
    // The reducer rejects chunkIndex 0 of group N+1 while group N is
    // incomplete — accepting it would silently lose bytes mid-stream.
    const vt = new TerminalVtAttachment("term-1");
    const s = sink();
    vt.attach(s);
    vt.beginStream();
    vt.applyFrame(frame(1, snapshot()), snapshot());
    const seeded = s.calls.length; // the first snapshot's reply-enabled write
    vt.applyFrame(frame(2, output(10, "lost-head", 0, 2)), output(10, "lost-head", 0, 2));
    vt.applyFrame(frame(3, output(11, "next", 0, 1)), output(11, "next", 0, 1));
    NodeAssert.equal(vt.state.status, "error");
    NodeAssert.match(vt.state.statusText, /discontinuous/);
    NodeAssert.equal(s.calls.length, seeded);
  });

  NodeTest.it("a native sequence that does not strictly increase fails", () => {
    const vt = new TerminalVtAttachment("term-1");
    const s = sink();
    vt.attach(s);
    vt.beginStream();
    vt.applyFrame(frame(1, snapshot()), snapshot()); // boundarySequence 7
    vt.applyFrame(frame(2, output(10, "a")), output(10, "a"));
    // Replay at the boundary and a regression are both rejected.
    vt.applyFrame(frame(3, output(7, "replayed")), output(7, "replayed"));
    NodeAssert.equal(vt.state.status, "error");
    NodeAssert.match(vt.state.statusText, /monotonic/);
  });

  NodeTest.it("the pre-sink buffer is bounded and dropping bytes marks degraded", () => {
    const vt = new TerminalVtAttachment("term-1");
    vt.beginStream();
    vt.applyFrame(frame(1, snapshot()), snapshot());
    // No surface attached: >512KiB of live output must not accumulate.
    let seq = 1;
    let native = 8;
    for (let i = 0; i < 70; i += 1) {
      const value = output(native, "x".repeat(8192));
      native += 1;
      seq += 1;
      vt.applyFrame(frame(seq, value), value);
    }
    NodeAssert.equal(vt.state.status, "live");
    NodeAssert.equal(vt.state.degraded, true);
    // A late surface replays only the retained tail and sees the banner.
    const s = sink();
    vt.attach(s);
    const replayed = s.calls.filter(([m]) => m === "write").reduce((n, [, d]) => n + d.length, 0);
    NodeAssert.ok(replayed <= 512 * 1024);
    NodeAssert.ok(replayed > 0);
  });

  NodeTest.it("a surface-create failure is a visible error, not a dead pane", () => {
    const vt = new TerminalVtAttachment("term-1");
    vt.beginStream();
    vt.applyFrame(frame(1, snapshot()), snapshot());
    vt.applySinkFailure("Terminal renderer failed to start: no canvas");
    NodeAssert.equal(vt.state.status, "error");
    NodeAssert.match(vt.state.statusText, /renderer failed/);
    NodeAssert.equal(vt.state.ended, false);
    // The stream keeps applying into the bounded buffer — a remount can
    // still attach and replay.
    vt.applyFrame(frame(2, output(10, "still-live")), output(10, "still-live"));
    const s = sink();
    vt.attach(s);
    // R7: the first snapshot was claimed as the window's first gap and
    // extended by the buffered bytes — one reply-enabled write over the
    // suppressed (empty-prefix) re-base.
    NodeAssert.deepEqual(s.calls, [
      ["resetAndWrite", ""],
      ["write", "prompt$ still-live"],
    ]);
    // A successful mount clears the failure.
    NodeAssert.equal(vt.state.status, "live");
  });

  NodeTest.it("a snapshot arriving after a renderer-start failure cannot hide it", () => {
    const vt = new TerminalVtAttachment("term-1");
    vt.beginStream();
    // The real ordering: WASM/DOM mount fails first, then the stream's
    // snapshot lands — the pane must stay errored, not silently "live"
    // with no renderer behind it.
    vt.applySinkFailure("Terminal renderer failed to start: no canvas");
    vt.applyFrame(frame(1, snapshot()), snapshot());
    NodeAssert.equal(vt.state.status, "error");
    NodeAssert.match(vt.state.statusText, /renderer failed/);
    // Same for a history-clear frame.
    const reset = {
      kind: "reset",
      terminalId: "term-1",
      streamEpoch: EPOCH,
      sequence: 8,
      clearGeneration: 1,
      reason: "history-cleared",
    };
    vt.applyFrame(frame(2, reset), reset);
    NodeAssert.equal(vt.state.status, "error");
    // A resubscribe snapshot still cannot mask it.
    vt.beginStream();
    vt.applyFrame(frame(1, snapshot()), snapshot());
    NodeAssert.equal(vt.state.status, "error");
    // Only a renderer that actually mounts restores live status.
    vt.attach(sink());
    NodeAssert.equal(vt.state.status, "live");
  });

  NodeTest.it("the replay boundary answers only never-delivered bytes", () => {
    const vt = new TerminalVtAttachment("term-1");
    const s = sink();
    vt.attach(s);
    vt.beginStream();
    vt.applyFrame(frame(1, snapshot()), snapshot());
    // Delivered to the live sink — already parsed and answered.
    vt.applyFrame(frame(2, output(10, "old-")), output(10, "old-"));
    vt.detach();
    // Buffered while detached — never parsed; queries inside still need
    // their reply, so these replay outside the suppression bracket.
    vt.applyFrame(frame(3, output(11, "new-1")), output(11, "new-1"));
    vt.applyFrame(frame(4, output(12, "new-2")), output(12, "new-2"));
    const s2 = sink();
    vt.attach(s2);
    NodeAssert.deepEqual(s2.calls, [
      ["resetAndWrite", "prompt$ old-"],
      ["write", "new-1new-2"],
    ]);
  });

  NodeTest.it(
    "a resubscribe snapshot extending past unanswered bytes keeps their claim mid-stream",
    () => {
      // An unanswered run is not necessarily a suffix of the replay stream —
      // the resubscribe snapshot's retained contents can append newer output
      // after it. Replay must suppress only the already-answered/history bytes
      // around the run. The appended gap bytes ("later") are claimed too —
      // nothing parsed them with the reply writer attached, so their queries
      // replay answered.
      const vt = new TerminalVtAttachment("term-1");
      vt.beginStream();
      const snap0 = snapshot({ contents: "", retainedByteLength: 0, boundarySequence: 0 });
      vt.applyFrame(frame(1, snap0), snap0);
      vt.applyFrame(frame(2, output(1, "Q")), output(1, "Q"));
      const closed = {
        kind: "closed",
        terminalId: "term-1",
        streamEpoch: EPOCH,
        reason: "overflow",
      };
      vt.applyFrame(frame(3, closed), closed);
      vt.beginStream();
      const snap1 = snapshot({
        contents: "Qlater",
        retainedByteLength: 6,
        boundarySequence: 2,
      });
      vt.applyFrame(frame(1, snap1), snap1);
      const s = bracketedSink();
      vt.attach(s);
      NodeAssert.deepEqual(s.calls, [
        ["beginReplay"],
        ["resetAndWrite", ""],
        ["endReplay"],
        ["write", "Q"],
        ["write", "later"],
      ]);
    },
  );

  NodeTest.it("a query emitted while hidden is answered on reshow — no RIS re-base", () => {
    // The pane hides, its output stream is dropped, and the program emits a
    // cursor-position query (CSI 6n). The surface stays mounted with its
    // parser; on reshow the resubscribe snapshot carries the gap bytes. The
    // surviving parser must receive exactly the gap — with the PTY reply writer
    // attached (no suppression bracket) — and without the RIS reset that would
    // wipe application-cursor mode.
    const s = bracketedSink();
    const vt = new TerminalVtAttachment("term-1");
    vt.attach(s);
    vt.beginStream();
    vt.applyFrame(frame(1, snapshot()), snapshot());
    vt.applyFrame(frame(2, output(10, "[?1h")), output(10, "[?1h"));
    const before = s.calls.length;
    // Hidden: the stream is gone and the host retains "\r\nQ" (a DSR the
    // process is still waiting on) past our last received byte.
    vt.beginStream();
    const reshow = snapshot({
      contents: "prompt$ [?1h\r\nQ",
      retainedByteLength: 14,
      boundarySequence: 11,
    });
    vt.applyFrame(frame(1, reshow), reshow);
    // Exactly the gap bytes, bracket-free — replies enabled — and no
    // resetAndWrite anywhere in the reshow.
    NodeAssert.deepEqual(s.calls.slice(before), [["write", "\r\nQ"]]);
    NodeAssert.equal(vt.state.degraded, false);
    NodeAssert.equal(vt.state.status, "live");
  });

  NodeTest.it("a truncated reshow snapshot does not wipe the surviving parser's modes", () => {
    // Retention evicted early history, so the reshow snapshot is truncated
    // — but the pane's parser saw every byte live. The snapshot must not
    // RIS-re-base it (that would drop application-cursor and friends the
    // process still expects); only the gap is delivered, the live pane
    // stays clean, and the unfaithful base degrades the NEXT remount.
    const s = sink();
    const vt = new TerminalVtAttachment("term-1");
    vt.attach(s);
    vt.beginStream();
    vt.applyFrame(frame(1, snapshot()), snapshot());
    vt.applyFrame(frame(2, output(10, "[?1hmode-text")), output(10, "[?1hmode-text"));
    const before = s.calls.length;
    vt.beginStream();
    const reshow = snapshot({
      contents: "pt$ [?1hmode-textgap",
      retainedByteLength: 21,
      truncated: true,
      contentsUnitStart: 4,
      boundarySequence: 11,
    });
    vt.applyFrame(frame(1, reshow), reshow);
    NodeAssert.deepEqual(s.calls.slice(before), [["write", "gap"]]);
    NodeAssert.equal(vt.state.degraded, false);
    vt.detach();
    const s2 = sink();
    vt.attach(s2);
    NodeAssert.equal(vt.state.degraded, true);
  });

  NodeTest.it("a throwing attach keeps the renderer failure sticky", () => {
    const vt = new TerminalVtAttachment("term-1");
    vt.beginStream();
    vt.applyFrame(frame(1, snapshot()), snapshot());
    vt.applySinkFailure("Terminal renderer failed to start: no canvas");
    // A mount whose replay throws must not clear the failure — the
    // renderer never actually took.
    const bad = {
      resetAndWrite() {
        throw new Error("wasm trap");
      },
      write() {},
      clearScreen() {},
    };
    NodeAssert.throws(() => vt.attach(bad), /wasm trap/);
    NodeAssert.equal(vt.state.status, "error");
    // The rejected sink is detached: output buffers for a clean remount.
    vt.applyFrame(frame(2, output(10, "buf")), output(10, "buf"));
    // A later snapshot still cannot mask it.
    vt.beginStream();
    vt.applyFrame(frame(1, snapshot()), snapshot());
    NodeAssert.equal(vt.state.status, "error");
    NodeAssert.match(vt.state.statusText, /renderer failed/);
    // And a mount that completes clears it.
    const s = sink();
    vt.attach(s);
    NodeAssert.equal(vt.state.status, "live");
  });

  NodeTest.it("a sink failure does not resurrect an ended stream", () => {
    const vt = new TerminalVtAttachment("term-1");
    vt.beginStream();
    vt.applyFrame(frame(1, snapshot()), snapshot());
    const exit = {
      kind: "exit",
      terminalId: "term-1",
      streamEpoch: EPOCH,
      sequence: 8,
      exitCode: 0,
    };
    vt.applyFrame(frame(2, exit), exit);
    NodeAssert.equal(vt.state.status, "exited");
    vt.applySinkFailure("Terminal renderer failed to start: no canvas");
    NodeAssert.equal(vt.state.status, "exited");
  });
});

NodeTest.describe("pumpTerminalOutput — recovery", () => {
  NodeTest.it(
    "identity-changed resubscribes and re-bases the parser on the new snapshot",
    async () => {
      const vt = new TerminalVtAttachment("term-1");
      const s = sink();
      vt.attach(s);
      const streams = [
        [
          frame(1, snapshot({ contents: "old" })),
          frame(2, {
            kind: "closed",
            terminalId: "term-1",
            streamEpoch: EPOCH,
            reason: "identity-changed",
          }),
        ],
        [frame(1, snapshot({ contents: "new", streamEpoch: "epoch-2" }), "stream-2")],
      ];
      let subscribes = 0;
      const ac = new AbortController();
      await pumpTerminalOutput({
        subscribe: () => {
          subscribes += 1;
          return iterate(streams[subscribes - 1] ?? []);
        },
        attachment: vt,
        signal: ac.signal,
      });
      NodeAssert.equal(subscribes, 2);
      NodeAssert.equal(vt.state.status, "live");
      NodeAssert.deepEqual(s.calls.at(-1), ["resetAndWrite", "new"]);
    },
  );

  NodeTest.it("overflow closes resubscribe up to the streak bound, then stop", async () => {
    const vt = new TerminalVtAttachment("term-1");
    vt.attach(sink());
    const closedOverflow = {
      kind: "closed",
      terminalId: "term-1",
      streamEpoch: EPOCH,
      reason: "overflow",
    };
    let subscribes = 0;
    let now = 0;
    const ac = new AbortController();
    await pumpTerminalOutput({
      subscribe: () => {
        subscribes += 1;
        now += 10;
        return iterate([frame(1, snapshot()), frame(2, closedOverflow)]);
      },
      attachment: vt,
      signal: ac.signal,
      now: () => now,
      sleep: () => Promise.resolve(),
    });
    // 1 initial + OVERFLOW_RESUBSCRIBE_MAX resubscribes, then the pump gives up.
    NodeAssert.equal(subscribes, OVERFLOW_RESUBSCRIBE_MAX + 1);
    NodeAssert.equal(vt.state.ended, true);
    NodeAssert.equal(vt.state.status, "closed");
  });

  NodeTest.it("a terminal-closed close ends the pump without resubscribing", async () => {
    const vt = new TerminalVtAttachment("term-1");
    vt.attach(sink());
    let subscribes = 0;
    const ac = new AbortController();
    await pumpTerminalOutput({
      subscribe: () => {
        subscribes += 1;
        return iterate([
          frame(1, snapshot()),
          frame(2, {
            kind: "closed",
            terminalId: "term-1",
            streamEpoch: EPOCH,
            reason: "terminal-closed",
          }),
        ]);
      },
      attachment: vt,
      signal: ac.signal,
    });
    NodeAssert.equal(subscribes, 1);
    NodeAssert.equal(vt.state.status, "closed");
  });

  NodeTest.it("a transport error surfaces as error, not a silent hang", async () => {
    const vt = new TerminalVtAttachment("term-1");
    vt.attach(sink());
    const ac = new AbortController();
    await pumpTerminalOutput({
      subscribe: async function* () {
        for await (const never of []) yield never;
        throw new Error("WebSocket dropped");
      },
      attachment: vt,
      signal: ac.signal,
    });
    NodeAssert.equal(vt.state.status, "error");
    NodeAssert.match(vt.state.statusText, /WebSocket dropped/);
  });

  NodeTest.it("a broker refusal ends the pump without failing the attachment", async () => {
    // R6: the broker's cap refusal is capacity another client of the
    // installation is spending — reported to the caller (which waits and
    // retries), never surfaced as the pane's error.
    const vt = new TerminalVtAttachment("term-1");
    vt.attach(sink());
    const ac = new AbortController();
    let refused = 0;
    await pumpTerminalOutput({
      subscribe: async function* () {
        for await (const never of []) yield never;
        throw new Error("Plugin stream limit reached");
      },
      attachment: vt,
      signal: ac.signal,
      refusal: isBrokerStreamRefusal,
      onRefused: () => {
        refused += 1;
      },
    });
    NodeAssert.equal(refused, 1);
    NodeAssert.equal(vt.state.status, "connecting"); // beginStream ran, nothing failed
    NodeAssert.equal(vt.state.ended, false);
    NodeAssert.doesNotMatch(vt.state.statusText, /limit reached/);
  });

  NodeTest.it("abortion stops the pump quietly", async () => {
    const vt = new TerminalVtAttachment("term-1");
    vt.attach(sink());
    const ac = new AbortController();
    ac.abort();
    await pumpTerminalOutput({
      subscribe: () => iterate([]),
      attachment: vt,
      signal: ac.signal,
    });
    NodeAssert.notEqual(vt.state.status, "error");
  });
});
