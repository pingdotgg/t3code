// @effect-diagnostics nodeBuiltinImport:off
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

export function isGitRepository(current: string): boolean {
  do {
    if (existsSync(join(current, ".git"))) return true;
  } while (current !== (current = dirname(current)));
  return false;
}
