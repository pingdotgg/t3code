// @effect-diagnostics nodeBuiltinImport:off - Runs the standalone tools against disposable on-disk fixtures.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { afterEach, describe, expect, it } from "vite-plus/test";

const directories: string[] = [];
// oxlint-disable-next-line t3code/no-global-process-runtime -- Standalone tooling tests run without an Effect runtime.
const platform = NodeOS.platform();
function temporaryDirectory() {
  const path = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-qt-tooling-"));
  directories.push(path);
  return path;
}
afterEach(() => {
  for (const directory of directories.splice(0))
    NodeFS.rmSync(directory, { recursive: true, force: true });
});

describe.skipIf(platform === "win32")("Qt tooling", () => {
  it("finds the test runner in a later CMAKE_PREFIX_PATH entry", () => {
    const directory = temporaryDirectory();
    const prefix = NodePath.join(directory, "qt");
    NodeFS.mkdirSync(NodePath.join(prefix, "bin"), { recursive: true });
    NodeFS.writeFileSync(
      NodePath.join(prefix, "bin/qmltestrunner"),
      '#!/bin/sh\nprintf "%s\\n" "$@"\n',
      { mode: 0o755 },
    );
    const result = NodeChildProcess.spawnSync(
      process.execPath,
      [NodeURL.fileURLToPath(new URL("./test-qml.mjs", import.meta.url))],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          QT_ROOT_DIR: "",
          QT_PREFIX: "",
          CMAKE_PREFIX_PATH: [NodePath.join(directory, "missing"), prefix].join(NodePath.delimiter),
        },
      },
    );
    expect(result.status).toBe(0);
    expect(result.stdout.trim().split("\n")).toEqual([
      "-input",
      "tests",
      "-import",
      "tests/imports",
    ]);
  });

  it.skipIf(platform !== "linux")(
    "rejects tampered cached packaging tools before installing or executing them",
    () => {
      const directory = temporaryDirectory();
      NodeFS.mkdirSync(NodePath.join(directory, "tools"));
      NodeFS.mkdirSync(NodePath.join(directory, "AppDir"));
      NodeFS.writeFileSync(NodePath.join(directory, "AppDir/keep"), "existing staging directory");
      NodeFS.writeFileSync(
        NodePath.join(directory, "tools/linuxdeploy-1-alpha-20251107-1"),
        "tampered tool",
        { mode: 0o755 },
      );
      const result = NodeChildProcess.spawnSync(
        "bash",
        [NodeURL.fileURLToPath(new URL("./package-linux.sh", import.meta.url)), directory],
        { encoding: "utf8" },
      );
      expect(result.status).not.toBe(0);
      expect(NodeFS.readFileSync(NodePath.join(directory, "AppDir/keep"), "utf8")).toBe(
        "existing staging directory",
      );
    },
  );
});
