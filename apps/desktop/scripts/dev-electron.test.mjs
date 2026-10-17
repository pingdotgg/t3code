import * as NodeChildProcess from "node:child_process";
import * as NodeOS from "node:os";
import * as NodeEvents from "node:events";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeVM from "node:vm";

import { makeDevelopmentLauncherScript } from "./electron-launcher.mjs";

import { assert, describe, it } from "vite-plus/test";

// oxlint-disable-next-line t3code/no-global-process-runtime -- Standalone launcher native boundary test.
const hostPlatform = NodeOS.platform();

const source = NodeFS.readFileSync(new URL("./dev-electron.mjs", import.meta.url), "utf8");

// Execute the actual launcher with inert process boundaries; no process is signalled.
async function launchFixture(
  platform,
  exitsOnTerm = true,
  desktopDir = "/tmp/t3-feature.one/apps/desktop",
) {
  const commands = [];
  const sweeps = [];
  const apps = [];
  const watchers = [];
  const timers = [];
  const restarted = Promise.withResolvers();
  const stopping = Promise.withResolvers();
  const context = {
    NodeChildProcess: {
      execFileSync: () => undefined,
      spawnSync: (command, args) => {
        commands.push([command, args]);
        if (args.includes("-f")) sweeps.push(args.at(-1));
      },
      spawn: () => {
        const app = new NodeEvents.EventEmitter();
        app.pid = 1000 + apps.length;
        app.signals = [];
        app.kill = (signal) => {
          app.signals.push(signal);
          stopping.resolve();
          if (signal === "SIGKILL" || exitsOnTerm) app.emit("exit", null, signal);
          return true;
        };
        apps.push(app);
        if (apps.length === 2) restarted.resolve();
        return app;
      },
    },
    NodeFS: {
      watch: (_path, _options, callback) => {
        watchers.push(callback);
        return { close: () => undefined };
      },
    },
    NodeOS: { platform: () => platform },
    NodePath,
    desktopDir,
    resolveDevProtocolClient: () =>
      platform === "darwin" ? { appBundleId: "codes.t3.dev" } : null,
    resolveElectronLaunchCommand: (args) => ({ electronPath: "electron", args }),
    waitForResources: async () => undefined,
    URL,
    process: {
      env: { VITE_DEV_SERVER_URL: "http://localhost:1234" },
      execPath: "node",
      pid: 900,
      once: () => undefined,
    },
    setTimeout: (callback, delay) => {
      const timer = { callback, delay, unref: () => undefined };
      timers.push(timer);
      return timer;
    },
    clearTimeout: (timer) => timers.splice(timers.indexOf(timer), 1),
  };
  // Imports are supplied by the context so startup, watchers, and restart run unchanged.
  await NodeVM.runInNewContext(
    `(async () => { ${source.replace(/^import\s[\s\S]*?;\n/gm, "")} })()`,
    context,
  );
  return {
    apps,
    commands,
    sweeps,
    restart: async () => {
      watchers[0]("change", "main.cjs");
      timers.shift().callback();
      await stopping.promise;
      if (!exitsOnTerm) timers.shift().callback();
      await restarted.promise;
    },
  };
}

function assertSweeps(patterns) {
  for (const pattern of patterns) {
    const regex = new RegExp(pattern);
    assert.isTrue(
      regex.test("electron --t3code-dev-root=/tmp/t3-feature.one/apps/desktop main.cjs"),
    );
    assert.isTrue(regex.test("electron --t3code-dev-root=/tmp/t3-feature.one/apps/desktop"));
    assert.isFalse(
      regex.test("electron --t3code-dev-root=/tmp/t3-featureXone/apps/desktop main.cjs"),
    );
    assert.isFalse(
      regex.test("electron --t3code-dev-root=/tmp/t3-feature.one-two/apps/desktop main.cjs"),
    );
    assert.isFalse(
      regex.test("electron --t3code-dev-root=/tmp/t3-feature.one/apps/desktop-two main.cjs"),
    );
  }
}

describe("desktop dev process ownership", () => {
  const platforms = ["linux", "darwin", "win32"];
  it.each(platforms)("%s: startup leaves the other worktree running", async (platform) => {
    const fixture = await launchFixture(platform);
    assert.lengthOf(fixture.apps, 1);
    assert.lengthOf(fixture.sweeps, platform === "win32" ? 0 : 1);
    assertSweeps(fixture.sweeps);
  });

  it.each(
    platforms.flatMap((platform) => [
      { platform, exitsOnTerm: true, kind: "ordinary" },
      { platform, exitsOnTerm: false, kind: "forced" },
    ]),
  )(
    "$platform: $kind restart stops the captured app and sweeps own orphans",
    async ({ platform, exitsOnTerm }) => {
      const fixture = await launchFixture(platform, exitsOnTerm);
      await fixture.restart();
      assert.deepEqual(fixture.apps[0].signals, exitsOnTerm ? ["SIGTERM"] : ["SIGTERM", "SIGKILL"]);
      assert.lengthOf(fixture.apps, 2);
      assert.deepEqual(fixture.apps[1].signals, []);
      assert.lengthOf(fixture.sweeps, platform === "win32" ? 0 : exitsOnTerm ? 2 : 3);
      assertSweeps(fixture.sweeps);
      assert.deepEqual(
        fixture.commands.filter(([, args]) => !args.includes("-f")),
        platform === "win32"
          ? []
          : [
              ["pkill", ["-TERM", "-P", "1000"]],
              ...(!exitsOnTerm ? [["pkill", ["-KILL", "-P", "1000"]]] : []),
            ],
      );
    },
  );
});

it
  .skipIf(hostPlatform === "win32")
  .each([
    "/tmp/t3-feature.one/apps/desktop",
    "/tmp/t3 [feature](one)+?^${two}|back\\slash/apps/desktop",
  ])("native pgrep matches only the exact dev root %s", async (desktopDir) => {
  const fixture = await launchFixture(hostPlatform, true, desktopDir);
  const pattern = fixture.sweeps[0];
  const roots = [
    desktopDir,
    desktopDir,
    desktopDir.replace(".one", "Xone").replace("(one)", "(Xone)"),
    `${desktopDir}-two`,
  ];
  const children = [];
  try {
    for (const [index, root] of roots.entries()) {
      // Node reports readiness after exec; only captured children are ever stopped.
      const child = NodeChildProcess.spawn(
        process.execPath,
        [
          "-e",
          "process.send('ready'); setInterval(() => {}, 1000)",
          "--",
          `--t3code-dev-root=${root}`,
          ...(index === 0 ? ["main.cjs"] : []),
        ],
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
    const result = NodeChildProcess.spawnSync("pgrep", ["-f", "--", pattern], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    const matches = result.stdout.trim().split(/\s+/).map(Number);
    assert.include(matches, children[0].pid);
    assert.include(matches, children[1].pid);
    assert.notInclude(matches, children[2].pid);
    assert.notInclude(matches, children[3].pid);
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

it.skipIf(hostPlatform === "win32")(
  "macOS launcher shell quoting preserves the raw dev-root argument",
  async () => {
    const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-dev-argv-"));
    try {
      const mainEntryPath = NodePath.join(directory, "argv.mjs");
      const launcherPath = NodePath.join(directory, "launcher.sh");
      const desktopRoot = "/tmp/t3 [feature].one's/apps/desktop";
      NodeFS.writeFileSync(mainEntryPath, "console.log(JSON.stringify(process.argv.slice(2)))");
      // Node treats the Electron flag as a Node option, so put it after -- using a wrapper.
      const wrapperPath = NodePath.join(directory, "electron");
      NodeFS.writeFileSync(
        wrapperPath,
        '#!/bin/sh\nexec "$T3_FIXTURE_NODE" "$T3_FIXTURE_MAIN" "$@"\n',
        { mode: 0o755 },
      );
      NodeFS.writeFileSync(
        launcherPath,
        makeDevelopmentLauncherScript({
          electronBinaryPath: wrapperPath,
          mainEntryPath,
          desktopRoot,
          environmentFilePath: NodePath.join(directory, "absent.sh"),
        }),
      );
      const result = NodeChildProcess.spawnSync("/bin/sh", [launcherPath], {
        encoding: "utf8",
        env: { ...process.env, T3_FIXTURE_NODE: process.execPath, T3_FIXTURE_MAIN: mainEntryPath },
      });
      assert.equal(result.status, 0, result.stderr);
      const argv = JSON.parse(result.stdout);
      assert.equal(argv[0], `--t3code-dev-root=${desktopRoot}`);
      const fixture = await launchFixture("darwin", true, desktopRoot);
      assert.isTrue(new RegExp(fixture.sweeps[0]).test(argv.join(" ")));
    } finally {
      NodeFS.rmSync(directory, { recursive: true, force: true });
    }
  },
);
