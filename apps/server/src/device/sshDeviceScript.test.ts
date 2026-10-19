// @effect-diagnostics nodeBuiltinImport:off globalFetchInEffect:off - verifies generated remote scripts using real shell and Node processes.
import * as Effect from "effect/Effect";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { describe, expect, it } from "@effect/vitest";
import * as NodeChildProcess from "node:child_process";
import * as NodeEvents from "node:events";
import * as NodeStreamConsumers from "node:stream/consumers";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";
import * as SshDeviceScript from "./sshDeviceScript.ts";
import { AGENT_DEVICE_VERSION, DEVICE_HUB_VERSION } from "./DeviceToolchain.ts";

const exec = NodeUtil.promisify(NodeChildProcess.execFile);
const windowsHost = HostProcess.Platform.defaultValue() === "win32";

const writeNpmPackage = async (directory: string, version: string, nodeEngine: string) => {
  const root = NodePath.join(directory, "node_modules/npm");
  await NodeFSP.mkdir(NodePath.join(root, "bin"), { recursive: true });
  await NodeFSP.writeFile(
    NodePath.join(root, "package.json"),
    JSON.stringify({ version, engines: { node: nodeEngine } }),
  );
  // Use npm's real bundled engine checker, without adding a repository dependency.
  await NodeFSP.cp(
    NodePath.resolve(
      NodePath.dirname(process.execPath),
      windowsHost ? "." : "../lib",
      "node_modules/npm/node_modules/semver",
    ),
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
    Effect.gen(function* () {
      yield* Effect.promise(async () => {
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
      });
    }),
  { skip: windowsHost },
);

it.effect.skipIf(windowsHost)("finds Android Studio Java for a non-interactive SSH session", () =>
  Effect.gen(function* () {
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
    });
  }),
);

it.effect.skipIf(windowsHost)(
  "preserves shell metacharacters and newlines in remote arguments",
  () =>
    Effect.gen(function* () {
      yield* Effect.promise(async () => {
        const value = "quotes ' \" ; $(echo expanded) $HOME\nnext line";
        const result = await exec("sh", [
          "-c",
          `printf %s ${SshDeviceScript.quoteRemoteArg(value)}`,
        ]);
        expect(result.stdout).toBe(value);
      });
    }),
);

describe.skipIf(windowsHost)("remote helper lifecycle", () => {
  it.effect("reuses its own healthy helpers and stops only its own runtime", () =>
    Effect.gen(function* () {
      yield* Effect.promise(async () => {
        const home = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-remote-script-"));
        const bin = NodePath.join(home, "bin");
        await NodeFSP.mkdir(bin);
        await NodeFSP.writeFile(NodePath.join(bin, "adb"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
        const root = NodePath.join(home, ".t3/device");
        const hubDir = NodePath.join(root, `tools/expo-device-hub@${DEVICE_HUB_VERSION}`);
        const agentDir = NodePath.join(root, `tools/agent-device@${AGENT_DEVICE_VERSION}`);
        const hub = NodePath.join(hubDir, "node_modules/expo-device-hub/dist/server/cli.mjs");
        const agent = NodePath.join(agentDir, "node_modules/agent-device/bin/agent-device.mjs");
        await NodeFSP.mkdir(NodePath.join(hubDir, "node_modules/expo-device-hub/dist/server"), {
          recursive: true,
        });
        await NodeFSP.mkdir(NodePath.join(agentDir, "node_modules/agent-device/bin"), {
          recursive: true,
        });
        await NodeFSP.writeFile(NodePath.join(hubDir, ".install-complete"), DEVICE_HUB_VERSION);
        await NodeFSP.writeFile(NodePath.join(agentDir, ".install-complete"), AGENT_DEVICE_VERSION);
        await NodeFSP.writeFile(
          hub,
          `import http from 'node:http'; import fs from 'node:fs';
if(fs.existsSync('fail-start-once')) {fs.unlinkSync('fail-start-once');process.exit(1);}
const args=process.argv.slice(2); fs.writeFileSync('hub-args.json',JSON.stringify(args)); http.createServer((req,res)=>{res.statusCode=fs.existsSync('unhealthy-'+process.pid)?503:200;res.end('ok');}).listen(Number(args[args.indexOf('--port')+1]),'127.0.0.1');`,
        );
        await NodeFSP.writeFile(
          agent,
          `import fs from 'node:fs'; import path from 'node:path'; import http from 'node:http'; import {spawn} from 'node:child_process';
const args=process.argv.slice(2);
const state=process.env.AGENT_DEVICE_STATE_DIR || args[args.indexOf('--state-dir')+1];
const file=path.join(state,'daemon.json');
if(args[0]==='daemon') { const data=JSON.parse(fs.readFileSync(file,'utf8')); fs.writeFileSync(path.join(state,'stopped-agent'),String(data.pid)); try {process.kill(data.pid,'SIGTERM')} catch {} }
else if(args[0]==='serve') { const server=http.createServer((req,res)=>{res.statusCode=fs.existsSync(path.join(state,'unhealthy-agent-'+process.pid))?503:200;res.end('ok');}); server.listen(0,'127.0.0.1',()=>{fs.writeFileSync(file,JSON.stringify({httpPort:server.address().port,pid:process.pid,token:'test'}));process.send?.('ready');process.disconnect?.();}); }
else { const child=spawn(process.execPath,[path.join(path.dirname(process.argv[1]),'daemon.mjs'),'serve'],{detached:true,stdio:['ignore','ignore','ignore','ipc'],env:process.env});await new Promise((resolve,reject)=>{child.once('message',resolve);child.once('error',reject);});child.unref(); }
`,
        );
        await NodeFSP.copyFile(agent, NodePath.join(NodePath.dirname(agent), "daemon.mjs"));
        const nextHubVersion = DEVICE_HUB_VERSION + "-upgrade";
        const nextAgentVersion = AGENT_DEVICE_VERSION + "-upgrade";
        // Each owner stands in for a host on a different platform.
        const hostPlatforms: Record<string, NodeJS.Platform> = { one: "linux", two: "darwin" };
        const hubArgs = async (owner: string): Promise<ReadonlyArray<string>> =>
          JSON.parse(
            await NodeFSP.readFile(NodePath.join(root, `hosts/${owner}/hub-args.json`), "utf8"),
          );
        let invocation = 0;
        const invoke = async (
          owner: string,
          mode: "probe" | "start" | "agent-start" | "stop-agent" | "stop",
          upgraded = false,
        ) => {
          const file = NodePath.join(home, `${owner}-${mode}-${invocation++}.cjs`);
          await NodeFSP.writeFile(
            file,
            `Object.defineProperty(process, 'platform', { value: ${JSON.stringify(hostPlatforms[owner])} });\n` +
              `const originalKill = process.kill; process.kill = (pid, signal) => { if (signal === 'SIGTERM') require('node:fs').appendFileSync(${JSON.stringify(NodePath.join(home, "stops"))}, pid+'\\n'); return originalKill(pid, signal); };\n` +
              SshDeviceScript.remoteDeviceScript(owner, mode)
                .replace(DEVICE_HUB_VERSION, upgraded ? nextHubVersion : DEVICE_HUB_VERSION)
                .replace(AGENT_DEVICE_VERSION, upgraded ? nextAgentVersion : AGENT_DEVICE_VERSION),
          );
          const result = await exec(process.execPath, [file], {
            env: { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}` },
          });
          return result.stdout ? JSON.parse(result.stdout) : null;
        };
        const inventory = await invoke("one", "probe");
        expect(inventory.tools.hub.installedVersions).toEqual([DEVICE_HUB_VERSION]);
        expect(inventory.tools.hub.runningVersion).toBeNull();
        expect(inventory.tools.agent.installedVersions).toEqual([AGENT_DEVICE_VERSION]);
        await expect(NodeFSP.stat(NodePath.join(root, "hosts/one/hub.json"))).rejects.toThrow();
        const template = NodePath.join(home, "hub-template");
        await NodeFSP.cp(hubDir, template, { recursive: true });
        await NodeFSP.rm(NodePath.join(hubDir, ".install-complete"));
        const installLock = hubDir + ".lock";
        await NodeFSP.symlink("2147483647:exited-installer", installLock);
        await NodeFSP.writeFile(
          NodePath.join(bin, "npm"),
          `#!${process.execPath}\nconst fs=require('node:fs');const args=process.argv.slice(2);if(args[0]==='--version'){console.log('10.0.0');process.exit(0);}fs.cpSync(${JSON.stringify(template)},args[args.indexOf('--prefix')+1],{recursive:true});`,
          { mode: 0o755 },
        );
        await NodeFSP.mkdir(NodePath.join(root, "hosts/one"), { recursive: true });
        await NodeFSP.writeFile(NodePath.join(root, "hosts/one/fail-start-once"), "");
        await NodeFSP.writeFile(NodePath.join(root, "tools/.maintenance-lock"), "blocked");
        await NodeFSP.writeFile(NodePath.join(root, "tools/.users"), "unwritable lease directory");
        try {
          const [manual, concurrent] = await Promise.all([
            invoke("one", "start"),
            invoke("one", "start"),
          ]);
          expect(concurrent.hubPort).toBe(manual.hubPort);
          expect(manual.daemonPort).toBeUndefined();
          expect((await hubArgs("one")).slice(-2)).toEqual(["--platform", "android"]);
          // A hub started before discovery was filtered has no recorded platform.
          const hubFile = NodePath.join(root, "hosts/one/hub.json");
          const { platform: _platform, ...unfilteredHub } = JSON.parse(
            await NodeFSP.readFile(hubFile, "utf8"),
          );
          await NodeFSP.writeFile(hubFile, JSON.stringify(unfilteredHub));
          const filtered = await invoke("one", "start");
          expect(filtered.hubPort).not.toBe(manual.hubPort);
          expect(await NodeFSP.readFile(NodePath.join(home, "stops"), "utf8")).toContain(
            `${unfilteredHub.pid}\n`,
          );
          expect((await invoke("one", "start")).hubPort).toBe(filtered.hubPort);
          await expect(
            NodeFSP.stat(NodePath.join(root, "hosts/one/daemon.json")),
          ).rejects.toThrow();
          const [first, concurrentAgent] = await Promise.all([
            invoke("one", "agent-start"),
            invoke("one", "agent-start"),
          ]);
          expect(concurrentAgent.hubPort).toBe(first.hubPort);
          expect(concurrentAgent.daemonPort).toBe(first.daemonPort);
          const running = await invoke("one", "probe");
          expect(running.tools.hub.runningVersion).toBe(DEVICE_HUB_VERSION);
          expect(running.tools.agent.runningVersion).toBe(AGENT_DEVICE_VERSION);
          const second = await invoke("two", "agent-start");
          const reused = await invoke("one", "agent-start");
          expect(reused.hubPort).toBe(first.hubPort);
          expect(await hubArgs("two")).not.toContain("--platform");
          expect((await invoke("two", "start")).hubPort).toBe(second.hubPort);
          expect(reused.daemonPort).toBe(first.daemonPort);
          expect(second.hubPort).not.toBe(first.hubPort);
          expect(second.daemonPort).not.toBe(first.daemonPort);
          const firstHub = JSON.parse(
            await NodeFSP.readFile(NodePath.join(root, "hosts/one/hub.json"), "utf8"),
          );
          const secondHub = JSON.parse(
            await NodeFSP.readFile(NodePath.join(root, "hosts/two/hub.json"), "utf8"),
          );
          await NodeFSP.writeFile(NodePath.join(root, `hosts/one/unhealthy-${firstHub.pid}`), "");
          let repaired = await invoke("one", "agent-start");
          expect(repaired.hubPort).not.toBe(first.hubPort);
          const stopped = (await NodeFSP.readFile(NodePath.join(home, "stops"), "utf8"))
            .trim()
            .split("\n");
          expect(stopped).toContain(String(firstHub.pid));
          expect(stopped).not.toContain(String(secondHub.pid));
          const previousDaemon = JSON.parse(
            await NodeFSP.readFile(NodePath.join(root, "hosts/one/daemon.json"), "utf8"),
          );
          for (const [source, name, version] of [
            [hubDir, "expo-device-hub", nextHubVersion],
            [agentDir, "agent-device", nextAgentVersion],
          ]) {
            const destination = NodePath.join(root, `tools/${name}@${version}`);
            await NodeFSP.cp(source!, destination, { recursive: true });
            await NodeFSP.writeFile(NodePath.join(destination, ".install-complete"), version!);
          }
          const upgraded = await invoke("one", "agent-start", true);
          expect(upgraded.entryPath).toContain(nextAgentVersion);
          const upgradedHub = JSON.parse(
            await NodeFSP.readFile(NodePath.join(root, "hosts/one/hub.json"), "utf8"),
          );
          expect(upgradedHub.entryPath).toContain(nextHubVersion);
          const upgradedDaemon = JSON.parse(
            await NodeFSP.readFile(NodePath.join(root, "hosts/one/daemon.json"), "utf8"),
          );
          expect(upgradedDaemon.pid).not.toBe(previousDaemon.pid);
          expect(await invoke("one", "agent-start", true)).toEqual(upgraded);
          await NodeFSP.writeFile(
            NodePath.join(root, `hosts/one/unhealthy-agent-${upgradedDaemon.pid}`),
            "",
          );
          repaired = await invoke("one", "agent-start", true);
          expect(
            await NodeFSP.readFile(NodePath.join(root, "hosts/one/stopped-agent"), "utf8"),
          ).toBe(String(upgradedDaemon.pid));
          expect(repaired.daemonPort).not.toBe(upgraded.daemonPort);
          const originalScript = SshDeviceScript.remoteDeviceScript("one", "stop-agent");
          const upgradedStop = NodePath.join(home, "upgraded-stop.cjs");
          await NodeFSP.writeFile(
            upgradedStop,
            originalScript.replace(AGENT_DEVICE_VERSION, "999.0.0"),
          );
          await exec(process.execPath, [upgradedStop], {
            env: { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}` },
          });
          const daemon = JSON.parse(
            await NodeFSP.readFile(NodePath.join(root, "hosts/one/daemon.json"), "utf8"),
          );
          expect(
            await NodeFSP.readFile(NodePath.join(root, "hosts/one/stopped-agent"), "utf8"),
          ).toBe(String(daemon.pid));
          expect((await fetch(`http://127.0.0.1:${repaired.hubPort}/readyz`)).ok).toBe(true);
          await invoke("one", "stop");
          expect((await fetch(`http://127.0.0.1:${second.hubPort}/readyz`)).ok).toBe(true);
          expect(
            JSON.parse(await NodeFSP.readFile(NodePath.join(root, "hosts/two/hub.json"), "utf8"))
              .owner,
          ).toBe("two");
        } finally {
          await invoke("one", "stop").catch(() => {});
          await invoke("two", "stop").catch(() => {});
          await NodeFSP.rm(home, { recursive: true, force: true });
        }
      });
    }),
  );
});
