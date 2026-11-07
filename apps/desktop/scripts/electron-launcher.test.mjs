import * as NodeChildProcess from "node:child_process";
import * as NodeEvents from "node:events";
import * as NodeReadline from "node:readline";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeVM from "node:vm";

import { assert, describe, it } from "vite-plus/test";

import {
  makeDevelopmentEnvironmentScript,
  makeDevelopmentLauncherScript,
  resolveElectronBinaryPath,
  resolveMacLauncherPaths,
  writeDevelopmentLauncherScript,
} from "./electron-launcher.mjs";

describe("electron development launcher", () => {
  it("uses captured values only as fallbacks for a live runner environment", () => {
    const environmentScript = makeDevelopmentEnvironmentScript({
      VITE_DEV_SERVER_URL: "http://127.0.0.1:8526",
      T3CODE_PORT: "16566",
      T3CODE_HOME: "/tmp/t3",
      T3CODE_OTLP_PROTOCOL: "http/protobuf",
    });

    assert.include(
      environmentScript,
      "if [ -z \"${VITE_DEV_SERVER_URL:-}\" ]; then export VITE_DEV_SERVER_URL='http://127.0.0.1:8526'; fi",
    );
    assert.include(
      environmentScript,
      "if [ -z \"${T3CODE_OTLP_PROTOCOL:-}\" ]; then export T3CODE_OTLP_PROTOCOL='http/protobuf'; fi",
    );
    assert.notInclude(environmentScript, "\nexport VITE_DEV_SERVER_URL=");
  });

  it("keeps the launcher script free of volatile environment values", () => {
    const script = makeDevelopmentLauncherScript({
      electronBinaryPath: "/repo/node_modules/electron/Electron",
      mainEntryPath: "/repo/apps/desktop/dist-electron/main.cjs",
      desktopRoot: "/repo/apps/desktop",
      environmentFilePath: "/repo/apps/desktop/.electron-runtime/dev-environment.sh",
    });

    assert.include(
      script,
      "if [ -f '/repo/apps/desktop/.electron-runtime/dev-environment.sh' ]; then . '/repo/apps/desktop/.electron-runtime/dev-environment.sh'; fi",
    );
    assert.notInclude(script, "VITE_DEV_SERVER_URL");
    assert.include(
      script,
      "exec '/repo/node_modules/electron/Electron' --t3code-dev-root='/repo/apps/desktop' '/repo/apps/desktop/dist-electron/main.cjs' \"$@\"",
    );
  });

  it("repairs Electron before loading the package entrypoint", () => {
    const calls = [];
    const electronPath = resolveElectronBinaryPath({
      ensureRuntime: () => {
        calls.push("ensure");
      },
      createRequire: () => (specifier) => {
        calls.push(`require:${specifier}`);
        return "/repo/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron";
      },
      moduleUrl: import.meta.url,
    });

    assert.equal(
      electronPath,
      "/repo/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron",
    );
    assert.deepEqual(calls, ["ensure", "require:electron"]);
  });

  it("keeps the native Electron executable name inside the branded macOS bundle", () => {
    const paths = resolveMacLauncherPaths(
      "/repo/apps/desktop/.electron-runtime/T3 Code (Dev).app",
      "T3 Code (Dev)",
    );

    assert.equal(paths.launcherExecutableName, "T3 Code (Dev) Launcher");
    assert.equal(
      paths.launcherBinaryPath,
      "/repo/apps/desktop/.electron-runtime/T3 Code (Dev).app/Contents/MacOS/T3 Code (Dev) Launcher",
    );
    assert.equal(
      paths.runtimeElectronBinaryPath,
      "/repo/apps/desktop/.electron-runtime/T3 Code (Dev).app/Contents/MacOS/Electron",
    );

    const script = makeDevelopmentLauncherScript({
      electronBinaryPath: paths.runtimeElectronBinaryPath,
      mainEntryPath: "/repo/apps/desktop/dist-electron/main.cjs",
      desktopRoot: "/repo/apps/desktop",
      environmentFilePath: "/repo/apps/desktop/.electron-runtime/dev-environment.sh",
    });
    assert.include(
      script,
      "exec '/repo/apps/desktop/.electron-runtime/T3 Code (Dev).app/Contents/MacOS/Electron'",
    );
    assert.notInclude(script, "node_modules/electron");
  });

  it("restores execute permissions on an unchanged launcher", () => {
    const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-launcher-"));
    const launcherPath = NodePath.join(directory, "launcher");
    try {
      writeDevelopmentLauncherScript(launcherPath, "/runtime/Electron");
      NodeFS.chmodSync(launcherPath, 0o644);

      assert.isFalse(writeDevelopmentLauncherScript(launcherPath, "/runtime/Electron"));
      assert.equal(NodeFS.statSync(launcherPath).mode & 0o777, 0o755);
    } finally {
      NodeFS.rmSync(directory, { recursive: true, force: true });
    }
  });
});

// oxlint-disable-next-line t3code/no-global-process-runtime -- Exercises the host process ancestry.
const supportsAncestors = ["linux", "darwin"].includes(NodeOS.platform());

describe.skipIf(!supportsAncestors)("dev Electron supervisor", () => {
  it.each([
    ["launcher", "running", "shell"],
    ["launcher", "waiting for resources", "shell"],
    ["outer ancestor", "running", "shell"],
    ["outer ancestor", "running", "direct"],
  ])("handles loss of %s while %s with a %s launch", async (lostProcess, phase, layout) => {
    const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-supervisor-"));
    const scripts = NodePath.join(directory, "desktop/scripts");
    NodeFS.mkdirSync(scripts, { recursive: true });
    for (const file of NodeFS.readdirSync(new URL(".", import.meta.url))) {
      if (file.endsWith(".mjs") && !file.endsWith(".test.mjs")) {
        NodeFS.copyFileSync(new URL(file, import.meta.url), NodePath.join(scripts, file));
      }
    }
    const write = (file, source) => NodeFS.writeFileSync(NodePath.join(scripts, file), source);
    write("build-browser-secret.mjs", "");
    write(
      "electron-launcher.mjs",
      `
        export const desktopDir = new URL("../", import.meta.url).pathname;
        export const resolveDevProtocolClient = () => null;
        export const resolveElectronLaunchCommand = () => ({
          electronPath: process.execPath, args: ["scripts/fake-electron.mjs"],
        });
      `,
    );
    write(
      "fake-electron.mjs",
      `
        console.log(JSON.stringify({ event: "ready", pid: process.pid }));
        setInterval(() => {}, 1000);
      `,
    );
    write(
      "wait-for-resources.mjs",
      `
        import { mkdirSync, writeFileSync } from "node:fs";
        import { dirname, resolve } from "node:path";
        export const waitForResources = ({ baseDir, files }) => new Promise(resolveReady => {
          for (const file of files) {
            const path = resolve(baseDir, file);
            mkdirSync(dirname(path), { recursive: true });
            writeFileSync(path, "");
          }
          const keepAlive = setInterval(() => {}, 1000);
          process.once("SIGUSR2", () => { clearInterval(keepAlive); resolveReady(); });
          console.log(JSON.stringify({ event: "waiting", pid: process.pid, ppid: process.ppid }));
        });
      `,
    );
    // Block the script's broad pkill cleanup; only the fake Electron may be spawned.
    // Keep real /proc reads and macOS ps calls so ancestry detection is not mocked.
    write(
      "preload.mjs",
      `
        import cp from "node:child_process";
        import { syncBuiltinESMExports } from "node:module";
        const spawnSync = cp.spawnSync, spawn = cp.spawn;
        cp.spawnSync = (command, ...args) => {
          if (command === "pkill") return { status: 0 };
          if (command === "ps") return spawnSync(command, ...args);
          throw new Error("Unexpected command: " + command);
        };
        cp.spawn = (command, args, options) => {
          if (command !== process.execPath || args[0] !== "scripts/fake-electron.mjs") {
            throw new Error("Unexpected child: " + command);
          }
          const child = spawn(command, args, options);
          console.log(JSON.stringify({ event: "spawn", pid: child.pid }));
          child.once("exit", (code, signal) => {
            console.log(JSON.stringify({ event: "app-exit", pid: child.pid, code, signal }));
          });
          return child;
        };
        syncBuiltinESMExports();
      `,
    );
    const shellCommand = `"$TEST_NODE" --import ./preload.mjs ./dev-electron.mjs & supervisor=$!; printf '{"event":"supervisor","pid":%s}\n' "$supervisor"; wait "$supervisor"; printf '{"event":"supervisor-exit","code":%s}\n' "$?"`;
    const launcherSource =
      layout === "shell"
        ? `
        import { spawn } from "node:child_process";
        const shell = spawn("/bin/sh", ["-c", ${JSON.stringify(shellCommand)}], { stdio: "inherit" });
        console.log(JSON.stringify({ event: "shell", pid: shell.pid }));
      `
        : `
        import { spawn } from "node:child_process";
        const supervisor = spawn(process.execPath, ["--import", "./preload.mjs", "./dev-electron.mjs"], { stdio: "inherit" });
        console.log(JSON.stringify({ event: "supervisor", pid: supervisor.pid }));
        supervisor.once("exit", code => {
          console.log(JSON.stringify({ event: "supervisor-exit", code }));
          console.log(JSON.stringify({ event: "launcher-exit" }));
        });
      `;
    const outer = NodeChildProcess.spawn(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
        import { spawn } from "node:child_process";
        const launcher = spawn(process.execPath, ["--input-type=module", "-e", ${JSON.stringify(launcherSource)}], { stdio: "inherit" });
        console.log(JSON.stringify({ event: "launcher", pid: launcher.pid }));
        launcher.once("exit", () => console.log(JSON.stringify({ event: "launcher-exit" })));
      `,
      ],
      {
        cwd: scripts,
        env: {
          ...process.env,
          TEST_NODE: process.execPath,
          VITE_DEV_SERVER_URL: "http://127.0.0.1:12345",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    const outputClosed = NodeEvents.once(outer.stdout, "close", {
      signal: AbortSignal.timeout(12_000),
    });
    const lines = NodeReadline.createInterface({ input: outer.stdout });
    const events = [];
    const owned = new Set();
    let stderr = "";
    outer.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    lines.on("line", (line) => {
      const event = JSON.parse(line);
      events.push(event);
      if (["launcher", "shell", "supervisor", "spawn"].includes(event.event)) owned.add(event.pid);
      if (event.event === "app-exit") owned.delete(event.pid);
      if (event.event === "launcher-exit") {
        owned.delete(events.find((item) => item.event === "launcher").pid);
      }
      if (event.event === "supervisor-exit") {
        owned.delete(events.find((item) => item.event === "supervisor").pid);
      }
    });
    outer.stdout.once("close", () => {
      owned.delete(events.find((item) => item.event === "shell")?.pid);
    });
    const kill = (pid) => {
      if (!owned.has(pid)) return;
      try {
        process.kill(pid, "SIGKILL");
      } catch (error) {
        assert.equal(error.code, "ESRCH");
      }
    };
    const waitFor = async (event, count = 1) => {
      const signal = AbortSignal.timeout(5_000);
      while (events.filter((item) => item.event === event).length < count) {
        await NodeEvents.once(lines, "line", { signal }).catch(() => {
          throw new Error(`Missing ${event}: ${JSON.stringify(events)} ${stderr}`);
        });
      }
      return events.filter((item) => item.event === event)[count - 1];
    };
    try {
      const supervisor = await waitFor("waiting");
      const launcher = await waitFor("launcher");
      const shell = layout === "shell" ? await waitFor("shell") : null;
      assert.equal(supervisor.ppid, shell?.pid ?? launcher.pid);
      if (phase === "running") {
        process.kill(supervisor.pid, "SIGUSR2");
        const firstApp = await waitFor("ready");
        process.kill(firstApp.pid, "SIGKILL");
        await waitFor("ready", 2); // Prove the real abnormal-exit restart path is active.
      }
      if (lostProcess === "outer ancestor") {
        const outerExited = NodeEvents.once(outer, "exit");
        outer.kill("SIGKILL");
        await outerExited;
        process.kill(launcher.pid, 0);
        // A real restart samples ownership again after the unrelated ancestor has gone.
        process.kill(events.findLast((event) => event.event === "ready").pid, "SIGKILL");
        await waitFor("ready", 3);
      }
      if (layout === "direct") {
        process.kill(supervisor.pid, "SIGTERM");
      } else {
        process.kill(launcher.pid, "SIGKILL");
        owned.delete(launcher.pid);
      }
      if (lostProcess === "launcher") await waitFor("launcher-exit");
      if (shell) process.kill(shell.pid, 0);
      if (phase === "waiting for resources") process.kill(supervisor.pid, "SIGUSR2");
      assert.equal((await waitFor("supervisor-exit")).code, layout === "direct" ? 143 : 0);
      await outputClosed;
      assert.lengthOf(
        events.filter((event) => event.event === "spawn"),
        phase === "running" ? (lostProcess === "outer ancestor" ? 3 : 2) : 0,
      );
      if (phase === "running") {
        assert.equal(
          (await waitFor("app-exit", lostProcess === "outer ancestor" ? 3 : 2)).signal,
          "SIGTERM",
        );
      }
    } finally {
      outer.kill("SIGKILL");
      // Stop the producer first, then clean up every child it reported, including late spawns.
      const supervisorPid = events.find((event) => event.event === "supervisor")?.pid;
      if (owned.has(supervisorPid)) {
        kill(supervisorPid);
        await waitFor("supervisor-exit");
      }
      for (const pid of owned) kill(pid);
      await outputClosed;
      NodeFS.rmSync(directory, { recursive: true, force: true });
    }
  });
});

async function startupCleanupPattern(desktopDir) {
  const source = NodeFS.readFileSync(new URL("./dev-electron.mjs", import.meta.url), "utf8");
  let pattern;
  // Supply inert imports so the real startup runs without launching Electron or signalling processes.
  await NodeVM.runInNewContext(
    `(async () => { ${source.replace(/^import\s[\s\S]*?;\n/gm, "")} })()`,
    {
      NodeChildProcess: {
        execFileSync: () => undefined,
        spawnSync: (command, args) => {
          if (command === "pkill" && args.includes("-f")) pattern = args.at(-1);
        },
        spawn: () => new NodeEvents.EventEmitter(),
      },
      NodeFS: { watch: () => ({ close: () => undefined }) },
      NodeOS: { platform: () => "linux" },
      NodePath,
      desktopDir,
      resolveDevProtocolClient: () => null,
      resolveElectronLaunchCommand: (args) => ({ electronPath: "electron", args }),
      waitForResources: async () => undefined,
      watchSupervisingAncestors: () => ({ check: () => false, stop: () => undefined }),
      URL,
      process: {
        env: { VITE_DEV_SERVER_URL: "http://localhost:1234" },
        execPath: "node",
        once: () => undefined,
      },
    },
  );
  assert.isString(pattern);
  return pattern;
}

it
  // oxlint-disable-next-line t3code/no-global-process-runtime -- Native pgrep is unavailable on Windows.
  .skipIf(NodeOS.platform() === "win32")
  .each([
    "/tmp/t3-feature.one/apps/desktop",
    "/tmp/t3-feature.one [two](three)+?^${four}|back\\slash*/apps/desktop",
  ])("dev cleanup matches only the literal root argument: %s", async (desktopDir) => {
  const pattern = await startupCleanupPattern(desktopDir);
  const flag = `--t3code-dev-root=${desktopDir}`;
  const argvCases = [
    [flag],
    [flag, "main.cjs"],
    [flag.replace(".one", "Xone")],
    [`${flag}-two`],
    [`prefix${flag}`],
    [`--t3code-dev-root=/other${desktopDir}`],
  ];
  const children = [];
  try {
    for (const args of argvCases) {
      const child = NodeChildProcess.spawn(
        process.execPath,
        ["-e", "process.send('ready'); setInterval(() => {}, 1000)", "--", ...args],
        { stdio: ["ignore", "ignore", "inherit", "ipc"] },
      );
      children.push(child);
      await Promise.race([
        NodeEvents.once(child, "message"),
        NodeEvents.once(child, "exit").then(() => {
          throw new Error("Fixture exited before readiness");
        }),
      ]);
    }
    // Use the native ERE engine, but never execute the launcher's signal-producing command.
    const result = NodeChildProcess.spawnSync(
      "pgrep",
      ["-P", String(process.pid), "-f", "--", pattern],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr);
    const matches = result.stdout.trim().split(/\s+/).map(Number);
    assert.sameMembers(
      matches,
      children.slice(0, 2).map((child) => child.pid),
    );
  } finally {
    await Promise.all(
      children.map(async (child) => {
        if (child.exitCode !== null || child.signalCode !== null) return;
        const exited = NodeEvents.once(child, "exit");
        child.kill("SIGTERM");
        await exited;
      }),
    );
  }
});
