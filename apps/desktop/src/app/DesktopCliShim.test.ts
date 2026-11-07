// @effect-diagnostics nodeBuiltinImport:off - Runs the rendered launcher in a real shell.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  type CliShimTarget,
  renderCliShim,
  renderWslCliInstallScript,
  renderWslCliShim,
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
  const shim = NodePath.join(root, "bin", "t3");
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
  it("forwards WSL distro and Linux cwd to the Windows desktop CLI", () => {
    const root = tempRoot();
    const bin = NodePath.join(root, "bin");
    const project = NodePath.join(root, "project with spaces");
    NodeFS.mkdirSync(project);
    writeExecutable(NodePath.join(bin, "wslpath"), '#!/bin/sh\nprintf "%s\\n" "$2"\n');
    writeExecutable(
      NodePath.join(bin, "powershell.exe"),
      '#!/bin/sh\nprintf "%s\\n" "$T3CODE_WSL_DISTRO" "$T3CODE_WSL_WORKSPACE_ROOT" "$T3CODE_WSL_BASE_DIR" "${T3CODE_HOME-unset}" "$WSLENV"\n',
    );
    const shim = NodePath.join(root, "t3");
    writeExecutable(shim, renderWslCliShim("C:\\Users\\test\\t3.cmd"));
    const env = {
      PATH: `${bin}:${process.env.PATH}`,
      WSL_DISTRO_NAME: "Ubuntu",
      T3CODE_HOME: "/linux-home",
      HOME: root,
    };
    const result = run(shim, ["app", project, "--base-dir", project], env);
    expect(result.status).toBe(0);
    expect(result.stdout.split("\n").slice(0, 4)).toEqual(["Ubuntu", project, project, "unset"]);
    expect(result.stdout).toContain("T3CODE_WSL_WORKSPACE_ROOT/w");
    expect(run(shim, ["app", `--base-dir=${project}`, "--", project], env).status).toBe(0);
    expect(run(shim, ["app", "--base-dir=~/data"], env).stdout.split("\n")[2]).toBe(`${root}/data`);
    expect(run(shim, ["app", "--help"], env).status).toBe(0);
    expect(run(shim, ["app", project, project], env).status).toBe(2);
    expect(run(shim, ["app", "--base-dir"], env).status).toBe(2);
  });

  it("only replaces or removes its own WSL command shim", () => {
    const install = renderWslCliInstallScript({
      action: "install",
      windowsCliPath: "C:\\Users\\me\\.t3\\bin\\t3.cmd",
    });
    const uninstall = renderWslCliInstallScript({
      action: "uninstall",
      windowsCliPath: "C:\\Users\\me\\.t3\\bin\\t3.cmd",
    });

    const root = tempRoot();
    const target = NodePath.join(root, ".local", "bin", "t3");
    NodeFS.mkdirSync(NodePath.dirname(target), { recursive: true });
    const execute = (script: string) =>
      NodeChildProcess.spawnSync("sh", ["-c", script], {
        encoding: "utf8",
        env: { HOME: root, PATH: "/usr/bin:/bin", WSL_DISTRO_NAME: "Ubuntu" },
      });
    NodeFS.writeFileSync(target, "other command\n");
    expect(execute(install).status).toBe(73);
    expect(execute(uninstall).status).toBe(0);
    expect(NodeFS.readFileSync(target, "utf8")).toBe("other command\n");
    NodeFS.unlinkSync(target);
    NodeFS.symlinkSync(NodePath.join(root, "missing"), target);
    expect(execute(install).status).toBe(73);
    NodeFS.unlinkSync(target);
    expect(execute(install).status).toBe(0);
    expect(execute(uninstall).status).toBe(0);
    expect(NodeFS.existsSync(target)).toBe(false);
  });

  it("extracts the AppImage where it cannot be mounted", () => {
    const { shim } = fakeAppImage(false);
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
    expect(run(shim, []).stdout).toContain(`home=${root}/home`);
    expect(run(shim, [], { T3CODE_HOME: "/elsewhere" }).stdout).toContain("home=/elsewhere");
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
    const bare = lines.filter(
      (line) => line.includes("whoami") && !/"[^"]*whoami[^"]*"/.test(line),
    );
    expect(bare).toEqual([]);
    expect(lines).toContain('set "T3CODE_CLI_PATH=C:\\Users\\José\\.t3\\bin\\t3.cmd"');
  });
});
