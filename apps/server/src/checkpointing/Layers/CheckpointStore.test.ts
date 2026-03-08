import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { ThreadId } from "@t3tools/contracts";
import { Effect, Layer, ManagedRuntime } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import { parseTurnDiffFilesFromUnifiedDiff } from "../Diffs.ts";
import { checkpointRefForThreadTurn } from "../Utils.ts";
import { CheckpointStore } from "../Services/CheckpointStore.ts";
import { CheckpointStoreLive } from "./CheckpointStore.ts";

function runGit(cwd: string, args: ReadonlyArray<string>) {
  return execFileSync("git", args, {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
  });
}

function createRepository(prefix: string) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  runGit(cwd, ["init", "--initial-branch=main"]);
  runGit(cwd, ["config", "user.email", "test@example.com"]);
  runGit(cwd, ["config", "user.name", "Test User"]);
  return cwd;
}

function commitFile(cwd: string, relativePath: string, content: string, message: string) {
  fs.mkdirSync(path.dirname(path.join(cwd, relativePath)), { recursive: true });
  fs.writeFileSync(path.join(cwd, relativePath), content, "utf8");
  runGit(cwd, ["add", relativePath]);
  runGit(cwd, ["commit", "-m", message]);
  return runGit(cwd, ["rev-parse", "HEAD"]).trim();
}

function checkoutSubmoduleCommit(cwd: string, relativePath: string, commitOid: string) {
  runGit(path.join(cwd, relativePath), ["checkout", commitOid]);
}

describe("CheckpointStore", () => {
  let runtime: ManagedRuntime.ManagedRuntime<CheckpointStore, unknown> | null = null;
  const tempDirs: string[] = [];

  afterEach(async () => {
    if (runtime) {
      await runtime.dispose();
    }
    runtime = null;

    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  it("includes inline submodule diffs between checkpoints", async () => {
    const submoduleRepo = createRepository("t3-checkpoint-submodule-");
    const superRepo = createRepository("t3-checkpoint-super-");
    tempDirs.push(submoduleRepo, superRepo);

    const initialSubmoduleCommit = commitFile(
      submoduleRepo,
      "file.txt",
      "one\n",
      "Initial submodule commit",
    );
    const updatedSubmoduleCommit = commitFile(
      submoduleRepo,
      "file.txt",
      "one\ntwo\n",
      "Update submodule file",
    );

    runGit(superRepo, [
      "-c",
      "protocol.file.allow=always",
      "submodule",
      "add",
      submoduleRepo,
      "packages/submodule",
    ]);
    checkoutSubmoduleCommit(superRepo, "packages/submodule", initialSubmoduleCommit);
    runGit(superRepo, ["add", "."]);
    runGit(superRepo, ["commit", "-m", "Add submodule"]);

    runtime = ManagedRuntime.make(CheckpointStoreLive.pipe(Layer.provideMerge(NodeServices.layer)));
    const checkpointStore = await runtime.runPromise(Effect.service(CheckpointStore));
    const threadId = ThreadId.makeUnsafe("thread-submodule");
    const checkpoint0 = checkpointRefForThreadTurn(threadId, 0);
    const checkpoint1 = checkpointRefForThreadTurn(threadId, 1);

    await runtime.runPromise(
      checkpointStore.captureCheckpoint({
        cwd: superRepo,
        checkpointRef: checkpoint0,
      }),
    );

    checkoutSubmoduleCommit(superRepo, "packages/submodule", updatedSubmoduleCommit);

    await runtime.runPromise(
      checkpointStore.captureCheckpoint({
        cwd: superRepo,
        checkpointRef: checkpoint1,
      }),
    );

    const diff = await runtime.runPromise(
      checkpointStore.diffCheckpoints({
        cwd: superRepo,
        fromCheckpointRef: checkpoint0,
        toCheckpointRef: checkpoint1,
      }),
    );

    expect(diff).toContain("diff --git a/packages/submodule/file.txt b/packages/submodule/file.txt");
    expect(parseTurnDiffFilesFromUnifiedDiff(diff)).toEqual([
      { path: "packages/submodule/file.txt", additions: 1, deletions: 0 },
    ]);
  });
});
