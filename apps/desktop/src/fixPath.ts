import {
  defaultShellCandidates,
  resolvePathFromLoginShells,
  shouldRepairPath,
} from "@t3tools/shared/shell";

export function fixPath(): void {
  if (!shouldRepairPath()) return;

  const result = resolvePathFromLoginShells(defaultShellCandidates());
  if (result) {
    process.env.PATH = result;
  }
}
