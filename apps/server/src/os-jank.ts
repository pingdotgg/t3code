import * as OS from "node:os";
import { Effect, Path } from "effect";
import { defaultShellCandidates, resolvePathFromLoginShells } from "@t3tools/shared/shell";

export function fixPath(): void {
  if (process.platform !== "darwin" && process.platform !== "linux") return;

  const shells = defaultShellCandidates();

  const resolvedPath = resolvePathFromLoginShells(shells);
  if (resolvedPath) {
    process.env.PATH = resolvedPath;
  }
}

export const expandHomePath = Effect.fn(function* (input: string) {
  const { join } = yield* Path.Path;
  if (input === "~") {
    return OS.homedir();
  }
  if (input.startsWith("~/") || input.startsWith("~\\")) {
    return join(OS.homedir(), input.slice(2));
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
