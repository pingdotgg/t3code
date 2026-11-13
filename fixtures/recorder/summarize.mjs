#!/usr/bin/env node
// Prints a readable timeline of one recording: HTTP calls and RPC requests with their outcome.
// Usage: node fixtures/recorder/summarize.mjs <name>   (e.g. pairing). Needs no monorepo.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const dir = NodePath.resolve(
  NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
  "../sessions",
);
const name = process.argv[2];
const read = (f) =>
  NodeFS.existsSync(f)
    ? NodeFS.readFileSync(f, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l))
    : [];
const wire = read(NodePath.join(dir, `${name}.ndjson`));
const http = read(NodePath.join(dir, `${name}.http.ndjson`));

const events = [];
for (const h of http) {
  if (h.closed) events.push({ ms: h.ms, text: `ws#${h.ws} closed` });
  else if (h.upgrade) events.push({ ms: h.ms, text: `WS  ws#${h.ws} ${new URL(h.url).search}` });
  else {
    const u = new URL(h.url);
    events.push({
      ms: h.ms,
      text: `HTTP ${h.method} ${u.pathname}${u.search} -> ${h.status ?? h.failed ?? h.error}`,
    });
  }
}
const reqs = new Map();
for (const l of wire) {
  const f = l.frame;
  const key = `${l.ws}:${f.id ?? f.requestId}`;
  if (l.dir === "in" && f._tag === "Request") {
    const r = {
      ms: l.ms,
      ws: l.ws,
      id: f.id,
      tag: f.tag,
      payload: f.payload,
      chunks: 0,
      exit: null,
    };
    reqs.set(key, r);
    events.push({ ms: l.ms, req: r });
  } else if (l.dir === "out" && f._tag === "Chunk") {
    const r = reqs.get(key);
    if (r) r.chunks += f.values.length;
  } else if (l.dir === "out" && f._tag === "Exit") {
    const r = reqs.get(key);
    if (r)
      r.exit = { ms: l.ms, tag: f.exit._tag, cause: f.exit.cause?.map((c) => c._tag).join(",") };
  } else if (l.dir === "in" && f._tag === "Interrupt") {
    events.push({ ms: l.ms, text: `    Interrupt ws#${l.ws} id=${f.requestId}` });
  }
}
events.sort((a, b) => a.ms - b.ms);
for (const e of events) {
  if (e.text) {
    console.log(`${String(e.ms).padStart(7)}  ${e.text}`);
    continue;
  }
  const r = e.req;
  const keys =
    r.payload && typeof r.payload === "object"
      ? Object.keys(r.payload).join(",")
      : JSON.stringify(r.payload);
  const end = r.exit
    ? `${r.exit.tag}${r.exit.cause ? `(${r.exit.cause})` : ""}@${r.exit.ms}`
    : "open";
  console.log(
    `${String(e.ms).padStart(7)}  RPC ws#${r.ws} #${r.id} ${r.tag} {${keys}} chunks=${r.chunks} ${end}`,
  );
}
const tags = wire.reduce(
  (m, l) => ((m[`${l.dir}:${l.frame._tag}`] = (m[`${l.dir}:${l.frame._tag}`] ?? 0) + 1), m),
  {},
);
console.log(
  "\nframes:",
  wire.length,
  JSON.stringify(tags),
  "multi-part:",
  wire.filter((l) => l.parts).length,
);
