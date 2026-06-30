#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off - Standalone Git maintenance boundary.
// @effect-diagnostics globalDate:off - Backup ids and manifests use wall-clock timestamps.
// @effect-diagnostics globalConsole:off - CLI prints a human-readable briefing.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export interface PatchUpgradeConflict {
  readonly file: string;
  readonly commit: string;
  readonly subject: string;
  readonly backupPath: string | null;
}

export interface PatchUpgradeManifest {
  readonly id: string;
  readonly repoRoot: string;
  readonly backupRef: string;
  readonly upstream: string;
  readonly createdAt: string;
  readonly conflicts: ReadonlyArray<PatchUpgradeConflict>;
}

export type PatchUpgradeStatus =
  | "current"
  | "upgraded"
  | "upgraded_with_conflicts"
  | "dirty"
  | "no_upstream"
  | "failed";

export interface PatchUpgradeResult {
  readonly status: PatchUpgradeStatus;
  readonly upstream?: string;
  readonly pulled?: number;
  readonly replayed?: number;
  readonly conflicts?: ReadonlyArray<PatchUpgradeConflict>;
  readonly backupRef?: string;
  readonly backupDir?: string;
  readonly error?: string;
}

export interface PatchUpgradeOptions {
  readonly id?: string;
  readonly backupBase?: string;
}

function git(repoRoot: string, ...args: ReadonlyArray<string>): string {
  return execFileSync("git", ["-C", repoRoot, ...args], {
    encoding: "utf-8",
    timeout: 120_000,
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, GIT_EDITOR: "true" },
  }).trim();
}

function gitBlob(repoRoot: string, revPath: string): Buffer {
  return execFileSync("git", ["-C", repoRoot, "show", revPath], {
    timeout: 120_000,
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, GIT_EDITOR: "true" },
  });
}

function rebaseInProgress(repoRoot: string): boolean {
  return (
    existsSync(join(repoRoot, ".git", "rebase-merge")) ||
    existsSync(join(repoRoot, ".git", "rebase-apply"))
  );
}

function timestampId(): string {
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(
    now.getHours(),
  )}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

function defaultBackupBase(): string {
  const home = process.env.HOME || process.env.USERPROFILE;
  return home
    ? join(home, ".t3code", "patch-upgrade-backups")
    : resolve(".t3code", "patch-upgrade-backups");
}

function splitRemote(upstream: string): string {
  return upstream.split("/")[0] ?? upstream;
}

/**
 * Rebase local fork patches onto the configured upstream.
 *
 * Clean local patch commits replay automatically. If a patch commit conflicts,
 * upstream wins, the previous patched file is saved in the backup directory,
 * and the rebase is completed so the repo is not left mid-conflict. Re-applying
 * local intent is a separate user-approved step handled by
 * `skills/patch-resolve`.
 */
export function runPatchUpgrade(
  repoRoot: string,
  options: PatchUpgradeOptions = {},
): PatchUpgradeResult {
  let upstream: string;
  try {
    upstream = git(repoRoot, "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}");
  } catch {
    return {
      status: "no_upstream",
      error:
        "Current branch has no upstream tracking branch. Set one with: git branch --set-upstream-to=<remote>/<branch>",
    };
  }

  const remote = splitRemote(upstream);
  try {
    git(repoRoot, "fetch", remote);
  } catch (error) {
    return {
      status: "failed",
      upstream,
      error: `git fetch ${remote} failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  const pulled = Number(git(repoRoot, "rev-list", "--count", `HEAD..${upstream}`));
  if (pulled === 0) {
    return { status: "current", upstream, pulled: 0 };
  }

  if (git(repoRoot, "status", "--porcelain") !== "") {
    return {
      status: "dirty",
      upstream,
      error:
        "Working tree has uncommitted changes. Commit or stash them, then re-run the patch upgrade.",
    };
  }

  const id = options.id ?? timestampId();
  const backupRef = `backup/pre-patch-upgrade-${id}`;
  git(repoRoot, "branch", backupRef);
  const backupDir = join(options.backupBase ?? defaultBackupBase(), id);
  const conflicts: Array<PatchUpgradeConflict> = [];

  try {
    try {
      git(repoRoot, "rebase", upstream);
    } catch {
      let guard = 0;
      while (rebaseInProgress(repoRoot)) {
        if (++guard > 200) {
          throw new Error("rebase conflict loop exceeded 200 iterations");
        }

        const files = git(repoRoot, "diff", "--name-only", "--diff-filter=U")
          .split("\n")
          .filter(Boolean);
        if (files.length === 0) {
          throw new Error("rebase stopped without content conflicts; resolve manually");
        }

        const commit = git(repoRoot, "rev-parse", "REBASE_HEAD");
        const subject = git(repoRoot, "log", "-1", "--format=%s", commit);

        for (const file of files) {
          let backupPath: string | null = null;
          try {
            const patched = gitBlob(repoRoot, `${backupRef}:${file}`);
            backupPath = join(backupDir, file);
            mkdirSync(dirname(backupPath), { recursive: true });
            writeFileSync(backupPath, patched);
          } catch {
            backupPath = null;
          }

          try {
            git(repoRoot, "checkout", "--ours", "--", file);
            git(repoRoot, "add", "--", file);
          } catch {
            git(repoRoot, "rm", "--quiet", "--ignore-unmatch", "--", file);
          }

          conflicts.push({ file, commit, subject, backupPath });
        }

        let hasStagedChanges = false;
        try {
          git(repoRoot, "diff", "--cached", "--quiet");
        } catch {
          hasStagedChanges = true;
        }

        try {
          git(repoRoot, "rebase", hasStagedChanges ? "--continue" : "--skip");
        } catch {
          if (!rebaseInProgress(repoRoot)) {
            throw new Error("rebase --continue failed in an unexpected way");
          }
        }
      }
    }
  } catch (error) {
    try {
      git(repoRoot, "rebase", "--abort");
    } catch {
      // Not in a rebase; keep rollback best-effort.
    }
    try {
      git(repoRoot, "reset", "--hard", backupRef);
    } catch {
      // Best-effort rollback already reported below.
    }
    return {
      status: "failed",
      upstream,
      backupRef,
      error: error instanceof Error ? error.message : String(error),
    };
  }

  const replayed = Number(git(repoRoot, "rev-list", "--count", `${upstream}..HEAD`));
  if (conflicts.length > 0) {
    mkdirSync(backupDir, { recursive: true });
    const manifest: PatchUpgradeManifest = {
      id,
      repoRoot,
      backupRef,
      upstream,
      createdAt: new Date().toISOString(),
      conflicts,
    };
    writeFileSync(join(backupDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    return {
      status: "upgraded_with_conflicts",
      upstream,
      pulled,
      replayed,
      conflicts,
      backupRef,
      backupDir,
    };
  }

  return { status: "upgraded", upstream, pulled, replayed, backupRef };
}

export function printPatchUpgradeBriefing(result: PatchUpgradeResult): void {
  switch (result.status) {
    case "current":
      console.log("Already on the latest upstream commit.");
      break;
    case "no_upstream":
    case "dirty":
      console.error(result.error);
      break;
    case "failed":
      console.error(`Patch upgrade failed: ${result.error}`);
      if (result.backupRef) {
        console.error(`Repo restored to pre-upgrade state (${result.backupRef}).`);
      }
      break;
    case "upgraded":
      console.log(
        `Pulled ${result.pulled} upstream commit(s); ${result.replayed} local patch commit(s) replayed cleanly.`,
      );
      console.log(`Rollback point: ${result.backupRef}`);
      break;
    case "upgraded_with_conflicts":
      console.log(
        `Pulled ${result.pulled} upstream commit(s); ${result.replayed} local patch commit(s) replayed cleanly.`,
      );
      console.log("");
      console.log(`Conflicts resolved upstream-wins for ${result.conflicts?.length ?? 0} file(s):`);
      for (const conflict of result.conflicts ?? []) {
        console.log(`  ${conflict.file} (patch: "${conflict.subject}")`);
      }
      console.log("");
      console.log(`Patched versions backed up at: ${result.backupDir}`);
      console.log(`Rollback point: ${result.backupRef}`);
      console.log(
        "To re-apply local intent, ask your agent to run skills/patch-resolve/SKILL.md. It will ask for approval first.",
      );
      break;
  }
}

if (import.meta.main) {
  const repoRoot = resolve(process.argv[2] ?? process.cwd());
  const result = runPatchUpgrade(repoRoot);
  printPatchUpgradeBriefing(result);
  if (result.status === "dirty" || result.status === "no_upstream" || result.status === "failed") {
    process.exitCode = 1;
  }
}
