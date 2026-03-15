import { ensureCommonMacPaths, readPathFromLoginShell } from "@t3tools/shared/shell";

export function fixPath(): void {
  if (process.platform !== "darwin") return;

  try {
    const shell = process.env.SHELL ?? "/bin/zsh";
    const result = readPathFromLoginShell(shell);
    if (result) {
      process.env.PATH = result;
    }
  } catch {
    // Keep inherited PATH if shell lookup fails.
  }

  // Ensure well-known macOS binary directories (e.g. Homebrew) are on PATH
  // even when the login-shell probe fails or returns a partial result.
  ensureCommonMacPaths();
}
