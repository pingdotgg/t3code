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

const fakeAppImage = (canMount = true, app = REPORTER) => {
  const root = tempRoot();
  const image = NodePath.join(root, "image");
  writeExecutable(NodePath.join(image, "t3code"), app);
  const appImage = NodePath.join(root, "T3 Code.AppImage");
  writeExecutable(
    appImage,
    [
      "#!/bin/sh",
      `if [ "$1" = --appimage-extract ]; then cp -R '${image}' squashfs-root; exit 0; fi`,
      '[ "$1" = --appimage-mount ] || exit 9',
      '[ -n "$APPIMAGE_EXTRACT_AND_RUN" ] && exit 8',
      `echo $$ >'${root}/mounter.pid'`,
      canMount ? `echo '${image}'` : 'echo "Cannot mount AppImage"; exit 1',
      // Like the FUSE runtime, any of these unmounts. fd 3 reports to the test when it is open.
      `trap 'echo unmounted >&3 2>/dev/null; touch "${root}/unmounted"; exit 0' TERM HUP INT`,
      "trap 'echo mounted >&3 2>/dev/null' WINCH",
      "while :; do sleep 0.05; done",
      "",
    ].join("\n"),
  );
  const shim = writeShim(root, { kind: "appimage", appImage, executableName: "t3code" });
  return { root, image, appImage, shim };
};

// Stays up after a signal until the test lets it finish, like a server shutting down.
const SLOW_SERVER = [
  "#!/bin/sh",
  "trap 'echo stopping >&3; read go; echo stopped >&3; exit 0' TERM HUP",
  "echo ready",
  "while :; do sleep 0.05; done",
  "",
].join("\n");

// The launcher mounts only under setsid, which stock macOS and Windows lack; there it extracts instead.
const hasSetsid = NodeChildProcess.spawnSync("setsid", ["true"]).status === 0;

const lines = (stream: NodeJS.ReadableStream) => {
  const seen: Array<string> = [];
  const waiters: Array<() => void> = [];
  let buffer = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk: string) => {
    buffer += chunk;
    const parts = buffer.split("\n");
    buffer = parts.pop()!;
    seen.push(...parts);
    for (const wake of waiters.splice(0)) wake();
  });
  const until = async (match: (line: string) => boolean) => {
    for (;;) {
      const line = seen.find(match);
      if (line !== undefined) return line;
      await new Promise<void>((resolve) => waiters.push(resolve));
    }
  };
  return { seen, until };
};

describe("renderCliShim", () => {
  it.skipIf(!hasSetsid).each(["SIGTERM", "SIGHUP"] as const)(
    "keeps the AppImage mounted until the server exits after %s to the process group",
    async (signal) => {
      const { root, shim } = fakeAppImage(true, SLOW_SERVER);
      const child = NodeChildProcess.spawn(shim, [], {
        detached: true,
        env: { PATH: process.env.PATH },
        stdio: ["pipe", "pipe", "ignore", "pipe"],
      });
      let mounter: number | undefined;
      try {
        const stdout = lines(child.stdout!);
        const events = lines(child.stdio[3] as NodeJS.ReadableStream);
        const exited = new Promise((resolve) => child.on("close", resolve));
        await stdout.until((line) => line === "ready");
        mounter = Number(NodeFS.readFileSync(NodePath.join(root, "mounter.pid"), "utf8"));

        // Ctrl-C in a terminal, a closed SSH session, or a service manager signals the whole group.
        process.kill(-child.pid!, signal);
        // The shell runs pending traps in ascending signal number, and WINCH outnumbers TERM and
        // HUP, so a mounter that also got the group signal unmounts before it answers this probe.
        process.kill(mounter, "SIGWINCH");
        const mount = await events.until((line) => line === "mounted" || line === "unmounted");
        expect(mount).toBe("mounted");

        await events.until((line) => line === "stopping");
        child.stdin!.end("go\n");
        await exited;
        expect(events.seen.slice(-2)).toEqual(["stopped", "unmounted"]);
      } finally {
        for (const pid of [-child.pid!, mounter]) {
          if (pid === undefined) continue;
          try {
            process.kill(pid, "SIGKILL");
          } catch {}
        }
      }
    },
  );

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
    // sudo clears the environment, so the launcher supplies its own.
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
