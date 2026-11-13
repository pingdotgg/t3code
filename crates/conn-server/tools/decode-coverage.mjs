// The coverage gate for the wire checks: every method the server registers must get at least
// one answer that the real client's decoders read, in effect-client.mjs or replay.mjs.
//
//   node crates/conn-server/tools/decode-coverage.mjs <decoded-tags file> [<conn-server binary>]
//
// <decoded-tags file> holds one tag per line: effect-client.mjs and replay.mjs append to the
// file named by DECODE_COVERAGE each tag whose answer (a value, a stream item or a typed error)
// decoded. tools/check.sh runs them with that variable set, then this gate.
//
// `decode-coverage.pending` lists the registered methods that still lack such a run. The gate
// fails when a registered method is in neither, and when a listed method now has a run or is
// no longer registered, so the list only shrinks. With a binary, it also checks that the
// sources' registered count equals the server's.
import * as NodeFS from "node:fs";
import * as NodeURL from "node:url";

import { binaryCoverage, contractMethods, registeredTags, servedCount } from "../../../tools/served.mjs";

const [decodedFile, binary] = process.argv.slice(2);
if (!decodedFile) throw new Error("usage: decode-coverage.mjs <decoded-tags file> [<binary>]");
const pendingFile = NodeURL.fileURLToPath(new URL("decode-coverage.pending", import.meta.url));

const lines = (text) =>
  text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));
const decoded = new Set(NodeFS.existsSync(decodedFile) ? lines(NodeFS.readFileSync(decodedFile, "utf8")) : []);
const pending = new Set(lines(NodeFS.readFileSync(pendingFile, "utf8")));
const registered = registeredTags(new Set(contractMethods().map((m) => m.tag)));

let failed = false;
const report = (label, tags) => {
  if (tags.length === 0) return;
  failed = true;
  console.log(`FAIL ${label} (${tags.length}):`);
  for (const tag of tags.sort()) console.log(`  ${tag}`);
};

if (binary) {
  const line = await binaryCoverage(binary);
  const count = servedCount(line);
  if (count !== registered.size) {
    failed = true;
    console.log(`FAIL the sources register ${registered.size} methods, the binary says ${line ?? "nothing"}`);
  }
}
report(
  "registered without a decode-checked run: add a call to effect-client.mjs (or, last, a line to decode-coverage.pending)",
  [...registered].filter((t) => !decoded.has(t) && !pending.has(t)),
);
report(
  "listed in decode-coverage.pending but now decode-checked: remove the line",
  [...pending].filter((t) => decoded.has(t)),
);
report(
  "listed in decode-coverage.pending but not registered: remove the line",
  [...pending].filter((t) => !registered.has(t)),
);
const covered = [...registered].filter((t) => decoded.has(t)).length;
console.log(
  `${covered} of ${registered.size} registered methods have a decode-checked run; ${pending.size} pending (decode-coverage.pending)`,
);
if (failed) process.exitCode = 1;
