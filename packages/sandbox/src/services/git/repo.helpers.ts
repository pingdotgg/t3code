import { posix as path } from "node:path";
import * as Effect from "effect/Effect";

import { InvalidRepositorySetupError } from "./repo.errors";
import type { PrepareRepositoryOptions } from "./repo.service";

export interface NormalizedRepositorySetup {
  readonly setupCommands: readonly string[];
  readonly envFiles: readonly {
    readonly path: string;
    readonly content: string;
  }[];
}

export function normalizeEnvFilePath(rawPath: string): string | undefined {
  const trimmed = rawPath.trim();
  if (trimmed.length === 0 || path.isAbsolute(trimmed)) {
    return undefined;
  }

  const normalized = path.normalize(trimmed);
  if (
    normalized === "." ||
    normalized.startsWith("../") ||
    normalized === ".." ||
    normalized.includes("/../")
  ) {
    return undefined;
  }

  return normalized.replace(/^\.\/+/u, "");
}

export function normalizeRepositorySetup(
  setup: PrepareRepositoryOptions["setup"],
): Effect.Effect<NormalizedRepositorySetup, InvalidRepositorySetupError> {
  const rawCommands = setup?.setupCommands ?? [];
  const rawEnvFiles = setup?.envFiles ?? [];
  const setupCommands: string[] = [];

  for (const command of rawCommands) {
    const normalizedCommand = command.trim();
    if (normalizedCommand.length === 0) {
      return Effect.fail(
        new InvalidRepositorySetupError({
          message: "Setup commands must not be empty.",
        }),
      );
    }

    setupCommands.push(normalizedCommand);
  }

  const envFiles: Array<{ path: string; content: string }> = [];
  const seenPaths = new Set<string>();
  for (const envFile of rawEnvFiles) {
    const normalizedPath = normalizeEnvFilePath(envFile.path);
    if (!normalizedPath) {
      return Effect.fail(
        new InvalidRepositorySetupError({
          message: `Env file path "${envFile.path}" must be relative to the repo root and must not contain "..".`,
        }),
      );
    }

    if (seenPaths.has(normalizedPath)) {
      return Effect.fail(
        new InvalidRepositorySetupError({
          message: `Env file path "${normalizedPath}" was provided more than once.`,
        }),
      );
    }

    seenPaths.add(normalizedPath);
    envFiles.push({
      path: normalizedPath,
      content: envFile.content,
    });
  }

  return Effect.succeed({
    setupCommands,
    envFiles,
  } satisfies NormalizedRepositorySetup);
}
