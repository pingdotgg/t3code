import * as NodeChildProcess from "node:child_process";
import * as NodeEvents from "node:events";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeVM from "node:vm";

import { assert, describe, it } from "vite-plus/test";

import {
  makeDevelopmentEnvironmentScript,
  makeDevelopmentLauncherScript,
  resolveElectronBinaryPath,
  resolveMacBundleInfoPlistStrings,
  resolveMacCodeSignArguments,
  resolveMacLauncherIconPaths,
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

  it("declares why the macOS app needs protected access", () => {
    const values = resolveMacBundleInfoPlistStrings("T3 Code (Dev) Launcher");

    assert.equal(
      values.NSScreenCaptureUsageDescription,
      "T3 Code captures the active window when you use the snapshot shortcut.",
    );
    assert.equal(
      values.NSDocumentsFolderUsageDescription,
      "T3 Code reads project files you open in the desktop app.",
    );
  });

  it("ad-hoc signs the complete development app bundle", () => {
    assert.deepEqual(resolveMacCodeSignArguments("/runtime/T3 Code (Dev).app"), [
      "--force",
      "--deep",
      "--sign",
      "-",
      "--timestamp=none",
      "/runtime/T3 Code (Dev).app",
    ]);
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

  it("derives launcher icons from canonical development and production assets", () => {
    const development = resolveMacLauncherIconPaths("/runtime", true);
    const production = resolveMacLauncherIconPaths("/runtime", false);

    assert.match(development.sourceIconPath, /assets[\\/]dev[\\/]blueprint-macos-1024\.png$/);
    assert.equal(development.generatedIconPath, "/runtime/icon-dev.icns");
    assert.match(production.sourceIconPath, /assets[\\/]prod[\\/]black-macos-1024\.png$/);
    assert.equal(production.generatedIconPath, "/runtime/icon-prod.icns");
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
