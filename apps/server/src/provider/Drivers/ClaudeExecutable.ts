// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { SpawnExecutableResolution } from "@t3tools/shared/shell";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";

/**
 * Windows launcher-script extensions that Node cannot spawn without a shell
 * (`spawn EINVAL` since Node 20.12) and that the Claude Agent SDK therefore
 * cannot use as `pathToClaudeCodeExecutable`.
 */
const WINDOWS_SHIM_EXTENSIONS: ReadonlySet<string> = new Set([".cmd", ".bat", ".ps1"]);

/**
 * Entry points of the npm `@anthropic-ai/claude-code` package relative to the
 * global `node_modules` directory that sits next to the npm launcher shim.
 * Newer package versions ship a native `bin/claude.exe`; older versions only
 * ship `cli.js`, which the SDK runs with a JavaScript runtime.
 *
 * Kept as a fallback after {@link extractShimRelativeTargets} — that parser
 * covers this layout too, but this list is cheap, exactly matches npm's
 * documented layout, and protects against a shim format the parser doesn't
 * anticipate.
 */
const NPM_PACKAGE_ENTRY_CANDIDATES = [
  ["node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe"],
  ["node_modules", "@anthropic-ai", "claude-code", "cli.js"],
] as const;

/**
 * Matches the launcher's own directory reference in `.cmd`/`.bat` shims
 * (`%~dp0\...` or `%dp0%\...`), capturing everything up to the closing quote
 * or line end.
 */
const CMD_DP0_REFERENCE_PATTERN = /%~?dp0%?[\\/]([^"'\r\n]+)/gi;

/**
 * Matches the launcher's own directory reference in `.ps1` shims
 * (`$basedir/...`), capturing everything up to the closing quote, a `$`
 * (variable interpolation, e.g. `$basedir/node$exe`), or line end.
 */
const PS1_BASEDIR_REFERENCE_PATTERN = /\$basedir[\\/]([^"'\r\n$]+)/gi;

export type ExecutableFileCheck = (filePath: string) => boolean;
export type ShimScriptReader = (filePath: string) => string | undefined;

function isExistingFile(filePath: string): boolean {
  try {
    return NodeFS.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function readShimScript(filePath: string): string | undefined {
  try {
    return NodeFS.readFileSync(filePath, "utf8");
  } catch {
    return undefined;
  }
}

/** Injectable file-existence check so tests can run against a fake filesystem. */
export const ClaudeExecutableFileCheck = Context.Reference<ExecutableFileCheck>(
  "server/provider/Drivers/ClaudeExecutableFileCheck",
  {
    defaultValue: () => isExistingFile,
  },
);

/** Injectable shim-script reader so tests can run against fake shim contents. */
export const ClaudeExecutableShimReader = Context.Reference<ShimScriptReader>(
  "server/provider/Drivers/ClaudeExecutableShimReader",
  {
    defaultValue: () => readShimScript,
  },
);

function isNodeExecutableTarget(relativeTarget: string): boolean {
  const base = NodePath.win32.basename(relativeTarget).toLowerCase();
  return base === "node.exe" || base === "node";
}

/**
 * Extracts candidate real-target paths (relative to the shim's own
 * directory) from a launcher shim's source text.
 *
 * Both npm and pnpm generate `.cmd`/`.bat`/`.ps1` launcher shims from the
 * same underlying convention (`cmd-shim`): the script resolves its own
 * directory (`%~dp0` / `$basedir`) and invokes the real entry point via a
 * path relative to it. npm keeps that target at a fixed
 * `node_modules/<pkg>/...` layout, but pnpm's global shims point into a
 * version-pinned pnpm store path instead
 * (`global/5/.pnpm/<pkg>@<version>/node_modules/<pkg>/...`), which no fixed
 * candidate list can anticipate. Parsing the shim's own reference works for
 * both, and for any other tool built on the same convention (e.g. corepack).
 */
function extractShimRelativeTargets(shimContent: string, extension: string): ReadonlyArray<string> {
  const pattern = extension === ".ps1" ? PS1_BASEDIR_REFERENCE_PATTERN : CMD_DP0_REFERENCE_PATTERN;
  const targets: Array<string> = [];
  for (const match of shimContent.matchAll(pattern)) {
    const relative = match[1]?.trim();
    if (relative && relative.length > 0) {
      targets.push(relative.replace(/\//g, "\\"));
    }
  }
  return targets;
}

/**
 * Resolves the configured Claude binary path into a value the Claude Agent
 * SDK can spawn directly via `pathToClaudeCodeExecutable`.
 *
 * The SDK spawns the given path without a shell and without Windows PATH /
 * PATHEXT resolution, so a bare command name like `claude` fails with
 * "native binary not found" and an npm `claude.cmd` shim fails with
 * `spawn EINVAL`. CLI probes avoid this via `resolveSpawnCommand`, which can
 * fall back to `shell: true`; the SDK offers no such escape hatch.
 *
 * On Windows this resolves the command against PATH/PATHEXT and, when the
 * result is an npm launcher shim, follows it to the real package entry
 * (`bin/claude.exe`, or `cli.js` for older package versions). On other
 * platforms the configured value is returned unchanged.
 */
export const resolveClaudeSdkExecutablePath = Effect.fn("resolveClaudeSdkExecutablePath")(
  function* (binaryPath: string, environment: NodeJS.ProcessEnv): Effect.fn.Return<string> {
    const platform = yield* HostProcessPlatform;
    if (platform !== "win32") {
      return binaryPath;
    }

    const resolveExecutable = yield* SpawnExecutableResolution;
    const isFile = yield* ClaudeExecutableFileCheck;
    const readShim = yield* ClaudeExecutableShimReader;
    const resolved = resolveExecutable(binaryPath, platform, environment) ?? binaryPath;
    const extension = NodePath.win32.extname(resolved).toLowerCase();
    if (!WINDOWS_SHIM_EXTENSIONS.has(extension)) {
      return resolved;
    }

    const shimDirectory = NodePath.win32.dirname(resolved);
    const shimContent = readShim(resolved);
    if (shimContent) {
      for (const relativeTarget of extractShimRelativeTargets(shimContent, extension)) {
        if (isNodeExecutableTarget(relativeTarget)) {
          continue;
        }
        const candidate = NodePath.win32.join(shimDirectory, relativeTarget);
        if (isFile(candidate)) {
          return candidate;
        }
      }
    }

    for (const entrySegments of NPM_PACKAGE_ENTRY_CANDIDATES) {
      const candidate = NodePath.win32.join(shimDirectory, ...entrySegments);
      if (isFile(candidate)) {
        return candidate;
      }
    }

    yield* Effect.logWarning(
      "Claude launcher shim resolved but no known package entry was found next to it; the Claude Agent SDK cannot spawn launcher scripts directly.",
      { binaryPath, resolvedShimPath: resolved },
    );
    return binaryPath;
  },
);
