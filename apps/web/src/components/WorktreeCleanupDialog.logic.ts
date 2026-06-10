import type { WorktreeClassification } from "../worktreeCleanup";

export interface CleanupRowState {
  path: string;
  refName: string;
  classification: WorktreeClassification;
  isDirty: boolean;
  selected: boolean;
  force: boolean;
  sizeBytes: number | null;
}

export function formatBytes(bytes: number): string {
  if (bytes <= 0) {
    return "0 B";
  }
  const units = ["B", "KB", "MB", "GB", "TB"];
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / Math.pow(1024, exponent);
  return `${value.toFixed(exponent === 0 ? 0 : 1)} ${units[exponent]}`;
}

export function totalSelectedBytes(rows: readonly CleanupRowState[]): number {
  return rows.reduce(
    (sum, row) => (row.selected && row.sizeBytes !== null ? sum + row.sizeBytes : sum),
    0,
  );
}

export function isRowRemovable(row: CleanupRowState): boolean {
  if (row.classification === "active") {
    return false;
  }
  if (!row.selected) {
    return false;
  }
  if (row.isDirty && !row.force) {
    return false;
  }
  return true;
}

export function buildRemovalItems(
  rows: readonly CleanupRowState[],
): { path: string; force: boolean }[] {
  return rows
    .filter(isRowRemovable)
    .map((row) => ({ path: row.path, force: row.isDirty || row.force }));
}
