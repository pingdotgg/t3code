import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeTest from "node:test";
import * as NodeURL from "node:url";

const SCRIPT = NodePath.join(
  NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
  "check-engine-untouched.mjs",
);
const ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };

let repo;

const git = (...args) => {
  const result = NodeChildProcess.spawnSync(
    "git",
    ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args],
    { cwd: repo, env: ENV, encoding: "utf8" },
  );
  NodeAssert.equal(result.status, 0, result.stderr);
};
const write = (path, text) => {
  NodeFS.mkdirSync(NodePath.dirname(NodePath.join(repo, path)), { recursive: true });
  NodeFS.writeFileSync(NodePath.join(repo, path), text);
};
const commit = () => {
  git("add", "-A");
  git("commit", "-q", "-m", "change");
};
const check = () =>
  NodeChildProcess.spawnSync(process.execPath, [SCRIPT], { cwd: repo, env: ENV, encoding: "utf8" });

NodeTest.beforeEach(() => {
  repo = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "board-boundary-"));
  git("init", "-q", "-b", "main");
  write("apps/server/src/x.ts", "export {};\n");
  write("apps/desktop/README.md", "desktop\n");
  commit();
  git("remote", "add", "upstream", "https://example.invalid/t3code.git");
  git("update-ref", "refs/remotes/upstream/main", "HEAD");
});

NodeTest.afterEach(() => NodeFS.rmSync(repo, { recursive: true, force: true }));

NodeTest.test(
  "Given a branch that changes only apps/board, When the check runs, Then it exits 0",
  () => {
    write("apps/board/src/probe.ts", "export {};\n");
    commit();
    const result = check();
    NodeAssert.equal(result.status, 0);
    NodeAssert.equal(result.stdout, "engine untouched: 0 paths outside apps/board\n");
  },
);

NodeTest.test(
  "Given a branch that edits an engine file, When the check runs, Then it exits 1 and names the file",
  () => {
    write("apps/server/src/x.ts", "export const x = 1;\n");
    commit();
    const result = check();
    NodeAssert.equal(result.status, 1);
    NodeAssert.equal(
      result.stdout,
      "engine touched: 1 paths outside apps/board\n  apps/server/src/x.ts\n",
    );
  },
);

NodeTest.test(
  "Given an engine file moved into apps/board, When the check runs, Then it exits 1 and names the old path",
  () => {
    NodeFS.mkdirSync(NodePath.join(repo, "apps/board"), { recursive: true });
    NodeFS.renameSync(
      NodePath.join(repo, "apps/desktop/README.md"),
      NodePath.join(repo, "apps/board/README.md"),
    );
    commit();
    const result = check();
    NodeAssert.equal(result.status, 1);
    NodeAssert.match(result.stdout, /^ {2}apps\/desktop\/README\.md$/m);
  },
);

NodeTest.test(
  "Given no upstream remote, When the check runs, Then it exits 2 with the command to add it",
  () => {
    git("remote", "remove", "upstream");
    const result = check();
    NodeAssert.equal(result.status, 2);
    NodeAssert.match(result.stderr, /^add the upstream remote/);
  },
);
