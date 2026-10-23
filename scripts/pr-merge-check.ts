// @effect-diagnostics nodeBuiltinImport:off globalConsole:off
// Checks that pull requests still pass together on current main, right before
// they merge. Main takes hundreds of merges a day, so the ruleset cannot require
// branches to be up to date, and GitHub reports CLEAN for a PR that is far
// behind. A PR's green CI can be days old. Most breaks on main were two changes
// that each passed alone: a renamed type, a removed dependency, a new request
// an older test did not stub.
//
//   vp run pr-merge-check <pr> [<pr>...]
//
// Merges GitHub's main and each PR head, in order, in a temporary worktree
// next to this checkout, then runs check:changed against that main. PR numbers
// are GitHub's: with `origin` on the GitCafe mirror, fetches use the `github`
// remote. Pass every PR of a batch in one run. Exit 0 prints the merge commands,
// pinned to the tested heads. Run them now, in order: each new commit on main
// makes the result older.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

const root = NodePath.resolve(import.meta.dirname, "..");
const prs = process.argv.slice(2);
if (prs.length === 0 || prs.some((pr) => !/^\d+$/.test(pr))) {
  console.error("usage: vp run pr-merge-check <pr> [<pr>...]");
  process.exit(1);
}

// `vp run` puts this checkout's node_modules/.bin first on PATH. Left there,
// the merged worktree would run this checkout's Vitest against its own test
// files, and two Vitest copies fail every suite.
const env = {
  ...process.env,
  PATH: (process.env.PATH ?? "")
    .split(NodePath.delimiter)
    .filter((entry) => !entry.startsWith(`${root}${NodePath.sep}`))
    .join(NodePath.delimiter),
};

const run = (command: string, args: ReadonlyArray<string>, cwd: string) =>
  NodeChildProcess.spawnSync(command, args, { cwd, env, stdio: "inherit" }).status === 0;

const git = (cwd: string, ...args: Array<string>) =>
  NodeChildProcess.execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

const hasGitHubRemote =
  NodeChildProcess.spawnSync("git", ["remote", "get-url", "github"], { cwd: root }).status === 0;
const remote = hasGitHubRemote ? "github" : "origin";
// Signing can prompt or fail, which would read as a conflict.
const merge = ["-c", "commit.gpgsign=false", "merge", "--quiet", "--no-ff"];

// The worktree has its own FETCH_HEAD, so a fetch in this checkout or in
// another run cannot swap the commit under test.
const dir = NodePath.resolve(root, "..", `${NodePath.basename(root)}-merge-check-${process.pid}`);
git(root, "worktree", "add", "--quiet", "--detach", "--no-checkout", dir);
// A terminal signal reaches the running child too. Staying alive lets
// `finally` remove the worktree. SIGKILL still leaves it behind.
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(signal, () => {});

const fetchHead = (ref: string) => {
  git(dir, "fetch", "--quiet", remote, ref);
  return git(dir, "rev-parse", "FETCH_HEAD");
};

const heads: Array<{ pr: string; sha: string }> = [];
let ok = false;
try {
  const base = fetchHead("refs/heads/main");
  git(dir, "checkout", "--quiet", "--detach", base);
  const conflict = prs.find((pr) => {
    const sha = fetchHead(`pull/${pr}/head`);
    heads.push({ pr, sha });
    return !run("git", [...merge, "-m", `merge-check #${pr}`, sha], dir);
  });
  if (conflict) {
    console.error(`\npr-merge-check: #${conflict} does not merge cleanly onto main.`);
  } else {
    // A lockfile that two PRs edited can merge as text and still not match
    // the manifests. The frozen install fails on that.
    ok =
      run("vp", ["i", "--frozen-lockfile", "--", "--yes"], dir) &&
      run("node", ["scripts/check-changed.ts", base], dir);
  }
} finally {
  git(root, "worktree", "remove", "--force", dir);
  NodeFS.rmSync(dir, { recursive: true, force: true });
}

const list = prs.map((pr) => `#${pr}`).join(" ");
if (!ok) {
  console.log(`\npr-merge-check: ${list} fail on main. Do not merge.`);
  process.exit(1);
}
console.log(`\npr-merge-check: ${list} pass on main. Merge them now, in this order:`);
for (const { pr, sha } of heads)
  console.log(`  gh pr merge ${pr} --squash --match-head-commit ${sha}`);
