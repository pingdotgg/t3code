import * as ChildProcess from "node:child_process";

export function fixPath(): void {
  if (process.platform !== "darwin") return;

  try {
    const shell = process.env.SHELL ?? "/bin/zsh";
    const result = ChildProcess.execFileSync(shell, ["-ilc", "echo -n $PATH"], {
      encoding: "utf8",
      timeout: 5000,
    });
    if (result) {
      process.env.PATH = result;
    }
  } catch {
    // Keep inherited PATH if shell lookup fails.
  }
}
