import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, assert, describe, it, vi } from "vite-plus/test";

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
    assert.equal(
      values.NSLocationUsageDescription,
      "T3 Code uses your location when a website requests it.",
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

    // The source icons are real repo paths, joined for the host.
    assert.match(development.sourceIconPath, /assets[\\/]dev[\\/]blueprint-macos-1024\.png$/);
    assert.equal(development.generatedIconPath, "/runtime/icon-dev.icns");
    assert.match(production.sourceIconPath, /assets[\\/]prod[\\/]black-macos-1024\.png$/);
    assert.equal(production.generatedIconPath, "/runtime/icon-prod.icns");
  });
});

describe("macOS cached launcher bundles", () => {
  let directory;

  afterEach(() => {
    for (const module of [
      "node:url",
      "node:module",
      "node:os",
      "node:child_process",
      "./ensure-electron-runtime.mjs",
    ]) {
      vi.doUnmock(module);
    }
    vi.unstubAllEnvs();
    vi.resetModules();
    if (directory) NodeFS.rmSync(directory, { recursive: true, force: true });
  });

  it.each([false, true])(
    "refreshes stale privacy metadata and reuses an up-to-date bundle, development=%s",
    async (development) => {
      directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-launcher-cache-"));
      const desktopRoot = NodePath.join(directory, "apps", "desktop");
      const runtimeDir = NodePath.join(desktopRoot, ".electron-runtime");
      const electronBinary = NodePath.join(
        directory,
        "Electron.app",
        "Contents",
        "MacOS",
        "Electron",
      );
      const sourcePlist = NodePath.join(directory, "Electron.app", "Contents", "Info.plist");
      NodeFS.mkdirSync(NodePath.dirname(electronBinary), { recursive: true });
      NodeFS.mkdirSync(NodePath.join(directory, "Electron.app", "Contents", "Resources"));
      NodeFS.writeFileSync(electronBinary, "native executable");
      NodeFS.writeFileSync(sourcePlist, "{}");
      NodeFS.mkdirSync(runtimeDir, { recursive: true });
      for (const [mode, name] of [
        ["dev", "blueprint"],
        ["prod", "black"],
      ]) {
        const sourceIcon = NodePath.join(directory, "assets", mode, `${name}-macos-1024.png`);
        NodeFS.mkdirSync(NodePath.dirname(sourceIcon), { recursive: true });
        NodeFS.writeFileSync(sourceIcon, "source icon");
        const generatedIcon = NodePath.join(runtimeDir, `icon-${mode}.icns`);
        NodeFS.writeFileSync(generatedIcon, "generated icon");
        const mtime = NodeFS.statSync(sourceIcon).mtimeMs / 1000 + 1;
        NodeFS.utimesSync(generatedIcon, mtime, mtime);
      }

      vi.stubEnv("VITE_DEV_SERVER_URL", development ? "http://127.0.0.1:3000" : "");
      vi.doMock("node:url", async (importOriginal) => ({
        ...(await importOriginal()),
        fileURLToPath: () => NodePath.join(desktopRoot, "scripts", "electron-launcher.mjs"),
      }));
      vi.doMock("node:module", async (importOriginal) => ({
        ...(await importOriginal()),
        createRequire: () => () => electronBinary,
      }));
      vi.doMock("node:os", async (importOriginal) => ({
        ...(await importOriginal()),
        platform: () => "darwin",
      }));
      vi.doMock("./ensure-electron-runtime.mjs", () => ({ ensureElectronRuntime: () => {} }));
      vi.doMock("node:child_process", () => ({
        spawnSync: (command, args) => {
          if (command === "plutil") {
            const [operation, key, type, value, path] = args;
            const plist = JSON.parse(NodeFS.readFileSync(path, "utf8"));
            if (operation === "-replace" && !Object.hasOwn(plist, key)) {
              return { status: 1, stderr: "key missing" };
            }
            plist[key] = type === "-json" ? JSON.parse(value) : value;
            NodeFS.writeFileSync(path, JSON.stringify(plist));
          }
          return { status: 0, stdout: "", stderr: "" };
        },
      }));
      vi.resetModules();
      const { resolveElectronLaunchCommand } = await import("./electron-launcher.mjs");
      const { electronPath } = resolveElectronLaunchCommand();
      assert.isTrue(electronPath.startsWith(runtimeDir));
      const bundle = NodePath.resolve(electronPath, "..", "..", "..");
      const plistPath = NodePath.join(bundle, "Contents", "Info.plist");
      const metadataPath = NodePath.join(runtimeDir, "metadata.json");
      const marker = NodePath.join(bundle, "Contents", "Resources", "stale-bundle");

      for (const staleMetadata of ["legacy", "outdated privacy description"]) {
        const metadata = JSON.parse(NodeFS.readFileSync(metadataPath, "utf8"));
        if (staleMetadata === "legacy") delete metadata.infoPlistStrings;
        else metadata.infoPlistStrings.NSLocationUsageDescription = "outdated";
        NodeFS.writeFileSync(metadataPath, JSON.stringify(metadata));
        const plist = JSON.parse(NodeFS.readFileSync(plistPath, "utf8"));
        delete plist.NSLocationUsageDescription;
        NodeFS.writeFileSync(plistPath, JSON.stringify(plist));
        NodeFS.writeFileSync(marker, "old bundle");

        assert.equal(resolveElectronLaunchCommand().electronPath, electronPath);
        assert.isFalse(NodeFS.existsSync(marker), `${staleMetadata} must rebuild the bundle`);
        assert.equal(
          JSON.parse(NodeFS.readFileSync(plistPath, "utf8")).NSLocationUsageDescription,
          "T3 Code uses your location when a website requests it.",
        );
      }

      NodeFS.writeFileSync(marker, "current bundle");
      assert.equal(resolveElectronLaunchCommand().electronPath, electronPath);
      assert.equal(NodeFS.readFileSync(marker, "utf8"), "current bundle");
    },
  );
});
