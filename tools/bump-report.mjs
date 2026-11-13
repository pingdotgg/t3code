#!/usr/bin/env node
// Prints the report of a Conn pin bump: what moved in the contract, /mcp, keybindings and the
// provider files, and what the Conn Server does not serve. tools/bump-conn.sh calls it.
//
//   node tools/bump-report.mjs --before <snapshot dir> --from <old sha> --to <new sha>
//        [--checks <file>] [--binary <conn-server>]
//   node tools/bump-report.mjs --tool-digests <gen-tools --all output> <out>
//
// --before holds the generated files as they were at the old pin, at their repository paths.
// The files of this repository are the state after the bump. `--checks` has one line per check:
// `ok <name>`, `FAIL <name>` or `skip <name>`. `--binary` is started once with a temp state
// folder to read its method coverage line, then stopped. Reads CONN_MONOREPO with `git` only.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { repoRoot } from "./monorepo.mjs";

const args = process.argv.slice(2);

// `--tool-digests`: keeps one digest per tool field, so tools/upkeep/mcp-tools.json stays small
// and the next bump can say which field of which tool changed.
if (args[0] === "--tool-digests") {
  const { tools } = JSON.parse(NodeFS.readFileSync(args[1], "utf8"));
  const digest = (value) =>
    NodeCrypto.createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 12);
  const rows = tools
    .map((tool) => ({
      name: tool.name,
      fields: Object.fromEntries(
        Object.keys(tool)
          .filter((k) => k !== "name")
          .sort()
          .map((k) => [k, digest(tool[k])]),
      ),
    }))
    .sort((a, b) => (a.name < b.name ? -1 : 1));
  const text = `{"tools": [\n${rows.map((r) => `  ${JSON.stringify(r)}`).join(",\n")}\n]}\n`;
  NodeFS.writeFileSync(args[2], text);
  console.log(`wrote digests of ${rows.length} tools to ${args[2]}`);
  process.exit(0);
}
const option = (name) => {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
};
const before = option("--before");
const from = option("--from");
const to = option("--to");
if (!before || !from || !to) {
  console.error("usage: bump-report.mjs --before <dir> --from <sha> --to <sha> [--checks <file>] [--binary <path>]");
  process.exit(2);
}
const monorepo = process.env.CONN_MONOREPO;

const readText = (root, rel) => {
  const file = NodePath.join(root, rel);
  return NodeFS.existsSync(file) ? NodeFS.readFileSync(file, "utf8") : undefined;
};
const readJson = (root, rel) => {
  const text = readText(root, rel);
  try {
    return text === undefined ? undefined : JSON.parse(text);
  } catch {
    return undefined;
  }
};
const git = (...gitArgs) => {
  try {
    return NodeChildProcess.execFileSync("git", ["-C", monorepo, ...gitArgs], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch {
    return undefined;
  }
};
const short = (sha) => sha.slice(0, 10);
const out = [];
const line = (text = "") => out.push(text);
const list = (label, names, max = 40) => {
  if (names.length === 0) return;
  const shown = names.slice(0, max).join(", ");
  line(`  ${label} (${names.length}): ${shown}${names.length > max ? ", …" : ""}`);
};

// ---- Header and checks -------------------------------------------------------------------

const commits = monorepo ? git("rev-list", "--count", `${from}..${to}`)?.trim() : undefined;
const back = monorepo ? git("rev-list", "--count", `${to}..${from}`)?.trim() : undefined;
const direction =
  commits !== undefined && back !== undefined
    ? Number(back) === 0
      ? `${commits} commits forward`
      : Number(commits) === 0
        ? `${back} commits back`
        : `${commits} commits forward, ${back} back`
    : "commit distance unknown";
line(`# Conn bump ${short(from)} → ${short(to)} (${direction})`);

const oldMethods = readJson(before, "crates/conn-contract/methods.json");
const newMethods = readJson(repoRoot, "crates/conn-contract/methods.json");
if (oldMethods && newMethods && oldMethods.commit !== newMethods.commit) {
  line(`Contract commit: ${short(oldMethods.commit)} → ${short(newMethods.commit)}`);
} else if (newMethods) {
  line(`Contract commit: ${short(newMethods.commit)} (unchanged)`);
}

const checksFile = option("--checks");
let failedChecks = [];
if (checksFile && NodeFS.existsSync(checksFile)) {
  const rows = NodeFS.readFileSync(checksFile, "utf8").split("\n").filter(Boolean);
  const by = (kind) => rows.filter((r) => r.startsWith(`${kind} `)).map((r) => r.slice(kind.length + 1));
  failedChecks = by("FAIL");
  line();
  line(failedChecks.length === 0 ? "## Checks: green" : `## Checks: RED (${failedChecks.length} failed)`);
  list("failed", failedChecks);
  line(`  passed ${by("ok").length}${by("skip").length ? `, skipped: ${by("skip").join(", ")}` : ""}`);
}

// ---- Contract ----------------------------------------------------------------------------

/** Top-level items of generated.rs: name -> text. `lit::X` for the literal types. */
function parseItems(text) {
  const items = new Map();
  if (text === undefined) return items;
  const lines = text.split("\n");
  let pending = [];
  for (let i = 0; i < lines.length; i++) {
    const row = lines[i];
    if (row.startsWith("pub mod lit {")) {
      for (i++; i < lines.length && lines[i] !== "}"; i++) {
        const m = /^\s+literal!\((\w+)\s*=/.exec(lines[i]);
        if (m) items.set(`lit::${m[1]}`, lines[i].trim());
      }
      pending = [];
      continue;
    }
    if (row.startsWith("#[") || row.startsWith("///")) {
      pending.push(row);
      continue;
    }
    let name;
    const decl = /^pub (?:struct|enum|type) (\w+)/.exec(row);
    const macro = /^(\w+)! \{/.exec(row);
    if (decl) name = decl[1];
    else if (macro) name = /^\s+(\w+)/.exec(lines[i + 1] ?? "")?.[1];
    if (name === undefined) {
      pending = [];
      continue;
    }
    const body = [...pending, row];
    const single = row.endsWith(";") || (decl && !row.endsWith("{"));
    if (!single) {
      for (i++; i < lines.length; i++) {
        body.push(lines[i]);
        if (lines[i] === "}") break;
      }
    }
    items.set(name, body.join("\n"));
    pending = [];
  }
  return items;
}

const identifiers = (text) => {
  const found = new Set();
  for (const m of text.matchAll(/\blit::(\w+)/g)) found.add(`lit::${m[1]}`);
  for (const m of text.replace(/"(?:[^"\\]|\\.)*"/g, '""').matchAll(/\b[A-Z]\w*/g)) found.add(m[0]);
  return found;
};

function closure(items, roots) {
  const seen = new Set();
  const stack = [...roots].filter((r) => items.has(r));
  while (stack.length) {
    const name = stack.pop();
    if (seen.has(name)) continue;
    seen.add(name);
    for (const ref of identifiers(items.get(name))) if (items.has(ref) && !seen.has(ref)) stack.push(ref);
  }
  return seen;
}

const oldItems = parseItems(readText(before, "crates/conn-contract/src/generated.rs"));
const newItems = parseItems(readText(repoRoot, "crates/conn-contract/src/generated.rs"));
const oldReport = readJson(before, "crates/conn-contract/generated/report.json");
const newReport = readJson(repoRoot, "crates/conn-contract/generated/report.json");
const oldRows = new Map((oldReport?.methodTypes ?? []).map((m) => [m.tag, m]));
const newRows = new Map((newReport?.methodTypes ?? []).map((m) => [m.tag, m]));
const changedItems = new Set();
for (const [name, text] of newItems) if (oldItems.has(name) && oldItems.get(name) !== text) changedItems.add(name);
const addedItems = [...newItems.keys()].filter((n) => !oldItems.has(n));
const removedItems = [...oldItems.keys()].filter((n) => !newItems.has(n));

const PARTS = [
  ["payload", "payload"],
  ["success", "result"],
  ["error", "error"],
  ["item", "item"],
];
const tagged = (tag, row) => `${tag}${row?.stream ? " [stream]" : ""}`;
const addedMethods = [...newRows.keys()].filter((t) => !oldRows.has(t)).sort();
const removedMethods = [...oldRows.keys()].filter((t) => !newRows.has(t)).sort();
const changedMethods = [];
for (const [tag, row] of [...newRows].sort(([a], [b]) => (a < b ? -1 : 1))) {
  const old = oldRows.get(tag);
  if (old === undefined) continue;
  const parts = [];
  if (old.stream !== row.stream) parts.push(row.stream ? "now a stream" : "no longer a stream");
  for (const [key, label] of PARTS) {
    if ((old[key] ?? "") !== (row[key] ?? "")) {
      parts.push(`${label} ${old[key] ?? "none"} → ${row[key] ?? "none"}`);
      continue;
    }
    if (row[key] === undefined) continue;
    const roots = identifiers(row[key]);
    const oldSet = closure(oldItems, roots);
    const newSet = closure(newItems, roots);
    const moved = [...newSet].filter((n) => !oldSet.has(n) || changedItems.has(n));
    const gone = [...oldSet].filter((n) => !newSet.has(n));
    if (moved.length + gone.length > 0) {
      const names = [...moved, ...gone].sort();
      parts.push(`${label} (${names.slice(0, 4).join(", ")}${names.length > 4 ? `, +${names.length - 4}` : ""})`);
    }
  }
  if (parts.length) changedMethods.push(`${tagged(tag, row)}: ${parts.join("; ")}`);
}

line();
line(`## Contract: ${oldRows.size} → ${newRows.size} methods`);
if (newItems.size === 0) line("  generated.rs is missing or empty: gen-contract failed, so no method diff.");
list("added", addedMethods.map((t) => tagged(t, newRows.get(t))));
list("removed", removedMethods.map((t) => tagged(t, oldRows.get(t))));
if (changedMethods.length) {
  line(`  changed (${changedMethods.length}):`);
  for (const row of changedMethods.slice(0, 40)) line(`    ${row}`);
  if (changedMethods.length > 40) line(`    … ${changedMethods.length - 40} more`);
}
if (addedMethods.length + removedMethods.length + changedMethods.length === 0 && newItems.size) {
  line("  no method changed shape");
}
line(
  `  Rust items: ${addedItems.length} added, ${removedItems.length} removed, ${changedItems.size} changed` +
    (newReport ? `; opaque fallbacks ${oldReport?.opaqueFallbacks ?? "?"} → ${newReport.opaqueFallbacks}` : ""),
);
if (newReport && oldReport && newReport.opaqueFallbacks > oldReport.opaqueFallbacks) {
  line("  WARNING: more Opaque fallbacks: the generator met a shape it cannot map (generated/report.json).");
}

// ---- /mcp --------------------------------------------------------------------------------

const toolsOf = (root) => {
  const json = readJson(root, "tools/upkeep/mcp-tools.json");
  return json === undefined ? undefined : new Map(json.tools.map((t) => [t.name, t.fields]));
};
const oldTools = toolsOf(before);
const newTools = toolsOf(repoRoot);
const served = new Set(
  (readText(repoRoot, "crates/conn-mcp/tools.implemented") ?? "")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#")),
);
const mark = (name) => (served.has(name) ? `${name}*` : name);
line();
if (oldTools === undefined || newTools === undefined) {
  line("## /mcp tools: no tool list to compare (tools/upkeep/mcp-tools.json missing).");
} else {
  line(`## /mcp tools: ${oldTools.size} → ${newTools.size} in the T3 server, ${served.size} served (* = served)`);
  list("added", [...newTools.keys()].filter((n) => !oldTools.has(n)).sort().map(mark));
  list("removed", [...oldTools.keys()].filter((n) => !newTools.has(n)).sort().map(mark));
  const changed = [];
  for (const [name, tool] of [...newTools].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const old = oldTools.get(name);
    if (old === undefined) continue;
    const keys = [...new Set([...Object.keys(old), ...Object.keys(tool)])].filter(
      (k) => JSON.stringify(old[k]) !== JSON.stringify(tool[k]),
    );
    if (keys.length) changed.push(`${mark(name)} (${keys.join(", ")})`);
  }
  list("changed", changed);
  if (changed.length === 0 && oldTools.size === newTools.size) line("  no tool changed");
}
for (const [rel, what] of [
  ["crates/conn-mcp/src/instructions.txt", "agent instructions text"],
  ["crates/conn-mcp/src/claude-background-wait.txt", "Claude background-wait text"],
]) {
  const a = readText(before, rel);
  const b = readText(repoRoot, rel);
  if (a !== b) line(`  ${what} changed (${rel})`);
}

// ---- Keybindings -------------------------------------------------------------------------

const keys = (root) => readJson(root, "crates/conn-server/keybindings.defaults.json");
const oldKeys = keys(before);
const newKeys = keys(repoRoot);
line();
if (!oldKeys || !newKeys) {
  line("## Keybindings: no defaults file to compare");
} else {
  const rows = (k) =>
    new Set([...k.defaults, ...k.late].map((b) => `${b.key} → ${b.command}${b.when ? ` (when ${b.when})` : ""}`));
  const a = rows(oldKeys);
  const b = rows(newKeys);
  const added = [...b].filter((r) => !a.has(r));
  const removed = [...a].filter((r) => !b.has(r));
  const limits =
    oldKeys.maxCount !== newKeys.maxCount || oldKeys.maxWhenDepth !== newKeys.maxWhenDepth
      ? `; limits ${oldKeys.maxCount}/${oldKeys.maxWhenDepth} → ${newKeys.maxCount}/${newKeys.maxWhenDepth}`
      : "";
  line(`## Keybindings: ${added.length} added, ${removed.length} removed${limits}`);
  list("added", added, 12);
  list("removed", removed, 12);
}

// ---- Provider files ----------------------------------------------------------------------

line();
const specs = (readText(repoRoot, "tools/upkeep/provider-files.txt") ?? "")
  .split("\n")
  .map((l) => l.trim())
  .filter((l) => l && !l.startsWith("#"));
if (!monorepo) {
  line("## Provider files: CONN_MONOREPO is not set");
} else {
  const stat = git("diff", "--stat=100", from, to, "--", ...specs)?.trimEnd();
  line(`## Provider files the provider crates follow (tools/upkeep/provider-files.txt)`);
  if (stat === undefined) line("  git diff failed: is the old commit in CONN_MONOREPO's Git data?");
  else if (stat === "") line("  no change");
  else for (const row of stat.split("\n")) line(`  ${row.trim()}`);

  const at = (sha, rel) => git("show", `${sha}:${rel}`);
  const sdk = (sha) => {
    const pkg = at(sha, "apps/server/package.json");
    const lock = at(sha, "pnpm-lock.yaml");
    const spec = pkg && /"@anthropic-ai\/claude-agent-sdk":\s*"([^"]+)"/.exec(pkg)?.[1];
    const resolved = lock && /\n {2}'?@anthropic-ai\/claude-agent-sdk@([0-9][^':(]*)'?:/.exec(lock)?.[1];
    return `${spec ?? "?"} (lock ${resolved ?? "?"})`;
  };
  const codex = (sha) => {
    const text = at(sha, "apps/server/src/provider/CodexInstallation.ts");
    const versions = text ? [...new Set([...text.matchAll(/version: "([^"]+)"/g)].map((m) => m[1]))] : [];
    return versions.length ? versions.join(", ") : "?";
  };
  const rustPin = (rel, re) => re.exec(readText(repoRoot, rel) ?? "")?.[1] ?? "?";
  const rustSdk = rustPin("crates/conn-provider-claude/src/launch.rs", /AGENT_SDK_VERSION: &str = "([^"]+)"/);
  const rustCodex = rustPin("crates/conn-provider-codex/src/client.rs", /TESTED_CLI_VERSION: &str = "([^"]+)"/);
  const sdkTo = sdk(to);
  const codexTo = codex(to);
  line(`  Claude Agent SDK: ${sdk(from)} → ${sdkTo}; conn-provider-claude pins ${rustSdk}` +
    (sdkTo.includes(`lock ${rustSdk})`) ? "" : "  ← differs"));
  line(`  Codex CLI (managed): ${codex(from)} → ${codexTo}; conn-provider-codex tested ${rustCodex}` +
    (codexTo.split(", ").includes(rustCodex) ? "" : "  ← differs"));
}

// ---- Coverage ----------------------------------------------------------------------------

/** Method tags our Rust sources register (`.unary("tag"` / `.stream("tag"`), tests excluded. */
function registeredTags() {
  const found = new Set();
  const walk = (dir) => {
    for (const entry of NodeFS.readdirSync(dir, { withFileTypes: true })) {
      const path = NodePath.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "tests") walk(path);
      } else if (entry.name.endsWith(".rs") && entry.name !== "tests.rs") {
        const text = NodeFS.readFileSync(path, "utf8").split(/\n#\[cfg\(test\)\]/)[0];
        for (const m of text.matchAll(/\.(?:unary|stream)\(\s*"([A-Za-z0-9_.]+)"/g)) found.add(m[1]);
      }
    }
  };
  for (const crate of NodeFS.readdirSync(NodePath.join(repoRoot, "crates"))) {
    const src = NodePath.join(repoRoot, "crates", crate, "src");
    if (NodeFS.existsSync(src)) walk(src);
  }
  return found;
}

async function coverageLine(binary) {
  if (!binary || !NodeFS.existsSync(binary)) return undefined;
  const tmp = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "conn-bump-cov-"));
  const project = NodePath.join(tmp, "project");
  NodeFS.mkdirSync(project);
  const child = NodeChildProcess.spawn(binary, ["--state-dir", NodePath.join(tmp, "state"), "--project", project], {
    cwd: tmp,
    stdio: ["ignore", "pipe", "pipe"],
  });
  try {
    return await new Promise((ok) => {
      let text = "";
      const timer = setTimeout(() => ok(undefined), 15000);
      child.stdout.on("data", (d) => {
        text += d;
        const m = /^methods: (.+)$/m.exec(text);
        if (m) {
          clearTimeout(timer);
          ok(m[1]);
        }
      });
      child.on("exit", () => {
        clearTimeout(timer);
        ok(undefined);
      });
    });
  } finally {
    if (child.exitCode === null) child.kill("SIGTERM");
    await new Promise((r) => (child.exitCode === null ? child.once("exit", r) : r()));
    NodeFS.rmSync(tmp, { recursive: true, force: true });
  }
}

line();
const registered = registeredTags();
const all = newMethods?.methods ?? [];
const missing = all.filter((m) => !registered.has(m.tag));
const servedCount = all.length - missing.length;
const binaryLine = await coverageLine(option("--binary"));
line(`## Coverage: ${binaryLine ?? `${servedCount} of ${all.length} methods (from the sources; no binary run)`}`);
const binaryServed = binaryLine && Number(/^(\d+) of/.exec(binaryLine)?.[1]);
if (binaryLine && binaryServed !== servedCount) {
  line(`  WARNING: the sources register ${servedCount}, the binary says ${binaryServed}; the list below may be off.`);
}
const unservedNew = addedMethods.filter((t) => !registered.has(t));
list("new in this bump and not served", unservedNew);
const areas = new Map();
for (const m of missing) {
  const area = m.tag.split(".")[0];
  areas.set(area, [...(areas.get(area) ?? []), m.tag.slice(area.length + 1) + (m.stream ? "*" : "")]);
}
line(`  not served, by area (${missing.length}; * = stream):`);
for (const [area, tags] of [...areas].sort(([a], [b]) => (a < b ? -1 : 1))) {
  line(`    ${area} (${tags.length}): ${tags.join(", ")}`);
}
const stale = [...registered].filter((t) => !all.some((m) => m.tag === t));
if (stale.length) line(`  registered but no longer in the contract (the server panics at start): ${stale.join(", ")}`);

console.log(out.join("\n"));
