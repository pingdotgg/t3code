#!/usr/bin/env node
// Fails when this branch changes anything outside the board app and its repo standards, so upstream T3 merges stay conflict-free.
import * as NodeChildProcess from "node:child_process";

const ALLOWED = [
  "apps/board/",
  "standards/",
  ".vite-hooks/pre-push",
  ".claude/settings.json",
  ".github/workflows/agent-board.yml",
  "pnpm-lock.yaml",
];
const UPSTREAM_URL = "https://github.com/pingdotgg/t3code.git";

const git = (args, cwd) =>
  NodeChildProcess.execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();

const root = git(["rev-parse", "--show-toplevel"]);

let base;
try {
  git(["remote", "get-url", "upstream"], root);
  base = git(["merge-base", "upstream/main", "HEAD"], root);
} catch {
  console.error(
    `add the upstream remote: git remote add upstream ${UPSTREAM_URL} && git fetch upstream main`,
  );
  process.exit(2);
}

// --no-renames lists both sides of a move, so moving an engine file into apps/board still fails.
const changed = git(["diff", "--name-only", "--no-renames", base, "HEAD"], root)
  .split("\n")
  .filter(Boolean);
const outside = changed.filter(
  (path) =>
    !ALLOWED.some((allowed) =>
      allowed.endsWith("/") ? path.startsWith(allowed) : path === allowed,
    ),
);

if (outside.length === 0) {
  console.log("engine untouched: 0 paths outside apps/board");
  process.exit(0);
}
console.log(`engine touched: ${outside.length} paths outside apps/board`);
for (const path of outside) console.log(`  ${path}`);
process.exit(1);
