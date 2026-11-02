import * as NodeChildProcess from "node:child_process";
import * as NodeEvents from "node:events";
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeVM from "node:vm";
import * as NodeURL from "node:url";
import { build } from "vite-plus/pack";
import { assert, it } from "vite-plus/test";

import desktopConfig from "../vite.config.ts";

it("keeps lazy Linux imports and worker bundles from executing desktop startup twice", async () => {
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-desktop-bundle-"));
  try {
    const workerEntries = [
      "src/electron/WindowsForegroundFocusWorker.ts",
      "src/snapShot/GlobalShiftShortcutWorker.ts",
      "src/snapShot/RegionSnapShotWorker.ts",
      "src/snapShot/SnapShotAccessibilityWorker.ts",
    ];
    await Promise.all([
      NodeFSP.mkdir(NodePath.join(directory, "src/electron"), { recursive: true }),
      NodeFSP.mkdir(NodePath.join(directory, "src/snapShot"), { recursive: true }),
    ]);
    await Promise.all([
      NodeFSP.writeFile(
        NodePath.join(directory, "src/main.ts"),
        `import { shared } from "./shared.ts";
process.emit("startup", shared.value);
void import("./linux.ts").then(({ result }) => process.emit("ready", result));`,
      ),
      NodeFSP.writeFile(
        NodePath.join(directory, "src/shared.ts"),
        "export const shared = { value: 42 };",
      ),
      NodeFSP.writeFile(
        NodePath.join(directory, "src/linux.ts"),
        'import { shared } from "./shared.ts"; export const result = shared.value + 1;',
      ),
      ...workerEntries.map((entry) =>
        NodeFSP.writeFile(
          NodePath.join(directory, entry),
          'import { shared } from "../shared.ts"; process.emit("worker", shared.value);',
        ),
      ),
    ]);
    assert.ok(Array.isArray(desktopConfig.pack));
    const fixtureEntries = new Set(["src/main.ts", ...workerEntries]);
    for (const packConfig of desktopConfig.pack) {
      if (!Array.isArray(packConfig.entry)) continue;
      if (!packConfig.entry.some((entry) => fixtureEntries.has(entry))) continue;
      await build({
        ...packConfig,
        config: false,
        cwd: directory,
        tsconfig: false,
        sourcemap: false,
        onSuccess: undefined,
        logLevel: "silent",
      });
    }

    const outputDirectory = NodePath.join(directory, "dist-electron");
    const filenames = (await NodeFSP.readdir(outputDirectory, { recursive: true })).filter(
      (filename) => filename.endsWith(".cjs"),
    );
    const sources = new Map(
      await Promise.all(
        filenames.map(async (filename) => {
          const path = NodePath.join(outputDirectory, filename);
          return [path, await NodeFSP.readFile(path, "utf8")];
        }),
      ),
    );
    const modules = new Map();
    const startups = [];
    const workers = [];
    const ready = Promise.withResolvers();
    const load = (filename, cacheModule = true) => {
      const cached = modules.get(filename);
      if (cached) return cached.exports;
      const module = { exports: {} };
      if (cacheModule) modules.set(filename, module);
      const source = sources.get(filename);
      assert.ok(source, `Missing bundle: ${filename}`);
      NodeVM.runInNewContext(source, {
        exports: module.exports,
        module,
        require: (specifier) => load(NodePath.resolve(NodePath.dirname(filename), specifier)),
        process: {
          emit: (event, value) => {
            if (event === "startup") startups.push(value);
            if (event === "worker") workers.push(value);
            if (event === "ready") ready.resolve(value);
          },
        },
      });
      return module.exports;
    };

    load(NodePath.join(outputDirectory, "main.cjs"), false);
    assert.equal(await ready.promise, 43);
    assert.deepEqual(startups, [42]);
    for (const entry of workerEntries) {
      load(NodePath.join(outputDirectory, entry.replace(/^src\//, "").replace(/\.ts$/, ".cjs")));
    }
    assert.deepEqual(workers, [42, 42, 42, 42]);
    assert.deepEqual(startups, [42]);
  } finally {
    await NodeFSP.rm(directory, { recursive: true, force: true });
  }
});

it("loads the emitted packaged boot entry and backend cache preload", async () => {
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-desktop-boot-"));
  try {
    const entries = ["src/boot.ts", "src/compileCache.ts"];
    await NodeFSP.mkdir(NodePath.join(directory, "src"));
    await NodeFSP.cp(new URL("../src", import.meta.url), NodePath.join(directory, "src"), {
      recursive: true,
    });
    assert.ok(Array.isArray(desktopConfig.pack));
    for (const packConfig of desktopConfig.pack) {
      if (!Array.isArray(packConfig.entry)) continue;
      if (!packConfig.entry.some((entry) => entries.includes(entry))) continue;
      await build({
        ...packConfig,
        entry: packConfig.entry.map((entry) =>
          NodeURL.fileURLToPath(new URL(`../${entry}`, import.meta.url)),
        ),
        outDir: NodePath.join(directory, "dist-electron"),
        config: false,
        cwd: directory,
        tsconfig: false,
        sourcemap: false,
        onSuccess: undefined,
        logLevel: "silent",
      });
    }
    const outputDirectory = NodePath.join(directory, "dist-electron");
    const fixture = `console.log(require('node:module').getCompileCacheDir() ? 'cached' : 'uncached');`;
    await NodeFSP.writeFile(NodePath.join(outputDirectory, "main.cjs"), fixture);
    await NodeFSP.writeFile(
      NodePath.join(outputDirectory, "backend.mjs"),
      `import { getCompileCacheDir } from 'node:module'; console.log(getCompileCacheDir() ? 'cached' : 'uncached');`,
    );
    const nodeRequire = NodeModule.createRequire(import.meta.url);
    for (const platform of ["linux", "darwin"]) {
      for (const lockAvailable of [true, false]) {
        const home = NodePath.join(directory, `${platform}-${lockAvailable}`);
        const settingsDirectory = NodePath.join(home, ".t3", "userdata");
        await NodeFSP.mkdir(settingsDirectory, { recursive: true });
        await NodeFSP.writeFile(
          NodePath.join(settingsDirectory, "desktop-settings.json"),
          JSON.stringify({
            mainWindowBounds: { x: 10, y: 20, width: 1200, height: 800 },
            mainWindowMaximized: true,
          }),
        );
        const events = [];
        const immediates = [];
        const app = Object.assign(new NodeEvents.EventEmitter(), {
          isPackaged: true,
          getVersion: () => "0.1.5",
          getAppPath: () => directory,
          setPath: () => events.push("profile"),
          requestSingleInstanceLock: () => lockAvailable,
          quit: () => events.push("quit"),
          exit: () => events.push("exit"),
          setDesktopName: () => {},
          commandLine: { hasSwitch: () => false, getSwitchValue: () => "", appendSwitch: () => {} },
        });
        const windows = [];
        class BrowserWindow extends NodeEvents.EventEmitter {
          constructor(options) {
            super();
            this.options = options;
            this.destroyed = false;
            windows.push(this);
            events.push("window");
          }
          maximize() {
            events.push("maximize");
          }
          show() {
            events.push("show");
          }
          isDestroyed() {
            return this.destroyed;
          }
        }
        const electron = {
          app,
          BrowserWindow,
          nativeTheme: { shouldUseDarkColors: true },
          screen: { getAllDisplays: () => [{ bounds: { x: 0, y: 0, width: 1920, height: 1080 } }] },
          protocol: { registerSchemesAsPrivileged: () => events.push("schemes") },
          dialog: {
            showErrorBox: (_title, detail) => {
              throw Error(detail);
            },
          },
        };
        const modules = new Map();
        const context = NodeVM.createContext({
          process: {
            versions: { electron: "44.10.0" },
            argv: [],
            platform,
            env: {},
            execPath: process.execPath,
            emit: () => events.push("main"),
          },
          setImmediate: (callback) => immediates.push(callback),
          console,
        });
        const load = (filename) => {
          if (modules.has(filename)) return modules.get(filename).exports;
          const module = { exports: {} };
          modules.set(filename, module);
          const require = (specifier) =>
            specifier.startsWith(".")
              ? load(NodePath.resolve(NodePath.dirname(filename), specifier))
              : specifier === "electron"
                ? electron
                : specifier === "node:os"
                  ? { homedir: () => home, tmpdir: () => home }
                  : nodeRequire(specifier);
          const source = filename.endsWith("main.cjs")
            ? 'process.emit("startup");'
            : NodeFS.readFileSync(filename, "utf8");
          NodeVM.runInContext(
            `(function(require, module, exports, __dirname) {${source}\n})`,
            context,
          )(require, module, module.exports, NodePath.dirname(filename));
          return module.exports;
        };
        load(NodePath.join(outputDirectory, "boot.cjs"));
        assert.equal(windows.length, 0);
        assert.ok(!events.includes("main"));
        const linkEvent = { preventDefault() {} };
        app.emit("open-url", linkEvent, "t3code://oauth/callback");
        app.emit("second-instance", linkEvent, ["t3code", "t3code://new"], home, {});
        app.emit("ready");
        if (!lockAvailable) {
          assert.deepEqual(events, ["profile", "quit"]);
          continue;
        }
        assert.deepEqual(events, ["profile", "schemes", "window", "maximize", "show"]);
        assert.deepEqual(JSON.parse(JSON.stringify(windows[0].options.webPreferences)), {
          preload: NodePath.join(outputDirectory, "preload.cjs"),
          backgroundThrottling: false,
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
          webviewTag: true,
          disableHtmlFullscreenWindowResize: true,
        });
        assert.equal(windows[0].options.width, 1200);
        assert.equal(windows[0].options.height, 800);
        immediates.shift()();
        assert.equal(events.at(-1), "main");
        assert.equal(windows.length, 1);
        const boot = NodeVM.runInContext(
          'globalThis[Symbol.for("@t3tools/desktop/boot")]',
          context,
        );
        boot.detachLinkListeners();
        const urls = [];
        const instances = [];
        app.on("open-url", (_event, url) => urls.push(url));
        app.on("second-instance", (_event, argv) => instances.push(Array.from(argv)));
        boot.replayLinkEvents();
        boot.replayLinkEvents();
        assert.deepEqual(urls, ["t3code://oauth/callback"]);
        assert.deepEqual(instances, [["t3code", "t3code://new"]]);
      }
    }
    const packagedOutputDirectory = NodePath.join(
      directory,
      "resources/app.asar/apps/desktop/dist-electron",
    );
    await NodeFSP.cp(outputDirectory, packagedOutputDirectory, { recursive: true });
    for (const runtimeDirectory of [outputDirectory, packagedOutputDirectory]) {
      for (const disabled of [false, true]) {
        for (const args of [
          [NodePath.join(runtimeDirectory, "boot.cjs")],
          [
            "--require",
            NodePath.join(runtimeDirectory, "compileCache.cjs"),
            NodePath.join(runtimeDirectory, "backend.mjs"),
          ],
        ]) {
          const child = NodeChildProcess.spawnSync(process.execPath, args, {
            encoding: "utf8",
            env: {
              ...process.env,
              APPIMAGE: "",
              ELECTRON_RUN_AS_NODE: "1",
              NODE_COMPILE_CACHE: undefined,
              NODE_DISABLE_COMPILE_CACHE: disabled ? "1" : undefined,
              XDG_CACHE_HOME: directory,
              TMPDIR: directory,
              TEMP: directory,
              TMP: directory,
            },
          });
          assert.equal(child.status, 0, child.stderr);
          assert.equal(child.stdout.trim(), disabled ? "uncached" : "cached");
        }
      }
    }
  } finally {
    await NodeFSP.rm(directory, { recursive: true, force: true });
  }
});
