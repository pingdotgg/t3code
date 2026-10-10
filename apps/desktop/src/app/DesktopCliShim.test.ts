// @effect-diagnostics nodeBuiltinImport:off - Runs the rendered launcher in a real shell.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, describe, expect, it } from "vite-plus/test";

import { type CliShimTarget, renderCliShim } from "./DesktopCliShim.ts";

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

/** Writes the launcher for `target` at `<root>/bin/t3`, with `<root>/home` as its T3 home. */
const writeShim = (root: string, target: CliShimTarget) => {
  const shim = NodePath.join(root, "bin", "t3");
  writeExecutable(shim, renderCliShim({ target, shimPath: shim, t3Home: `${root}/home` }));
  return shim;
};

const run = (shim: string, args: ReadonlyArray<string>, env: NodeJS.ProcessEnv = {}) =>
  NodeChildProcess.spawnSync(shim, args, {
    encoding: "utf8",
    env: { PATH: process.env.PATH, ...env },
  });

/** An app executable that reports its environment and arguments. */
const REPORTER =
  '#!/bin/sh\necho "node=$ELECTRON_RUN_AS_NODE cli=$T3CODE_CLI_PATH home=$T3CODE_HOME"\nprintf "%s\\n" "$@"\nexit 3\n';

/**
 * A stand-in AppImage whose image holds the reporter. `--appimage-mount`
 * prints the mount and stays up until killed, recording that it was; with
 * `canMount` false it fails like a host without FUSE. `--appimage-extract`
 * unpacks into ./squashfs-root.
 */
const fakeAppImage = (canMount = true) => {
  const root = tempRoot();
  const image = NodePath.join(root, "image");
  writeExecutable(NodePath.join(image, "t3code"), REPORTER);
  const appImage = NodePath.join(root, "T3 Code.AppImage");
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
  const shim = writeShim(root, { kind: "appimage", appImage, executableName: "t3code" });
  return { root, image, appImage, shim };
};

describe("renderCliShim", () => {
  it("runs the AppImage's bundled CLI with every argument and unmounts after", () => {
    const { root, image, shim } = fakeAppImage();
    const result = run(shim, ["browser", "setup", "a b"]);
    expect(result.status).toBe(3);
    expect(result.stdout.split("\n")).toEqual([
      `node=1 cli=${shim} home=${root}/home`,
      `${image}/resources/app.asar/apps/server/dist/bin.mjs`,
      "browser",
      "setup",
      "a b",
      "",
    ]);
    // The trap kills the mount helper as the launcher exits.
    NodeChildProcess.spawnSync("sh", [
      "-c",
      `i=0; while [ ! -e '${root}/unmounted' ] && [ $i -lt 40 ]; do sleep 0.05; i=$((i+1)); done`,
    ]);
    expect(NodeFS.existsSync(NodePath.join(root, "unmounted"))).toBe(true);
  });

  it("extracts the AppImage where it cannot be mounted", () => {
    const { shim } = fakeAppImage(false);
    // Extract-and-run is ignored too, so the runtime never starts the app.
    const result = run(shim, ["--version"], { APPIMAGE_EXTRACT_AND_RUN: "1" });
    expect(result.status).toBe(3);
    expect(result.stdout).toMatch(
      /squashfs-root\/resources\/app\.asar\/apps\/server\/dist\/bin\.mjs/,
    );
  });

  it("keeps the install's T3 home under sudo, unless one is set", () => {
    const root = tempRoot();
    writeExecutable(NodePath.join(root, "app"), REPORTER);
    const shim = writeShim(root, {
      kind: "direct",
      executable: NodePath.join(root, "app"),
      entry: "/bin.mjs",
    });
    // sudo clears the environment, so the launcher supplies its own.
    expect(run(shim, []).stdout).toContain(`home=${root}/home`);
    expect(run(shim, [], { T3CODE_HOME: "/elsewhere" }).stdout).toContain("home=/elsewhere");
    // Run by a relative path, it still names itself absolutely.
    const relative = NodeChildProcess.spawnSync("./bin/t3", [], { cwd: root, encoding: "utf8" });
    expect(relative.stdout).toContain(`cli=${shim}`);
  });

  it("runs an installed app's server directly", () => {
    const root = tempRoot();
    const executable = NodePath.join(root, "opt", "T3 Code", "t3code");
    writeExecutable(executable, REPORTER);
    const shim = writeShim(root, {
      kind: "direct",
      executable,
      entry: "/opt/T3's/app.asar/bin.mjs",
    });
    expect(run(shim, ["browser", "setup"]).stdout.split("\n").slice(1)).toEqual([
      "/opt/T3's/app.asar/bin.mjs",
      "browser",
      "setup",
      "",
    ]);
  });

  it("tells a person whose app moved to reopen it", () => {
    const root = tempRoot();
    const shim = writeShim(root, {
      kind: "direct",
      executable: NodePath.join(root, "Gone.app/Contents/MacOS/T3 Code"),
      entry: "/bin.mjs",
    });
    const result = run(shim, ["--version"]);
    expect(result.status).toBe(127);
    expect(result.stderr).toContain("Open the app once to update this command.");
  });

  it("writes a Windows launcher that keeps cmd from reinterpreting paths", () => {
    const executable = "C:\\Apps\\R&whoami&X 100%\\!CHANNEL!\\T3 Code.exe";
    const script = renderCliShim({
      target: { kind: "windows", executable, entry: "C:\\Apps\\server.asar\\bin.mjs" },
      shimPath: "C:\\Users\\José\\.t3\\bin\\t3.cmd",
      t3Home: "C:\\Users\\José\\.t3",
    });
    const lines = script.split("\r\n");
    expect(lines).toContain("setlocal EnableExtensions DisableDelayedExpansion");
    expect(lines).toContain("chcp 65001 >nul");
    expect(lines).toContain(
      'if exist "C:\\Apps\\R&whoami&X 100%%\\!CHANNEL!\\T3 Code.exe" goto run',
    );
    // Paths only ever appear quoted or inside `set "..."`, never bare where `&` would split them.
    const bare = lines.filter(
      (line) => line.includes("whoami") && !/"[^"]*whoami[^"]*"/.test(line),
    );
    expect(bare).toEqual([]);
    expect(lines).toContain('set "T3CODE_CLI_PATH=C:\\Users\\José\\.t3\\bin\\t3.cmd"');
  });

  it("switches the Windows console to UTF-8 only when a path needs it", () => {
    const ascii = renderCliShim({
      target: { kind: "windows", executable: "C:\\T3\\T3 Code.exe", entry: "C:\\T3\\bin.mjs" },
      shimPath: "C:\\Users\\me\\.t3\\bin\\t3.cmd",
      t3Home: "C:\\Users\\me\\.t3",
    });
    // A Ctrl-C that ends the batch would leave the console switched.
    expect(ascii).not.toContain("chcp");
    expect(ascii.split("\r\n")).toContain("exit /b %t3_exit%");
  });
});
