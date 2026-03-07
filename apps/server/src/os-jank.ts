import * as OS from "node:os";
import { Effect, Path } from "effect";
import { execFileSync } from "node:child_process";

export function fixPath(): void {
  if (process.platform === "win32") return;

  const shell = process.env.SHELL ?? (process.platform === "darwin" ? "/bin/zsh" : "/bin/sh");
  const commandArgSets = [
    ["-ilc", "echo -n $PATH"],
    ["-lc", "echo -n $PATH"],
  ] as const;

  for (const args of commandArgSets) {
    try {
      const result = execFileSync(shell, args, {
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

  // Silently ignore and keep default PATH.
}

export const expandHomePath = Effect.fn(function* (input: string) {
  const { join, sep } = yield* Path.Path;
  if (input === "~") {
    return OS.homedir();
  }
  if (input.startsWith(`~${sep}`)) {
    return join(OS.homedir(), input.slice(sep.length));
  }
  return input;
});

export const resolveStateDir = Effect.fn(function* (raw: string | undefined) {
  const { join, resolve } = yield* Path.Path;
  if (!raw || raw.trim().length === 0) {
    return join(OS.homedir(), ".t3", "userdata");
  }
  return resolve(yield* expandHomePath(raw.trim()));
});
