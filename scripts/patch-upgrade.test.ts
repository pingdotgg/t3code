// @effect-diagnostics nodeBuiltinImport:off - Tests create throwaway Git repositories directly.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assert, describe, it } from "@effect/vitest";

import { runPatchUpgrade } from "./patch-upgrade.ts";

function normalizeNewlines(input: string): string {
  return input.replace(/\r\n/g, "\n");
}

function git(repoRoot: string, ...args: ReadonlyArray<string>): string {
  return execFileSync("git", ["-C", repoRoot, ...args], {
    encoding: "utf-8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "Test",
      GIT_COMMITTER_EMAIL: "test@example.com",
    },
  }).trim();
}

async function makeRepoPair(prefix: string) {
  const baseDir = await mkdtemp(join(tmpdir(), prefix));
  const upstream = join(baseDir, "upstream");
  const fork = join(baseDir, "fork");

  await mkdir(upstream);
  git(upstream, "init", "-b", "main");
  await writeFile(join(upstream, "app.txt"), "one\n");
  git(upstream, "add", "app.txt");
  git(upstream, "commit", "-m", "upstream: initial");

  execFileSync("git", ["clone", upstream, fork], { encoding: "utf-8" });
  git(fork, "branch", "--set-upstream-to=origin/main", "main");

  return { baseDir, upstream, fork };
}

describe("patch-upgrade", () => {
  it("reports current when there are no upstream commits", async () => {
    const { fork } = await makeRepoPair("t3code-patch-current-");

    const result = runPatchUpgrade(fork, { id: "current-test" });

    assert.equal(result.status, "current");
    assert.equal(result.pulled, 0);
  });

  it("refuses to run with uncommitted work", async () => {
    const { upstream, fork } = await makeRepoPair("t3code-patch-dirty-");
    await writeFile(join(upstream, "app.txt"), "two\n");
    git(upstream, "commit", "-am", "upstream: update");
    await writeFile(join(fork, "local.txt"), "dirty\n");

    const result = runPatchUpgrade(fork, { id: "dirty-test" });

    assert.equal(result.status, "dirty");
    assert.match(result.error ?? "", /uncommitted changes/);
  });

  it("rebases clean local commits and creates a rollback branch", async () => {
    const { upstream, fork } = await makeRepoPair("t3code-patch-clean-");
    await writeFile(join(fork, "local.txt"), "local\n");
    git(fork, "add", "local.txt");
    git(fork, "commit", "-m", "patch: add local file");

    await writeFile(join(upstream, "app.txt"), "two\n");
    git(upstream, "commit", "-am", "upstream: update");

    const result = runPatchUpgrade(fork, { id: "clean-test" });

    assert.equal(result.status, "upgraded");
    assert.equal(result.pulled, 1);
    assert.equal(result.replayed, 1);
    assert.equal(
      git(fork, "rev-parse", "--verify", "backup/pre-patch-upgrade-clean-test").length > 0,
      true,
    );
    assert.equal(normalizeNewlines(await readFile(join(fork, "local.txt"), "utf-8")), "local\n");
  });

  it("keeps upstream on conflict, backs up patched bytes, and writes a manifest", async () => {
    const { upstream, fork, baseDir } = await makeRepoPair("t3code-patch-conflict-");
    await writeFile(join(fork, "app.txt"), "local patch\n");
    git(fork, "commit", "-am", "patch: local app text");

    await writeFile(join(upstream, "app.txt"), "upstream text\n");
    git(upstream, "commit", "-am", "upstream: app text");

    const backupBase = join(baseDir, "backups");
    const result = runPatchUpgrade(fork, { id: "conflict-test", backupBase });

    assert.equal(result.status, "upgraded_with_conflicts");
    assert.equal(
      normalizeNewlines(await readFile(join(fork, "app.txt"), "utf-8")),
      "upstream text\n",
    );
    assert.equal(
      normalizeNewlines(readFileSync(join(backupBase, "conflict-test", "app.txt"), "utf-8")),
      "local patch\n",
    );
    assert.equal(existsSync(join(backupBase, "conflict-test", "manifest.json")), true);
    assert.equal(result.conflicts?.[0]?.file, "app.txt");
  });
});
