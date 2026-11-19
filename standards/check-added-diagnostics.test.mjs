import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeTest from "node:test";

const SCRIPT = NodePath.join(import.meta.dirname, "check-added-diagnostics.mjs");
const ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
const LEGACY = "apps/server/src/legacy.ts";
const LEGACY_SOURCE = "export function legacy(value: unknown): void {\n  void value;\n}\n";
const VIOLATION = "export function added(other: unknown): void {\n  void other;\n}\n";

let repo;

const git = (...args) => {
  const result = NodeChildProcess.spawnSync(
    "git",
    ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args],
    { cwd: repo, env: ENV, encoding: "utf8" },
  );
  NodeAssert.equal(result.status, 0, result.stderr);
};
const read = (path) => NodeFS.readFileSync(NodePath.join(repo, path), "utf8");
const write = (path, text) => {
  NodeFS.mkdirSync(NodePath.dirname(NodePath.join(repo, path)), { recursive: true });
  NodeFS.writeFileSync(NodePath.join(repo, path), text);
};
const commit = () => {
  git("add", "-A");
  git("commit", "-q", "-m", "change");
};
const check = (...args) =>
  NodeChildProcess.spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: repo,
    env: ENV,
    encoding: "utf8",
  });

NodeTest.beforeEach(() => {
  repo = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "standards-check-"));
  git("init", "-q", "-b", "main");
  write(LEGACY, LEGACY_SOURCE);
  commit();
  git("remote", "add", "upstream", "https://example.invalid/t3code.git");
  git("update-ref", "refs/remotes/upstream/main", "HEAD");
});

NodeTest.afterEach(() => NodeFS.rmSync(repo, { recursive: true, force: true }));

NodeTest.test(
  "Given an upstream violation, When a clean line is added beside it, Then the check exits 0",
  () => {
    write(LEGACY, `${LEGACY_SOURCE}export const answer = 1;\n`);
    commit();
    const result = check();
    NodeAssert.equal(result.status, 0, result.stdout + result.stderr);
  },
);

NodeTest.test(
  "Given an upstream violation, When a second violation is added, Then the check exits 1 and prints only the new line",
  () => {
    write(LEGACY, LEGACY_SOURCE + VIOLATION);
    commit();
    const result = check();
    NodeAssert.equal(result.status, 1);
    NodeAssert.match(
      result.stdout,
      /^apps\/server\/src\/legacy\.ts:4:\d+ anti-slop\(no-unknown-parameters\)/m,
    );
    NodeAssert.doesNotMatch(result.stdout, /legacy\.ts:1:/);
    NodeAssert.equal(result.stdout.match(/no-unknown-parameters/g).length, 1);
  },
);

NodeTest.test(
  "Given an uncommitted new file with a violation, When the check runs, Then it exits 1",
  () => {
    write("apps/server/src/fresh.ts", VIOLATION);
    const result = check();
    NodeAssert.equal(result.status, 1);
    NodeAssert.match(
      result.stdout,
      /^apps\/server\/src\/fresh\.ts:1:\d+ anti-slop\(no-unknown-parameters\)/m,
    );
  },
);

NodeTest.test(
  "Given a violation in two changed files, When the check is limited with --files, Then it reports only the listed file",
  () => {
    write("apps/server/src/one.ts", VIOLATION);
    write("apps/server/src/two.ts", VIOLATION);
    const result = check("--files", "apps/server/src/one.ts");
    NodeAssert.equal(result.status, 1);
    NodeAssert.match(result.stdout, /apps\/server\/src\/one\.ts/);
    NodeAssert.doesNotMatch(result.stdout, /two\.ts/);
  },
);

NodeTest.test(
  "Given a renderer file importing the Electron main process, When the check runs, Then it exits 1 and names renderer-not-main",
  () => {
    write("apps/board/electron/main.ts", "export const main = 1;\n");
    write(
      "apps/board/src/main.tsx",
      'import { main } from "../electron/main";\n\nexport const value = main;\n',
    );
    const result = check();
    NodeAssert.equal(result.status, 1);
    NodeAssert.match(result.stdout, /^apps\/board\/src\/main\.tsx:1:\d+ renderer-not-main/m);
  },
);

NodeTest.test(
  "Given a board file importing another app, When the check runs, Then it exits 1 and names no-cross-app-imports",
  () => {
    write(
      "apps/board/src/main.tsx",
      'import { legacy } from "../../server/src/legacy";\n\nexport const value = legacy;\n',
    );
    const result = check();
    NodeAssert.equal(result.status, 1);
    NodeAssert.match(result.stdout, /^apps\/board\/src\/main\.tsx:1:\d+ no-cross-app-imports/m);
  },
);

NodeTest.test(
  "Given a dependency violation, When the check runs with --lint-only, Then the dependency step is skipped",
  () => {
    write(
      "apps/board/src/main.tsx",
      'import { legacy } from "../../server/src/legacy";\n\nexport const value = legacy;\n',
    );
    const result = check("--lint-only");
    NodeAssert.equal(result.status, 0, result.stdout + result.stderr);
  },
);

NodeTest.test(
  "Given no source changes, When the check runs, Then it exits 0 without linting",
  () => {
    NodeAssert.equal(read(LEGACY), LEGACY_SOURCE);
    const result = check();
    NodeAssert.equal(result.status, 0);
    NodeAssert.match(result.stdout, /no added source lines/);
  },
);

NodeTest.test(
  "Given no upstream remote ref, When the check runs, Then it exits 2 with the command to add it",
  () => {
    git("update-ref", "-d", "refs/remotes/upstream/main");
    const result = check();
    NodeAssert.equal(result.status, 2);
    NodeAssert.match(result.stderr, /^add the upstream remote/);
  },
);
