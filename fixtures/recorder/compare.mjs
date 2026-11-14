#!/usr/bin/env node
// Usage: compare.mjs <scenario a> <scenario b> [tag prefix ...] (default: the VCS area).
// A scenario is a name in ../sessions or a path to a recording (`<dir>/<name>.ndjson`).
// Pairs calls by tag and normalized payload and diffs their first answers; exits 1 on a
// difference. Payloads only one side sent are counted, not failed: client timing varies.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const here = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const sessions = NodePath.resolve(here, "../sessions");
const [a, b, ...prefixes] = process.argv.slice(2);
if (!a || !b) {
  console.error("usage: compare.mjs <scenario a> <scenario b> [tag prefix ...]");
  process.exit(2);
}
const wanted = prefixes.length
  ? prefixes
  : ["vcs.", "review.", "subscribeVcs", "subscribeWorktreeSetup", "server.discoverSourceControl"];

/** Each call of a wanted tag: its payload and its first answer. */
function calls(scenario) {
  const file = scenario.endsWith(".ndjson")
    ? scenario
    : NodePath.join(sessions, `${scenario}.ndjson`);
  const lines = NodeFS.readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  const byId = new Map();
  const out = [];
  for (const { dir, ws, frame } of lines) {
    if (dir === "in" && frame._tag === "Request" && wanted.some((p) => frame.tag.startsWith(p))) {
      const call = { tag: frame.tag, payload: frame.payload, answer: undefined };
      byId.set(`${ws}:${frame.id}`, call);
      out.push(call);
    } else if (dir === "out" && (frame._tag === "Chunk" || frame._tag === "Exit")) {
      const call = byId.get(`${ws}:${frame.requestId}`);
      if (call && call.answer === undefined) {
        call.answer = frame._tag === "Chunk" ? frame.values[0] : frame.exit;
      }
    }
  }
  return out;
}

/** Drops what legitimately differs between runs and servers. */
function normalize(value, key = "") {
  if (Array.isArray(value)) return value.map((v) => normalize(v));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((k) => [k, normalize(value[k], k)]),
    );
  }
  if (typeof value !== "string") return value;
  if (/At$|^generatedAt$|Hash$/.test(key)) return `<${key}>`;
  if (/^(sha|id|headRef|baseRef)$/.test(key) && /^[0-9a-f]{40}$/.test(value)) return "<sha>";
  return value
    .replace(/\/(private\/)?var\/folders\/[^"]*?\/(conn-(rec|rust)-[A-Za-z0-9]+)/g, "<tmp>")
    // The recorder's own TypeScript server names its scratch project plain `project`.
    .replace(/<tmp>\/project\b/g, "<tmp>/<project>")
    .replace(/\b(ts|rust)-project\b/g, "<project>")
    .replace(/index [0-9a-f]{7,}\.\.[0-9a-f]{7,}/g, "index <blobs>");
}

const key = (c) => `${c.tag} ${JSON.stringify(normalize(c.payload))}`;
const firstByKey = (list) => {
  const map = new Map();
  for (const c of list) if (c.answer !== undefined && !map.has(key(c))) map.set(key(c), c);
  return map;
};
const left = firstByKey(calls(a));
const right = firstByKey(calls(b));
let differences = 0;
const counts = new Map();
for (const k of [...new Set([...left.keys(), ...right.keys()])].sort()) {
  const tag = k.slice(0, k.indexOf(" "));
  const count = counts.get(tag) ?? { same: 0, different: 0, onlyA: 0, onlyB: 0 };
  counts.set(tag, count);
  const l = left.get(k);
  const r = right.get(k);
  if (!l || !r) {
    count[l ? "onlyA" : "onlyB"]++;
    continue;
  }
  const want = JSON.stringify(normalize(l.answer));
  const got = JSON.stringify(normalize(r.answer));
  if (want === got) {
    count.same++;
    continue;
  }
  count.different++;
  differences++;
  console.log(`DIFF ${k}`);
  console.log(`  ${a}: ${want.slice(0, 800)}`);
  console.log(`  ${b}: ${got.slice(0, 800)}`);
}
for (const [tag, c] of counts) {
  console.log(
    `${tag}: ${c.same} same, ${c.different} different, ${c.onlyA} only in ${a}, ${c.onlyB} only in ${b}`,
  );
}
process.exitCode = differences ? 1 : 0;
