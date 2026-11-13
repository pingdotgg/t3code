#!/usr/bin/env node
// Prints the terminal calls and events of one recording, one line each, with repeats folded.
// Usage: compare-terminal.mjs <recording.ndjson>. Run it on `terminal` and `rust-terminal`.
import * as NodeFS from "node:fs";
const file = process.argv[2];
const lines = NodeFS.readFileSync(file, "utf8")
  .trim()
  .split("\n")
  .map((l) => JSON.parse(l));
const tags = new Map();
const out = [];
for (const l of lines) {
  const f = l.frame;
  if (l.dir === "in" && f._tag === "Request") {
    tags.set(`${l.ws}:${f.id}`, f.tag);
    if (f.tag.startsWith("terminal.") || f.tag === "subscribeTerminalMetadata") {
      const p = { ...f.payload };
      for (const k of ["threadId", "cwd", "worktreePath", "env"])
        if (k in p) p[k] = typeof p[k] === "string" ? "…" : p[k] && "…";
      if (p.data) p.data = p.data.length > 40 ? p.data.slice(0, 40) + "…" : p.data;
      out.push(`→ ${f.tag} ${JSON.stringify(p)}`);
    }
  }
  if (l.dir === "out" && (f._tag === "Chunk" || f._tag === "Exit")) {
    const tag = tags.get(`${l.ws}:${f.requestId}`);
    if (!tag || !(tag.startsWith("terminal.") || tag === "subscribeTerminalMetadata")) continue;
    if (f._tag === "Exit") {
      out.push(
        `← ${tag} exit ${f.exit._tag}${f.exit.cause ? " " + JSON.stringify(f.exit.cause[0]?.error?._tag ?? f.exit.cause[0]?._tag) : ""}`,
      );
      continue;
    }
    const types = f.values.map((v) =>
      v.type === "snapshot" && v.snapshot
        ? `snapshot(${v.snapshot.status},${v.snapshot.cols}x${v.snapshot.rows},hist=${v.snapshot.history.length > 0})`
        : v.type === "snapshot"
          ? `snapshot[${v.terminals.length}]`
          : v.type === "upsert"
            ? `upsert(${v.terminal.status},${v.terminal.hasRunningSubprocess},${v.terminal.label})`
            : v.type === "activity"
              ? `activity(${v.hasRunningSubprocess},${v.label}${v.cols ? "," + v.cols + "x" + v.rows : ""})`
              : v.type,
    );
    out.push(`← ${tag} ${types.join(" ")}`);
  }
}
// Collapse runs of identical lines.
let prev = null,
  n = 0;
for (const l of [...out, null]) {
  if (l === prev) {
    n++;
    continue;
  }
  if (prev !== null) console.log(n > 1 ? `${prev}  ×${n}` : prev);
  prev = l;
  n = 1;
}
