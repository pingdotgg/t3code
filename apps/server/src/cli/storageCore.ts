// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { DatabaseSync } from "node:sqlite";

export type StorageAreaKind =
  | "worktrees"
  | "provider-logs"
  | "userdata"
  | "tools"
  | "runtime-versions";

export interface StorageArea {
  readonly kind: StorageAreaKind;
  readonly path: string;
  readonly bytes: number;
  readonly entries: number;
  readonly exists: boolean;
}

export interface WorktreeCandidate {
  readonly id: string;
  readonly path: string;
  readonly bytes: number;
  readonly snapshot: string;
  readonly referencedByDatabase: boolean;
  readonly active: boolean;
  readonly eligible: boolean;
  readonly reasons: ReadonlyArray<string>;
}

export interface StorageInspection {
  readonly baseDir: string;
  readonly areas: ReadonlyArray<StorageArea>;
  readonly candidates: ReadonlyArray<WorktreeCandidate>;
}

export interface StorageReceipt {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly candidateId: string;
  readonly snapshot: string;
  readonly originalPath: string;
  readonly quarantinedPath: string;
  readonly createdAt: string;
  readonly restoredAt?: string;
}

interface TreeMeasurement {
  readonly bytes: number;
  readonly entries: number;
  readonly snapshot: string;
}

const QUARANTINE_DIRECTORY = "storage-quarantine";

function hash(value: string): string {
  return NodeCrypto.createHash("sha256").update(value).digest("hex");
}

function isWithin(root: string, candidate: string): boolean {
  const relative = NodePath.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !NodePath.isAbsolute(relative));
}

function assertWithin(root: string, candidate: string, label: string): void {
  if (!isWithin(root, candidate)) {
    throw new Error(`${label} is outside ${root}.`);
  }
}

function assertNoSymlink(root: string, candidate: string): void {
  assertWithin(root, candidate, "Path");
  if (NodeFS.lstatSync(root).isSymbolicLink()) {
    throw new Error(`Refusing symbolic link path: ${root}`);
  }
  let current = root;
  const relative = NodePath.relative(root, candidate);
  for (const segment of relative.split(NodePath.sep).filter(Boolean)) {
    current = NodePath.join(current, segment);
    if (NodeFS.lstatSync(current).isSymbolicLink()) {
      throw new Error(`Refusing symbolic link path: ${current}`);
    }
  }
}

function assertNoSymlinkAncestors(root: string, candidate: string): void {
  assertWithin(root, candidate, "Path");
  let current = root;
  if (NodeFS.lstatSync(current).isSymbolicLink()) {
    throw new Error(`Refusing symbolic link path: ${current}`);
  }
  const relative = NodePath.relative(root, candidate);
  for (const segment of relative.split(NodePath.sep).filter(Boolean)) {
    current = NodePath.join(current, segment);
    if (!NodeFS.existsSync(current)) return;
    if (NodeFS.lstatSync(current).isSymbolicLink()) {
      throw new Error(`Refusing symbolic link path: ${current}`);
    }
  }
}

function measureTree(root: string): TreeMeasurement {
  const records: Array<string> = [];
  let bytes = 0;
  let entries = 0;

  const visit = (current: string, relative: string): void => {
    const stat = NodeFS.lstatSync(current, { bigint: true });
    if (stat.isSymbolicLink()) {
      throw new Error(`Refusing symbolic link in storage tree: ${current}`);
    }
    entries += 1;
    if (stat.isFile()) bytes += Number(stat.size);
    records.push(
      [
        relative,
        stat.mode.toString(),
        stat.dev.toString(),
        stat.ino.toString(),
        stat.size.toString(),
        stat.mtimeNs.toString(),
      ].join("\0"),
    );
    if (!stat.isDirectory()) return;
    for (const entry of NodeFS.readdirSync(current).sort()) {
      visit(NodePath.join(current, entry), NodePath.join(relative, entry));
    }
  };

  visit(root, ".");
  return { bytes, entries, snapshot: hash(records.join("\n")) };
}

function inspectArea(kind: StorageAreaKind, areaPath: string): StorageArea {
  if (!NodeFS.existsSync(areaPath)) {
    return { kind, path: areaPath, bytes: 0, entries: 0, exists: false };
  }
  const measurement = measureTree(areaPath);
  return {
    kind,
    path: areaPath,
    bytes: measurement.bytes,
    entries: measurement.entries,
    exists: true,
  };
}

function findWorktreeRoots(worktreesRoot: string): ReadonlyArray<string> {
  if (!NodeFS.existsSync(worktreesRoot)) return [];
  assertNoSymlink(worktreesRoot, worktreesRoot);
  const found: Array<string> = [];
  const visit = (directory: string): void => {
    const stat = NodeFS.lstatSync(directory);
    if (stat.isSymbolicLink()) {
      throw new Error(`Refusing symbolic link in worktrees directory: ${directory}`);
    }
    if (!stat.isDirectory()) return;
    if (NodeFS.existsSync(NodePath.join(directory, ".git"))) {
      found.push(directory);
      return;
    }
    for (const entry of NodeFS.readdirSync(directory).sort()) {
      const child = NodePath.join(directory, entry);
      if (NodeFS.lstatSync(child).isDirectory()) visit(child);
    }
  };
  visit(worktreesRoot);
  return found;
}

function readDatabaseWorktreePaths(dbPath: string): {
  readonly available: boolean;
  readonly referenced: ReadonlySet<string>;
  readonly active: ReadonlySet<string>;
} {
  if (!NodeFS.existsSync(dbPath)) {
    return { available: false, referenced: new Set(), active: new Set() };
  }
  const database = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const tables = database
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((row) => String(row.name));
    if (!tables.includes("projection_threads")) {
      return { available: false, referenced: new Set(), active: new Set() };
    }
    const rows = database
      .prepare(
        "SELECT worktree_path, deleted_at FROM projection_threads WHERE worktree_path IS NOT NULL",
      )
      .all();
    const referenced = new Set<string>();
    const active = new Set<string>();
    for (const row of rows) {
      const resolvedPath = NodePath.resolve(String(row.worktree_path));
      const worktreePath = NodeFS.existsSync(resolvedPath)
        ? NodeFS.realpathSync.native(resolvedPath)
        : resolvedPath;
      referenced.add(worktreePath);
      if (row.deleted_at === null) active.add(worktreePath);
    }
    return { available: true, referenced, active };
  } finally {
    database.close();
  }
}

function readWorktreeReferenceState(baseDir: string): ReturnType<typeof readDatabaseWorktreePaths> {
  const databasePath = NodePath.join(baseDir, "userdata", "state.sqlite");
  if (NodeFS.existsSync(databasePath)) assertNoSymlink(baseDir, databasePath);
  return readDatabaseWorktreePaths(databasePath);
}

export function inspectStorage(baseDirectory: string): StorageInspection {
  const baseDir = NodePath.resolve(baseDirectory);
  const worktreesRoot = NodePath.join(baseDir, "worktrees");
  const userdataRoot = NodePath.join(baseDir, "userdata");
  const dbPaths = readWorktreeReferenceState(baseDir);
  const candidates = findWorktreeRoots(worktreesRoot).map((candidatePath): WorktreeCandidate => {
    assertNoSymlink(worktreesRoot, candidatePath);
    const measurement = measureTree(candidatePath);
    const resolvedPath = NodeFS.realpathSync.native(candidatePath);
    const referencedByDatabase = dbPaths.referenced.has(resolvedPath);
    const active = dbPaths.active.has(resolvedPath);
    const reasons = [
      ...(!dbPaths.available ? ["database-unavailable"] : []),
      ...(active ? ["active-thread"] : []),
      ...(referencedByDatabase ? ["database-reference"] : []),
    ];
    return {
      id: hash(NodePath.relative(worktreesRoot, resolvedPath)).slice(0, 20),
      path: resolvedPath,
      bytes: measurement.bytes,
      snapshot: measurement.snapshot,
      referencedByDatabase,
      active,
      eligible: reasons.length === 0,
      reasons,
    };
  });

  return {
    baseDir,
    areas: [
      inspectArea("worktrees", worktreesRoot),
      inspectArea("provider-logs", NodePath.join(userdataRoot, "logs", "provider")),
      inspectArea("userdata", userdataRoot),
      inspectArea("tools", NodePath.join(baseDir, "tools")),
      inspectArea("runtime-versions", NodePath.join(baseDir, "runtime", "versions")),
    ],
    candidates,
  };
}

function receiptDirectory(baseDir: string): string {
  return NodePath.join(baseDir, QUARANTINE_DIRECTORY, "receipts");
}

function writeReceipt(receiptPath: string, receipt: StorageReceipt): void {
  NodeFS.mkdirSync(NodePath.dirname(receiptPath), { recursive: true });
  const temporaryPath = `${receiptPath}.${process.pid}.tmp`;
  NodeFS.writeFileSync(temporaryPath, `${JSON.stringify(receipt, null, 2)}\n`, { flag: "wx" });
  NodeFS.renameSync(temporaryPath, receiptPath);
}

export function quarantineStorageCandidate(
  input: {
    readonly baseDir: string;
    readonly candidateId: string;
    readonly snapshot: string;
    readonly now?: Date;
    readonly receiptId?: string;
  },
  hooks: {
    readonly beforeMove?: () => void;
    readonly afterMove?: () => void;
  } = {},
): { readonly receipt: StorageReceipt; readonly receiptPath: string } {
  const inspection = inspectStorage(input.baseDir);
  const candidate = inspection.candidates.find((entry) => entry.id === input.candidateId);
  if (candidate === undefined)
    throw new Error(`Storage candidate ${input.candidateId} was not found.`);
  if (!candidate.eligible) {
    throw new Error(
      `Storage candidate ${candidate.id} is not eligible: ${candidate.reasons.join(", ")}.`,
    );
  }
  if (candidate.snapshot !== input.snapshot) {
    throw new Error(`Storage candidate ${candidate.id} changed after inspection.`);
  }

  const worktreesRoot = NodePath.join(inspection.baseDir, "worktrees");
  assertNoSymlink(worktreesRoot, candidate.path);
  const current = measureTree(candidate.path);
  if (current.snapshot !== input.snapshot) {
    throw new Error(`Storage candidate ${candidate.id} changed before quarantine.`);
  }

  const receiptId = input.receiptId ?? NodeCrypto.randomUUID();
  const quarantineRoot = NodePath.join(inspection.baseDir, QUARANTINE_DIRECTORY, "worktrees");
  const quarantinedPath = NodePath.join(
    quarantineRoot,
    receiptId,
    NodePath.basename(candidate.path),
  );
  assertWithin(quarantineRoot, quarantinedPath, "Quarantine target");
  assertNoSymlinkAncestors(inspection.baseDir, NodePath.dirname(quarantinedPath));
  NodeFS.mkdirSync(NodePath.dirname(quarantinedPath), { recursive: true });
  assertNoSymlink(inspection.baseDir, NodePath.dirname(quarantinedPath));
  if (NodeFS.existsSync(quarantinedPath)) {
    throw new Error(`Quarantine target already exists: ${quarantinedPath}`);
  }
  const receipt: StorageReceipt = {
    schemaVersion: 1,
    id: receiptId,
    candidateId: candidate.id,
    snapshot: candidate.snapshot,
    originalPath: candidate.path,
    quarantinedPath,
    createdAt: (input.now ?? new Date()).toISOString(),
  };
  const receiptPath = NodePath.join(receiptDirectory(inspection.baseDir), `${receiptId}.json`);
  assertNoSymlinkAncestors(inspection.baseDir, NodePath.dirname(receiptPath));
  NodeFS.mkdirSync(NodePath.dirname(receiptPath), { recursive: true });
  assertNoSymlink(inspection.baseDir, NodePath.dirname(receiptPath));
  if (NodeFS.existsSync(receiptPath)) {
    throw new Error(`Quarantine receipt already exists: ${receiptPath}`);
  }
  hooks.beforeMove?.();
  const latestReferences = readWorktreeReferenceState(inspection.baseDir);
  if (!latestReferences.available || latestReferences.referenced.has(candidate.path)) {
    throw new Error(`Storage candidate ${candidate.id} gained a database reference.`);
  }
  NodeFS.renameSync(candidate.path, quarantinedPath);
  try {
    hooks.afterMove?.();
    const afterMoveReferences = readWorktreeReferenceState(inspection.baseDir);
    if (!afterMoveReferences.available || afterMoveReferences.referenced.has(candidate.path)) {
      throw new Error(
        `Storage candidate ${candidate.id} gained a database reference during quarantine.`,
      );
    }
    if (measureTree(quarantinedPath).snapshot !== candidate.snapshot) {
      throw new Error(`Storage candidate ${candidate.id} changed during quarantine.`);
    }
    writeReceipt(receiptPath, receipt);
  } catch (cause) {
    const originalParent = NodePath.dirname(candidate.path);
    assertNoSymlinkAncestors(worktreesRoot, originalParent);
    if (NodeFS.existsSync(candidate.path)) {
      throw new AggregateError(
        [cause, new Error(`Rollback target already exists: ${candidate.path}`)],
        `Storage candidate ${candidate.id} could not be rolled back safely.`,
      );
    }
    NodeFS.renameSync(quarantinedPath, candidate.path);
    throw cause;
  }
  return { receipt, receiptPath };
}

export function restoreStorageReceipt(input: {
  readonly baseDir: string;
  readonly receiptId: string;
  readonly now?: Date;
}): { readonly receipt: StorageReceipt; readonly receiptPath: string } {
  const baseDir = NodePath.resolve(input.baseDir);
  const receiptsRoot = receiptDirectory(baseDir);
  const receiptPath = NodePath.join(receiptsRoot, `${input.receiptId}.json`);
  assertWithin(receiptsRoot, receiptPath, "Receipt");
  assertNoSymlink(receiptsRoot, receiptPath);
  const receipt = JSON.parse(NodeFS.readFileSync(receiptPath, "utf8")) as StorageReceipt;
  if (
    receipt.schemaVersion !== 1 ||
    receipt.id !== input.receiptId ||
    typeof receipt.candidateId !== "string" ||
    typeof receipt.snapshot !== "string" ||
    typeof receipt.originalPath !== "string" ||
    typeof receipt.quarantinedPath !== "string" ||
    typeof receipt.createdAt !== "string" ||
    receipt.restoredAt !== undefined
  ) {
    throw new Error(`Receipt ${input.receiptId} is invalid or already restored.`);
  }

  const worktreesRoot = NodePath.join(baseDir, "worktrees");
  const quarantineRoot = NodePath.join(baseDir, QUARANTINE_DIRECTORY, "worktrees");
  const originalPath = NodePath.resolve(receipt.originalPath);
  const quarantinedPath = NodePath.resolve(receipt.quarantinedPath);
  assertWithin(worktreesRoot, originalPath, "Restore target");
  assertWithin(quarantineRoot, quarantinedPath, "Quarantined path");
  const expectedQuarantinedPath = NodePath.join(
    quarantineRoot,
    receipt.id,
    NodePath.basename(originalPath),
  );
  if (quarantinedPath !== expectedQuarantinedPath) {
    throw new Error(`Receipt ${receipt.id} does not match its quarantined path.`);
  }
  assertNoSymlink(quarantineRoot, quarantinedPath);
  const expectedCandidateId = hash(NodePath.relative(worktreesRoot, originalPath)).slice(0, 20);
  if (receipt.candidateId !== expectedCandidateId) {
    throw new Error(`Receipt ${receipt.id} does not match its restore target.`);
  }
  if (NodeFS.existsSync(originalPath))
    throw new Error(`Restore target already exists: ${originalPath}`);
  if (measureTree(quarantinedPath).snapshot !== receipt.snapshot) {
    throw new Error(`Quarantined storage for receipt ${receipt.id} changed.`);
  }

  const originalParent = NodePath.dirname(originalPath);
  assertNoSymlinkAncestors(worktreesRoot, originalParent);
  NodeFS.mkdirSync(originalParent, { recursive: true });
  assertNoSymlink(worktreesRoot, originalParent);
  NodeFS.renameSync(quarantinedPath, originalPath);
  const restored = { ...receipt, restoredAt: (input.now ?? new Date()).toISOString() };
  try {
    writeReceipt(receiptPath, restored);
  } catch (cause) {
    NodeFS.renameSync(originalPath, quarantinedPath);
    throw cause;
  }
  return { receipt: restored, receiptPath };
}
