// @effect-diagnostics nodeBuiltinImport:off globalFetchInEffect:off - verifies generated remote scripts using real shell and Node processes.
import * as Effect from "effect/Effect";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { expect, it } from "@effect/vitest";
import * as NodeChildProcess from "node:child_process";
import * as NodeEvents from "node:events";
import * as NodeStreamConsumers from "node:stream/consumers";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";
import { DEVICE_HUB_VERSION } from "./DeviceToolchain.ts";
import {
  quoteRemoteArg,
  remoteDeviceCommand,
  remoteDeviceEnvironment,
  remoteDeviceScript,
  SYMLINK_HINT,
} from "./sshDeviceScript.ts";

const exec = NodeUtil.promisify(NodeChildProcess.execFile);
const windowsHost = HostProcess.Platform.defaultValue() === "win32";
const writeNpmPackage = async (directory: string, version: string, nodeEngine: string) => {
  const root = NodePath.join(directory, "node_modules/npm");
  await NodeFSP.mkdir(NodePath.join(root, "bin"), { recursive: true });
  await NodeFSP.writeFile(
    NodePath.join(root, "package.json"),
    JSON.stringify({ version, engines: { node: nodeEngine } }),
  );
  const located = await exec(windowsHost ? "where.exe" : "which", ["npm"]);
  const launcher = await NodeFSP.realpath(located.stdout.trim().split(/\r?\n/)[0]!);
  const npmRoot = NodePath.resolve(
    NodePath.dirname(launcher),
    windowsHost ? "node_modules/npm" : "..",
  );
  await NodeFSP.cp(
    NodePath.join(npmRoot, "node_modules/semver"),
    NodePath.join(root, "node_modules/semver"),
    { recursive: true },
  );
};
const writeNodeRuntime = async (directory: string) => {
  await NodeFSP.copyFile(process.execPath, NodePath.join(directory, "node.exe"));
  if (!windowsHost) await NodeFSP.symlink("node.exe", NodePath.join(directory, "node"));
};
it("passes bootstrap code through the remote login shell without reinterpreting quotes", () => {
  const value = "spaces 'single' \"double\" $HOME `literal`\nsecond line";
  const command = remoteDeviceCommand(
    "exec node",
    `process.stdout.write(${JSON.stringify(value)});`,
    {
      nodeBootstrap: true,
    },
  );
  const result = NodeChildProcess.spawnSync(
    windowsHost ? "powershell.exe" : "sh",
    windowsHost
      ? ["-NoProfile", "-NonInteractive", "-Command", command.remoteCommandArgs.join(" ")]
      : ["-c", command.remoteCommandArgs.join(" ")],
    { input: command.stdin, encoding: "utf8", timeout: 10000 },
  );
  expect(result.error).toBeUndefined();
  expect(result.stderr).toBe("");
  expect(result.status).toBe(0);
  expect(result.stdout).toBe(value);
});

const executable = async (file: string, body = "exit 0") => {
  await NodeFSP.mkdir(NodePath.dirname(file), { recursive: true });
  await NodeFSP.writeFile(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
};

const completeSdk = async (sdk: string, adb = "echo Android Debug Bridge", windows = false) => {
  await executable(NodePath.join(sdk, `platform-tools/adb${windows ? ".exe" : ""}`), adb);
  await executable(NodePath.join(sdk, `emulator/emulator${windows ? ".exe" : ""}`));
  await executable(
    NodePath.join(sdk, `cmdline-tools/latest/bin/avdmanager${windows ? ".bat" : ""}`),
  );
};

/** Runs the probe through the SSH shell setup, then `after` in that same shell. */
const probeAndroid = (setup: (home: string) => Promise<Record<string, string>>, after = "true") =>
  Effect.promise(async () => {
    const home = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-ssh-sdk-"));
    try {
      const env = await setup(home);
      await executable(NodePath.join(home, "bin/npm"), "echo 10.0.0");
      const probe = NodePath.join(home, "probe.cjs");
      await NodeFSP.writeFile(probe, remoteDeviceScript("fixture", "probe"));
      const result = await exec(
        "/bin/sh",
        ["-c", `${remoteDeviceEnvironment()}\n"$NODE" "$PROBE" && ${after}`],
        {
          env: {
            HOME: home,
            PATH: `${NodePath.join(home, "bin")}:/usr/bin:/bin`,
            NODE: process.execPath,
            PROBE: probe,
            ...env,
          },
        },
      );
      const [inventory = "", ...rest] = result.stdout.trim().split("\n");
      const android = JSON.parse(inventory).platforms.find(
        (entry: { platform: string }) => entry.platform === "android",
      );
      return { android, after: rest.join("\n") };
    } finally {
      await NodeFSP.rm(home, { recursive: true, force: true });
    }
  });

it.effect("does not offer Android when the SDK adb cannot run", () =>
  Effect.gen(function* () {
    if ((yield* HostProcess.Platform) === "win32") return;
    const { android } = yield* probeAndroid(async (home) => {
      const sdk = NodePath.join(home, "sdk");
      await completeSdk(sdk, "exit 1");
      return { ANDROID_HOME: sdk };
    });
    expect(android).toEqual({ platform: "android", available: false, reason: expect.any(String) });
  }),
);

it.effect("does not offer Android when SDK tools are directories", () =>
  Effect.gen(function* () {
    if ((yield* HostProcess.Platform) === "win32") return;
    const { android } = yield* probeAndroid(async (home) => {
      const sdk = NodePath.join(home, "sdk");
      await executable(NodePath.join(sdk, "platform-tools/adb"), "echo Android Debug Bridge");
      await NodeFSP.mkdir(NodePath.join(sdk, "emulator/emulator"), { recursive: true });
      await NodeFSP.mkdir(NodePath.join(sdk, "cmdline-tools/latest/bin/avdmanager"), {
        recursive: true,
      });
      return { ANDROID_HOME: sdk };
    });
    expect(android).toEqual({
      platform: "android",
      available: false,
      reason: expect.stringContaining("Android Emulator"),
    });
  }),
);

it.effect("uses the SDK the probe accepted for later SSH commands", () =>
  Effect.gen(function* () {
    if ((yield* HostProcess.Platform) === "win32") return;
    let sdk = "";
    const result = yield* probeAndroid(async (home) => {
      // Incomplete default locations must not shadow the configured SDK.
      await NodeFSP.mkdir(NodePath.join(home, "Library/Android/sdk"), { recursive: true });
      await NodeFSP.mkdir(NodePath.join(home, "Android/Sdk"), { recursive: true });
      sdk = NodePath.join(home, "custom-sdk");
      await completeSdk(sdk);
      return { ANDROID_SDK_ROOT: sdk };
    }, "command -v emulator");
    expect(result.android).toEqual({ platform: "android", available: true });
    expect(result.after).toBe(NodePath.join(sdk, "emulator/emulator"));
  }),
);

it("runs Windows npm probe and installation through Node with paths containing spaces", (context) => {
  let active: NodeChildProcess.ChildProcess | undefined;
  // Terminate the owned Windows tree or POSIX group before joining fixture teardown.
  context.onTestFinished(async () => {
    const child = active;
    try {
      if (child?.pid && child.exitCode === null && child.signalCode === null) {
        if (!windowsHost) process.kill(-child.pid, "SIGKILL");
        else
          await exec("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
            windowsHide: true,
            timeout: 10000,
          });
      }
    } finally {
      await running.catch(() => {});
    }
  });
  const running = (async () => {
    const home = await NodeFSP.realpath(
      await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3 npm fixture ")),
    );
    try {
      const node = NodePath.join(home, "Node runtime", "node.exe");
      const npm = NodePath.join(NodePath.dirname(node), "node_modules/npm/bin/npm-cli.js");
      const calls = NodePath.join(home, "npm calls.jsonl");
      const sdk = NodePath.join(home, "sdk");
      await completeSdk(sdk, undefined, true);
      await writeNpmPackage(NodePath.dirname(node), "11.0.0", "^20.17.0 || >=22.13.0");
      await writeNodeRuntime(NodePath.dirname(node));
      const npmFixture = `const fs = require('node:fs');
const args = process.argv.slice(2);
const child = require('node:child_process').spawnSync(process.env.ComSpec || '/bin/sh',
  process.platform === 'win32' ? ['/d', '/s', '/c', 'node -p process.execPath'] : ['-c', 'node -p process.execPath'],
  { cwd: ${JSON.stringify(home)}, encoding: 'utf8' });
if (child.error || child.status !== 0) { console.error(child.error?.message || child.stderr); process.exit(29); }
fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify({ node: process.execPath, args, childNode: child.stdout.trim() }) + '\\n');
if (args[0] === 'install') { console.error('fixture registry unavailable'); process.exitCode = 23; }
else console.log(require('../package.json').version);`;
      await NodeFSP.writeFile(npm, npmFixture);
      type NpmArgs = [path?: string, node?: string, key?: "PATH" | "Path", sibling?: string];
      let denyLock = false;
      const invoke = async (
        mode: "probe" | "start",
        ...[npmPath = "", nodeVersion, pathKey = "PATH", siblingVersion]: NpmArgs
      ) => {
        const script = NodePath.join(home, `${mode}.cjs`);
        await NodeFSP.writeFile(
          script,
          `Object.defineProperty(process, 'platform', { value: 'win32' });
${nodeVersion ? `Object.defineProperty(process.versions, 'node', { value: ${JSON.stringify(nodeVersion)} });` : ""}
require('node:os').homedir = () => ${JSON.stringify(home)};
if (${denyLock}) require('node:fs').symlinkSync = () => { throw Object.assign(Error('fixture symlink blocked'), { code: 'EPERM' }); };
const childProcess = require('node:child_process');
const originalSpawnSync = childProcess.spawnSync;
childProcess.spawnSync = (command, args, options) => command.endsWith('adb.exe')
  ? { status: 0, stdout: '', stderr: '' }
  ${siblingVersion ? `: args[0] === '-p' ? { status: 0, stdout: ${JSON.stringify(siblingVersion)}, stderr: '' }` : ""}
  : originalSpawnSync(command, args, options);
` + remoteDeviceScript("fixture", mode),
        );
        const env = Object.fromEntries(
          Object.entries(process.env).filter(([key]) => key.toLowerCase() !== "path"),
        );
        context.signal.throwIfAborted();
        const child = NodeChildProcess.spawn(node, [script], {
          env: { ...env, [pathKey]: npmPath, ANDROID_HOME: sdk },
          detached: !windowsHost,
        });
        active = child;
        const [[code], stdout, stderr] = await Promise.all([
          NodeEvents.EventEmitter.once(child, "close"),
          NodeStreamConsumers.text(child.stdout),
          NodeStreamConsumers.text(child.stderr),
        ]);
        if (code !== 0) throw Object.assign(new Error(`${code}: ${stderr}`), { stdout, stderr });
        return { stdout, stderr };
      };
      const rejects = (result: ReturnType<typeof invoke>, diagnostic: string) =>
        expect(result).rejects.toMatchObject({ stderr: expect.stringContaining(diagnostic) });
      const checkNpm = async (runtime: string, ...args: NpmArgs) => {
        await NodeFSP.writeFile(calls, "");
        const probe = await invoke("probe", ...args);
        expect(JSON.parse(probe.stdout).nodePath).toBe(node);
        expect(JSON.parse(probe.stdout).platforms).toContainEqual({
          platform: "android",
          available: true,
        });
        await rejects(
          invoke("start", ...args),
          "Installing expo-device-hub: exit code 23: fixture registry unavailable",
        );
        const recent = (await NodeFSP.readFile(calls, "utf8"))
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line));
        const prefix = expect.stringContaining(home);
        const packageSpec = `expo-device-hub@${DEVICE_HUB_VERSION}`;
        expect(recent).toEqual(
          [
            ["--version"],
            ["--version"],
            ["install", "--prefix", prefix, "--no-fund", "--no-audit", packageSpec],
          ].map((args) => ({ node: runtime, childNode: runtime, args })),
        );
      };
      await checkNpm(node);
      await NodeFSP.writeFile(calls, "");
      denyLock = true;
      await rejects(invoke("start"), SYMLINK_HINT);
      expect(await NodeFSP.readFile(calls, "utf8")).toBe("");
      denyLock = false;
      const competitor = NodePath.join(home, "Competing runtime");
      await NodeFSP.mkdir(competitor);
      await writeNodeRuntime(competitor);
      await checkNpm(node, competitor, undefined, "Path");
      await writeNpmPackage(NodePath.dirname(node), "10.0.0", "^18.17.0 || >=20.0.0");
      await checkNpm(node, "", "22.12.0");
      await writeNpmPackage(NodePath.dirname(node), "11.0.0", "^20.17.0 || >=22.13.0");
      for (const mode of ["probe", "start"] as const) {
        await rejects(
          invoke(mode, "", "22.12.0"),
          `No compatible Node 22.12+ and npm pair: npm 11.0.0 at ${npm} requires Node ^20.17.0 || >=22.13.0; found 22.12.0 at ${node}`,
        );
      }
      for (const [method, code, message, prefix, mode] of [
        ["error", 17, "fixture npm configuration invalid", "npm probe failed: ", "probe"],
        ["log", 19, "fixture stdout-only failure", "", "probe"],
        ["log", 19, "fixture stdout-only failure", "", "start"],
      ] as const) {
        const source = `console.${method}('${message}'); process.exitCode = ${code};`;
        await NodeFSP.writeFile(npm, source);
        await rejects(invoke(mode), `${prefix}exit code ${code}: ${message}`);
      }
      await rejects(invoke("probe", "", "18.0.0"), `Found 18.0.0 at ${node}.`);
      await NodeFSP.rm(npm);
      await rejects(invoke("probe"), "npm is missing:");
      const fallback = NodePath.join(home, "npm on PATH");
      const fallbackEntry = NodePath.join(fallback, "node_modules/npm/bin/npm-cli.js");
      await writeNpmPackage(fallback, "10.0.0", "^18.17.0 || >=20.0.0");
      await NodeFSP.writeFile(fallbackEntry, "console.log('10.0.0');");
      expect(JSON.parse((await invoke("probe", `"${fallback}"`, "22.12.0")).stdout).nodePath).toBe(
        node,
      );
      await writeNpmPackage(fallback, "11.0.0", "^20.17.0 || >=22.13.0");
      await rejects(invoke("probe", fallback, "22.12.0"), "npm 11.0.0");
      const sibling = NodePath.join(fallback, "node.exe");
      await writeNodeRuntime(fallback);
      await NodeFSP.writeFile(fallbackEntry, npmFixture);
      await checkNpm(sibling, fallback, "22.12.0");
      await checkNpm(node, fallback, undefined, "PATH", "18.0.0");
      await writeNpmPackage(NodePath.dirname(node), "10.0.0", "^18.17.0 || >=20.0.0");
      await NodeFSP.writeFile(npm, npmFixture);
      await checkNpm(node, fallback, "22.12.0");
      for (const [file, contents] of [
        ["package.json", undefined],
        ["package.json", "{"],
        ["package.json", "null"],
        ["package.json", "{}"],
        ["node_modules/semver", undefined],
        ["bin/npm-cli.js", "throw Error('fixture damaged CLI');"],
      ] as const) {
        await writeNpmPackage(NodePath.dirname(node), "10.0.0", ">=22");
        const target = NodePath.resolve(NodePath.dirname(npm), "..", file);
        if (contents === undefined) await NodeFSP.rm(target, { recursive: true });
        else await NodeFSP.writeFile(target, contents);
        await checkNpm(sibling, fallback);
        await rejects(invoke("probe"), `No compatible Node 22.12+ and npm pair: npm at ${npm}:`);
      }
    } finally {
      await NodeFSP.rm(home, { recursive: true, force: true });
    }
  })();
  return running;
});
it.effect.each([{ supported: true }, { supported: false }])(
  "preserves a working SSH Node/npm pair and replaces an old Node: supported=$supported",
  ({ supported }) =>
    Effect.promise(async () => {
      const home = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-ssh-path-"));
      try {
        const bin = NodePath.join(home, "selected-node/bin");
        const fallback = NodePath.join(home, ".local/bin");
        const sdk = NodePath.join(home, "android-sdk");
        const jvm = NodePath.join(home, "java-home");
        for (const [tool, directory] of [
          ["adb", NodePath.join(sdk, "platform-tools")],
          ["java", NodePath.join(jvm, "bin")],
        ] as const) {
          await executable(NodePath.join(directory, tool), `echo configured-${tool}`);
          await executable(NodePath.join(fallback, tool), `echo wrong-${tool}`);
        }
        for (const tool of ["node", "npm"]) {
          const probe = (status: number) => `if [ "$1" = "-e" ]; then exit ${status}; fi`;
          await executable(NodePath.join(bin, tool), `${probe(supported ? 0 : 1)}\necho selected`);
          await executable(NodePath.join(fallback, tool), `${probe(0)}\necho fallback`);
        }
        const script = `${remoteDeviceEnvironment({ nodeBootstrap: true })}\nnode; npm; adb; java`;
        const result = await exec("/bin/sh", ["-c", script], {
          env: { HOME: home, PATH: bin, JAVA_HOME: jvm, ANDROID_HOME: sdk },
        });
        expect(result.stdout).toBe(
          (supported ? "selected\nselected\n" : "fallback\nfallback\n") +
            "configured-adb\nconfigured-java\n",
        );
      } finally {
        await NodeFSP.rm(home, { recursive: true, force: true });
      }
    }),
  { skip: windowsHost },
);
it.effect("finds Android Studio Java for a non-interactive SSH session", () =>
  Effect.gen(function* () {
    if ((yield* HostProcess.Platform) === "win32") return;
    yield* Effect.promise(async () => {
      const home = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-ssh-java-"));
      try {
        const javaHome = NodePath.join(home, ".local/opt/android-studio/jbr");
        await NodeFSP.mkdir(NodePath.join(javaHome, "bin"), { recursive: true });
        await NodeFSP.writeFile(
          NodePath.join(javaHome, "bin/java"),
          "#!/bin/sh\necho test-java\n",
          { mode: 0o755 },
        );
        const result = await exec("/bin/sh", ["-c", `${remoteDeviceEnvironment()}\njava`], {
          env: { HOME: home, PATH: "/nonexistent", JAVA_HOME: "" },
        });
        expect(result.stdout.trim()).toBe("test-java");
      } finally {
        await NodeFSP.rm(home, { recursive: true, force: true });
      }
    });
  }),
);

it.effect("preserves shell metacharacters and newlines in remote arguments", () =>
  Effect.gen(function* () {
    if ((yield* HostProcess.Platform) === "win32") return;
    yield* Effect.promise(async () => {
      const value = "quotes ' \" ; $(echo expanded) $HOME\nnext line";
      const result = await exec("sh", ["-c", `printf %s ${quoteRemoteArg(value)}`]);
      expect(result.stdout).toBe(value);
    });
  }),
);

it.effect("rejects a Node release below the pinned agent-device engine floor", () =>
  Effect.gen(function* () {
    if ((yield* HostProcess.Platform) === "win32") return;
    const probe = NodeChildProcess.spawnSync(process.execPath, [], {
      input:
        `Object.defineProperty(process.versions, "node", { value: "22.11.0" });\n` +
        remoteDeviceScript("owner", "probe"),
      env: { HOME: NodeOS.tmpdir(), PATH: NodePath.dirname(process.execPath) },
      encoding: "utf8",
    });
    expect(probe.status).not.toBe(0);
    expect(probe.stderr).toContain("Node 22.12 or newer");
  }),
);

it.effect("stops a daemon left for its owner when starting without agent tools", () =>
  Effect.gen(function* () {
    if ((yield* HostProcess.Platform) === "win32") return;
    yield* Effect.promise(async () => {
      const home = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-ssh-start-"));
      try {
        const state = NodePath.join(home, ".t3/device/hosts/owner");
        const daemonFile = NodePath.join(state, "daemon.json");
        const calls = NodePath.join(home, "calls");
        const failMarker = NodePath.join(home, "fail-stop");
        const entry = NodePath.join(home, "agent-device.mjs");
        await NodeFSP.mkdir(NodePath.join(home, "bin"));
        await NodeFSP.mkdir(state, { recursive: true });
        await NodeFSP.writeFile(
          entry,
          `import * as fs from "node:fs";
fs.appendFileSync(${JSON.stringify(calls)}, process.argv.slice(2).join(" ") + "\\n");
if (fs.existsSync(${JSON.stringify(failMarker)})) process.exitCode = 1;`,
        );
        await NodeFSP.writeFile(
          NodePath.join(state, "agent.json"),
          JSON.stringify({ entryPath: entry }),
        );
        await NodeFSP.writeFile(daemonFile, JSON.stringify({ httpPort: 1, token: "claims" }));
        // An empty PATH leaves no platforms, so the script ends right after the daemon check.
        const start = () =>
          NodeChildProcess.spawnSync(process.execPath, [], {
            input: remoteDeviceScript("owner", "start"),
            env: { HOME: home, PATH: NodePath.join(home, "bin") },
            encoding: "utf8",
          });
        await NodeFSP.writeFile(failMarker, "");
        expect(start().stderr).toContain("Could not stop the agent-device daemon");
        expect(await NodeFSP.readFile(daemonFile, "utf8")).toContain("claims");
        await NodeFSP.rm(failMarker);
        expect(start().stderr).toContain("Android SDK was not found");
        await expect(NodeFSP.access(daemonFile)).rejects.toThrow();
        expect(await NodeFSP.readFile(calls, "utf8")).toBe(
          `daemon stop --state-dir ${state}\ndaemon stop --state-dir ${state}\n`,
        );
      } finally {
        await NodeFSP.rm(home, { recursive: true, force: true });
      }
    });
  }),
);

it.effect("keeps a daemon record its missing agent CLI cannot stop", () =>
  Effect.gen(function* () {
    if ((yield* HostProcess.Platform) === "win32") return;
    yield* Effect.promise(async () => {
      const home = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-ssh-start-"));
      try {
        const state = NodePath.join(home, ".t3/device/hosts/owner");
        const daemonFile = NodePath.join(state, "daemon.json");
        await NodeFSP.mkdir(NodePath.join(home, "bin"));
        await NodeFSP.mkdir(state, { recursive: true });
        await NodeFSP.writeFile(
          NodePath.join(state, "agent.json"),
          JSON.stringify({ entryPath: NodePath.join(home, "missing/agent-device.mjs") }),
        );
        const start = async (pid: number) => {
          await NodeFSP.writeFile(
            daemonFile,
            JSON.stringify({ pid, httpPort: 1, token: "claims" }),
          );
          return NodeChildProcess.spawnSync(process.execPath, [], {
            input: remoteDeviceScript("owner", "start"),
            env: { HOME: home, PATH: NodePath.join(home, "bin") },
            encoding: "utf8",
          });
        };
        // This test process stands in for a daemon that is still running.
        expect((await start(process.pid)).stderr).toContain(
          "Could not stop the agent-device daemon",
        );
        expect(await NodeFSP.readFile(daemonFile, "utf8")).toContain("claims");
        const exited = NodeChildProcess.spawnSync(process.execPath, ["-e", ""]).pid;
        expect((await start(exited)).stderr).toContain("Android SDK was not found");
        await expect(NodeFSP.access(daemonFile)).rejects.toThrow();
      } finally {
        await NodeFSP.rm(home, { recursive: true, force: true });
      }
    });
  }),
);
