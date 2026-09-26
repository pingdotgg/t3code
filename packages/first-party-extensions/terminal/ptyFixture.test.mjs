/**
 * Raw-mode PTY fixture replay: a recorded curses-style stream (alt screen,
 * cursor-addressed frames, SGR, hide/show cursor) replayed through the real
 * attach path — snapshot frame → chunked output frames → TerminalVtAttachment
 * → vendored libghostty-vt — then the final screen is asserted.
 */
import * as NodeAssert from "node:assert/strict";
import * as NodeFSP from "node:fs/promises";
import * as NodeTest from "node:test";
import * as NodeURL from "node:url";

import { GhosttyTerminalCore } from "@t3tools/ghostty-terminal/core";
import { loadGhosttyRuntime } from "@t3tools/ghostty-terminal/runtime";
import { TerminalVtAttachment } from "./vtAttachment.ts";

const packageDir = NodeURL.fileURLToPath(new URL("./", import.meta.url));
const ghosttyAssetsDir = NodeURL.fileURLToPath(
  new URL("./", import.meta.resolve("@t3tools/ghostty-terminal/assets/ghostty-vt.wasm")),
);

const THEME = {
  foreground: { r: 229, g: 231, b: 235 },
  background: { r: 10, g: 10, b: 12 },
  cursor: { r: 229, g: 231, b: 235 },
};

function rowText(snapshot, row) {
  return snapshot.rowData[row].cells.map((cell) => cell.text).join("");
}

NodeTest.it("raw-mode PTY fixture replays to the correct final screen", async () => {
  const [vt, writePty, fixture] = await Promise.all([
    NodeFSP.readFile(new URL("ghostty-vt.wasm", `file://${ghosttyAssetsDir}`)),
    NodeFSP.readFile(new URL("ghostty-write-pty.wasm", `file://${ghosttyAssetsDir}`)),
    NodeFSP.readFile(new URL("fixtures/raw-mode-pty.txt", `file://${packageDir}`), "utf8"),
  ]);
  const runtime = await loadGhosttyRuntime({ vt, writePty });
  const core = await GhosttyTerminalCore.create(runtime, 80, 24, 8, 16, THEME, () => {});
  try {
    const attachment = new TerminalVtAttachment("term-pty");
    attachment.attach(core);
    attachment.beginStream();

    const snapshot = {
      kind: "snapshot",
      terminalId: "term-pty",
      streamEpoch: "pty-1",
      status: "running",
      contents: "",
      retainedByteLength: 0,
      truncated: false,
      clearGeneration: 0,
      contentsUnitStart: 0,
      boundarySequence: 0,
    };
    attachment.applyFrame({ streamId: "s1", sequence: 1 }, snapshot);

    // Stream the fixture as ~64-byte chunks split mid-sequence on purpose —
    // the attachment must reassemble before the parser sees them.
    let seq = 1;
    let nativeSeq = 0;
    const CHUNK = 64;
    for (let offset = 0; offset < fixture.length;) {
      const end = Math.min(offset + CHUNK, fixture.length);
      const parts = [fixture.slice(offset, end)];
      offset = end;
      nativeSeq += 1;
      for (let i = 0; i < parts.length; i += 1) {
        const value = {
          kind: "output",
          terminalId: "term-pty",
          streamEpoch: "pty-1",
          sequence: nativeSeq,
          chunkIndex: i,
          chunkCount: parts.length,
          data: parts[i],
        };
        seq += 1;
        attachment.applyFrame({ streamId: "s1", sequence: seq }, value);
      }
    }

    NodeAssert.equal(attachment.state.status, "live");
    NodeAssert.equal(attachment.state.degraded, false);

    // The app exited the alt screen: the primary screen shows the two shell
    // prompts (before + after), not the app's frame.
    const snap = core.snapshot();
    NodeAssert.equal(core.isAlternateScreen(), false);
    NodeAssert.ok(rowText(snap, 0).startsWith("user@host:proj$"));
    NodeAssert.ok(!rowText(snap, 0).includes("RAW-MODE APP"));
    NodeAssert.ok(rowText(snap, 0).includes("user@host:proj$"));
  } finally {
    core.dispose();
  }
});

NodeTest.it("the same fixture held inside the alt screen renders its frame", async () => {
  const [vt, writePty, fixture] = await Promise.all([
    NodeFSP.readFile(new URL("ghostty-vt.wasm", `file://${ghosttyAssetsDir}`)),
    NodeFSP.readFile(new URL("ghostty-write-pty.wasm", `file://${ghosttyAssetsDir}`)),
    NodeFSP.readFile(new URL("fixtures/raw-mode-pty.txt", `file://${packageDir}`), "utf8"),
  ]);
  const runtime = await loadGhosttyRuntime({ vt, writePty });
  const core = await GhosttyTerminalCore.create(runtime, 80, 24, 8, 16, THEME, () => {});
  try {
    // Replay only up to the end of frame 2 (before the alt-screen exit): the
    // status bar shows the insert-mode redraw.
    const exitIndex = fixture.indexOf("\x1b[?25h");
    core.write(fixture.slice(0, exitIndex));
    const snap = core.snapshot();
    NodeAssert.equal(core.isAlternateScreen(), true);
    NodeAssert.ok(rowText(snap, 0).includes("RAW-MODE APP"));
    NodeAssert.ok(rowText(snap, 3).includes("body line two"));
    NodeAssert.ok(rowText(snap, 23).includes(":insert"));
  } finally {
    core.dispose();
  }
});
