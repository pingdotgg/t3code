import { accessSync, constants, statSync } from "node:fs";
import { extname, isAbsolute, resolve } from "node:path";

export function stripWrappingQuotes(value: string): string {
  return value.replace(/^"+|"+$/g, "");
}

export function resolvePathEnvironmentVariable(env: NodeJS.ProcessEnv): string {
  return env.PATH ?? env.Path ?? env.path ?? "";
}

export function resolveWindowsPathExtensions(env: NodeJS.ProcessEnv): ReadonlyArray<string> {
  const rawValue = env.PATHEXT;
  const fallback = [".COM", ".EXE", ".BAT", ".CMD"];
  if (!rawValue) return fallback;

  const parsed = rawValue
    .split(";")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map((entry) => (entry.startsWith(".") ? entry.toUpperCase() : `.${entry.toUpperCase()}`));

  return parsed.length > 0 ? Array.from(new Set(parsed)) : fallback;
}

export function resolveCommandCandidates(
  command: string,
  platform: NodeJS.Platform,
  windowsPathExtensions: ReadonlyArray<string>,
): ReadonlyArray<string> {
  if (platform !== "win32") {
    return [command];
  }

  const extension = extname(command);
  const normalizedExtension = extension.toUpperCase();

  if (extension.length > 0 && windowsPathExtensions.includes(normalizedExtension)) {
    const commandWithoutExtension = command.slice(0, -extension.length);
    return Array.from(
      new Set([
        command,
        `${commandWithoutExtension}${normalizedExtension}`,
        `${commandWithoutExtension}${normalizedExtension.toLowerCase()}`,
      ]),
    );
  }

  const candidates: string[] = [command];
  for (const candidateExtension of windowsPathExtensions) {
    candidates.push(`${command}${candidateExtension}`);
    candidates.push(`${command}${candidateExtension.toLowerCase()}`);
  }
  return Array.from(new Set(candidates));
}

interface ResolveExecutableFileOptions {
  readonly platform: NodeJS.Platform;
  readonly windowsPathExtensions: ReadonlyArray<string>;
  readonly cwd?: string | undefined;
}

export function resolveExecutableFile(
  filePath: string,
  options: ResolveExecutableFileOptions,
): string | null {
  const candidatePath =
    options.cwd !== undefined && !isAbsolute(filePath) ? resolve(options.cwd, filePath) : filePath;

  try {
    const stat = statSync(candidatePath);
    if (!stat.isFile()) return null;

    if (options.platform === "win32") {
      const extension = extname(candidatePath);
      if (extension.length === 0) return null;
      return options.windowsPathExtensions.includes(extension.toUpperCase()) ? candidatePath : null;
    }

    accessSync(candidatePath, constants.X_OK);
    return candidatePath;
  } catch {
    return null;
  }
}

export function isExecutableFile(
  filePath: string,
  options: ResolveExecutableFileOptions,
): boolean {
  return resolveExecutableFile(filePath, options) !== null;
}
