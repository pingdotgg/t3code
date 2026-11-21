#!/usr/bin/env node
// Cuts a GitHub release of the board: gates, build, installer, SHA256SUMS, notes, release.
// Run it from a clean checkout of origin/main, or of a pushed branch for a test pre-release.
// Usage: node apps/board/scripts/release.mjs <version> [--prerelease]
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";

const { positionals, values } = NodeUtil.parseArgs({
  allowPositionals: true,
  options: { prerelease: { type: "boolean", default: false } },
});
const version = positionals[0];
if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version ?? "")) {
  console.error("Usage: node apps/board/scripts/release.mjs <version> [--prerelease]");
  process.exit(1);
}
const tag = `board-v${version}`;

const out = (command, args, cwd) =>
  NodeChildProcess.execFileSync(command, args, { cwd, encoding: "utf8" }).trim();
const run = (command, args, cwd) =>
  NodeChildProcess.execFileSync(command, args, { cwd, stdio: "inherit" });
const fail = (message) => {
  console.error(message);
  process.exit(1);
};

const root = out("git", ["rev-parse", "--show-toplevel"]);
const boardDir = NodePath.join(root, "apps", "board");
const releaseDir = NodePath.join(boardDir, "release");
const repository = out("git", ["remote", "get-url", "origin"]).match(
  /github\.com[:/](.+?)(?:\.git)?$/,
)?.[1];
if (!repository) fail("origin is not a GitHub remote");

if (out("git", ["ls-remote", "--tags", "origin", `refs/tags/${tag}`]) !== "") {
  fail(`The tag ${tag} already exists, so ${version} is already released.`);
}

run("git", ["fetch", "--no-tags", "origin", "main"], root);
const sha = out("git", ["rev-parse", "HEAD"], root);
if (out("git", ["status", "--porcelain"], root) !== "")
  fail("The checkout has uncommitted changes.");
if (!values.prerelease && sha !== out("git", ["rev-parse", "origin/main"], root)) {
  fail("A release comes from origin/main. Check it out, or pass --prerelease for a test release.");
}
if (out("git", ["branch", "-r", "--contains", sha], root) === "") {
  fail(`${sha} is not pushed, and the release is created on GitHub's copy of it.`);
}

try {
  out("git", ["remote", "get-url", "upstream"], root);
} catch {
  run("git", ["remote", "add", "upstream", "https://github.com/pingdotgg/t3code.git"], root);
}
run("git", ["fetch", "--no-tags", "--filter=blob:none", "upstream", "main"], root);

// The same gates as the agent-board job.
run("node", ["apps/board/scripts/check-engine-untouched.mjs"], root);
run("node", ["standards/check-added-diagnostics.mjs"], root);
run("vp", ["run", "--filter", "@agent-board/app", "standards:deps"], root);
run(
  "node",
  [
    "--test",
    "apps/board/scripts/*.test.mjs",
    "apps/board/plugins/**/*.test.mjs",
    "standards/**/*.test.mjs",
  ],
  root,
);
run("vp", ["run", "--filter", "@agent-board/app", "typecheck"], root);
run("vp", ["test", "run"], boardDir);

run("vp", ["run", "--filter", "@agent-board/app", "build"], root);
NodeFS.rmSync(releaseDir, { recursive: true, force: true });
run("pnpm", ["run", "package", `-c.extraMetadata.version=${version}`], boardDir);

const assets = [`Agent-Board-Setup-${version}.exe`];
NodeFS.writeFileSync(
  NodePath.join(releaseDir, "SHA256SUMS"),
  assets
    .map((name) => {
      const hash = NodeCrypto.createHash("sha256");
      hash.update(NodeFS.readFileSync(NodePath.join(releaseDir, name)));
      return `${hash.digest("hex")}  ${name}\n`;
    })
    .join(""),
);

const notes = NodePath.join(releaseDir, "release-notes.md");
run(
  "node",
  [
    "apps/board/scripts/release-notes.mjs",
    "--repository",
    repository,
    "--tag",
    tag,
    "--ref",
    sha,
    "--output",
    notes,
  ],
  root,
);

run(
  "gh",
  [
    "release",
    "create",
    tag,
    "--repo",
    repository,
    "--target",
    sha,
    "--title",
    `Agent Board ${version}`,
    "--notes-file",
    notes,
    ...(values.prerelease ? ["--prerelease"] : []),
    ...[...assets, "SHA256SUMS"].map((name) => NodePath.join(releaseDir, name)),
  ],
  root,
);
