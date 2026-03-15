import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const CLAUDE_AGENT_SDK_PACKAGE = "@anthropic-ai/claude-agent-sdk";

export interface ResolveClaudeCodeExecutablePathOptions {
  readonly resolvePackageEntry?: (specifier: string) => string;
  readonly exists?: (path: string) => boolean;
}

const defaultResolvePackageEntry = createRequire(import.meta.url).resolve;

export function toAsarUnpackedPath(path: string): string {
  return path.replace(/\.asar(?=$|[\\/])/, ".asar.unpacked");
}

export function resolveClaudeCodeExecutablePath(
  options: ResolveClaudeCodeExecutablePathOptions = {},
): string | undefined {
  const resolvePackageEntry = options.resolvePackageEntry ?? defaultResolvePackageEntry;
  const exists = options.exists ?? existsSync;

  let packageEntry: string;
  try {
    packageEntry = resolvePackageEntry(CLAUDE_AGENT_SDK_PACKAGE);
  } catch {
    return undefined;
  }

  const packagedCliPath = join(dirname(packageEntry), "cli.js");
  const unpackedCliPath = toAsarUnpackedPath(packagedCliPath);

  if (unpackedCliPath !== packagedCliPath && exists(unpackedCliPath)) {
    return unpackedCliPath;
  }
  if (exists(packagedCliPath)) {
    return packagedCliPath;
  }

  return undefined;
}
