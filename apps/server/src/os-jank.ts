import * as OS from "node:os";
import { Effect, Path } from "effect";
import { execFileSync } from "node:child_process";

export function fixPath(): void {
  if (process.platform !== "darwin") return;

  try {
    const shell = process.env.SHELL ?? "/bin/zsh";
    const result = execFileSync(shell, ["-ilc", "echo -n $PATH"], {
      encoding: "utf8",
      timeout: 5000,
    });
    if (result) {
      process.env.PATH = result;
    }
  } catch {
    // Silently ignore — keep default PATH
  }
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
