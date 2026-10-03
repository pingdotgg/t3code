import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ThreadId } from "@t3tools/contracts";
import { Effect, Layer, ManagedRuntime } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { afterEach, describe, expect, it } from "vitest";

import {
  WorkspaceOwnershipConflict,
  WorkspaceOwnershipRepository,
} from "../Services/WorkspaceOwnership.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";
import { WorkspaceOwnershipRepositoryLive } from "./WorkspaceOwnership.ts";

function runGit(cwd: string, args: ReadonlyArray<string>) {
  execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
}

function createGitRepository() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "t3-workspace-ownership-"));
  runGit(cwd, ["init", "--initial-branch=main"]);
  runGit(cwd, ["config", "user.email", "test@example.com"]);
  runGit(cwd, ["config", "user.name", "Test User"]);
  fs.writeFileSync(path.join(cwd, "README.md"), "v1\n", "utf8");
  runGit(cwd, ["add", "."]);
  runGit(cwd, ["commit", "-m", "Initial"]);
  return cwd;
}

const tempDirs: string[] = [];
afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

function trackTempDir(dir: string) {
  tempDirs.push(dir);
  return dir;
}

// Wraps the real SQLite client and fails the next workspace_ownership INSERT
// once, simulating a transient persistence failure after the filesystem
// ledger write.
function makeFaultySqlLayer(failFlag: { value: boolean }) {
  return Layer.effect(
    SqlClient.SqlClient,
    Effect.gen(function* () {
      const real = yield* SqlClient.SqlClient;
      return new Proxy(real, {
        apply(target, thisArg, args) {
          const strings = (args as Array<unknown>)[0] as TemplateStringsArray | undefined;
          if (
            failFlag.value &&
            typeof strings?.[0] === "string" &&
            strings[0].includes("INSERT INTO workspace_ownership")
          ) {
            return Effect.fail(new Error("injected ownership insert failure"));
          }
          return Reflect.apply(
            target as (...callArgs: Array<unknown>) => unknown,
            thisArg,
            args as Array<unknown>,
          );
        },
        get(target, property, receiver) {
          const value = Reflect.get(target, property, receiver);
          return typeof value === "function"
            ? (value as (...callArgs: Array<unknown>) => unknown).bind(target)
            : value;
        },
      }) as never;
    }),
  );
}

async function makeRuntime(failFlag?: { value: boolean }) {
  const repositoryLayer =
    failFlag === undefined
      ? WorkspaceOwnershipRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory))
      : WorkspaceOwnershipRepositoryLive.pipe(
          Layer.provide(makeFaultySqlLayer(failFlag)),
          Layer.provideMerge(SqlitePersistenceMemory),
        );
  return ManagedRuntime.make(Layer.merge(repositoryLayer, SqlitePersistenceMemory));
}

describe("WorkspaceOwnershipRepository", () => {
  it("lets a declared co-owner take over a worktree and keeps the conflict for others", async () => {
    const runtime = await makeRuntime();
    const repo = await runtime.runPromise(Effect.service(WorkspaceOwnershipRepository));
    const now = new Date().toISOString();
    try {
      const repoDir = trackTempDir(createGitRepository());
      const source = ThreadId.make("ownership-family-source");
      const fork = ThreadId.make("ownership-family-fork");
      const outsider = ThreadId.make("ownership-family-outsider");

      const first = await runtime.runPromise(
        repo.claim({
          threadId: source,
          worktreePath: repoDir,
          branch: null,
          commandId: "cmd-ownership-family-source",
          now,
        }),
      );

      // Without the lineage allowance the fork is a conflict.
      const conflict = await runtime.runPromise(
        repo
          .claim({
            threadId: fork,
            worktreePath: repoDir,
            branch: null,
            commandId: "cmd-ownership-family-fork-denied",
            now,
          })
          .pipe(Effect.flip),
      );
      expect(conflict).toBeInstanceOf(WorkspaceOwnershipConflict);

      // With it, the fork takes ownership and the generation advances so no
      // stale binding from the previous owner still asserts.
      const takeover = await runtime.runPromise(
        repo.claim({
          threadId: fork,
          worktreePath: repoDir,
          branch: null,
          commandId: "cmd-ownership-family-fork",
          now,
          coOwnerThreadIds: [source],
        }),
      );
      expect(takeover.generation).toBeGreaterThan(first.generation);
      await expect(runtime.runPromise(repo.assertOwned(takeover, fork))).resolves.toBeUndefined();

      // An unrelated thread still cannot take it.
      const outsiderClaim = await runtime.runPromise(
        repo
          .claim({
            threadId: outsider,
            worktreePath: repoDir,
            branch: null,
            commandId: "cmd-ownership-family-outsider",
            now,
            coOwnerThreadIds: [source],
          })
          .pipe(Effect.flip),
      );
      expect(outsiderClaim).toBeInstanceOf(WorkspaceOwnershipConflict);

      // The fork hands it back to the source the same way.
      const handback = await runtime.runPromise(
        repo.claim({
          threadId: source,
          worktreePath: repoDir,
          branch: null,
          commandId: "cmd-ownership-family-handback",
          now,
          coOwnerThreadIds: [fork],
        }),
      );
      expect(handback.generation).toBeGreaterThan(takeover.generation);
    } finally {
      await runtime.dispose();
    }
  });

  it("releases the filesystem ledger when the database row is missing", async () => {
    const runtime = await makeRuntime();
    const repo = await runtime.runPromise(Effect.service(WorkspaceOwnershipRepository));
    const sql = await runtime.runPromise(Effect.service(SqlClient.SqlClient));
    const now = new Date().toISOString();
    try {
      const repoDir = trackTempDir(createGitRepository());
      const first = ThreadId.make("ownership-release-first");
      const second = ThreadId.make("ownership-release-second");

      const binding = await runtime.runPromise(
        repo.claim({
          threadId: first,
          worktreePath: repoDir,
          branch: null,
          commandId: "cmd-ownership-release-first",
          now,
        }),
      );

      const attempts = await runtime.runPromise(
        sql<{ readonly attemptId: string | null }>`
          SELECT attempt_id AS "attemptId"
          FROM workspace_ownership
          WHERE canonical_path = ${binding.canonicalPath}
        `,
      );
      expect(typeof attempts[0]?.attemptId).toBe("string");

      // Simulate a lost database row (partial failure or restoration) while
      // the filesystem ledger still names the first thread.
      await runtime.runPromise(sql`DELETE FROM workspace_ownership`);
      await runtime.runPromise(repo.release(first, binding.canonicalPath));

      const retry = await runtime.runPromise(
        repo.claim({
          threadId: second,
          worktreePath: repoDir,
          branch: null,
          commandId: "cmd-ownership-release-second",
          now,
        }),
      );
      expect(retry.canonicalPath).toBe(binding.canonicalPath);
    } finally {
      await runtime.dispose();
    }
  });

  it("does not clear a successful claim when a reentrant claim fails", async () => {
    const failFlag = { value: false };
    const runtime = await makeRuntime(failFlag);
    const repo = await runtime.runPromise(Effect.service(WorkspaceOwnershipRepository));
    const now = new Date().toISOString();
    try {
      const repoDir = trackTempDir(createGitRepository());
      const threadId = ThreadId.make("ownership-fenced-thread");

      const binding = await runtime.runPromise(
        repo.claim({
          threadId,
          worktreePath: repoDir,
          branch: null,
          commandId: "cmd-ownership-fenced-first",
          now,
        }),
      );

      failFlag.value = true;
      await expect(
        runtime.runPromise(
          repo.claim({
            threadId,
            worktreePath: repoDir,
            branch: null,
            commandId: "cmd-ownership-fenced-second",
            now,
          }),
        ),
      ).rejects.toThrow();

      const rows = await runtime.runPromise(repo.getByThreadId(threadId));
      expect(rows.length).toBe(1);
      await runtime.runPromise(repo.assertOwned(binding, threadId));
    } finally {
      await runtime.dispose();
    }
  });

  it("releases the original filesystem ledger after a Git worktree is removed", async () => {
    const runtime = await makeRuntime();
    const repo = await runtime.runPromise(Effect.service(WorkspaceOwnershipRepository));
    const now = new Date().toISOString();
    try {
      const repositoryRoot = trackTempDir(createGitRepository());
      const worktreePath = path.join(repositoryRoot, "worker");
      runGit(repositoryRoot, ["worktree", "add", "-b", "worker", worktreePath, "HEAD"]);

      const first = ThreadId.make("ownership-removed-first");
      const second = ThreadId.make("ownership-removed-second");
      const binding = await runtime.runPromise(
        repo.claim({
          threadId: first,
          worktreePath,
          branch: "worker",
          commandId: "cmd-ownership-removed-first",
          now,
        }),
      );

      runGit(repositoryRoot, ["worktree", "remove", "--force", worktreePath]);
      await runtime.runPromise(repo.release(first, binding.canonicalPath));

      runGit(repositoryRoot, ["worktree", "add", worktreePath, "worker"]);
      const retry = await runtime.runPromise(
        repo.claim({
          threadId: second,
          worktreePath,
          branch: "worker",
          commandId: "cmd-ownership-removed-second",
          now,
        }),
      );
      expect(retry.canonicalPath).toBe(binding.canonicalPath);
    } finally {
      await runtime.dispose();
    }
  });
});
