// @effect-diagnostics nodeBuiltinImport:off - Runs the rendered launcher in a real shell.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  type CliShimTarget,
  LEGACY_MARKER,
  MARKER,
  isOurLauncher,
  renderCliShim,
} from "./DesktopCliShim.ts";

const directories: Array<string> = [];
afterEach(() => {
  for (const directory of directories.splice(0)) {
    NodeFS.rmSync(directory, { recursive: true, force: true });
  }
});

const tempRoot = () => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-cli-shim-"));
  directories.push(root);
  return root;
};

const writeExecutable = (path: string, content: string) => {
  NodeFS.mkdirSync(NodePath.dirname(path), { recursive: true });
  NodeFS.writeFileSync(path, content, { mode: 0o755 });
};

const writeShim = (root: string, target: CliShimTarget) => {
  const shim = NodePath.join(root, "bin", "ominax");
  writeExecutable(shim, renderCliShim({ target, shimPath: shim, t3Home: `${root}/home` }));
  return shim;
};

const run = (shim: string, args: ReadonlyArray<string>, env: NodeJS.ProcessEnv = {}) =>
  NodeChildProcess.spawnSync(shim, args, {
    encoding: "utf8",
    env: { PATH: process.env.PATH, ...env },
  });

const REPORTER =
  '#!/bin/sh\necho "node=$ELECTRON_RUN_AS_NODE cli=$T3CODE_CLI_PATH home=$T3CODE_HOME"\nprintf "%s\\n" "$@"\nexit 3\n';

const fakeAppImage = (canMount = true) => {
  const root = tempRoot();
  const image = NodePath.join(root, "image");
  writeExecutable(NodePath.join(image, "t3learn"), REPORTER);
  const appImage = NodePath.join(root, "T3 Learn.AppImage");
  writeExecutable(
    appImage,
    [
      "#!/bin/sh",
      `if [ "$1" = --appimage-extract ]; then cp -R '${image}' squashfs-root; exit 0; fi`,
      '[ "$1" = --appimage-mount ] || exit 9',
      '[ -n "$APPIMAGE_EXTRACT_AND_RUN" ] && exit 8',
      canMount ? `echo '${image}'` : 'echo "Cannot mount AppImage"; exit 1',
      `trap 'touch "${root}/unmounted"; exit 0' TERM`,
      "while :; do sleep 0.05; done",
      "",
    ].join("\n"),
  );
  const shim = writeShim(root, { kind: "appimage", appImage, executableName: "t3learn" });
  return { root, image, appImage, shim };
};

describe("renderCliShim", () => {
  it("recognizes both launcher marker generations", () => {
    expect(isOurLauncher(MARKER)).toBe(true);
    expect(isOurLauncher(LEGACY_MARKER)).toBe(true);
    expect(isOurLauncher("foreign launcher")).toBe(false);
  });

  it("writes launchers a pre-rename build still recognises after a rollback", () => {
    const posix = renderCliShim({
      target: { kind: "direct", executable: "/opt/OminaX/ominax", entry: "/opt/bin.mjs" },
      shimPath: "/home/me/.ominax/bin/ominax",
      t3Home: "/home/me/.ominax",
    });
    const windows = renderCliShim({
      target: { kind: "windows", executable: "C:\\Apps\\OminaX.exe", entry: "C:\\bin.mjs" },
      shimPath: "C:\\Users\\Me\\.ominax\\bin\\ominax.cmd",
      t3Home: "C:\\Users\\Me\\.ominax",
    });
    expect(posix).toContain(`# ${LEGACY_MARKER}`);
    expect(windows).toContain(`rem ${LEGACY_MARKER}`);
  });

  it("extracts the AppImage where it cannot be mounted", () => {
    const { shim } = fakeAppImage(false);
    const result = run(shim, ["--version"], { APPIMAGE_EXTRACT_AND_RUN: "1" });
    expect(result.status).toBe(3);
    expect(result.stdout).toMatch(
      /squashfs-root\/resources\/app\.asar\/apps\/server\/dist\/bin\.mjs/,
    );
  });

  it("prefers OMINAX_HOME, then T3LEARN_HOME, over the baked home", () => {
    const root = tempRoot();
    writeExecutable(NodePath.join(root, "app"), REPORTER);
    const shim = writeShim(root, {
      kind: "direct",
      executable: NodePath.join(root, "app"),
      entry: "/bin.mjs",
    });
    expect(run(shim, []).stdout).toContain(`home=${root}/home`);
    expect(run(shim, [], { T3CODE_HOME: "/t3code-home" }).stdout).toContain(`home=${root}/home`);
    expect(run(shim, [], { T3LEARN_HOME: "/elsewhere" }).stdout).toContain("home=/elsewhere");
    expect(run(shim, [], { OMINAX_HOME: "/ominax" }).stdout).toContain("home=/ominax");
    expect(
      run(shim, [], { T3CODE_HOME: "/t3code-home", T3LEARN_HOME: "/elsewhere" }).stdout,
    ).toContain("home=/elsewhere");
    expect(run(shim, [], { OMINAX_HOME: "/ominax", T3LEARN_HOME: "/elsewhere" }).stdout).toContain(
      "home=/ominax",
    );
    const relative = NodeChildProcess.spawnSync("./bin/ominax", [], {
      cwd: root,
      encoding: "utf8",
    });
    expect(relative.stdout).toContain(`cli=${shim}`);
  });

  it("runs an installed app's server directly", () => {
    const root = tempRoot();
    const executable = NodePath.join(root, "opt", "T3 Learn", "t3learn");
    writeExecutable(executable, REPORTER);
    const shim = writeShim(root, {
      kind: "direct",
      executable,
      entry: "/opt/T3's/app.asar/bin.mjs",
    });
    // Launchers written by released installs are recognised by this exact text.
    expect(NodeFS.readFileSync(shim, "utf8")).toContain(
      "Written by OminaX: runs the desktop app's bundled t3 CLI.",
    );
    expect(run(shim, ["browser", "setup"]).stdout.split("\n").slice(1)).toEqual([
      "/opt/T3's/app.asar/bin.mjs",
      "browser",
      "setup",
      "",
    ]);
  });

  it("writes a Windows launcher that keeps cmd from reinterpreting paths", () => {
    const executable = "C:\\Apps\\R&whoami&X 100%\\!CHANNEL!\\T3 Learn.exe";
    const script = renderCliShim({
      target: { kind: "windows", executable, entry: "C:\\Apps\\server.asar\\bin.mjs" },
      shimPath: "C:\\Users\\José\\.ominax\\bin\\ominax.cmd",
      t3Home: "C:\\Users\\José\\.ominax",
    });
    const lines = script.split("\r\n");
    expect(lines).toContain("setlocal EnableExtensions DisableDelayedExpansion");
    expect(lines).toContain("chcp 65001 >nul");
    expect(lines).toContain(
      'if exist "C:\\Apps\\R&whoami&X 100%%\\!CHANNEL!\\T3 Learn.exe" goto run',
    );
    const bare = lines.filter(
      (line) => line.includes("whoami") && !/"[^"]*whoami[^"]*"/.test(line),
    );
    expect(bare).toEqual([]);
    expect(lines).toContain('set "T3CODE_CLI_PATH=C:\\Users\\José\\.ominax\\bin\\ominax.cmd"');
  });

  it("writes a Windows launcher that ignores T3 Code's T3CODE_HOME but honors T3LEARN_HOME", () => {
    const lines = renderCliShim({
      target: { kind: "windows", executable: "C:\\Apps\\T3 Learn.exe", entry: "C:\\bin.mjs" },
      shimPath: "C:\\Users\\Me\\.ominax\\bin\\ominax.cmd",
      t3Home: "C:\\Users\\Me\\.ominax",
    }).split("\r\n");
    const homeLines = lines.filter((line) => line.includes("T3CODE_HOME"));
    expect(homeLines).toEqual([
      'set "T3CODE_HOME=C:\\Users\\Me\\.ominax"',
      'if defined T3LEARN_HOME set "T3CODE_HOME=%T3LEARN_HOME%"',
      'if defined OMINAX_HOME set "T3CODE_HOME=%OMINAX_HOME%"',
    ]);
  });
});
