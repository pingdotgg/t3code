// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import {
  inspectStorage,
  quarantineStorageCandidate,
  restoreStorageReceipt,
} from "./storageCore.ts";

const temporaryDirectories: Array<string> = [];

function makeHome(): string {
  const baseDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-storage-"));
  temporaryDirectories.push(baseDir);
  NodeFS.mkdirSync(NodePath.join(baseDir, "userdata"), { recursive: true });
  return baseDir;
}

function makeWorktree(baseDir: string, name: string): string {
  const worktreePath = NodePath.join(baseDir, "worktrees", "project", name);
  NodeFS.mkdirSync(worktreePath, { recursive: true });
  NodeFS.writeFileSync(NodePath.join(worktreePath, ".git"), "gitdir: /repo/.git/worktrees/test\n");
  NodeFS.writeFileSync(NodePath.join(worktreePath, "file.txt"), name);
  return worktreePath;
}

function makeDatabase(
  baseDir: string,
  rows: ReadonlyArray<{ path: string; deletedAt: string | null }>,
): void {
  const database = new DatabaseSync(NodePath.join(baseDir, "userdata", "state.sqlite"));
  database.exec(
    "CREATE TABLE IF NOT EXISTS projection_threads (worktree_path TEXT, deleted_at TEXT)",
  );
  const insert = database.prepare(
    "INSERT INTO projection_threads (worktree_path, deleted_at) VALUES (?, ?)",
  );
  for (const row of rows) insert.run(row.path, row.deletedAt);
  database.close();
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    NodeFS.rmSync(directory, { recursive: true, force: true });
  }
});

describe("storage inspection", () => {
  it("classifies storage areas and only offers database-unreferenced worktrees", () => {
    const baseDir = makeHome();
    const active = makeWorktree(baseDir, "active");
    const deleted = makeWorktree(baseDir, "deleted");
    const orphan = makeWorktree(baseDir, "orphan");
    makeDatabase(baseDir, [
      { path: active, deletedAt: null },
      { path: deleted, deletedAt: "2025-01-01T00:00:00.000Z" },
    ]);
    NodeFS.mkdirSync(NodePath.join(baseDir, "runtime", "versions", "1.0.0"), { recursive: true });
    NodeFS.writeFileSync(NodePath.join(baseDir, "runtime", "versions", "1.0.0", "t3"), "binary");

    const result = inspectStorage(baseDir);

    expect(result.areas.map((area) => area.kind)).toEqual([
      "worktrees",
      "provider-logs",
      "userdata",
      "tools",
      "runtime-versions",
    ]);
    expect(result.candidates.find((candidate) => candidate.path === active)).toMatchObject({
      active: true,
      referencedByDatabase: true,
      eligible: false,
    });
    expect(result.candidates.find((candidate) => candidate.path === deleted)).toMatchObject({
      active: false,
      referencedByDatabase: true,
      eligible: false,
    });
    expect(result.candidates.find((candidate) => candidate.path === orphan)).toMatchObject({
      active: false,
      referencedByDatabase: false,
      eligible: true,
    });
  });

  it("rejects symlinks while discovering candidates", () => {
    const baseDir = makeHome();
    const outside = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-storage-outside-"));
    temporaryDirectories.push(outside);
    NodeFS.mkdirSync(NodePath.join(baseDir, "worktrees"), { recursive: true });
    NodeFS.symlinkSync(outside, NodePath.join(baseDir, "worktrees", "escape"));

    expect(() => inspectStorage(baseDir)).toThrow(/symbolic link/i);
  });

  it("isolates an unsafe worktree without hiding eligible siblings", () => {
    const baseDir = makeHome();
    const unsafe = makeWorktree(baseDir, "unsafe");
    const eligible = makeWorktree(baseDir, "eligible");
    makeDatabase(baseDir, []);
    NodeFS.symlinkSync("missing-python", NodePath.join(unsafe, ".venv-python"));

    const result = inspectStorage(baseDir);

    expect(result.candidates.find((candidate) => candidate.path === unsafe)).toMatchObject({
      bytes: 0,
      eligible: false,
      reasons: ["unsafe-tree"],
    });
    expect(result.candidates.find((candidate) => candidate.path === eligible)).toMatchObject({
      eligible: true,
    });
  });

  it("fails closed when the state database cannot prove a worktree is unreferenced", () => {
    const baseDir = makeHome();
    makeWorktree(baseDir, "orphan");

    expect(inspectStorage(baseDir).candidates[0]).toMatchObject({
      eligible: false,
      reasons: ["database-unavailable"],
    });
  });

  it("rejects a symlinked state database before reading it", () => {
    const baseDir = makeHome();
    makeWorktree(baseDir, "orphan");
    const outside = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-storage-database-"));
    temporaryDirectories.push(outside);
    const outsideDatabase = NodePath.join(outside, "state.sqlite");
    new DatabaseSync(outsideDatabase).close();
    NodeFS.symlinkSync(outsideDatabase, NodePath.join(baseDir, "userdata", "state.sqlite"));

    expect(() => inspectStorage(baseDir)).toThrow(/symbolic link/i);
  });
});

describe("storage quarantine", () => {
  it("quarantines an unchanged candidate and restores it from its receipt", () => {
    const baseDir = makeHome();
    const worktreePath = makeWorktree(baseDir, "orphan");
    makeDatabase(baseDir, []);
    const [candidate] = inspectStorage(baseDir).candidates;

    const quarantined = quarantineStorageCandidate({
      baseDir,
      candidateId: candidate!.id,
      snapshot: candidate!.snapshot,
      now: new Date("2025-01-02T00:00:00.000Z"),
    });

    expect(NodeFS.existsSync(worktreePath)).toBe(false);
    expect(NodeFS.existsSync(quarantined.receipt.quarantinedPath)).toBe(true);
    expect(JSON.parse(NodeFS.readFileSync(quarantined.receiptPath, "utf8"))).toMatchObject({
      id: quarantined.receipt.id,
      originalPath: worktreePath,
    });

    const restored = restoreStorageReceipt({
      baseDir,
      receiptId: quarantined.receipt.id,
      now: new Date("2025-01-03T00:00:00.000Z"),
    });
    expect(NodeFS.existsSync(worktreePath)).toBe(true);
    expect(NodeFS.existsSync(quarantined.receipt.quarantinedPath)).toBe(false);
    expect(restored.receipt.restoredAt).toBe("2025-01-03T00:00:00.000Z");
  });

  it("rejects a candidate changed after inspection", () => {
    const baseDir = makeHome();
    const worktreePath = makeWorktree(baseDir, "orphan");
    makeDatabase(baseDir, []);
    const [candidate] = inspectStorage(baseDir).candidates;
    NodeFS.writeFileSync(NodePath.join(worktreePath, "new.txt"), "changed");

    expect(() =>
      quarantineStorageCandidate({
        baseDir,
        candidateId: candidate!.id,
        snapshot: candidate!.snapshot,
      }),
    ).toThrow(/changed after inspection/i);
  });

  it("rejects a candidate that gained a database reference", () => {
    const baseDir = makeHome();
    const worktreePath = makeWorktree(baseDir, "orphan");
    makeDatabase(baseDir, []);
    const [candidate] = inspectStorage(baseDir).candidates;
    makeDatabase(baseDir, [{ path: worktreePath, deletedAt: null }]);

    expect(() =>
      quarantineStorageCandidate({
        baseDir,
        candidateId: candidate!.id,
        snapshot: candidate!.snapshot,
      }),
    ).toThrow(/not eligible/i);
  });

  it("rejects a database reference added immediately before the move", () => {
    const baseDir = makeHome();
    const worktreePath = makeWorktree(baseDir, "orphan");
    makeDatabase(baseDir, []);
    const [candidate] = inspectStorage(baseDir).candidates;

    expect(() =>
      quarantineStorageCandidate(
        {
          baseDir,
          candidateId: candidate!.id,
          snapshot: candidate!.snapshot,
        },
        { beforeMove: () => makeDatabase(baseDir, [{ path: worktreePath, deletedAt: null }]) },
      ),
    ).toThrow(/gained a database reference/i);
    expect(NodeFS.existsSync(worktreePath)).toBe(true);
  });

  it("holds an exclusive database transaction through the move and receipt", () => {
    const baseDir = makeHome();
    const worktreePath = makeWorktree(baseDir, "orphan");
    makeDatabase(baseDir, []);
    const [candidate] = inspectStorage(baseDir).candidates;

    let writerRejected = false;
    const result = quarantineStorageCandidate(
      {
        baseDir,
        candidateId: candidate!.id,
        snapshot: candidate!.snapshot,
      },
      {
        afterMove: () => {
          try {
            makeDatabase(baseDir, [{ path: worktreePath, deletedAt: null }]);
          } catch (error) {
            expect(error).toBeInstanceOf(Error);
            expect((error as Error).message).toMatch(/locked/i);
            writerRejected = true;
          }
        },
      },
    );

    expect(writerRejected).toBe(true);
    expect(NodeFS.existsSync(worktreePath)).toBe(false);
    expect(NodeFS.existsSync(result.receiptPath)).toBe(true);
  });

  it("rejects restore when quarantined contents changed", () => {
    const baseDir = makeHome();
    makeWorktree(baseDir, "orphan");
    makeDatabase(baseDir, []);
    const [candidate] = inspectStorage(baseDir).candidates;
    const quarantined = quarantineStorageCandidate({
      baseDir,
      candidateId: candidate!.id,
      snapshot: candidate!.snapshot,
    });
    NodeFS.writeFileSync(
      NodePath.join(quarantined.receipt.quarantinedPath, "changed.txt"),
      "changed",
    );

    expect(() => restoreStorageReceipt({ baseDir, receiptId: quarantined.receipt.id })).toThrow(
      /changed/i,
    );
  });

  it("rejects a quarantine destination collision", () => {
    const baseDir = makeHome();
    makeWorktree(baseDir, "orphan");
    makeDatabase(baseDir, []);
    const [candidate] = inspectStorage(baseDir).candidates;
    const receiptId = "00000000-0000-4000-8000-000000000000";
    NodeFS.mkdirSync(
      NodePath.join(baseDir, "storage-quarantine", "worktrees", receiptId, "orphan"),
      { recursive: true },
    );

    expect(() =>
      quarantineStorageCandidate({
        baseDir,
        candidateId: candidate!.id,
        snapshot: candidate!.snapshot,
        receiptId,
      }),
    ).toThrow(/target already exists/i);
  });

  it("rejects a symlinked quarantine root before writing outside the T3 home", () => {
    const baseDir = makeHome();
    makeWorktree(baseDir, "orphan");
    makeDatabase(baseDir, []);
    const [candidate] = inspectStorage(baseDir).candidates;
    const outside = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-storage-outside-"));
    temporaryDirectories.push(outside);
    NodeFS.symlinkSync(outside, NodePath.join(baseDir, "storage-quarantine"));

    expect(() =>
      quarantineStorageCandidate({
        baseDir,
        candidateId: candidate!.id,
        snapshot: candidate!.snapshot,
      }),
    ).toThrow(/symbolic link/i);
    expect(NodeFS.readdirSync(outside)).toEqual([]);
  });

  it("rejects a receipt redirected to another quarantined path", () => {
    const baseDir = makeHome();
    makeWorktree(baseDir, "orphan");
    makeDatabase(baseDir, []);
    const [candidate] = inspectStorage(baseDir).candidates;
    const quarantined = quarantineStorageCandidate({
      baseDir,
      candidateId: candidate!.id,
      snapshot: candidate!.snapshot,
    });
    const receipt = JSON.parse(NodeFS.readFileSync(quarantined.receiptPath, "utf8"));
    receipt.quarantinedPath = NodePath.join(
      baseDir,
      "storage-quarantine",
      "worktrees",
      "different-receipt",
      "orphan",
    );
    NodeFS.writeFileSync(quarantined.receiptPath, JSON.stringify(receipt));

    expect(() => restoreStorageReceipt({ baseDir, receiptId: receipt.id })).toThrow(
      /quarantined path/i,
    );
  });

  it("rejects a restore parent replaced by a symlink", () => {
    const baseDir = makeHome();
    const worktreePath = makeWorktree(baseDir, "orphan");
    makeDatabase(baseDir, []);
    const [candidate] = inspectStorage(baseDir).candidates;
    const quarantined = quarantineStorageCandidate({
      baseDir,
      candidateId: candidate!.id,
      snapshot: candidate!.snapshot,
    });
    const projectPath = NodePath.dirname(worktreePath);
    NodeFS.rmdirSync(projectPath);
    const outside = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-storage-restore-"));
    temporaryDirectories.push(outside);
    NodeFS.symlinkSync(outside, projectPath);

    expect(() => restoreStorageReceipt({ baseDir, receiptId: quarantined.receipt.id })).toThrow(
      /symbolic link/i,
    );
    expect(NodeFS.readdirSync(outside)).toEqual([]);
  });
});
