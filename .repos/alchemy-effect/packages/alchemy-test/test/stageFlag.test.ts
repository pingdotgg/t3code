import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const cli = resolve(import.meta.dirname, "../src/cli.ts");
const api = resolve(import.meta.dirname, "../src/index.ts");

const runWithStage = (stage: string) => {
  const root = mkdtempSync(join(tmpdir(), "alchemy-test-stage-flag-"));
  try {
    writeFileSync(
      join(root, "stage.test.ts"),
      `
      import { expect, test } from ${JSON.stringify(api)};
      test("sees the stage", () => {
        expect(process.env.ALCHEMY_TEST_STAGE).toBe(${JSON.stringify(stage)});
      });
    `,
    );
    const env = { ...process.env };
    delete env.ALCHEMY_TEST_STAGE;
    return spawnSync(process.execPath, [cli, "--stage", stage, "stage.test.ts"], {
      cwd: root,
      env,
      encoding: "utf8",
      timeout: 30_000,
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
};

test("--stage sets ALCHEMY_TEST_STAGE before test modules load", () => {
  const result = runWithStage("test_sam_feat-x");
  expect(result.stdout + result.stderr).toContain("1 passed");
  expect(result.status).toBe(0);
}, 40_000);

test("--stage rejects names a stage can't hold", () => {
  const result = runWithStage("feat/x");
  expect(result.status).not.toBe(0);
}, 40_000);

// Runs a test file that prints its stage from inside `root`, whose `.git`
// is `dotGit` (a file's contents, a directory, or absent).
const stageIn = (dotGit: string | "dir" | undefined, args: string[] = []) => {
  const root = mkdtempSync(join(tmpdir(), "alchemy-test-worktree-stage-"));
  try {
    if (dotGit === "dir") mkdirSync(join(root, ".git"));
    else if (dotGit !== undefined) writeFileSync(join(root, ".git"), dotGit);
    mkdirSync(join(root, "pkg"));
    writeFileSync(
      join(root, "pkg", "stage.test.ts"),
      `
      import { test } from ${JSON.stringify(api)};
      test("prints the stage", () => {
        console.log("STAGE=" + (process.env.ALCHEMY_TEST_STAGE ?? "<unset>"));
      });
    `,
    );
    const env: Record<string, string | undefined> = { ...process.env, USER: "sam" };
    delete env.ALCHEMY_TEST_STAGE;
    const result = spawnSync(process.execPath, [cli, ...args, "stage.test.ts"], {
      cwd: join(root, "pkg"),
      env,
      encoding: "utf8",
      timeout: 30_000,
    });
    const logs = readdirSync(join(root, "pkg", ".alchemy", "log", "test"));
    const log = logs
      .map((f) => readFileSync(join(root, "pkg", ".alchemy", "log", "test", f), "utf8"))
      .join("");
    return { status: result.status, stage: /STAGE=(\S+)/.exec(log)?.[1] };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
};

test("a linked worktree defaults to its own stage", () => {
  const result = stageIn("gitdir: /repo/.git/worktrees/Feat_Y.2\n");
  expect(result.status).toBe(0);
  expect(result.stage).toBe("test_sam_feat_y-2");
}, 40_000);

test("--stage overrides the worktree stage", () => {
  const result = stageIn("gitdir: /repo/.git/worktrees/feat-y\n", ["--stage", "test_custom"]);
  expect(result.stage).toBe("test_custom");
}, 40_000);

test("a main checkout keeps test_$USER", () => {
  expect(stageIn("dir").stage).toBe("<unset>");
}, 40_000);

test("a submodule checkout keeps test_$USER", () => {
  expect(stageIn("gitdir: ../.git/modules/distilled\n").stage).toBe("<unset>");
}, 40_000);
