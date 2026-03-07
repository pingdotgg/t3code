import { resolveLoginShellPath } from "@t3tools/shared/shellPath";

export function fixPath(): void {
  if (process.platform === "win32") return;

  try {
    const shell = process.env.SHELL ?? (process.platform === "darwin" ? "/bin/zsh" : "/bin/sh");
    const result = resolveLoginShellPath(shell, process.env);
    if (result) {
      process.env.PATH = result;
    }
  } catch {
    // Keep inherited PATH if shell lookup fails.
  }
}
