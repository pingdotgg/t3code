import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { checkpointRefForThreadTurn, FilesystemCheckpointStore } from "./filesystemCheckpointStore";
import { runProcess } from "./processRunner";

async function runGit(cwd: string, args: readonly string[]): Promise<string> {
  const result = await runProcess("git", args, {
    cwd,
    allowNonZeroExit: true,
  });
  if (result.code !== 0) {
    throw new Error(result.stderr.trim() || `git ${args.join(" ")} failed`);
  }
  return result.stdout.trim();
}

function exists(filePath: string): boolean {
  return fs.existsSync(filePath);
}

async function createRepo(): Promise<string> {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "t3-fs-checkpoints-test-"));
  await runGit(cwd, ["init", "--initial-branch=main"]);
  await runGit(cwd, ["config", "user.email", "test@example.com"]);
  await runGit(cwd, ["config", "user.name", "Test User"]);
  await writeFile(path.join(cwd, "README.md"), "v1\n");
  await writeFile(path.join(cwd, "tracked.txt"), "tracked-v1\n");
  await runGit(cwd, ["add", "."]);
  await runGit(cwd, ["commit", "-m", "Initial"]);
  return cwd;
}

describe("FilesystemCheckpointStore", () => {
  it("captures refs without mutating branch history and restores workspace state", async () => {
    const cwd = await createRepo();
    const store = new FilesystemCheckpointStore();
    const threadId = "thr_1";

    try {
      const headBefore = await runGit(cwd, ["rev-parse", "HEAD"]);

      await store.captureCheckpoint({ cwd, threadId, turnCount: 0 });
      const rootRef = checkpointRefForThreadTurn(threadId, 0);
      const rootCommit = await runGit(cwd, ["rev-parse", "--verify", `${rootRef}^{commit}`]);
      expect(rootCommit.length).toBeGreaterThan(0);
      expect(await runGit(cwd, ["rev-parse", "HEAD"])).toBe(headBefore);

      await writeFile(path.join(cwd, "README.md"), "v2\n");
      await rm(path.join(cwd, "tracked.txt"));
      await writeFile(path.join(cwd, "notes.md"), "notes\n");
      await store.captureCheckpoint({ cwd, threadId, turnCount: 1 });

      await writeFile(path.join(cwd, "README.md"), "v3\n");
      await writeFile(path.join(cwd, "scratch.txt"), "scratch\n");
      await writeFile(path.join(cwd, "tracked.txt"), "tracked-new\n");

      const restoredRoot = await store.restoreCheckpoint({ cwd, threadId, turnCount: 0 });
      expect(restoredRoot).toBe(true);
      expect(await readFile(path.join(cwd, "README.md"), "utf8")).toBe("v1\n");
      expect(await readFile(path.join(cwd, "tracked.txt"), "utf8")).toBe("tracked-v1\n");
      expect(exists(path.join(cwd, "notes.md"))).toBe(false);
      expect(exists(path.join(cwd, "scratch.txt"))).toBe(false);

      const restoredTurn1 = await store.restoreCheckpoint({ cwd, threadId, turnCount: 1 });
      expect(restoredTurn1).toBe(true);
      expect(await readFile(path.join(cwd, "README.md"), "utf8")).toBe("v2\n");
      expect(exists(path.join(cwd, "tracked.txt"))).toBe(false);
      expect(await readFile(path.join(cwd, "notes.md"), "utf8")).toBe("notes\n");
      expect(exists(path.join(cwd, "scratch.txt"))).toBe(false);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("returns false when restoring a missing checkpoint", async () => {
    const cwd = await createRepo();
    const store = new FilesystemCheckpointStore();

    try {
      const restored = await store.restoreCheckpoint({
        cwd,
        threadId: "thr_2",
        turnCount: 999,
      });
      expect(restored).toBe(false);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("falls back to HEAD when restoring turn 0 and root checkpoint ref is missing", async () => {
    const cwd = await createRepo();
    const store = new FilesystemCheckpointStore();
    const threadId = "thr_2b";

    try {
      await writeFile(path.join(cwd, "README.md"), "v2\n");
      await store.captureCheckpoint({ cwd, threadId, turnCount: 1 });

      await writeFile(path.join(cwd, "README.md"), "v3\n");
      await writeFile(path.join(cwd, "scratch.txt"), "scratch\n");

      const restored = await store.restoreCheckpoint({
        cwd,
        threadId,
        turnCount: 0,
      });

      expect(restored).toBe(true);
      expect(await readFile(path.join(cwd, "README.md"), "utf8")).toBe("v1\n");
      expect(exists(path.join(cwd, "scratch.txt"))).toBe(false);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("prunes refs newer than the retained turn", async () => {
    const cwd = await createRepo();
    const store = new FilesystemCheckpointStore();
    const threadId = "thr_3";

    try {
      await store.captureCheckpoint({ cwd, threadId, turnCount: 0 });
      await writeFile(path.join(cwd, "README.md"), "turn1\n");
      await store.captureCheckpoint({ cwd, threadId, turnCount: 1 });
      await writeFile(path.join(cwd, "README.md"), "turn2\n");
      await store.captureCheckpoint({ cwd, threadId, turnCount: 2 });

      await store.pruneAfterTurn({
        cwd,
        threadId,
        maxTurnCount: 1,
      });

      expect(await store.hasCheckpoint({ cwd, threadId, turnCount: 0 })).toBe(true);
      expect(await store.hasCheckpoint({ cwd, threadId, turnCount: 1 })).toBe(true);
      expect(await store.hasCheckpoint({ cwd, threadId, turnCount: 2 })).toBe(false);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("returns a unified patch between checkpoint turns", async () => {
    const cwd = await createRepo();
    const store = new FilesystemCheckpointStore();
    const threadId = "thr_4";

    try {
      await store.captureCheckpoint({ cwd, threadId, turnCount: 0 });
      await writeFile(path.join(cwd, "README.md"), "v2\n");
      await writeFile(path.join(cwd, "new.txt"), "new file\n");
      await store.captureCheckpoint({ cwd, threadId, turnCount: 1 });

      const diff = await store.diffCheckpoints({
        cwd,
        threadId,
        fromTurnCount: 0,
        toTurnCount: 1,
      });

      expect(diff).toContain("diff --git a/README.md b/README.md");
      expect(diff).toContain("diff --git a/new.txt b/new.txt");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("falls back to HEAD as diff base when turn 0 checkpoint is missing", async () => {
    const cwd = await createRepo();
    const store = new FilesystemCheckpointStore();
    const threadId = "thr_5";

    try {
      await writeFile(path.join(cwd, "README.md"), "v2\n");
      await writeFile(path.join(cwd, "new.txt"), "new file\n");
      await store.captureCheckpoint({ cwd, threadId, turnCount: 1 });

      const diff = await store.diffCheckpoints({
        cwd,
        threadId,
        fromTurnCount: 0,
        toTurnCount: 1,
      });

      expect(diff).toContain("diff --git a/README.md b/README.md");
      expect(diff).toContain("diff --git a/new.txt b/new.txt");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("detects non-repo folders", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "t3-fs-checkpoints-nonrepo-"));
    const store = new FilesystemCheckpointStore();

    try {
      expect(await store.isGitRepository(cwd)).toBe(false);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
