import { realpath } from "node:fs/promises";
import path from "node:path";

export async function canonicalizeWorktreePath(worktreePath: string): Promise<string> {
  const resolved = path.resolve(worktreePath);
  try {
    return await realpath(resolved);
  } catch {
    return resolved;
  }
}
