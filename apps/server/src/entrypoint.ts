// @effect-diagnostics nodeBuiltinImport:off
// Entrypoint detection runs before any Effect runtime is built, so it stays on
// Node built-ins.
import * as NodeFS from "node:fs";
import * as NodeURL from "node:url";

/**
 * Whether the module identified by `moduleUrl` is the process entrypoint.
 *
 * `import.meta.main` answers this directly, but it only exists on Node 22.18+
 * and 24.2+. This package's `engines.node` range also accepts 22.16, 22.17 and
 * 23.11, where it is `undefined`: an `if (import.meta.main)` guard never runs,
 * so the process loads every module and exits 0 without output. Fall back to
 * comparing the entrypoint path on those versions.
 */
export const isEntrypoint = (input: {
  readonly moduleUrl: string;
  readonly entryPath: string | undefined;
  readonly runtimeMain: boolean | undefined;
}): boolean => {
  if (input.runtimeMain !== undefined) {
    return input.runtimeMain;
  }
  if (input.entryPath === undefined || input.entryPath === "") {
    return false;
  }
  if (input.moduleUrl === NodeURL.pathToFileURL(input.entryPath).href) {
    return true;
  }
  // npm and npx install the CLI as a symlink. Without `--preserve-symlinks` the
  // module URL is the resolved real path while `process.argv[1]` keeps the link
  // path, so the comparison above misses.
  try {
    return input.moduleUrl === NodeURL.pathToFileURL(NodeFS.realpathSync(input.entryPath)).href;
  } catch {
    return false;
  }
};
