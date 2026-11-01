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
import * as SshDeviceScript from "./sshDeviceScript.ts";
import { DEVICE_HUB_VERSION } from "./DeviceToolchain.ts";

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

/** Runs a remote device command through the host's native login shell, as sshd would. */
const runThroughLoginShell = (command: ReturnType<typeof SshDeviceScript.remoteDeviceCommand>) =>
  Effect.map(HostProcess.Platform, (platform) =>
    NodeChildProcess.spawnSync(
      platform === "win32" ? "powershell.exe" : "sh",
      platform === "win32"
        ? ["-NoProfile", "-NonInteractive", "-Command", command.remoteCommandArgs.join(" ")]
        : ["-c", command.remoteCommandArgs.join(" ")],
      { input: command.stdin, encoding: "utf8", timeout: 10000 },
    ),
  );

it.effect(
  "passes bootstrap code through the remote login shell without reinterpreting quotes",
  () =>
    Effect.gen(function* () {
      const value = "spaces 'single' \"double\" $HOME `literal`\nsecond line";
      const result = yield* runThroughLoginShell(
        SshDeviceScript.remoteDeviceCommand(
          "exec node",
          `process.stdout.write(${JSON.stringify(value)});`,
          { nodeBootstrap: true },
        ),
      );
      expect(result.error).toBeUndefined();
      expect(result.stderr).toBe("");
      expect(result.status).toBe(0);
      expect(result.stdout).toBe(value);
    }),
);

it.effect(
  "preserves remote arguments and exact stdin, and reports failure through the login shell",
  () =>
    Effect.gen(function* () {
      const value = "quotes ' \" $HOME\nno trailing newline";
      const input = `${value}\r\nCR\rNUL\0backslash \\ \\0015 %s`;
      const code =
        "process.stdout.write(JSON.stringify({args:process.argv.slice(1),input:require('node:fs').readFileSync(0,'utf8')}));process.exitCode=23";
      const result = yield* runThroughLoginShell(
        SshDeviceScript.remoteDeviceCommand(
          `exec ${[process.execPath.replaceAll("\\", "/"), "-e", code, value].map(SshDeviceScript.quoteRemoteArg).join(" ")}`,
          input,
        ),
      );
      expect(result.error).toBeUndefined();
      expect(result.stderr).toBe("");
      // PowerShell -Command normalizes a failing native command to exit code 1.
      expect(result.status).toBe((yield* HostProcess.Platform) === "win32" ? 1 : 23);
      expect(JSON.parse(result.stdout)).toEqual({ args: [value], input });
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
      await writeNpmPackage(NodePath.dirname(node), "11.0.0", "^20.17.0 || >=22.9.0");
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
      const invoke = async (
        mode: "probe" | "start",
        npmPath = "",
        nodeVersion?: string,
        pathKey: "PATH" | "Path" = "PATH",
        siblingVersion?: string,
      ) => {
        const script = NodePath.join(home, `${mode}.cjs`);
        await NodeFSP.writeFile(
          script,
          `Object.defineProperty(process, 'platform', { value: 'win32' });
${nodeVersion ? `Object.defineProperty(process.versions, 'node', { value: ${JSON.stringify(nodeVersion)} });` : ""}
require('node:os').homedir = () => ${JSON.stringify(home)};
const childProcess = require('node:child_process');
const originalSpawnSync = childProcess.spawnSync;
childProcess.spawnSync = (command, args, options) => command === 'adb'
  ? { status: 0, stdout: '', stderr: '' }
  ${siblingVersion ? `: args[0] === '-p' ? { status: 0, stdout: ${JSON.stringify(siblingVersion)}, stderr: '' }` : ""}
  : originalSpawnSync(command, args, options);
` + SshDeviceScript.remoteDeviceScript("fixture", mode),
        );
        const env = Object.fromEntries(
          Object.entries(process.env).filter(([key]) => key.toLowerCase() !== "path"),
        );
        context.signal.throwIfAborted();
        const child = NodeChildProcess.spawn(node, [script], {
          env: { ...env, [pathKey]: npmPath },
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
      const checkNpm = async (
        runtime: string,
        npmPath = "",
        nodeVersion?: string,
        pathKey: "PATH" | "Path" = "PATH",
        siblingVersion?: string,
      ) => {
        await NodeFSP.writeFile(calls, "");
        const probe = await invoke("probe", npmPath, nodeVersion, pathKey, siblingVersion);
        expect(JSON.parse(probe.stdout).nodePath).toBe(node);
        await rejects(
          invoke("start", npmPath, nodeVersion, pathKey, siblingVersion),
          "Installing expo-device-hub: exit code 23: fixture registry unavailable",
        );
        const recent = (await NodeFSP.readFile(calls, "utf8"))
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line));
        expect(recent).toEqual(
          [
            ["--version"],
            [
              "install",
              "--prefix",
              expect.stringContaining(home),
              "--no-fund",
              "--no-audit",
              `expo-device-hub@${DEVICE_HUB_VERSION}`,
            ],
          ].map((args) => ({ node: runtime, childNode: runtime, args })),
        );
      };
      await checkNpm(node);
      const competitor = NodePath.join(home, "Competing runtime");
      await NodeFSP.mkdir(competitor);
      await writeNodeRuntime(competitor);
      await checkNpm(node, competitor, undefined, "Path");

      await writeNpmPackage(NodePath.dirname(node), "10.0.0", "^18.17.0 || >=20.0.0");
      await checkNpm(node, "", "22.0.0");
      await writeNpmPackage(NodePath.dirname(node), "11.0.0", "^20.17.0 || >=22.9.0");
      for (const mode of ["probe", "start"] as const) {
        await rejects(
          invoke(mode, "", "22.8.0"),
          `No compatible Node 22+ and npm pair: npm 11.0.0 at ${npm} requires Node ^20.17.0 || >=22.9.0; found 22.8.0 at ${node}`,
        );
      }
      for (const [method, code, message, prefix, modes] of [
        ["error", 17, "fixture npm configuration invalid", "npm probe failed: ", ["probe"]],
        ["log", 19, "fixture stdout-only failure", "", ["probe", "start"]],
      ] as const) {
        const source = `console.${method}('${message}'); process.exitCode = ${code};`;
        await NodeFSP.writeFile(npm, source);
        for (const mode of modes) {
          await rejects(invoke(mode), `${prefix}exit code ${code}: ${message}`);
        }
      }
      await rejects(invoke("probe", "", "18.0.0"), `Found 18.0.0 at ${node}.`);
      await NodeFSP.rm(npm);
      await rejects(invoke("probe"), "npm is missing:");
      const fallback = NodePath.join(home, "npm on PATH");
      const fallbackEntry = NodePath.join(fallback, "node_modules/npm/bin/npm-cli.js");
      await writeNpmPackage(fallback, "10.0.0", "^18.17.0 || >=20.0.0");
      await NodeFSP.writeFile(fallbackEntry, "console.log('10.0.0');");
      expect(JSON.parse((await invoke("probe", `"${fallback}"`, "22.0.0")).stdout).nodePath).toBe(
        node,
      );
      await writeNpmPackage(fallback, "11.0.0", "^20.17.0 || >=22.9.0");
      await rejects(invoke("probe", fallback, "22.8.0"), "npm 11.0.0");
      const sibling = NodePath.join(fallback, "node.exe");
      await writeNodeRuntime(fallback);
      await NodeFSP.writeFile(fallbackEntry, npmFixture);
      await checkNpm(sibling, fallback, "22.8.0");
      await checkNpm(node, fallback, undefined, "PATH", "18.0.0");
      await writeNpmPackage(NodePath.dirname(node), "10.0.0", "^18.17.0 || >=20.0.0");
      await NodeFSP.writeFile(npm, npmFixture);
      await checkNpm(node, fallback, "22.0.0");
      for (const [file, contents] of [
        ["package.json", undefined],
        ["package.json", "{"],
        ["package.json", "null"],
        ["package.json", "{}"],
        ["node_modules/semver", undefined],
      ] as const) {
        await writeNpmPackage(NodePath.dirname(node), "10.0.0", ">=22");
        const target = NodePath.resolve(NodePath.dirname(npm), "..", file);
        if (contents === undefined) await NodeFSP.rm(target, { recursive: true });
        else await NodeFSP.writeFile(target, contents);
        await checkNpm(sibling, fallback);
        await rejects(invoke("probe"), `No compatible Node 22+ and npm pair: npm at ${npm}:`);
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
        await NodeFSP.mkdir(bin, { recursive: true });
        await NodeFSP.mkdir(fallback, { recursive: true });
        for (const [tool, directory] of [
          ["adb", NodePath.join(sdk, "platform-tools")],
          ["java", NodePath.join(jvm, "bin")],
        ] as const) {
          await NodeFSP.mkdir(directory, { recursive: true });
          await NodeFSP.writeFile(
            NodePath.join(directory, tool),
            `#!/bin/sh\necho configured-${tool}\n`,
            { mode: 0o755 },
          );
          await NodeFSP.writeFile(
            NodePath.join(fallback, tool),
            `#!/bin/sh\necho wrong-${tool}\n`,
            { mode: 0o755 },
          );
        }
        for (const tool of ["node", "npm"]) {
          await NodeFSP.writeFile(
            NodePath.join(bin, tool),
            `#!/bin/sh\nif [ "$1" = "-e" ]; then exit ${supported ? 0 : 1}; fi\necho selected\n`,
            {
              mode: 0o755,
            },
          );
          await NodeFSP.writeFile(
            NodePath.join(fallback, tool),
            '#!/bin/sh\nif [ "$1" = "-e" ]; then exit 0; fi\necho fallback\n',
            {
              mode: 0o755,
            },
          );
        }
        const result = await exec(
          "/bin/sh",
          [
            "-c",
            `${SshDeviceScript.remoteDeviceEnvironment({ nodeBootstrap: true })}\nnode; npm; adb; java`,
          ],
          {
            env: { HOME: home, PATH: bin, JAVA_HOME: jvm, ANDROID_HOME: sdk },
          },
        );
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

it.effect.skipIf(windowsHost)("finds Android Studio Java for a non-interactive SSH session", () =>
  Effect.promise(async () => {
    const home = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-ssh-java-"));
    try {
      const javaHome = NodePath.join(home, ".local/opt/android-studio/jbr");
      await NodeFSP.mkdir(NodePath.join(javaHome, "bin"), { recursive: true });
      await NodeFSP.writeFile(NodePath.join(javaHome, "bin/java"), "#!/bin/sh\necho test-java\n", {
        mode: 0o755,
      });
      const result = await exec(
        "/bin/sh",
        ["-c", `${SshDeviceScript.remoteDeviceEnvironment()}\njava`],
        {
          env: { HOME: home, PATH: "/nonexistent", JAVA_HOME: "" },
        },
      );
      expect(result.stdout.trim()).toBe("test-java");
    } finally {
      await NodeFSP.rm(home, { recursive: true, force: true });
    }
  }),
);

it.effect.skipIf(windowsHost)(
  "preserves shell metacharacters and newlines in remote arguments",
  () =>
    Effect.promise(async () => {
      const value = "quotes ' \" ; $(echo expanded) $HOME\nnext line";
      const result = await exec("sh", ["-c", `printf %s ${SshDeviceScript.quoteRemoteArg(value)}`]);
      expect(result.stdout).toBe(value);
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
            input: SshDeviceScript.remoteDeviceScript("owner", "start"),
            env: { HOME: home, PATH: NodePath.join(home, "bin") },
            encoding: "utf8",
          });
        await NodeFSP.writeFile(failMarker, "");
        expect(start().stderr).toContain("Could not stop the agent-device daemon");
        expect(await NodeFSP.readFile(daemonFile, "utf8")).toContain("claims");
        await NodeFSP.rm(failMarker);
        expect(start().stderr).toContain("Android SDK missing");
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
            input: SshDeviceScript.remoteDeviceScript("owner", "start"),
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
        expect((await start(exited)).stderr).toContain("Android SDK missing");
        await expect(NodeFSP.access(daemonFile)).rejects.toThrow();
      } finally {
        await NodeFSP.rm(home, { recursive: true, force: true });
      }
    });
  }),
);
