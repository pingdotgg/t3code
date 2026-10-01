/**
 * Host wire-frame replay: recorded output-events frames exactly as the
 * host's terminal provider emits them, replayed through the shipped client
 * path — TerminalVtAttachment + vendored libghostty-vt — with the attach,
 * detach and resubscribe choreography a live panel goes through. The
 * recording is pinned field-for-field on the host side on every run; this
 * suite proves the client behavior those frames must produce.
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

const flush = () => new Promise((resolve) => setImmediate(resolve));

let runtime;
let recorded;

NodeTest.before(async () => {
  const [vt, writePty, fixture] = await Promise.all([
    NodeFSP.readFile(new URL("ghostty-vt.wasm", `file://${ghosttyAssetsDir}`)),
    NodeFSP.readFile(new URL("ghostty-write-pty.wasm", `file://${ghosttyAssetsDir}`)),
    NodeFSP.readFile(new URL("fixtures/host-output-frames.json", `file://${packageDir}`), "utf8"),
  ]);
  runtime = await loadGhosttyRuntime({ vt, writePty });
  recorded = JSON.parse(fixture);
});

async function makeCore(writes) {
  return GhosttyTerminalCore.create(runtime, 80, 24, 8, 16, THEME, (data) => writes.push(data));
}

// The wire envelope the transport carries around each frame: a stable
// stream identity and a sequence that restarts at 1 on each subscription.
function applier(attachment) {
  let sequence = 0;
  return (frame) => attachment.applyFrame({ streamId: "s", sequence: ++sequence }, frame.value);
}

NodeTest.describe("host wire-frame replay — evicted query claim", () => {
  for (const [mountInGap, gapQuery] of [
    [false, true],
    [true, true],
    [false, false],
    [true, false],
  ]) {
    NodeTest.it(
      `an evicted query's reply cannot transfer to a retained lookalike (mount ${mountInGap ? "in gap" : "after snapshot"}, gap tail ${gapQuery ? "queries" : "inert"})`,
      async () => {
        // The retained tail may keep a lookalike ESC Z; it lies past
        // everything the client received (unit 7), so it is a new query
        // issued in the subscription gap, not the evicted one.
        const scenario = gapQuery
          ? recorded.evictedQueryClaim
          : recorded.evictedQueryClaimInertTail;
        const [snapshot, query, lookalike, resnapshot] = scenario.frames;
        const attachment = new TerminalVtAttachment("term-1");
        let apply = applier(attachment);

        // Live: the parser receives the DA query and answers it.
        const firstWrites = [];
        const first = await makeCore(firstWrites);
        try {
          attachment.attach(first);
          attachment.beginStream();
          apply(snapshot);
          apply(query);
          await flush();
          NodeAssert.equal(firstWrites.length, 1);
          NodeAssert.match(firstWrites[0], /\[\d+;\d+R/);

          // Detached but subscribed: the unanswered run is delivered at
          // absolute position 4 of the stream window and buffered.
          attachment.detach();
          apply(lookalike);

          // Resubscribed after the eviction burst: the snapshot reports raw
          // provenance — unitStart 7 counts the evicted query's bytes.
          attachment.beginStream();
          apply = applier(attachment);
          const secondWrites = [];
          const second = await makeCore(secondWrites);
          try {
            NodeAssert.equal(resnapshot.value.contentsUnitStart, 7);
            NodeAssert.equal(resnapshot.value.clearGeneration, 0);
            NodeAssert.equal(resnapshot.value.truncated, false);
            NodeAssert.equal(
              resnapshot.value.contents,
              (gapQuery ? "x\x1bZ\n" : "xyz\n") + "z\n".repeat(4),
            );
            if (mountInGap) attachment.attach(second);
            apply(resnapshot);
            if (!mountInGap) attachment.attach(second);
            await flush();

            // The evicted claim is dead: an inert tail earns no reply. A gap
            // query earns exactly its own one DA reply (hidden panes keep VT
            // protocol continuity across the reshow gap), never a second one
            // transferred from the evicted claim. A transferred reply would be
            // byte-identical to the gap query's own, so only the count tells
            // them apart; a stronger signal would need distinct queries.
            NodeAssert.deepEqual(secondWrites, gapQuery ? ["\x1b[?62;22c"] : []);
            // A surface mounted in the gap replayed the attachment's complete
            // base and then received only the gap, so its parser is faithful;
            // one mounted after the snapshot replays only the truncated tail.
            NodeAssert.equal(attachment.state.degraded, !mountInGap);
          } finally {
            second.dispose();
          }
        } finally {
          first.dispose();
        }
      },
    );
  }
});

NodeTest.describe("host wire-frame replay — subscription-split mode setter", () => {
  for (const sinkBeforeSnapshot of [true, false]) {
    NodeTest.it(
      `a mode setter split across the subscription boundary keeps parser coverage (sink ${sinkBeforeSnapshot ? "before" : "after"} snapshot)`,
      async () => {
        const [snapshot, live] = recorded.subscriptionSplitModeSetter.frames;
        const attachment = new TerminalVtAttachment("term-1");
        const apply = applier(attachment);

        // The snapshot must carry the raw prefix of the split setter —
        // coverage includes it — so the parser continues the sequence.
        NodeAssert.equal(snapshot.value.contents, "\x1b[?2004");
        NodeAssert.equal(snapshot.value.contentsUnitStart, 0);
        NodeAssert.equal(snapshot.value.clearGeneration, 0);
        NodeAssert.equal(snapshot.value.truncated, false);
        NodeAssert.equal(live.value.data, "h");

        const writes = [];
        const core = await makeCore(writes);
        try {
          attachment.beginStream();
          if (sinkBeforeSnapshot) attachment.attach(core);
          apply(snapshot);
          if (!sinkBeforeSnapshot) attachment.attach(core);
          apply(live);
          await flush();

          // The completed setter took effect: paste encoding is bracketed
          // and the stream is live, not degraded.
          NodeAssert.equal(core.encodePaste("a\nb"), "\x1b[200~a\nb\x1b[201~");
          NodeAssert.equal(attachment.state.degraded, false);
        } finally {
          core.dispose();
        }
      },
    );
  }
});
