import * as ChildProcess from "node:child_process";

export function fixPath(): void {
  if (process.platform === "win32") return;

  const shell = process.env.SHELL ?? (process.platform === "darwin" ? "/bin/zsh" : "/bin/sh");
  const commandArgSets = [
    ["-ilc", "echo -n $PATH"],
    ["-lc", "echo -n $PATH"],
  ] as const;

  for (const args of commandArgSets) {
    try {
      const result = ChildProcess.execFileSync(shell, args, {
        encoding: "utf8",
        timeout: 5000,
      });
      if (result) {
        process.env.PATH = result;
        return;
      }
    } catch {
      // Try the next shell invocation mode.
    }
  }

  // Keep inherited PATH if shell lookup fails.
}
