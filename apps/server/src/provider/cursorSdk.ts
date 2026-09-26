// @effect-diagnostics nodeBuiltinImport:off - the SDK must load from disk through createRequire,
// and its helper paths are set synchronously before any Effect runtime uses it.
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";

type CursorSdk = typeof import("@cursor/sdk");

interface CursorSdkHost {
  readonly platform: NodeJS.Platform;
  readonly arch: NodeJS.Architecture;
}

// Cursor's Webpack chunks and local helpers must stay beside the SDK entry.
// createRequire also loads that disk-backed package from a Node SEA executable.
const requireCursorSdk = NodeModule.createRequire(import.meta.url);
let cursorSdk: CursorSdk | undefined;

/** Finds the `@cursor/sdk-<platform>-<arch>` package installed with the SDK. */
function resolveCursorSdkPlatformPackage(host: CursorSdkHost): string | undefined {
  try {
    const requireFromSdk = NodeModule.createRequire(requireCursorSdk.resolve("@cursor/sdk"));
    return NodePath.dirname(
      requireFromSdk.resolve(`@cursor/sdk-${host.platform}-${host.arch}/package.json`),
    );
  } catch {
    // Cursor ships no helpers for this platform. The SDK falls back to PATH.
    return undefined;
  }
}

/**
 * Points the SDK's ripgrep and tree-sitter lookups at the platform package
 * installed with the SDK. Without these, the SDK searches up from
 * `process.argv[1]`, which is the current folder when the single-file CLI runs
 * through a PATH symlink. Values that are already set win, so users can
 * override them. The SDK takes these paths only from the environment.
 */
export function setCursorSdkHelperEnvironment(
  env: NodeJS.ProcessEnv,
  host: CursorSdkHost,
  packageDir = resolveCursorSdkPlatformPackage(host),
): void {
  if (packageDir === undefined) return;
  const ripgrep = NodePath.join(packageDir, "bin", host.platform === "win32" ? "rg.exe" : "rg");
  const vendor = NodePath.join(packageDir, "vendor");
  if (!env.CURSOR_RIPGREP_PATH && NodeFS.existsSync(ripgrep)) {
    env.CURSOR_RIPGREP_PATH = ripgrep;
  }
  if (
    !env.CURSOR_TREE_SITTER_VENDOR_DIR &&
    NodeFS.existsSync(NodePath.join(vendor, "tree-sitter", "index.js"))
  ) {
    env.CURSOR_TREE_SITTER_VENDOR_DIR = vendor;
  }
}

/**
 * Loads `@cursor/sdk` on first use. It takes about 300 ms and 80 MB, so a
 * server that never enables Cursor never loads it. Call it inside the effect
 * that needs the SDK, so a load failure fails that effect only.
 */
export function loadCursorSdk(): CursorSdk {
  if (cursorSdk === undefined) {
    // The SDK reads its helpers for the real host, outside any Effect runtime.
    // oxlint-disable-next-line t3code/no-global-process-runtime
    setCursorSdkHelperEnvironment(process.env, { platform: process.platform, arch: process.arch });
    cursorSdk = requireCursorSdk("@cursor/sdk") as CursorSdk;
  }
  return cursorSdk;
}
