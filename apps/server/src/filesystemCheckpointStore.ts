import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { runProcess } from "./processRunner";

const CHECKPOINT_REFS_PREFIX = "refs/t3/checkpoints";
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_OUTPUT_BYTES = 1_000_000;

function quoteGitCommand(args: readonly string[]): string {
  return `git ${args.join(" ")}`;
}

function checkpointRefThreadSegment(threadId: string): string {
  return Buffer.from(threadId, "utf8").toString("base64url");
}

export function checkpointRefForThreadTurn(threadId: string, turnCount: number): string {
  if (!Number.isInteger(turnCount) || turnCount < 0) {
    throw new Error(`Invalid checkpoint turn count: ${turnCount}`);
  }
  return `${CHECKPOINT_REFS_PREFIX}/${checkpointRefThreadSegment(threadId)}/turn/${turnCount}`;
}

interface GitOptions {
  env?: NodeJS.ProcessEnv;
  stdin?: string;
  allowNonZeroExit?: boolean;
}

export class FilesystemCheckpointStore {
  async isGitRepository(cwd: string): Promise<boolean> {
    try {
      const result = await this.runGit(cwd, ["rev-parse", "--is-inside-work-tree"], {
        allowNonZeroExit: true,
      });
      return result.code === 0 && result.stdout.trim() === "true";
    } catch {
      return false;
    }
  }

  async captureCheckpoint(input: {
    cwd: string;
    threadId: string;
    turnCount: number;
  }): Promise<void> {
    const { cwd, threadId, turnCount } = input;
    const ref = checkpointRefForThreadTurn(threadId, turnCount);

    const tempDir = await mkdtemp(path.join(os.tmpdir(), "t3-fs-checkpoint-"));

    try {
      const tempIndexPath = path.join(tempDir, `index-${randomUUID()}`);
      const commitEnv: NodeJS.ProcessEnv = {
        ...process.env,
        GIT_INDEX_FILE: tempIndexPath,
        GIT_AUTHOR_NAME: "T3 Code",
        GIT_AUTHOR_EMAIL: "codex@users.noreply.github.com",
        GIT_COMMITTER_NAME: "T3 Code",
        GIT_COMMITTER_EMAIL: "codex@users.noreply.github.com",
      };

      const hasHead = await this.hasHeadCommit(cwd);
      if (hasHead) {
        await this.runGit(cwd, ["read-tree", "HEAD"], { env: commitEnv });
      }

      await this.runGit(cwd, ["add", "-A", "--", "."], { env: commitEnv });
      const writeTreeResult = await this.runGit(cwd, ["write-tree"], { env: commitEnv });
      const treeOid = writeTreeResult.stdout.trim();
      if (!treeOid) {
        throw new Error("git write-tree returned an empty tree oid.");
      }

      const message = `t3 checkpoint thread=${threadId} turn=${turnCount}`;
      const commitTreeResult = await this.runGit(cwd, ["commit-tree", treeOid], {
        env: commitEnv,
        stdin: `${message}\n`,
      });
      const commitOid = commitTreeResult.stdout.trim();
      if (!commitOid) {
        throw new Error("git commit-tree returned an empty commit oid.");
      }

      await this.runGit(cwd, ["update-ref", ref, commitOid]);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  }

  async hasCheckpoint(input: {
    cwd: string;
    threadId: string;
    turnCount: number;
  }): Promise<boolean> {
    const { cwd, threadId, turnCount } = input;
    const ref = checkpointRefForThreadTurn(threadId, turnCount);
    const commit = await this.resolveCheckpointCommit(cwd, ref);
    return commit !== null;
  }

  async ensureRootCheckpoint(input: { cwd: string; threadId: string }): Promise<boolean> {
    const { cwd, threadId } = input;
    const rootRef = checkpointRefForThreadTurn(threadId, 0);
    const existing = await this.resolveCheckpointCommit(cwd, rootRef);
    if (existing) {
      return true;
    }

    const headCommit = await this.resolveHeadCommit(cwd);
    if (!headCommit) {
      return false;
    }

    await this.runGit(cwd, ["update-ref", rootRef, headCommit]);
    return true;
  }

  async restoreCheckpoint(input: {
    cwd: string;
    threadId: string;
    turnCount: number;
  }): Promise<boolean> {
    const { cwd, threadId, turnCount } = input;
    const ref = checkpointRefForThreadTurn(threadId, turnCount);
    let commitOid = await this.resolveCheckpointCommit(cwd, ref);
    if (!commitOid && turnCount === 0) {
      commitOid = await this.resolveHeadCommit(cwd);
    }
    if (!commitOid) {
      return false;
    }

    await this.runGit(cwd, ["restore", "--source", commitOid, "--worktree", "--staged", "--", "."]);
    await this.runGit(cwd, ["clean", "-fd", "--", "."]);
    await this.runGit(cwd, ["reset", "--quiet", "--", "."]);
    return true;
  }

  async diffCheckpoints(input: {
    cwd: string;
    threadId: string;
    fromTurnCount: number;
    toTurnCount: number;
  }): Promise<string> {
    const { cwd, threadId, fromTurnCount, toTurnCount } = input;
    if (!Number.isInteger(fromTurnCount) || fromTurnCount < 0) {
      throw new Error(`Invalid from turn count: ${fromTurnCount}`);
    }
    if (!Number.isInteger(toTurnCount) || toTurnCount < 0) {
      throw new Error(`Invalid to turn count: ${toTurnCount}`);
    }
    if (fromTurnCount > toTurnCount) {
      throw new Error(`Invalid checkpoint range: ${fromTurnCount}..${toTurnCount}`);
    }

    const fromRef = checkpointRefForThreadTurn(threadId, fromTurnCount);
    const toRef = checkpointRefForThreadTurn(threadId, toTurnCount);
    let fromCommitOid = await this.resolveCheckpointCommit(cwd, fromRef);
    const toCommitOid = await this.resolveCheckpointCommit(cwd, toRef);
    if (!fromCommitOid && fromTurnCount === 0) {
      const headCommit = await this.resolveHeadCommit(cwd);
      if (headCommit) {
        fromCommitOid = headCommit;
      }
    }
    if (!fromCommitOid) {
      throw new Error(
        `Filesystem checkpoint is unavailable for turn ${fromTurnCount} in thread ${threadId}.`,
      );
    }
    if (!toCommitOid) {
      throw new Error(
        `Filesystem checkpoint is unavailable for turn ${toTurnCount} in thread ${threadId}.`,
      );
    }

    const result = await this.runGit(cwd, [
      "diff",
      "--patch",
      "--minimal",
      "--no-color",
      fromCommitOid,
      toCommitOid,
    ]);
    return result.stdout;
  }

  private async resolveHeadCommit(cwd: string): Promise<string | null> {
    const result = await this.runGit(cwd, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"], {
      allowNonZeroExit: true,
    });
    if (result.code !== 0) {
      return null;
    }
    const commit = result.stdout.trim();
    return commit.length > 0 ? commit : null;
  }

  async pruneAfterTurn(input: {
    cwd: string;
    threadId: string;
    maxTurnCount: number;
  }): Promise<void> {
    const { cwd, threadId, maxTurnCount } = input;
    if (!Number.isInteger(maxTurnCount) || maxTurnCount < 0) {
      throw new Error(`Invalid max turn count: ${maxTurnCount}`);
    }

    const threadRefPrefix = `${CHECKPOINT_REFS_PREFIX}/${checkpointRefThreadSegment(threadId)}/turn/`;
    const result = await this.runGit(
      cwd,
      ["for-each-ref", "--format=%(refname)", threadRefPrefix],
      {
        allowNonZeroExit: true,
      },
    );
    if (result.code !== 0) {
      return;
    }

    const refsToDelete = result.stdout
      .split(/\r?\n/g)
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .filter((refName) => {
        const turn = this.readRefTurnCount(refName);
        return turn !== null && turn > maxTurnCount;
      });

    const batchSize = 32;
    const batches = Array.from(
      { length: Math.ceil(refsToDelete.length / batchSize) },
      (_, index) => refsToDelete.slice(index * batchSize, (index + 1) * batchSize),
    );
    await batches.reduce<Promise<void>>((pending, batch) => {
      return pending.then(async () => {
        await Promise.all(
          batch.map((refName) =>
            this.runGit(cwd, ["update-ref", "-d", refName], { allowNonZeroExit: true }),
          ),
        );
      });
    }, Promise.resolve());
  }

  private async hasHeadCommit(cwd: string): Promise<boolean> {
    const result = await this.runGit(cwd, ["rev-parse", "--verify", "HEAD"], {
      allowNonZeroExit: true,
    });
    return result.code === 0;
  }

  private async resolveCheckpointCommit(cwd: string, ref: string): Promise<string | null> {
    const result = await this.runGit(cwd, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], {
      allowNonZeroExit: true,
    });
    if (result.code !== 0) {
      return null;
    }
    const commit = result.stdout.trim();
    return commit.length > 0 ? commit : null;
  }

  private readRefTurnCount(ref: string): number | null {
    const segments = ref.split("/");
    const rawTurn = segments.at(-1);
    if (!rawTurn) {
      return null;
    }
    const turn = Number.parseInt(rawTurn, 10);
    return Number.isInteger(turn) && turn >= 0 ? turn : null;
  }

  private async runGit(
    cwd: string,
    args: readonly string[],
    options: GitOptions = {},
  ): Promise<Awaited<ReturnType<typeof runProcess>>> {
    let result: Awaited<ReturnType<typeof runProcess>>;
    try {
      result = await runProcess("git", args, {
        cwd,
        env: options.env,
        stdin: options.stdin,
        timeoutMs: DEFAULT_TIMEOUT_MS,
        allowNonZeroExit: true,
        maxBufferBytes: DEFAULT_MAX_OUTPUT_BYTES,
        outputMode: "truncate",
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to run ${quoteGitCommand(args)}: ${message}`, { cause: error });
    }

    if (result.timedOut) {
      throw new Error(`${quoteGitCommand(args)} timed out.`);
    }

    if (result.stdoutTruncated || result.stderrTruncated) {
      throw new Error(
        `${quoteGitCommand(args)} output exceeded ${DEFAULT_MAX_OUTPUT_BYTES} bytes and was truncated.`,
      );
    }

    if (!options.allowNonZeroExit && result.code !== 0) {
      const stderr = result.stderr.trim();
      throw new Error(
        stderr.length > 0
          ? `${quoteGitCommand(args)} failed: ${stderr}`
          : `${quoteGitCommand(args)} failed with code ${result.code ?? "null"}.`,
      );
    }

    return result;
  }
}
