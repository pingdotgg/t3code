import { defaultShellCandidates, resolvePathFromLoginShells } from "@t3tools/shared/shell";

export function fixPath(): void {
  if (process.platform !== "darwin" && process.platform !== "linux") return;

  const result = resolvePathFromLoginShells(defaultShellCandidates());
  if (result) {
    process.env.PATH = result;
  }
}
