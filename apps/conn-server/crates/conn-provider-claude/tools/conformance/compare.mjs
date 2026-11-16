// Compares what stub-claude recorded from the T3 server (`<out>/t3`) and from the Conn Server
// (`<out>/rust`): per CLI start, argv, environment, every stdin line, and how it ended (a
// clean exit on end of stdin, SIGTERM, or neither: SIGKILL).
//
//   node compare.mjs <out> [scenario...]
//
// Normalized before comparing, and only these:
// - uuids and the SDK's control request ids are random per run: each becomes a placeholder
//   numbered by first appearance within its scenario (`<uuid-1>`, `<req-1>`);
// - the stub's own path differs per side (`<stub>`);
// - environment entries are compared as a set (their order in environ carries no meaning).
// A stdin line that matches only after sorting its object keys is reported separately as
// "key order"; the CLI parses JSON, so that is no behavioural difference, but it is not byte
// identical. Exit 1 when anything differs.

import * as fs from "node:fs";
import * as path from "node:path";

const [out, ...only] = process.argv.slice(2);
if (!out) {
  console.error("usage: node compare.mjs <out> [scenario...]");
  process.exit(2);
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;

function normalizer(stubDir) {
  const uuids = new Map();
  const requests = new Map();
  const uuid = (u) => {
    if (!uuids.has(u)) uuids.set(u, `<uuid-${uuids.size + 1}>`);
    return uuids.get(u);
  };
  const request = (r) => {
    if (!requests.has(r)) requests.set(r, `<req-${requests.size + 1}>`);
    return requests.get(r);
  };
  const text = (s) => s.split(stubDir).join("<stub>").replace(UUID, uuid);
  const value = (v, key) => {
    if (typeof v === "string") return key === "request_id" ? request(v) : text(v);
    if (Array.isArray(v)) return v.map((x) => value(x));
    if (v && typeof v === "object") {
      const o = {};
      for (const [k, x] of Object.entries(v)) o[text(k)] = value(x, k);
      return o;
    }
    return v;
  };
  return { text, value };
}

function sortKeys(v) {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === "object") {
    return Object.fromEntries(
      Object.keys(v)
        .sort()
        .map((k) => [k, sortKeys(v[k])]),
    );
  }
  return v;
}

function records(dir) {
  const recordsDir = path.join(dir, "records");
  if (!fs.existsSync(recordsDir)) return [];
  return fs
    .readdirSync(recordsDir)
    .filter((f) => f.endsWith(".json"))
    .sort((a, b) => Number.parseInt(a, 10) - Number.parseInt(b, 10))
    .map((f) => JSON.parse(fs.readFileSync(path.join(recordsDir, f), "utf8")));
}

/** A line diff (longest common subsequence), changed lines only. */
function lineDiff(a, b) {
  const al = a.split("\n");
  const bl = b.split("\n");
  const m = al.length;
  const n = bl.length;
  const lcs = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      lcs[i][j] = al[i] === bl[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const outLines = [];
  let i = 0;
  let j = 0;
  while (i < m || j < n) {
    if (i < m && j < n && al[i] === bl[j]) {
      i++;
      j++;
    } else if (j < n && (i === m || lcs[i][j + 1] >= lcs[i + 1][j])) {
      outLines.push(`      + conn: ${bl[j++]}`);
    } else {
      outLines.push(`      - t3:   ${al[i++]}`);
    }
  }
  return outLines.join("\n");
}

const scenarios = JSON.parse(
  fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), "scenarios.json"), "utf8"),
).scenarios.map((s) => s.name);

let differences = 0;
let orderOnly = 0;
const report = [];
for (const name of scenarios) {
  if (only.length > 0 && !only.includes(name)) continue;
  const t3Dir = path.join(out, "t3", name);
  const rustDir = path.join(out, "rust", name);
  const t3 = records(t3Dir);
  const rust = records(rustDir);
  const nt = normalizer(t3Dir);
  const nr = normalizer(rustDir);
  const lines = [];
  let same = true;
  if (t3.length !== rust.length) {
    lines.push(`  CLI starts: t3 ${t3.length}, conn ${rust.length}`);
    same = false;
  }
  for (let i = 0; i < Math.min(t3.length, rust.length); i++) {
    const a = t3[i];
    const b = rust[i];
    const argvA = a.argv.map(nt.text);
    const argvB = b.argv.map(nr.text);
    if (JSON.stringify(argvA) !== JSON.stringify(argvB)) {
      same = false;
      lines.push(`  start ${i} argv differs:\n${lineDiff(argvA.join("\n"), argvB.join("\n"))}`);
    }
    // How the start ended: a clean exit when stdin closed, SIGTERM, or neither (SIGKILL).
    const endOf = (r) => JSON.stringify({ exit: r.exit ?? null, signal: r.signal ?? null, held: r.held ?? null });
    if (endOf(a) !== endOf(b)) {
      same = false;
      lines.push(`  start ${i} end: t3 ${endOf(a)}, conn ${endOf(b)}`);
    }
    if (nt.text(a.cwd) !== nr.text(b.cwd)) {
      same = false;
      lines.push(`  start ${i} cwd: t3 ${a.cwd}, conn ${b.cwd}`);
    }
    const envA = Object.entries(a.env).map(([k, v]) => `${k}=${nt.text(v)}`).sort();
    const envB = Object.entries(b.env).map(([k, v]) => `${k}=${nr.text(v)}`).sort();
    const onlyA = envA.filter((e) => !envB.includes(e));
    const onlyB = envB.filter((e) => !envA.includes(e));
    if (onlyA.length > 0 || onlyB.length > 0) {
      same = false;
      lines.push(
        `  start ${i} environment differs:\n${onlyA.map((e) => `      - t3:   ${e}`).join("\n")}${
          onlyA.length && onlyB.length ? "\n" : ""
        }${onlyB.map((e) => `      + conn: ${e}`).join("\n")}`,
      );
    }
    const n = Math.max(a.stdin.length, b.stdin.length);
    if (a.stdin.length !== b.stdin.length) {
      same = false;
      lines.push(`  start ${i} stdin lines: t3 ${a.stdin.length}, conn ${b.stdin.length}`);
    }
    for (let j = 0; j < n; j++) {
      const la = a.stdin[j];
      const lb = b.stdin[j];
      if (la === undefined || lb === undefined) {
        const [side, line] = la === undefined ? ["conn", lb] : ["t3", la];
        lines.push(`  start ${i} stdin ${j}: only ${side}: ${line.slice(0, 300)}`);
        continue;
      }
      const va = nt.value(JSON.parse(la));
      const vb = nr.value(JSON.parse(lb));
      const rawA = JSON.stringify(va);
      const rawB = JSON.stringify(vb);
      if (rawA === rawB) continue;
      const sa = JSON.stringify(sortKeys(va), null, 1);
      const sb = JSON.stringify(sortKeys(vb), null, 1);
      if (sa === sb) {
        orderOnly++;
        lines.push(`  start ${i} stdin ${j}: key order only\n      - t3:   ${rawA.slice(0, 400)}\n      + conn: ${rawB.slice(0, 400)}`);
        continue;
      }
      same = false;
      lines.push(`  start ${i} stdin ${j} differs:\n${lineDiff(sa, sb)}`);
    }
  }
  if (!same) differences++;
  report.push(`${same ? "SAME" : "DIFF"} ${name} (${t3.length} CLI start(s))`);
  report.push(...lines);
}
report.push("");
report.push(
  `${differences === 0 ? "No differences" : `${differences} scenario(s) differ`}` +
    (orderOnly > 0 ? `; ${orderOnly} stdin line(s) differ in key order only` : "") +
    ". Normalized: uuids, SDK request ids, the stub path.",
);
console.log(report.join("\n"));
process.exit(differences === 0 && orderOnly === 0 ? 0 : 1);
