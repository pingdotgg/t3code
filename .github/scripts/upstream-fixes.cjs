// Cherry-picks upstream's non-breaking fix and perf commits after the cursor, takes back out
// any that would undo this fork, reports the rest, and advances the cursor.
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

// Files only this fork writes: its privacy promise, its telemetry no-ops and its branding.
const PROTECTED_FILES = new Set([
  "PRIVACY.md",
  "NOTICE",
  "LICENSE",
  "apps/server/src/cloud/publicConfig.ts",
  "apps/web/src/cloud/publicConfig.ts",
  "apps/server/src/telemetry/AnalyticsService.ts",
  "apps/server/src/telemetry/Identify.ts",
  "packages/shared/src/relayTracing.ts",
  "apps/mobile/src/features/observability/observe.ts",
  "apps/web/src/branding.ts",
  "apps/web/src/legalLinks.ts",
  "apps/server/src/auth/ServerSecretStore.ts",
  "apps/server/src/auth/VaultCipher.ts",
  "packages/contracts/src/localVault.ts",
  "packages/contracts/src/secretRequest.ts",
  "packages/client-runtime/src/secretRequest.ts",
  "apps/web/src/components/settings/LocalVaultSettings.tsx",
  "apps/web/src/components/settings/GmailVaultDialog.tsx",
  "apps/web/src/components/settings/GmailVaultRoute.ts",
  "apps/web/src/components/settings/privateVaultRoute.ts",
  "apps/web/src/components/chat/PrivateReadRequestCard.tsx",
  "apps/web/src/components/chat/SecretRequestCard.tsx",
  "apps/web/src/components/chat/composerVaultMentions.ts",
  "apps/web/src/components/chat/useVaultApprovalToast.ts",
]);
const PROTECTED_PREFIXES = [
  "assets/",
  "apps/desktop/resources/startup/",
  "apps/server/src/secrets/",
  "apps/web/src/components/settings/Vault",
  "apps/web/src/components/chat/Vault",
];

// Text a fix must not add: upstream's name and hosts, and analytics or tracing services.
const FORBIDDEN = [
  { pattern: /\bT3 Code\b/, reason: "upstream's product name", outsideTests: true },
  { pattern: /t3\.codes|t3tools\.com|t3coderelay\.com/i, reason: "an upstream host" },
  {
    pattern: /api\.axiom\.co|posthog|sentry\.io|segment\.io|mixpanel/i,
    reason: "a telemetry service",
  },
  { pattern: /pingdotgg\/t3code/, reason: "upstream's repository", outsideTests: true },
];

const TEST_FILE = /(^|\/)(test|tests|__tests__|fixtures?)\/|\.test\.[cm]?[jt]sx?$/;

/** Why a picked change would undo this fork, or "" when it is fine. */
function guard(files, addedLines) {
  for (const file of files) {
    if (PROTECTED_FILES.has(file) || PROTECTED_PREFIXES.some((prefix) => file.startsWith(prefix))) {
      return `changes ${file}, which only this fork writes`;
    }
  }
  for (const { file, line } of addedLines) {
    if (
      (file === "package.json" || file.endsWith("/package.json")) &&
      /^\s*"version"\s*:/.test(line)
    ) {
      return `changes package version in ${file}, which only this fork sets`;
    }
    for (const rule of FORBIDDEN) {
      if (rule.outsideTests && TEST_FILE.test(file)) continue;
      if (rule.pattern.test(line)) return `adds ${rule.reason} to ${file}`;
    }
  }
  return "";
}

/** Lines a commit adds, with the file each lands in, from `git show -U0` output. */
function addedLines(patch) {
  const lines = [];
  let file = "";
  for (const line of patch.split("\n")) {
    if (line.startsWith("+++ ")) file = line.replace(/^\+\+\+ (b\/)?/, "");
    else if (line.startsWith("+") && file && file !== "/dev/null")
      lines.push({ file, line: line.slice(1) });
  }
  return lines;
}

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

const MAX_PICKS = 12;
const MAX_SCANNED = 120;

function batchSize(value) {
  if (!/^(?:[1-9]|1[0-2])$/.test(value)) {
    throw new Error(`--max must be an integer from 1 to ${MAX_PICKS}`);
  }
  return Number(value);
}

function main(argv) {
  const upstream = argv[0];
  if (!upstream)
    throw new Error("usage: upstream-fixes.cjs <upstream-ref> [--max N] [--summary FILE]");
  const option = (name, fallback) => {
    const at = argv.indexOf(name);
    return at >= 0 && argv[at + 1] ? argv[at + 1] : fallback;
  };
  const max = batchSize(option("--max", String(MAX_PICKS)));
  const summaryFile = option("--summary", "");
  if (git(["status", "--porcelain", "--untracked-files=normal"])) {
    throw new Error("Upstream fixes require a clean worktree; commit or stash local work first.");
  }
  const cursor = fs.readFileSync(CURSOR_FILE, "utf8").trim();
  try {
    git(["merge-base", "--is-ancestor", cursor, upstream]);
  } catch (cause) {
    throw new Error(
      `The upstream cursor must be an ancestor of ${upstream}. Check the fetched ref.`,
      {
        cause,
      },
    );
  }
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
  const guarded = [];
  const filtered = {};
  let last = cursor;
  for (const sha of range.slice(0, MAX_SCANNED)) {
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
    const before = git(["rev-parse", "HEAD"]);
    try {
      git(["cherry-pick", "-x", "--empty=drop", sha]);
    } catch (cause) {
      if (!git(["diff", "--name-only", "--diff-filter=U"])) {
        throw new Error(`Could not cherry-pick ${sha}; the upstream cursor has not advanced.`, {
          cause,
        });
      }
      git(["cherry-pick", "--abort"]);
      conflicted.push(commit);
      continue;
    }
    if (git(["rev-parse", "HEAD"]) === before) continue;
    const files = git(["diff", "--name-only", before, "HEAD"]).split("\n").filter(Boolean);
    const why = guard(files, addedLines(git(["diff", "-U0", before, "HEAD"])));
    if (why) {
      git(["reset", "--hard", before]);
      guarded.push({ ...commit, why });
      continue;
    }
    picked.push(commit);
  }

  if (last !== cursor) fs.writeFileSync(CURSOR_FILE, `${last}\n`);
  git(["add", CURSOR_FILE, ...(fs.existsSync(SKIP_FILE) ? [SKIP_FILE] : [])]);
  if (git(["diff", "--cached", "--name-only"])) {
    git(["commit", "-m", `chore(upstream): look at upstream fixes up to ${last.slice(0, 12)}`]);
  }

  const remaining = range.length - range.indexOf(last) - 1;
  const lines = [
    `Upstream fixes from \`${cursor.slice(0, 12)}\` to \`${last.slice(0, 12)}\`.`,
    "",
    `Picked ${picked.length}, did not apply ${conflicted.length}, held back ${guarded.length}, left out ${Object.values(filtered).reduce((a, b) => a + b, 0)}.`,
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
  if (guarded.length) {
    lines.push("", "### Held back (would undo this fork)", "");
    for (const commit of guarded)
      lines.push(`- ${commit.sha.slice(0, 12)} ${commit.subject}: ${commit.why}`);
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

module.exports = { addedLines, batchSize, classify, guard, readSkip, skipped };

if (require.main === module) {
  main(process.argv.slice(2));
}
