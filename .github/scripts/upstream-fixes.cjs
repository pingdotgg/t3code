// Cherry-picks upstream's non-breaking fix and perf commits after the cursor in
// .github/upstream-fixes/cursor, reports what did not apply, and advances the cursor.
// Usage: node .github/scripts/upstream-fixes.cjs <upstream-ref> [--max N] [--summary FILE]

"use strict";

const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const STATE_DIR = ".github/upstream-fixes";
const CURSOR_FILE = path.join(STATE_DIR, "cursor");
const SKIP_FILE = path.join(STATE_DIR, "skip");

// Areas the fork does not carry; a fix scoped only to them is not ours to take.
const EXCLUDED_SCOPES = new Set(["mobile", "marketing", "relay", "release", "ci", "infra"]);
// Paths that only matter to upstream's own infrastructure and release process.
const EXCLUDED_PATHS = [".github/", "apps/mobile/", "apps/marketing/", "infra/"];

const SUBJECT = /^(fix|perf)(?:\(([^)]*)\))?(!)?:\s/;

function classify(commit) {
  const match = SUBJECT.exec(commit.subject);
  if (!match) return { take: false, reason: "not a fix" };
  if (match[3] || /^BREAKING[ -]CHANGE:/m.test(commit.body))
    return { take: false, reason: "breaking" };
  const scopes = (match[2] || "")
    .split(/[,/]/)
    .map((scope) => scope.trim())
    .filter(Boolean);
  if (scopes.length > 0 && scopes.every((scope) => EXCLUDED_SCOPES.has(scope))) {
    return { take: false, reason: `scope ${scopes.join(",")}` };
  }
  if (commit.files.some((file) => file.startsWith(".github/"))) {
    return { take: false, reason: "touches .github" };
  }
  if (
    commit.files.length > 0 &&
    commit.files.every((file) => EXCLUDED_PATHS.some((prefix) => file.startsWith(prefix)))
  ) {
    return { take: false, reason: "only upstream-only paths" };
  }
  return { take: true, reason: "" };
}

function readSkip(text) {
  const skip = new Set();
  for (const line of text.split("\n")) {
    const sha = line.replace(/#.*/, "").trim();
    if (/^[0-9a-f]{7,40}$/.test(sha)) skip.add(sha);
  }
  return skip;
}

function skipped(skip, sha) {
  for (const prefix of skip) if (sha.startsWith(prefix)) return true;
  return false;
}

function git(args, options = {}) {
  return execFileSync("git", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  }).trim();
}

function readCommit(sha) {
  const [subject, ...body] = git(["show", "-s", "--format=%s%n%b", sha]).split("\n");
  const files = git(["diff-tree", "--no-commit-id", "--name-only", "-r", "-m", "--root", sha])
    .split("\n")
    .filter(Boolean);
  return { sha, subject, body: body.join("\n"), files };
}

function main(argv) {
  const upstream = argv[0];
  if (!upstream)
    throw new Error("usage: upstream-fixes.cjs <upstream-ref> [--max N] [--summary FILE]");
  const option = (name, fallback) => {
    const at = argv.indexOf(name);
    return at >= 0 && argv[at + 1] ? argv[at + 1] : fallback;
  };
  const max = Number(option("--max", "200"));
  const summaryFile = option("--summary", "");

  const cursor = fs.readFileSync(CURSOR_FILE, "utf8").trim();
  const skip = fs.existsSync(SKIP_FILE) ? readSkip(fs.readFileSync(SKIP_FILE, "utf8")) : new Set();
  const range = git([
    "rev-list",
    "--reverse",
    "--no-merges",
    "--first-parent",
    `${cursor}..${upstream}`,
  ])
    .split("\n")
    .filter(Boolean);

  const picked = [];
  const conflicted = [];
  const filtered = {};
  let last = cursor;
  for (const sha of range) {
    if (picked.length >= max) break;
    last = sha;
    const commit = readCommit(sha);
    if (skipped(skip, sha)) {
      filtered.listed = (filtered.listed || 0) + 1;
      continue;
    }
    const verdict = classify(commit);
    if (!verdict.take) {
      filtered[verdict.reason] = (filtered[verdict.reason] || 0) + 1;
      continue;
    }
    try {
      git(["cherry-pick", "-x", "--empty=drop", sha]);
      picked.push(commit);
    } catch {
      try {
        git(["cherry-pick", "--abort"]);
      } catch {
        git(["reset", "--hard", "HEAD"]);
      }
      conflicted.push(commit);
    }
  }

  if (last !== cursor) {
    fs.writeFileSync(CURSOR_FILE, `${last}\n`);
    git(["add", CURSOR_FILE]);
    git(["commit", "-m", `chore(upstream): look at upstream fixes up to ${last.slice(0, 12)}`]);
  }

  const remaining = range.length - range.indexOf(last) - 1;
  const lines = [
    `Upstream fixes from \`${cursor.slice(0, 12)}\` to \`${last.slice(0, 12)}\`.`,
    "",
    `Picked ${picked.length}, did not apply ${conflicted.length}, left out ${Object.values(filtered).reduce((a, b) => a + b, 0)}.`,
  ];
  if (remaining > 0) lines.push("", `${remaining} upstream commits are left for the next run.`);
  if (picked.length) {
    lines.push("", "### Picked", "");
    for (const commit of picked) lines.push(`- ${commit.sha.slice(0, 12)} ${commit.subject}`);
  }
  if (conflicted.length) {
    lines.push("", "### Did not apply (pick by hand, or add to `.github/upstream-fixes/skip`)", "");
    for (const commit of conflicted) lines.push(`- ${commit.sha.slice(0, 12)} ${commit.subject}`);
  }
  if (Object.keys(filtered).length) {
    lines.push("", "### Left out", "");
    for (const [reason, count] of Object.entries(filtered)) lines.push(`- ${reason}: ${count}`);
  }
  const summary = lines.join("\n") + "\n";
  if (summaryFile) fs.writeFileSync(summaryFile, summary);
  process.stdout.write(summary);
  return { picked: picked.length, advanced: last !== cursor };
}

module.exports = { classify, readSkip, skipped };

if (require.main === module) {
  main(process.argv.slice(2));
}
