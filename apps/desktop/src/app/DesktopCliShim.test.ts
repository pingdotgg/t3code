// @effect-diagnostics nodeBuiltinImport:off - Runs the rendered launcher in a real shell.
import * as NodeChildProcess from "node:child_process";
import * as NodeEvents from "node:events";
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

const writeShim = (root: string, target: CliShimTarget) => {
  const shim = NodePath.join(root, "bin", "t3");
  writeExecutable(
    shim,
    renderCliShim({ target, shimPath: shim, t3Home: `${root}/home`, version: "1.2.3" }),
  );
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
  it("passes stdin, the exit status, and SIGTERM through to the AppImage's CLI", async () => {
    const { root, image, shim } = fakeAppImage();
    writeExecutable(
      NodePath.join(image, "t3code"),
      [
        "#!/bin/sh",
        `trap 'touch "${root}/cli-got-term"; exit 143' TERM`,
        'read -r line && echo "read: $line"',
        '[ "$2" = wait ] || exit 4',
        "echo ready",
        "while :; do sleep 0.05; done",
        "",
      ].join("\n"),
    );
    const piped = NodeChildProcess.spawnSync(shim, ["once"], {
      encoding: "utf8",
      input: "hello\n",
    });
    const closed = NodeChildProcess.spawnSync("sh", ["-c", `"$0" once <&-`, shim], {
      encoding: "utf8",
    });
    expect(closed.status).toBe(4);
    expect(closed.stderr).toBe("");
    expect(piped.stdout).toBe("read: hello\n");
    expect(piped.status).toBe(4);

    const running = NodeChildProcess.spawn(shim, ["wait"], { stdio: ["pipe", "pipe", "inherit"] });
    running.stdin.end("hi\n");
    await new Promise<void>((resolve) =>
      running.stdout.on("data", (chunk: Buffer) => chunk.includes("ready") && resolve()),
    );
    const exited = NodeEvents.EventEmitter.once(running, "exit");
    running.kill("SIGTERM");
    expect((await exited)[0]).toBe(143);
    expect(NodeFS.existsSync(NodePath.join(root, "cli-got-term"))).toBe(true);
    expect(NodeFS.existsSync(NodePath.join(root, "unmounted"))).toBe(true);
  });

  it("extracts the AppImage where it cannot be mounted", () => {
    const { shim, appImage } = fakeAppImage(false);
    const result = run(shim, ["--version"], { APPIMAGE_EXTRACT_AND_RUN: "1" });
    expect(result.status).toBe(3);
    expect(result.stdout).toMatch(
      /squashfs-root\/resources\/app\.asar\/apps\/server\/dist\/bin\.mjs/,
    );
    // Neither works: 126 tells the npm launcher to run its own copy instead.
    writeExecutable(appImage, "#!/bin/sh\nexit 1\n");
    expect(run(shim, ["--version"]).status).toBe(126);
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
    const executable = NodePath.join(root, "opt", "T3 Code's", "t3code");
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
    // The npm launcher reads these two lines with the same patterns (scripts/npm-launcher/t3.mjs).
    const script = NodeFS.readFileSync(shim, "utf8");
    expect(/^# T3 Code version: (\S+)$/m.exec(script)?.[1]).toBe("1.2.3");
    expect(/^app='(.*)'$/m.exec(script)?.[1]?.replaceAll(`'"'"'`, "'")).toBe(executable);
  });

  it("writes a Windows launcher that keeps cmd from reinterpreting paths", () => {
    const executable = "C:\\Apps\\R&whoami&X 100%\\!CHANNEL!\\T3 Code.exe";
    const script = renderCliShim({
      target: { kind: "windows", executable, entry: "C:\\Apps\\server.asar\\bin.mjs" },
      shimPath: "C:\\Users\\José\\.t3\\bin\\t3.cmd",
      t3Home: "C:\\Users\\José\\.t3",
      version: "1.2.3",
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
