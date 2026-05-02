import { existsSync } from "node:fs";
import { join } from "node:path";

export function isGitRepository(cwd: string): boolean {
  return existsSync(join(cwd, ".git"));
}
