/**
 * VT conformance over the REAL vendored libghostty-vt WASM — the same
 * closure the extension packages as format-4 assets. Loads the bytes from
 * @t3tools/ghostty-terminal, the files the build stages for readAsset.
 */
import * as NodeAssert from "node:assert/strict";
import * as NodeFSP from "node:fs/promises";
import * as NodeTest from "node:test";
import * as NodeURL from "node:url";

import { GhosttyTerminalCore } from "@t3tools/ghostty-terminal/core";
import { loadGhosttyRuntime } from "@t3tools/ghostty-terminal/runtime";
import { TerminalVtAttachment } from "./vtAttachment.ts";

const assetsDir = NodeURL.fileURLToPath(
  new URL("./", import.meta.resolve("@t3tools/ghostty-terminal/assets/ghostty-vt.wasm")),
);

const THEME = {
  foreground: { r: 229, g: 231, b: 235 },
  background: { r: 10, g: 10, b: 12 },
  cursor: { r: 229, g: 231, b: 235 },
};

function fakeKey(overrides = {}) {
  return {
    code: "KeyA",
    key: "a",
    shiftKey: false,
    ctrlKey: false,
    altKey: false,
    metaKey: false,
    repeat: false,
    isComposing: false,
    getModifierState: () => false,
    ...overrides,
  };
}

function rowText(snapshot, row) {
  return snapshot.rowData[row].cells.map((cell) => cell.text).join("");
}

let runtime;

NodeTest.before(async () => {
  const [vt, writePty] = await Promise.all([
    NodeFSP.readFile(new URL("ghostty-vt.wasm", `file://${assetsDir}`)),
    NodeFSP.readFile(new URL("ghostty-write-pty.wasm", `file://${assetsDir}`)),
  ]);
  runtime = await loadGhosttyRuntime({ vt, writePty });
});

async function makeCore(cols = 80, rows = 24) {
  const writes = [];
  const core = await GhosttyTerminalCore.create(runtime, cols, rows, 8, 16, THEME, (data) =>
    writes.push(data),
  );
  return { core, writes };
}

NodeTest.describe("vendored libghostty-vt — screen semantics", () => {
  NodeTest.it("instantiates the packaged WASM and reports the vendored revision", async () => {
    const version = await NodeFSP.readFile(
      new URL("libghostty-vt-VERSION.txt", `file://${assetsDir}`),
      "utf8",
    );
    NodeAssert.match(version.trim(), /^[0-9a-f]{40}$/);
    NodeAssert.ok(runtime.memory instanceof WebAssembly.Memory);
  });

  NodeTest.it("writes text and tracks the cursor at 80x24", async () => {
    const { core } = await makeCore();
    core.write("hello");
    const snap = core.snapshot();
    NodeAssert.equal(snap.cols, 80);
    NodeAssert.equal(snap.rows, 24);
    NodeAssert.ok(rowText(snap, 0).startsWith("hello"));
    NodeAssert.equal(snap.cursorX, 5);
    core.dispose();
  });

  NodeTest.it("applies SGR colors to cells", async () => {
    const { core } = await makeCore();
    core.write("[31mred");
    const snap = core.snapshot();
    const cell = snap.rowData[0].cells[0];
    NodeAssert.equal(cell.text, "r");
    NodeAssert.deepEqual(
      { r: cell.foreground.r, g: cell.foreground.g, b: cell.foreground.b },
      { r: 204, g: 102, b: 102 }, // Ghostty default palette red (#cc6666)
    );
    core.dispose();
  });

  NodeTest.it("honors absolute cursor addressing", async () => {
    const { core } = await makeCore();
    core.write("[5;10HX");
    const snap = core.snapshot();
    NodeAssert.equal(snap.rowData[4].cells[9].text, "X");
    NodeAssert.equal(snap.cursorX, 10);
    NodeAssert.equal(snap.cursorY, 4);
    core.dispose();
  });

  NodeTest.it("switches to and from the alternate screen", async () => {
    const { core } = await makeCore();
    core.write("main");
    core.write("[?1049h");
    NodeAssert.equal(core.isAlternateScreen(), true);
    core.write("alt");
    core.write("[?1049l");
    NodeAssert.equal(core.isAlternateScreen(), false);
    const snap = core.snapshot();
    NodeAssert.ok(rowText(snap, 0).startsWith("main"));
    core.dispose();
  });

  NodeTest.it("keeps wide CJK glyphs in a single wide cell", async () => {
    const { core } = await makeCore();
    core.write("ab界cd");
    const snap = core.snapshot();
    const cells = snap.rowData[0].cells;
    NodeAssert.equal(cells[0].text, "a");
    NodeAssert.equal(cells[1].text, "b");
    NodeAssert.equal(cells[2].text, "界");
    NodeAssert.equal(cells[4].text, "c");
    NodeAssert.equal(snap.cursorX, 6);
    core.dispose();
  });

  NodeTest.it("resize preserves content and re-reports geometry", async () => {
    const { core } = await makeCore(80, 24);
    core.write("persist");
    core.resize(120, 40, 8, 16);
    const snap = core.snapshot();
    NodeAssert.equal(snap.cols, 120);
    NodeAssert.equal(snap.rows, 40);
    NodeAssert.ok(rowText(snap, 0).startsWith("persist"));
    core.dispose();
  });

  NodeTest.it("scroll regions clip scrolling to the declared band", async () => {
    const { core } = await makeCore(10, 5);
    // Fill all 5 rows without a trailing newline so nothing scrolls yet.
    core.write("line1\r\nline2\r\nline3\r\nline4\r\nline5");
    core.write("[2;4r"); // scroll region rows 2-4 (1-based)
    core.write("[4;1H[S"); // scroll up one line inside the region
    const snap = core.snapshot();
    NodeAssert.ok(rowText(snap, 0).startsWith("line1")); // above region: untouched
    NodeAssert.ok(rowText(snap, 4).startsWith("line5")); // below region: untouched
    NodeAssert.ok(rowText(snap, 1).startsWith("line3")); // region scrolled up
    core.dispose();
  });
});

NodeTest.describe("vendored libghostty-vt — input + mode negotiation", () => {
  NodeTest.it("application cursor keys change the encoded arrow sequence", async () => {
    const { core } = await makeCore();
    const normal = core.encodeKey(fakeKey({ code: "ArrowUp", key: "ArrowUp" }));
    NodeAssert.equal(normal, "[A");
    core.write("[?1h");
    NodeAssert.equal(core.isApplicationCursorKeys(), true);
    const app = core.encodeKey(fakeKey({ code: "ArrowUp", key: "ArrowUp" }));
    NodeAssert.equal(app, "OA"); // SS3: ESC O A
    core.dispose();
  });

  NodeTest.it("bracketed paste wraps the payload only when mode 2004 is set", async () => {
    const { core } = await makeCore();
    NodeAssert.equal(core.encodePaste("rm -rf x\n"), "rm -rf x\r"); // LF normalizes to CR
    core.write("[?2004h");
    NodeAssert.equal(core.encodePaste("rm -rf x\n"), "[200~rm -rf x\n[201~"); // bracketed payload is verbatim
    core.dispose();
  });

  NodeTest.it("kitty keyboard push switches encodeKey to CSI-u", async () => {
    const { core } = await makeCore();
    NodeAssert.equal(core.encodeKey(fakeKey()), "a");
    core.write("[>1u"); // push disambiguate flag
    const encoded = core.encodeKey(fakeKey({ code: "KeyA", key: "a", ctrlKey: true }));
    // CSI-u: ctrl+a encodes as a CSI sequence, never a bare 0x01
    NodeAssert.match(encoded, /\[97;5u|\[a;5/);
    core.dispose();
  });

  NodeTest.it("OSC 8 hyperlinks are resolvable per cell", async () => {
    const { core } = await makeCore();
    core.write("]8;;https://example.comexample]8;;");
    const snap = core.snapshot();
    NodeAssert.ok(rowText(snap, 0).startsWith("example"));
    NodeAssert.equal(core.hyperlinkAt(0, 0), "https://example.com");
    NodeAssert.equal(core.hyperlinkAt(20, 0), null);
    core.dispose();
  });

  NodeTest.it("DECRQSS queries answer through the PTY writer", async () => {
    const { core, writes } = await makeCore();
    core.write("[Pq$p"); // not a valid query — use DSR cursor report instead
    core.write("[6n");
    await new Promise((resolve) => setTimeout(resolve, 0));
    NodeAssert.ok(writes.some((data) => /\[\d+;\d+R/.test(data)));
    core.dispose();
  });
});

NodeTest.describe("vendored libghostty-vt — reset + replay", () => {
  NodeTest.it("resetAndWrite rebuilds parser state from a snapshot base", async () => {
    const { core } = await makeCore();
    core.write("old output");
    core.resetAndWrite("snapshot base");
    const snap = core.snapshot();
    NodeAssert.ok(rowText(snap, 0).startsWith("snapshot base"));
    NodeAssert.ok(!rowText(snap, 0).includes("old output"));
    core.dispose();
  });

  NodeTest.it(
    "a mid-sequence truncated attach leaves parser state honest, not corrupt",
    async () => {
      const { core } = await makeCore();
      // Snapshot tail starting mid-SGR — the parser must treat it as literal-ish
      // content without crashing or leaking state into the next write.
      core.resetAndWrite("...[31morphan");
      core.write("clean");
      const snap = core.snapshot();
      NodeAssert.ok(rowText(snap, 0).includes("clean"));
      core.dispose();
    },
  );

  NodeTest.it(
    "clearScreen erases viewport + scrollback but preserves negotiated modes",
    async () => {
      // Seed application-cursor + bracketed-paste, clear,
      // then paste — the bracketed wrapper must survive. An RIS reset would
      // drop mode 2004 and encode "a\nb" as "a\rb" (interactive commands).
      const { core } = await makeCore();
      core.write("\x1b[?1h"); // application cursor keys
      core.write("\x1b[?2004h"); // bracketed paste
      core.write("scrollback filler\r\n".repeat(40));
      NodeAssert.equal(core.isApplicationCursorKeys(), true);
      core.clearScreen();
      const snap = core.snapshot();
      NodeAssert.ok(!rowText(snap, 0).includes("filler"));
      // Modes survived the erase.
      NodeAssert.equal(core.isApplicationCursorKeys(), true);
      NodeAssert.equal(core.encodePaste("a\nb"), "\x1b[200~a\nb\x1b[201~");
      NodeAssert.equal(core.encodeKey(fakeKey({ code: "ArrowUp", key: "ArrowUp" })), "\x1bOA");
      core.dispose();
    },
  );

  NodeTest.it(
    "resetAndWrite DOES drop modes — proving clearScreen is the correct primitive",
    async () => {
      const { core } = await makeCore();
      core.write("\x1b[?2004h");
      NodeAssert.equal(core.encodePaste("a\nb"), "\x1b[200~a\nb\x1b[201~");
      core.resetAndWrite("");
      NodeAssert.equal(core.encodePaste("a\nb"), "a\rb");
      core.dispose();
    },
  );

  NodeTest.it("a remount replay does not re-send terminal query replies", async () => {
    // The first mount answers a DSR once. On remount the attachment
    // replays base + retained tail into a fresh parser — the replayed
    // query must not emit a second reply the process never re-asked for.
    const attachment = new TerminalVtAttachment("term-1");
    const first = await makeCore();
    attachment.attach(first.core);
    const snap = {
      kind: "snapshot",
      terminalId: "term-1",
      streamEpoch: "epoch-1",
      status: "running",
      contents: "",
      retainedByteLength: 0,
      truncated: false,
      clearGeneration: 0,
      contentsUnitStart: 0,
      boundarySequence: 7,
    };
    attachment.applyFrame({ streamId: "s", sequence: 1 }, snap);
    const dsr = {
      kind: "output",
      terminalId: "term-1",
      streamEpoch: "epoch-1",
      sequence: 8,
      chunkIndex: 0,
      chunkCount: 1,
      data: "\x1b[6n",
    };
    attachment.applyFrame({ streamId: "s", sequence: 2 }, dsr);
    await new Promise((resolve) => setTimeout(resolve, 0));
    NodeAssert.equal(first.writes.length, 1);
    NodeAssert.match(first.writes[0], /\[\d+;\d+R/);
    attachment.detach();
    first.core.dispose();

    // Remount: replay lands the same DSR bytes in a fresh parser — the
    // replay bracket suppresses the duplicate answer.
    const second = await makeCore();
    attachment.attach(second.core);
    await new Promise((resolve) => setTimeout(resolve, 0));
    NodeAssert.equal(second.writes.length, 0);

    // A genuinely new query after remount is still answered.
    attachment.applyFrame({ streamId: "s", sequence: 3 }, { ...dsr, sequence: 9 });
    await new Promise((resolve) => setTimeout(resolve, 0));
    NodeAssert.equal(second.writes.length, 1);
    second.core.dispose();
  });

  NodeTest.it("queries buffered while detached get exactly one reply on mount", async () => {
    // Live output arrived before any surface existed — the DSR was
    // never answered; the first mount must emit its reply, not
    // suppress it as if an earlier parser had answered.
    const attachment = new TerminalVtAttachment("term-1");
    const snap = {
      kind: "snapshot",
      terminalId: "term-1",
      streamEpoch: "epoch-1",
      status: "running",
      contents: "",
      retainedByteLength: 0,
      truncated: false,
      clearGeneration: 0,
      contentsUnitStart: 0,
      boundarySequence: 7,
    };
    attachment.applyFrame({ streamId: "s", sequence: 1 }, snap);
    const dsr = (sequence) => ({
      kind: "output",
      terminalId: "term-1",
      streamEpoch: "epoch-1",
      sequence,
      chunkIndex: 0,
      chunkCount: 1,
      data: "\x1b[6n",
    });
    attachment.applyFrame({ streamId: "s", sequence: 2 }, dsr(8));
    const first = await makeCore();
    attachment.attach(first.core);
    await new Promise((resolve) => setTimeout(resolve, 0));
    NodeAssert.equal(first.writes.length, 1);
    NodeAssert.match(first.writes[0], /\[\d+;\d+R/);
    attachment.detach();
    first.core.dispose();

    // A NEW query arrives while detached — the remount answers it once
    // and does NOT re-answer the query the first mount already handled.
    attachment.applyFrame({ streamId: "s", sequence: 3 }, dsr(9));
    const second = await makeCore();
    attachment.attach(second.core);
    await new Promise((resolve) => setTimeout(resolve, 0));
    NodeAssert.equal(second.writes.length, 1);
    second.core.dispose();
  });

  NodeTest.it(
    "a resubscribe snapshot extending past an unanswered query still answers it",
    async () => {
      // A live DSR arrives while detached, then a
      // same-epoch resubscribe snapshot returns retained contents that
      // append NEWER output after the query — the unanswered bytes are
      // no longer a suffix of the replay stream, but their reply is
      // still owed.
      const attachment = new TerminalVtAttachment("term-1");
      const snap = (
        contents,
        boundarySequence,
        retainedByteLength = contents.length,
        contentsUnitStart = 0,
      ) => ({
        kind: "snapshot",
        terminalId: "term-1",
        streamEpoch: "epoch-1",
        status: "running",
        contents,
        retainedByteLength,
        truncated: false,
        clearGeneration: 0,
        contentsUnitStart,
        boundarySequence,
      });
      const output = (sequence, data) => ({
        kind: "output",
        terminalId: "term-1",
        streamEpoch: "epoch-1",
        sequence,
        chunkIndex: 0,
        chunkCount: 1,
        data,
      });
      const closed = {
        kind: "closed",
        terminalId: "term-1",
        streamEpoch: "epoch-1",
        reason: "overflow",
      };
      attachment.applyFrame({ streamId: "s", sequence: 1 }, snap("", 0, 0));
      attachment.applyFrame({ streamId: "s", sequence: 2 }, output(1, "\x1b[6n"));
      attachment.applyFrame({ streamId: "s", sequence: 3 }, closed);
      attachment.beginStream();
      // The retained stream kept growing while the subscription was down:
      // the unanswered DSR sits mid-contents, followed by newer bytes.
      attachment.applyFrame({ streamId: "s2", sequence: 1 }, snap("\x1b[6nlater", 2));
      const { core, writes } = await makeCore();
      attachment.attach(core);
      await new Promise((resolve) => setTimeout(resolve, 0));
      NodeAssert.equal(writes.length, 1);
      NodeAssert.match(writes[0], /\[\d+;\d+R/);
      // The newer retained output still reached the screen.
      const screen = core.snapshot();
      NodeAssert.ok(screen.rowData.some((_, i) => rowText(screen, i).includes("later")));
      core.dispose();
    },
  );

  NodeTest.it("unanswered runs separated by resubscribe output each get their reply", async () => {
    // The single-claim case generalizes: unanswered live bytes before a
    // resubscribe snapshot AND more live bytes after it form two
    // disjoint ranges of the replay stream — both must answer.
    const attachment = new TerminalVtAttachment("term-1");
    const snap = (
      contents,
      boundarySequence,
      retainedByteLength = contents.length,
      contentsUnitStart = 0,
    ) => ({
      kind: "snapshot",
      terminalId: "term-1",
      streamEpoch: "epoch-1",
      status: "running",
      contents,
      retainedByteLength,
      truncated: false,
      clearGeneration: 0,
      contentsUnitStart,
      boundarySequence,
    });
    const output = (sequence, data) => ({
      kind: "output",
      terminalId: "term-1",
      streamEpoch: "epoch-1",
      sequence,
      chunkIndex: 0,
      chunkCount: 1,
      data,
    });
    const closed = {
      kind: "closed",
      terminalId: "term-1",
      streamEpoch: "epoch-1",
      reason: "overflow",
    };
    attachment.applyFrame({ streamId: "s", sequence: 1 }, snap("", 0, 0));
    attachment.applyFrame({ streamId: "s", sequence: 2 }, output(1, "\x1b[6n"));
    attachment.applyFrame({ streamId: "s", sequence: 3 }, closed);
    attachment.beginStream();
    attachment.applyFrame({ streamId: "s2", sequence: 1 }, snap("\x1b[6nbetween", 2));
    // Still detached: a second DSR lands after the snapshot — two
    // disjoint unanswered runs in the replay stream.
    attachment.applyFrame({ streamId: "s2", sequence: 2 }, output(3, "\x1b[6n"));
    const { core, writes } = await makeCore();
    attachment.attach(core);
    await new Promise((resolve) => setTimeout(resolve, 0));
    NodeAssert.equal(writes.length, 2);
    for (const reply of writes) NodeAssert.match(reply, /\[\d+;\d+R/);
    core.dispose();
  });

  NodeTest.it(
    "a repeated query in a resubscribe snapshot answers at its OWN position",
    async () => {
      // The resnapshot holds TWO identical DSRs — the live one
      // we received (position 0) and a newer history-only copy emitted
      // while disconnected. Content matching picks the rightmost copy and
      // answers at the wrong cursor position; position tracking answers
      // the bytes that were actually received live.
      const attachment = new TerminalVtAttachment("term-1");
      const snap = (
        contents,
        boundarySequence,
        retainedByteLength = contents.length,
        contentsUnitStart = 0,
      ) => ({
        kind: "snapshot",
        terminalId: "term-1",
        streamEpoch: "epoch-1",
        status: "running",
        contents,
        retainedByteLength,
        truncated: false,
        clearGeneration: 0,
        contentsUnitStart,
        boundarySequence,
      });
      const output = (sequence, data) => ({
        kind: "output",
        terminalId: "term-1",
        streamEpoch: "epoch-1",
        sequence,
        chunkIndex: 0,
        chunkCount: 1,
        data,
      });
      const closed = {
        kind: "closed",
        terminalId: "term-1",
        streamEpoch: "epoch-1",
        reason: "overflow",
      };
      attachment.applyFrame({ streamId: "s", sequence: 1 }, snap("", 0, 0));
      attachment.applyFrame({ streamId: "s", sequence: 2 }, output(1, "\x1b[6n"));
      attachment.applyFrame({ streamId: "s", sequence: 3 }, closed);
      attachment.beginStream();
      // Retained contents: our live DSR, newer output, then ANOTHER DSR the
      // process emitted while we were gone. The gap-emitted copy earns its own
      // reply too — nothing parsed it with the reply writer attached — so BOTH
      // queries answer, each at its own cursor position.
      attachment.applyFrame({ streamId: "s2", sequence: 1 }, snap("\x1b[6nlater\x1b[6n", 2));
      const { core, writes } = await makeCore();
      attachment.attach(core);
      await new Promise((resolve) => setTimeout(resolve, 0));
      NodeAssert.deepEqual(writes, ["\x1b[1;1R", "\x1b[1;6R"]);
      core.dispose();
    },
  );

  NodeTest.it(
    "repeated queries around a resubscribe boundary each answer at their own position",
    async () => {
      // Same collision, plus a second live DSR after the snapshot: the
      // replay owes TWO replies at distinct cursor positions.
      const attachment = new TerminalVtAttachment("term-1");
      const snap = (
        contents,
        boundarySequence,
        retainedByteLength = contents.length,
        contentsUnitStart = 0,
      ) => ({
        kind: "snapshot",
        terminalId: "term-1",
        streamEpoch: "epoch-1",
        status: "running",
        contents,
        retainedByteLength,
        truncated: false,
        clearGeneration: 0,
        contentsUnitStart,
        boundarySequence,
      });
      const output = (sequence, data) => ({
        kind: "output",
        terminalId: "term-1",
        streamEpoch: "epoch-1",
        sequence,
        chunkIndex: 0,
        chunkCount: 1,
        data,
      });
      const closed = {
        kind: "closed",
        terminalId: "term-1",
        streamEpoch: "epoch-1",
        reason: "overflow",
      };
      attachment.applyFrame({ streamId: "s", sequence: 1 }, snap("", 0, 0));
      attachment.applyFrame({ streamId: "s", sequence: 2 }, output(1, "\x1b[6n"));
      attachment.applyFrame({ streamId: "s", sequence: 3 }, closed);
      attachment.beginStream();
      attachment.applyFrame({ streamId: "s2", sequence: 1 }, snap("\x1b[6nlater\x1b[6n", 2));
      attachment.applyFrame({ streamId: "s2", sequence: 2 }, output(3, "Z\x1b[6n"));
      const { core, writes } = await makeCore();
      attachment.attach(core);
      await new Promise((resolve) => setTimeout(resolve, 0));
      NodeAssert.deepEqual(writes, ["\x1b[1;1R", "\x1b[1;6R", "\x1b[1;7R"]);
      core.dispose();
    },
  );

  NodeTest.it("an evicted unanswered query cannot migrate to a newer identical query", async () => {
    // The original query falls entirely outside the retained tail while a
    // NEWER identical query lands inside the resnapshot. The pending reply
    // must drop with its bytes — never re-anchor to the coincidental copy.
    // The newer copy is gap bytes, though: nothing parsed it with the reply
    // writer attached, so it answers at ITS own position (after the CSI H +
    // "later" → col 6).
    const attachment = new TerminalVtAttachment("term-1");
    const snap = (
      contents,
      boundarySequence,
      truncated,
      retainedByteLength,
      contentsUnitStart = 0,
    ) => ({
      kind: "snapshot",
      terminalId: "term-1",
      streamEpoch: "epoch-1",
      status: "running",
      contents,
      retainedByteLength,
      truncated,
      clearGeneration: 0,
      contentsUnitStart,
      boundarySequence,
    });
    const output = (sequence, data) => ({
      kind: "output",
      terminalId: "term-1",
      streamEpoch: "epoch-1",
      sequence,
      chunkIndex: 0,
      chunkCount: 1,
      data,
    });
    const closed = {
      kind: "closed",
      terminalId: "term-1",
      streamEpoch: "epoch-1",
      reason: "overflow",
    };
    attachment.applyFrame({ streamId: "s", sequence: 1 }, snap("", 0, false, 0));
    attachment.applyFrame({ streamId: "s", sequence: 2 }, output(1, "\x1b[6n"));
    attachment.applyFrame({ streamId: "s", sequence: 3 }, closed);
    attachment.beginStream();
    // 8192 bytes emitted while disconnected: the original query is fully
    // evicted, and the retained tail ends with a DIFFERENT ESC[6n.
    const contents = `${"x".repeat(8180)}\x1b[Hlater\x1b[6n`;
    attachment.applyFrame({ streamId: "s2", sequence: 1 }, snap(contents, 2, true, 8196, 4));
    const { core, writes } = await makeCore();
    attachment.attach(core);
    await new Promise((resolve) => setTimeout(resolve, 0));
    NodeAssert.deepEqual(writes, ["\x1b[1;6R"]);
    core.dispose();
  });

  NodeTest.it("a same-boundary resnapshot keeps provably-retained unanswered queries", async () => {
    // The retention boundary itself can prove survival: with no newer
    // events (boundary === watermark) the contents MUST end at our last
    // received byte, so a contents suffix match pins both ends — here
    // the server evicted our leading output but the query survived.
    const attachment = new TerminalVtAttachment("term-1");
    const snap = (
      contents,
      boundarySequence,
      retainedByteLength = contents.length,
      contentsUnitStart = 0,
    ) => ({
      kind: "snapshot",
      terminalId: "term-1",
      streamEpoch: "epoch-1",
      status: "running",
      contents,
      retainedByteLength,
      truncated: false,
      clearGeneration: 0,
      contentsUnitStart,
      boundarySequence,
    });
    const output = (sequence, data) => ({
      kind: "output",
      terminalId: "term-1",
      streamEpoch: "epoch-1",
      sequence,
      chunkIndex: 0,
      chunkCount: 1,
      data,
    });
    const closed = {
      kind: "closed",
      terminalId: "term-1",
      streamEpoch: "epoch-1",
      reason: "overflow",
    };
    attachment.applyFrame({ streamId: "s", sequence: 1 }, snap("", 0, 0));
    attachment.applyFrame({ streamId: "s", sequence: 2 }, output(1, "AAAA"));
    attachment.applyFrame({ streamId: "s", sequence: 3 }, output(2, "\x1b[6n"));
    attachment.applyFrame({ streamId: "s", sequence: 4 }, closed);
    attachment.beginStream();
    // Same boundary — nothing newer. Retained contents are just the
    // surviving tail: the DSR itself, its position proven by the pinned
    // end of the stream.
    attachment.applyFrame({ streamId: "s2", sequence: 1 }, snap("\x1b[6n", 2, 4, 4));
    const { core, writes } = await makeCore();
    attachment.attach(core);
    await new Promise((resolve) => setTimeout(resolve, 0));
    NodeAssert.deepEqual(writes, ["\x1b[1;1R"]);
    core.dispose();
  });

  NodeTest.it(
    "a pending reply is dropped when mounting before the replacement snapshot",
    async () => {
      // Identity-changed invalidates the pending reply AT the
      // close — a renderer that finishes mounting before the replacement
      // subscription delivers its snapshot must not emit an old-epoch
      // reply to the new process over the shared terminalId channel.
      const attachment = new TerminalVtAttachment("term-1");
      const snap = (contents, boundarySequence, streamEpoch) => ({
        kind: "snapshot",
        terminalId: "term-1",
        streamEpoch,
        status: "running",
        contents,
        retainedByteLength: contents.length,
        truncated: false,
        clearGeneration: 0,
        contentsUnitStart: 0,
        boundarySequence,
      });
      const output = (sequence, data) => ({
        kind: "output",
        terminalId: "term-1",
        streamEpoch: "epoch-1",
        sequence,
        chunkIndex: 0,
        chunkCount: 1,
        data,
      });
      const closed = {
        kind: "closed",
        terminalId: "term-1",
        streamEpoch: "epoch-1",
        reason: "identity-changed",
      };
      attachment.applyFrame({ streamId: "s", sequence: 1 }, snap("", 0, "epoch-1"));
      attachment.applyFrame({ streamId: "s", sequence: 2 }, output(1, "\x1b[6n"));
      attachment.applyFrame({ streamId: "s", sequence: 3 }, closed);
      attachment.beginStream();
      // Mount completes in the gap — the epoch-1 claim is already dead.
      const { core, writes } = await makeCore();
      attachment.attach(core);
      await new Promise((resolve) => setTimeout(resolve, 0));
      NodeAssert.deepEqual(writes, []);
      // The replacement snapshot then re-bases the same renderer; its
      // history-only query stays suppressed as well.
      attachment.applyFrame({ streamId: "s2", sequence: 1 }, snap("fresh\x1b[6n", 1, "epoch-2"));
      await new Promise((resolve) => setTimeout(resolve, 0));
      NodeAssert.deepEqual(writes, []);
      core.dispose();
    },
  );

  NodeTest.it(
    "a mount in the resubscribe gap holds the reply until the epoch re-proves",
    async () => {
      // Overflow (not identity-changed): the same incarnation keeps
      // running, so its pending reply is legitimate — but while the epoch
      // is unproven (between beginStream and the replacement snapshot) a
      // mount must not release it. The reply lands once, when the
      // same-epoch snapshot proves the claim.
      const attachment = new TerminalVtAttachment("term-1");
      const snap = (
        contents,
        boundarySequence,
        retainedByteLength = contents.length,
        contentsUnitStart = 0,
      ) => ({
        kind: "snapshot",
        terminalId: "term-1",
        streamEpoch: "epoch-1",
        status: "running",
        contents,
        retainedByteLength,
        truncated: false,
        clearGeneration: 0,
        contentsUnitStart,
        boundarySequence,
      });
      const output = (sequence, data) => ({
        kind: "output",
        terminalId: "term-1",
        streamEpoch: "epoch-1",
        sequence,
        chunkIndex: 0,
        chunkCount: 1,
        data,
      });
      const closed = {
        kind: "closed",
        terminalId: "term-1",
        streamEpoch: "epoch-1",
        reason: "overflow",
      };
      attachment.applyFrame({ streamId: "s", sequence: 1 }, snap("", 0, 0));
      attachment.applyFrame({ streamId: "s", sequence: 2 }, output(1, "\x1b[6n"));
      attachment.applyFrame({ streamId: "s", sequence: 3 }, closed);
      attachment.beginStream();
      const { core, writes } = await makeCore();
      // Mount before the epoch is proven: the query parses suppressed —
      // the reply is held, not released to whatever owns the channel.
      attachment.attach(core);
      await new Promise((resolve) => setTimeout(resolve, 0));
      NodeAssert.deepEqual(writes, []);
      // Same-epoch snapshot with no newer events: boundary === the last
      // received sequence, contents is the provable retained suffix —
      // the claim proves out and answers exactly once.
      attachment.applyFrame({ streamId: "s2", sequence: 1 }, snap("\x1b[6n", 1));
      await new Promise((resolve) => setTimeout(resolve, 0));
      NodeAssert.deepEqual(writes, ["\x1b[1;1R"]);
      core.dispose();
    },
  );

  NodeTest.it(
    "a pending reply dies when a missed clear bumped the snapshot generation",
    async () => {
      // A history clear does not end the epoch, so an overflow
      // resubscription can miss the reset entirely. The next untruncated
      // snapshot's contents then start at the CLEAR POINT, not our
      // stream's origin — truncated:false only means "all current
      // retained bytes". The bumped clearGeneration is what proves the
      // window changed: the old claim drops rather than answering the
      // new generation's coincidentally identical query.
      const attachment = new TerminalVtAttachment("term-1");
      const snap = (contents, boundarySequence, clearGeneration, contentsUnitStart = 0) => ({
        kind: "snapshot",
        terminalId: "term-1",
        streamEpoch: "epoch-1",
        status: "running",
        contents,
        retainedByteLength: contents.length,
        truncated: false,
        clearGeneration,
        contentsUnitStart,
        boundarySequence,
      });
      const output = (sequence, data) => ({
        kind: "output",
        terminalId: "term-1",
        streamEpoch: "epoch-1",
        sequence,
        chunkIndex: 0,
        chunkCount: 1,
        data,
      });
      const closed = {
        kind: "closed",
        terminalId: "term-1",
        streamEpoch: "epoch-1",
        reason: "overflow",
      };
      attachment.applyFrame({ streamId: "s", sequence: 1 }, snap("", 0, 0));
      attachment.applyFrame({ streamId: "s", sequence: 2 }, output(1, "\x1b[6n"));
      attachment.applyFrame({ streamId: "s", sequence: 3 }, closed);
      attachment.beginStream();
      // While disconnected: the host clears retained history (seq 2),
      // then the process emits a NEW ESC[6n plus "later" (seq 3) — both
      // unseen. The resnapshot is untruncated yet covers only post-clear
      // bytes, marked by clearGeneration 1.
      attachment.applyFrame({ streamId: "s2", sequence: 1 }, snap("\x1b[6nlater", 3, 1));
      const { core, writes } = await makeCore();
      attachment.attach(core);
      await new Promise((resolve) => setTimeout(resolve, 0));
      NodeAssert.deepEqual(writes, []);
      core.dispose();
    },
  );

  NodeTest.it(
    "a gap mount cannot release a reply whose generation was cleared mid-gap",
    async () => {
      // Same missed clear as above, opposite mount order: the renderer
      // attaches INSIDE the beginStream→snapshot gap. The epoch fence
      // holds the claim during the gap; the bumped-generation snapshot
      // then discards it — the coincidentally identical post-clear query
      // never earns the old reply.
      const attachment = new TerminalVtAttachment("term-1");
      const snap = (contents, boundarySequence, clearGeneration, contentsUnitStart = 0) => ({
        kind: "snapshot",
        terminalId: "term-1",
        streamEpoch: "epoch-1",
        status: "running",
        contents,
        retainedByteLength: contents.length,
        truncated: false,
        clearGeneration,
        contentsUnitStart,
        boundarySequence,
      });
      const output = (sequence, data) => ({
        kind: "output",
        terminalId: "term-1",
        streamEpoch: "epoch-1",
        sequence,
        chunkIndex: 0,
        chunkCount: 1,
        data,
      });
      const closed = {
        kind: "closed",
        terminalId: "term-1",
        streamEpoch: "epoch-1",
        reason: "overflow",
      };
      attachment.applyFrame({ streamId: "s", sequence: 1 }, snap("", 0, 0));
      attachment.applyFrame({ streamId: "s", sequence: 2 }, output(1, "\x1b[6n"));
      attachment.applyFrame({ streamId: "s", sequence: 3 }, closed);
      attachment.beginStream();
      const { core, writes } = await makeCore();
      // Mount in the gap — the claim is held, not released.
      attachment.attach(core);
      await new Promise((resolve) => setTimeout(resolve, 0));
      NodeAssert.deepEqual(writes, []);
      // The generation-bumped snapshot arrives over the LIVE sink: it
      // discards the claim, and its own history-only query stays
      // suppressed as well.
      attachment.applyFrame({ streamId: "s2", sequence: 1 }, snap("\x1b[6nlater", 3, 1));
      await new Promise((resolve) => setTimeout(resolve, 0));
      NodeAssert.deepEqual(writes, []);
      core.dispose();
    },
  );

  NodeTest.it("a pending reply does not cross a terminal incarnation change", async () => {
    // A query queued against epoch e must not deliver into
    // epoch e+1 — the new process's retained history never earned it,
    // even when identical bytes appear there.
    const attachment = new TerminalVtAttachment("term-1");
    const snap = (contents, boundarySequence, streamEpoch) => ({
      kind: "snapshot",
      terminalId: "term-1",
      streamEpoch,
      status: "running",
      contents,
      retainedByteLength: contents.length,
      truncated: false,
      clearGeneration: 0,
      contentsUnitStart: 0,
      boundarySequence,
    });
    const output = (sequence, data) => ({
      kind: "output",
      terminalId: "term-1",
      streamEpoch: "epoch-1",
      sequence,
      chunkIndex: 0,
      chunkCount: 1,
      data,
    });
    const closed = {
      kind: "closed",
      terminalId: "term-1",
      streamEpoch: "epoch-1",
      reason: "identity-changed",
    };
    attachment.applyFrame({ streamId: "s", sequence: 1 }, snap("", 0, "epoch-1"));
    attachment.applyFrame({ streamId: "s", sequence: 2 }, output(1, "\x1b[6n"));
    attachment.applyFrame({ streamId: "s", sequence: 3 }, closed);
    attachment.beginStream();
    // New incarnation: identical query bytes exist in its history but
    // belong to the new process — suppressed like any snapshot query.
    attachment.applyFrame({ streamId: "s2", sequence: 1 }, snap("fresh\x1b[6n", 1, "epoch-2"));
    const { core, writes } = await makeCore();
    attachment.attach(core);
    await new Promise((resolve) => setTimeout(resolve, 0));
    NodeAssert.deepEqual(writes, []);
    core.dispose();
  });

  NodeTest.it("a query inside the FIRST full-coverage snapshot is answered at attach", async () => {
    // R7 first-window gap boundary: a snapshot proven complete since
    // process start (nothing truncated, zero clears, window origin at
    // unit 0) is the window's first subscription gap, not settled
    // history — the query's owning process is still waiting on its
    // answer, so the attach replays it reply-enabled and the core sends
    // the DSR response to the PTY. The documented drop still applies to
    // snapshots whose provenance is not provable: truncated, cleared,
    // windowed, or from an earlier incarnation (the tests above).
    const attachment = new TerminalVtAttachment("term-1");
    const snap = {
      kind: "snapshot",
      terminalId: "term-1",
      streamEpoch: "epoch-1",
      status: "running",
      contents: "\x1b[6n",
      retainedByteLength: 4,
      truncated: false,
      clearGeneration: 0,
      contentsUnitStart: 0,
      boundarySequence: 7,
    };
    attachment.applyFrame({ streamId: "s", sequence: 1 }, snap);
    const { core, writes } = await makeCore();
    attachment.attach(core);
    await new Promise((resolve) => setTimeout(resolve, 0));
    NodeAssert.equal(writes.length, 1);
    NodeAssert.match(writes[0], /^\x1b\[\d+;\d+R$/);
    core.dispose();
  });

  NodeTest.it(
    "default line retention cannot migrate an evicted query's claim — mount after snapshot",
    async () => {
      // The host's 5000-line retention evicts the original
      // query line while the retained tail still fits under the 8 KiB
      // snapshot cap — truncated:false, clearGeneration:0, yet the window
      // moved forward 5 units (contentsUnitStart). The pending reply must
      // drop by position, not migrate onto the newer identical query.
      const attachment = new TerminalVtAttachment("term-1");
      const snap = (contents, boundarySequence, contentsUnitStart = 0) => ({
        kind: "snapshot",
        terminalId: "term-1",
        streamEpoch: "epoch-1",
        status: "running",
        contents,
        retainedByteLength: contents.length,
        truncated: false,
        clearGeneration: 0,
        contentsUnitStart,
        boundarySequence,
      });
      const output = (sequence, data) => ({
        kind: "output",
        terminalId: "term-1",
        streamEpoch: "epoch-1",
        sequence,
        chunkIndex: 0,
        chunkCount: 1,
        data,
      });
      const closed = {
        kind: "closed",
        terminalId: "term-1",
        streamEpoch: "epoch-1",
        reason: "overflow",
      };
      attachment.applyFrame({ streamId: "s", sequence: 1 }, snap("", 0));
      attachment.applyFrame({ streamId: "s", sequence: 2 }, output(1, "\x1b[6n\n"));
      attachment.applyFrame({ streamId: "s", sequence: 3 }, closed);
      attachment.beginStream();
      // While disconnected: a NEW ESC[6n plus 5000 LFs arrive (seq 2). Line
      // retention evicts the original query line entirely — the retained tail
      // starts at window unit 5, still under the byte cap. The original claim
      // drops by position; the gap-emitted query earns its own reply, answered
      // before the LFs scroll.
      attachment.applyFrame(
        { streamId: "s2", sequence: 1 },
        snap("\x1b[6n" + "\n".repeat(5000), 2, 5),
      );
      const { core, writes } = await makeCore();
      attachment.attach(core);
      await new Promise((resolve) => setTimeout(resolve, 0));
      NodeAssert.deepEqual(writes, ["\x1b[1;1R"]);
      core.dispose();
    },
  );

  NodeTest.it(
    "default line retention cannot migrate an evicted query's claim — mount in the gap",
    async () => {
      // Same line-eviction case, opposite mount order: the renderer
      // attaches inside the beginStream→snapshot gap; the epoch fence
      // holds the claim, then the resnapshot's contentsUnitStart=5 proves
      // the query's absolute position is gone — the claim drops.
      const attachment = new TerminalVtAttachment("term-1");
      const snap = (contents, boundarySequence, contentsUnitStart = 0) => ({
        kind: "snapshot",
        terminalId: "term-1",
        streamEpoch: "epoch-1",
        status: "running",
        contents,
        retainedByteLength: contents.length,
        truncated: false,
        clearGeneration: 0,
        contentsUnitStart,
        boundarySequence,
      });
      const output = (sequence, data) => ({
        kind: "output",
        terminalId: "term-1",
        streamEpoch: "epoch-1",
        sequence,
        chunkIndex: 0,
        chunkCount: 1,
        data,
      });
      const closed = {
        kind: "closed",
        terminalId: "term-1",
        streamEpoch: "epoch-1",
        reason: "overflow",
      };
      attachment.applyFrame({ streamId: "s", sequence: 1 }, snap("", 0));
      attachment.applyFrame({ streamId: "s", sequence: 2 }, output(1, "\x1b[6n\n"));
      attachment.applyFrame({ streamId: "s", sequence: 3 }, closed);
      attachment.beginStream();
      const { core, writes } = await makeCore();
      attachment.attach(core);
      await new Promise((resolve) => setTimeout(resolve, 0));
      NodeAssert.deepEqual(writes, []);
      attachment.applyFrame(
        { streamId: "s2", sequence: 1 },
        snap("\x1b[6n" + "\n".repeat(5000), 2, 5),
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
      // The evicted claim dropped; the surviving parser receives exactly
      // the gap over the live channel, and the gap's own query answers —
      // at row 2, because the gap-mount replay already parsed the held
      // "\x1b[6n\n" bytes (suppressed) which moved the cursor a line.
      NodeAssert.deepEqual(writes, ["\x1b[2;1R"]);
      core.dispose();
    },
  );

  NodeTest.it(
    "a first attach after a host history clear is degraded — sink before snapshot",
    async () => {
      // A fresh attachment's FIRST snapshot already shows
      // clearGeneration 1 — the process negotiated modes before history
      // was cleared, and no retained byte covers them. truncated:false
      // is not coverage evidence: fidelity must stay unclaimed.
      const attachment = new TerminalVtAttachment("term-1");
      const snap = (contents, boundarySequence, clearGeneration, contentsUnitStart = 0) => ({
        kind: "snapshot",
        terminalId: "term-1",
        streamEpoch: "epoch-1",
        status: "running",
        contents,
        retainedByteLength: contents.length,
        truncated: false,
        clearGeneration,
        contentsUnitStart,
        boundarySequence,
      });
      const { core } = await makeCore();
      attachment.attach(core);
      attachment.beginStream();
      attachment.applyFrame({ streamId: "s", sequence: 1 }, snap("prompt", 3, 1));
      NodeAssert.equal(attachment.state.degraded, true);
      NodeAssert.match(attachment.state.statusText, /history was cleared/);
      core.dispose();
    },
  );

  NodeTest.it(
    "a first attach after a host history clear is degraded — snapshot before sink",
    async () => {
      // Opposite ordering: the post-clear snapshot lands first, then the
      // renderer mounts. The attach emit must still flag degraded.
      const attachment = new TerminalVtAttachment("term-1");
      const snap = {
        kind: "snapshot",
        terminalId: "term-1",
        streamEpoch: "epoch-1",
        status: "running",
        contents: "prompt",
        retainedByteLength: 6,
        truncated: false,
        clearGeneration: 1,
        contentsUnitStart: 0,
        boundarySequence: 3,
      };
      attachment.beginStream();
      attachment.applyFrame({ streamId: "s", sequence: 1 }, snap);
      const { core } = await makeCore();
      attachment.attach(core);
      NodeAssert.equal(attachment.state.degraded, true);
      core.dispose();
    },
  );

  NodeTest.it(
    "a query surviving line eviction still answers at its absolute position",
    async () => {
      // Matrix row — evicted-lines with surviving bytes: the retained
      // window moved forward past other output, but the query itself is
      // still retained at its proven position. The claim answers.
      const attachment = new TerminalVtAttachment("term-1");
      const snap = (contents, boundarySequence, contentsUnitStart = 0) => ({
        kind: "snapshot",
        terminalId: "term-1",
        streamEpoch: "epoch-1",
        status: "running",
        contents,
        retainedByteLength: contents.length,
        truncated: false,
        clearGeneration: 0,
        contentsUnitStart,
        boundarySequence,
      });
      const output = (sequence, data) => ({
        kind: "output",
        terminalId: "term-1",
        streamEpoch: "epoch-1",
        sequence,
        chunkIndex: 0,
        chunkCount: 1,
        data,
      });
      const closed = {
        kind: "closed",
        terminalId: "term-1",
        streamEpoch: "epoch-1",
        reason: "overflow",
      };
      attachment.applyFrame({ streamId: "s", sequence: 1 }, snap("", 0));
      attachment.applyFrame({ streamId: "s", sequence: 2 }, output(1, "noise\n"));
      attachment.applyFrame({ streamId: "s", sequence: 3 }, output(2, "\x1b[6n\n"));
      attachment.applyFrame({ streamId: "s", sequence: 4 }, closed);
      attachment.beginStream();
      // Line retention dropped "noise\n" (6 units) but kept the query
      // line and a newer line — window starts at unit 6.
      attachment.applyFrame({ streamId: "s2", sequence: 1 }, snap("\x1b[6n\nlast\n", 3, 6));
      const { core, writes } = await makeCore();
      attachment.attach(core);
      await new Promise((resolve) => setTimeout(resolve, 0));
      NodeAssert.deepEqual(writes, ["\x1b[1;1R"]);
      core.dispose();
    },
  );

  NodeTest.it(
    "a query surviving byte-tail truncation still answers at its absolute position",
    async () => {
      // Matrix row — evicted-bytes with surviving bytes: the resnapshot's
      // 8 KiB tail starts mid-window (truncated:true), but the claim's
      // absolute position is inside it.
      const attachment = new TerminalVtAttachment("term-1");
      const snap = (
        contents,
        boundarySequence,
        truncated,
        retainedByteLength,
        contentsUnitStart = 0,
      ) => ({
        kind: "snapshot",
        terminalId: "term-1",
        streamEpoch: "epoch-1",
        status: "running",
        contents,
        retainedByteLength,
        truncated,
        clearGeneration: 0,
        contentsUnitStart,
        boundarySequence,
      });
      const output = (sequence, data) => ({
        kind: "output",
        terminalId: "term-1",
        streamEpoch: "epoch-1",
        sequence,
        chunkIndex: 0,
        chunkCount: 1,
        data,
      });
      const closed = {
        kind: "closed",
        terminalId: "term-1",
        streamEpoch: "epoch-1",
        reason: "overflow",
      };
      attachment.applyFrame({ streamId: "s", sequence: 1 }, snap("", 0, false, 0));
      attachment.applyFrame({ streamId: "s", sequence: 2 }, output(1, "x".repeat(8000)));
      attachment.applyFrame({ streamId: "s", sequence: 3 }, output(2, "x".repeat(1000)));
      attachment.applyFrame({ streamId: "s", sequence: 4 }, output(3, "\x1b[6n"));
      attachment.applyFrame({ streamId: "s", sequence: 5 }, closed);
      attachment.beginStream();
      // 9004 units appended; byte retention cut the tail to the last
      // 64 units — contents start at absolute unit 8940, the query sits
      // at contents position 60 (the retained tail IS the stream's own
      // trailing bytes).
      attachment.applyFrame(
        { streamId: "s2", sequence: 1 },
        snap(`${"x".repeat(60)}\x1b[6n`, 3, true, 9004, 8940),
      );
      const { core, writes } = await makeCore();
      attachment.attach(core);
      await new Promise((resolve) => setTimeout(resolve, 0));
      NodeAssert.deepEqual(writes, ["\x1b[1;61R"]);
      core.dispose();
    },
  );

  NodeTest.it(
    "a post-clear claim re-anchored by the reset frame survives a resnapshot",
    async () => {
      // Matrix row — observed clear: the reset frame names the new
      // window ({epoch, generation:1}) and re-anchors the stream at unit
      // 0, so a query delivered after the clear keeps absolute positions
      // and survives a same-window resnapshot.
      const attachment = new TerminalVtAttachment("term-1");
      const snap = (contents, boundarySequence, clearGeneration, contentsUnitStart = 0) => ({
        kind: "snapshot",
        terminalId: "term-1",
        streamEpoch: "epoch-1",
        status: "running",
        contents,
        retainedByteLength: contents.length,
        truncated: false,
        clearGeneration,
        contentsUnitStart,
        boundarySequence,
      });
      const output = (sequence, data) => ({
        kind: "output",
        terminalId: "term-1",
        streamEpoch: "epoch-1",
        sequence,
        chunkIndex: 0,
        chunkCount: 1,
        data,
      });
      const reset = {
        kind: "reset",
        terminalId: "term-1",
        streamEpoch: "epoch-1",
        sequence: 2,
        clearGeneration: 1,
        reason: "history-cleared",
      };
      const closed = {
        kind: "closed",
        terminalId: "term-1",
        streamEpoch: "epoch-1",
        reason: "overflow",
      };
      attachment.applyFrame({ streamId: "s", sequence: 1 }, snap("", 0, 0));
      attachment.applyFrame({ streamId: "s", sequence: 2 }, reset);
      // A NEW query arrives post-clear, still while detached.
      attachment.applyFrame({ streamId: "s", sequence: 3 }, output(3, "\x1b[6n"));
      attachment.applyFrame({ streamId: "s", sequence: 4 }, closed);
      attachment.beginStream();
      // Same window (generation 1), contents grew — claim at absolute
      // unit 0 survives provably.
      attachment.applyFrame({ streamId: "s2", sequence: 1 }, snap("\x1b[6nmore", 4, 1, 0));
      const { core, writes } = await makeCore();
      attachment.attach(core);
      await new Promise((resolve) => setTimeout(resolve, 0));
      NodeAssert.deepEqual(writes, ["\x1b[1;1R"]);
      core.dispose();
    },
  );

  NodeTest.it(
    "a first snapshot with an evicted head is degraded even without truncation",
    async () => {
      // Matrix row — fidelity under evicted-lines: contentsUnitStart > 0
      // proves retained bytes were dropped ahead of the tail even though
      // truncated:false and clearGeneration:0 — the parser cannot be
      // proven to have seen every byte since process start.
      const attachment = new TerminalVtAttachment("term-1");
      const snap = {
        kind: "snapshot",
        terminalId: "term-1",
        streamEpoch: "epoch-1",
        status: "running",
        contents: "tail",
        retainedByteLength: 128,
        truncated: false,
        clearGeneration: 0,
        contentsUnitStart: 124,
        boundarySequence: 5,
      };
      attachment.beginStream();
      attachment.applyFrame({ streamId: "s", sequence: 1 }, snap);
      NodeAssert.equal(attachment.state.degraded, true);
      NodeAssert.match(attachment.state.statusText, /exceeded retention/);
      const { core } = await makeCore();
      attachment.attach(core);
      NodeAssert.equal(attachment.state.degraded, true);
      core.dispose();
    },
  );
});

NodeTest.describe("attachment retention gap", () => {
  const snap = (contents, extra = {}) => ({
    kind: "snapshot",
    terminalId: "t",
    streamEpoch: "epoch",
    status: "running",
    contents,
    retainedByteLength: contents.length,
    truncated: false,
    clearGeneration: 0,
    contentsUnitStart: 0,
    boundarySequence: 1,
    ...extra,
  });

  NodeTest.it(
    "an unobserved retention hole degrades instead of preserving stale modes",
    async () => {
      // A hidden pane's stream drops mid-history while the program disables
      // application cursor keys and floods output past the 8192-byte retention
      // tail. The caught-up check must look for the hole, not just the
      // snapshot END — otherwise the surviving parser keeps the obsolete mode
      // with degraded=false and arrows encode with the wrong mode and no
      // indication.
      const { core, writes } = await makeCore();
      const attachment = new TerminalVtAttachment("t");
      attachment.attach(core);
      const frame = (value) => attachment.applyFrame({ streamId: "s", sequence: 1 }, value);
      const initial = "\x1b[?1h\x1b[?2004hhello";
      attachment.beginStream();
      frame(snap(initial));
      attachment.beginStream();
      frame(snap(initial + "\x1b[6n", { boundarySequence: 2 }));
      NodeAssert.deepEqual(writes, ["\x1b[1;6R"]);
      NodeAssert.equal(core.isApplicationCursorKeys(), true);
      // Control: a truncated prefix whose window still COVERS every unseen
      // byte keeps the continuity fast path — modes preserved, not degraded.
      attachment.beginStream();
      frame(
        snap("hello\x1b[6n", {
          contentsUnitStart: initial.indexOf("hello"),
          boundarySequence: 2,
          truncated: true,
        }),
      );
      NodeAssert.equal(core.isApplicationCursorKeys(), true);
      NodeAssert.equal(attachment.state.degraded, false);
      // The gap: everything after the observed end was evicted except the
      // legal final 8192-byte tail; the DECRST lives in the hole.
      const missed = "\x1b[?1l" + "x".repeat(9000) + "\r\nTAIL\x1b[6n";
      const whole = initial + "\x1b[6n" + missed;
      const tail = whole.slice(-8192);
      attachment.beginStream();
      frame(
        snap(tail, {
          contentsUnitStart: whole.length - tail.length,
          boundarySequence: 100,
          truncated: true,
        }),
      );
      // Reference: an uninterrupted parser fed the same bytes.
      const reference = await makeCore();
      reference.core.write(whole);
      NodeAssert.equal(reference.core.isApplicationCursorKeys(), false);
      // Honest recovery: re-based from the retained tail (the mode now
      // matches the reference) and flagged degraded — never silent
      // continuity over a hole that changed negotiated modes.
      NodeAssert.equal(core.isApplicationCursorKeys(), false);
      NodeAssert.equal(attachment.state.degraded, true);
      NodeAssert.match(attachment.state.statusText, /truncated|incomplete/);
      const lastReply = writes.at(-1) ?? "";
      NodeAssert.ok(
        lastReply.startsWith("\x1b[") && lastReply.endsWith("R"),
        `unexpected reply ${JSON.stringify(lastReply)}`,
      );
      core.dispose();
      reference.core.dispose();
    },
  );
});
