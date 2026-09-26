// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { setCursorSdkHelperEnvironment } from "./cursorSdk.ts";

const linux = { platform: "linux", arch: "x64" } as const;
// The real-install check needs the real host, outside any Effect runtime.
// oxlint-disable-next-line t3code/no-global-process-runtime
const host = { platform: process.platform, arch: process.arch };
const CURSOR_HELPER_PLATFORMS = new Set([
  "darwin-arm64",
  "darwin-x64",
  "linux-arm64",
  "linux-x64",
  "win32-x64",
]);
const scratchDirs: Array<string> = [];

function makeScratchDir(): string {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-cursor-helpers-"));
  scratchDirs.push(dir);
  return dir;
}

function makePlatformPackage(): string {
  const dir = makeScratchDir();
  NodeFS.mkdirSync(NodePath.join(dir, "bin"));
  NodeFS.writeFileSync(NodePath.join(dir, "bin", "rg"), "");
  NodeFS.mkdirSync(NodePath.join(dir, "vendor", "tree-sitter"), { recursive: true });
  NodeFS.writeFileSync(NodePath.join(dir, "vendor", "tree-sitter", "index.js"), "");
  return dir;
}

afterEach(() => {
  for (const dir of scratchDirs.splice(0)) NodeFS.rmSync(dir, { recursive: true, force: true });
});

describe("setCursorSdkHelperEnvironment", () => {
  it("points ripgrep and tree-sitter at the platform package", () => {
    const packageDir = makePlatformPackage();
    const env: NodeJS.ProcessEnv = {};

    setCursorSdkHelperEnvironment(env, linux, packageDir);

    expect(env).toEqual({
      CURSOR_RIPGREP_PATH: NodePath.join(packageDir, "bin", "rg"),
      CURSOR_TREE_SITTER_VENDOR_DIR: NodePath.join(packageDir, "vendor"),
    });
  });

  it("keeps paths the user already set", () => {
    const env: NodeJS.ProcessEnv = {
      CURSOR_RIPGREP_PATH: "/opt/rg",
      CURSOR_TREE_SITTER_VENDOR_DIR: "/opt/vendor",
    };

    setCursorSdkHelperEnvironment(env, linux, makePlatformPackage());

    expect(env).toEqual({
      CURSOR_RIPGREP_PATH: "/opt/rg",
      CURSOR_TREE_SITTER_VENDOR_DIR: "/opt/vendor",
    });
  });

  it("leaves the SDK lookup alone when the package has no helpers", () => {
    const env: NodeJS.ProcessEnv = {};

    setCursorSdkHelperEnvironment(env, linux, makeScratchDir());

    expect(env).toEqual({});
  });

  it.skipIf(!CURSOR_HELPER_PLATFORMS.has(`${host.platform}-${host.arch}`))(
    "finds the platform package installed with the SDK",
    () => {
      const env: NodeJS.ProcessEnv = {};

      setCursorSdkHelperEnvironment(env, host);

      const ripgrep = env.CURSOR_RIPGREP_PATH ?? "";
      expect(NodePath.isAbsolute(ripgrep)).toBe(true);
      const packageDir = NodePath.dirname(NodePath.dirname(ripgrep));
      const manifest: unknown = JSON.parse(
        NodeFS.readFileSync(NodePath.join(packageDir, "package.json"), "utf8"),
      );
      expect(manifest).toMatchObject({ name: `@cursor/sdk-${host.platform}-${host.arch}` });
      expect(env.CURSOR_TREE_SITTER_VENDOR_DIR).toBe(NodePath.join(packageDir, "vendor"));
    },
  );
});
