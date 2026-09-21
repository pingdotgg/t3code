// @effect-diagnostics nodeBuiltinImport:off globalFetchInEffect:off preferSchemaOverJson:off - verifies generated remote scripts using real shell and Node processes.
import * as Effect from "effect/Effect";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { describe, expect, it } from "@effect/vitest";
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";
import {
  quoteRemoteArg,
  remoteDeviceCommand,
  remoteDeviceEnvironment,
  remoteDeviceScript,
} from "./sshDeviceScript.ts";
import { AGENT_DEVICE_VERSION, DEVICE_HUB_VERSION } from "./DeviceToolchain.ts";

const exec = NodeUtil.promisify(NodeChildProcess.execFile);

it("stops only verified Windows hubs during removal and adapter replacement", async () => {
  const home = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3 hub identity "));
  try {
    const root = NodePath.join(home, ".t3/device");
    const state = NodePath.join(root, "hosts/fixture");
    const tool = NodePath.join(root, `tools/expo-device-hub@${DEVICE_HUB_VERSION}`);
    const entry = NodePath.join(tool, "node_modules/expo-device-hub/dist/server/cli.mjs");
    const sdk = NodePath.join(home, "sdk");
    await NodeFSP.mkdir(state, { recursive: true });
    await NodeFSP.mkdir(NodePath.dirname(entry), { recursive: true });
    await NodeFSP.writeFile(entry, "");
    await NodeFSP.writeFile(NodePath.join(tool, ".install-complete"), DEVICE_HUB_VERSION);
    for (const relative of [
      "platform-tools/adb.exe",
      "emulator/emulator.exe",
      "cmdline-tools/latest/bin/avdmanager.bat",
    ]) {
      const file = NodePath.join(sdk, relative);
      await NodeFSP.mkdir(NodePath.dirname(file), { recursive: true });
      await NodeFSP.writeFile(file, "");
    }
    const hub = { owner: "fixture", pid: 12345, port: 54321, entryPath: entry };
    const matchingCommand = `node "${entry}" --port ${hub.port}`;
    for (const mode of ["stop", "start"] as const) {
      for (const condition of [
        "match",
        "entry-mismatch",
        "port-mismatch",
        "failed",
        "other-owner",
      ] as const) {
        await NodeFSP.writeFile(
          NodePath.join(state, "hub.json"),
          JSON.stringify({
            ...hub,
            owner: condition === "other-owner" ? "another-owner" : hub.owner,
          }),
        );
        const command =
          condition === "entry-mismatch"
            ? `node unrelated.mjs --port ${hub.port}`
            : condition === "port-mismatch"
              ? `node "${entry}" --port 123`
              : matchingCommand;
        const result = NodeChildProcess.spawnSync(
          process.execPath,
          [
            "-e",
            `
Object.defineProperty(process, 'platform', { value: 'win32' });
require('node:os').homedir = () => ${JSON.stringify(home)};
const calls = [];
process.kill = (pid, signal) => { calls.push({ pid, signal }); };
const childProcess = require('node:child_process');
childProcess.spawnSync = (command) => command === 'powershell.exe'
  ? { status: ${condition === "failed" ? 1 : 0}, stdout: ${JSON.stringify(command)} }
  : { status: 1, stdout: '' };
childProcess.spawn = () => {
  calls.push({ spawned: true });
  const child = new (require('node:events').EventEmitter)();
  Object.assign(child, { pid: 23456, exitCode: null, signalCode: null, unref() {} });
  process.nextTick(() => child.emit('spawn'));
  return child;
};
global.fetch = async () => ({ ok: true });
process.on('exit', () => console.log(JSON.stringify({ calls })));
` + remoteDeviceScript("fixture", mode),
          ],
          {
            encoding: "utf8",
            timeout: 10000,
            env: { ...process.env, ANDROID_HOME: sdk },
          },
        );
        expect(result.status, result.stderr).toBe(0);
        const output = JSON.parse(result.stdout.trim().split("\n").at(-1)!);
        expect(output.calls).toEqual([
          ...(condition === "match" ? [{ pid: hub.pid, signal: "SIGTERM" }] : []),
          ...(mode === "start" ? [{ spawned: true }] : []),
        ]);
      }
    }
  } finally {
    await NodeFSP.rm(home, { recursive: true, force: true });
  }
});

it("requires a complete Android SDK on SSH hosts while retaining iOS availability", () => {
  for (const missing of ["emulator/emulator", "cmdline-tools/latest/bin/avdmanager", null]) {
    const result = NodeChildProcess.spawnSync(
      process.execPath,
      [
        "-e",
        `
Object.defineProperty(process,'platform',{value:'darwin'});
process.env.ANDROID_HOME='/fixture/sdk';
require('node:child_process').spawnSync=()=>({status:0,stdout:'ok',stderr:''});
require('node:fs').existsSync=(file)=>!${JSON.stringify(missing)} || !file.replaceAll('\\\\','/').endsWith(${JSON.stringify(missing)});
` + remoteDeviceScript("fixture", "probe"),
      ],
      { encoding: "utf8", timeout: 10000 },
    );
    expect(result.status).toBe(0);
    const platforms = JSON.parse(result.stdout).platforms;
    expect(platforms).toContainEqual({ platform: "ios", available: true });
    expect(platforms).toContainEqual(
      missing
        ? {
            platform: "android",
            available: false,
            reason: expect.stringContaining(
              missing.startsWith("emulator") ? "Android Emulator" : "Command-line Tools",
            ),
          }
        : { platform: "android", available: true },
    );
  }
});

it.effect(
  "passes bootstrap code through the remote login shell without reinterpreting quotes",
  () =>
    Effect.gen(function* () {
      const value = "spaces 'single' \"double\" $HOME `literal`\nsecond line";
      const command = remoteDeviceCommand(
        "exec node",
        `process.stdout.write(${JSON.stringify(value)});`,
        true,
      );
      const result = NodeChildProcess.spawnSync(
        (yield* HostProcessPlatform) === "win32" ? "pwsh" : "sh",
        (yield* HostProcessPlatform) === "win32"
          ? ["-NoProfile", "-NonInteractive", "-Command", command.remoteCommandArgs.join(" ")]
          : ["-c", command.remoteCommandArgs.join(" ")],
        { input: command.stdin, encoding: "utf8", timeout: 10000 },
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
      const code =
        "process.stdout.write(JSON.stringify({args:process.argv.slice(1),input:require('node:fs').readFileSync(0,'utf8')}));process.exitCode=23";
      const command = remoteDeviceCommand(
        `exec ${[process.execPath.replaceAll("\\", "/"), "-e", code, value].map(quoteRemoteArg).join(" ")}`,
        value,
      );
      const result = NodeChildProcess.spawnSync(
        (yield* HostProcessPlatform) === "win32" ? "pwsh" : "sh",
        (yield* HostProcessPlatform) === "win32"
          ? ["-NoProfile", "-NonInteractive", "-Command", command.remoteCommandArgs.join(" ")]
          : ["-c", command.remoteCommandArgs.join(" ")],
        { input: command.stdin, encoding: "utf8", timeout: 10000 },
      );
      expect(result.error).toBeUndefined();
      expect(result.stderr).toBe("");
      // PowerShell -Command normalizes a failing native command to exit code 1.
      expect(result.status).toBe((yield* HostProcessPlatform) === "win32" ? 1 : 23);
      expect(JSON.parse(result.stdout)).toEqual({ args: [value], input: value });
    }),
);

it("runs Windows npm probe and installation through Node with paths containing spaces", async () => {
  const home = await NodeFSP.realpath(
    await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3 npm fixture ")),
  );
  try {
    const node = NodePath.join(home, "Node runtime", "node.exe");
    const npm = NodePath.join(NodePath.dirname(node), "node_modules/npm/bin/npm-cli.js");
    const calls = NodePath.join(home, "npm calls.jsonl");
    await NodeFSP.mkdir(NodePath.dirname(npm), { recursive: true });
    await NodeFSP.copyFile(process.execPath, node);
    const sdk = NodePath.join(home, "Android SDK");
    for (const relative of [
      "platform-tools/adb.exe",
      "emulator/emulator.exe",
      "cmdline-tools/latest/bin/avdmanager.bat",
    ]) {
      const file = NodePath.join(sdk, relative);
      await NodeFSP.mkdir(NodePath.dirname(file), { recursive: true });
      await NodeFSP.writeFile(file, "fixture");
    }
    await NodeFSP.writeFile(
      npm,
      `const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify({ node: process.execPath, args }) + '\\n');
if (args[0] === 'install') { console.error('fixture registry unavailable'); process.exitCode = 23; }
else console.log('11.0.0');`,
    );
    const invoke = async (mode: "probe" | "start", npmPath = "", nodeVersion?: string) => {
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
  : originalSpawnSync(command, args, options);
` + remoteDeviceScript("fixture", mode),
      );
      return exec(node, [script], { env: { ...process.env, PATH: npmPath, ANDROID_HOME: sdk } });
    };
    expect(JSON.parse((await invoke("probe")).stdout).nodePath).toBe(node);
    await NodeFSP.rename(
      NodePath.join(sdk, "emulator/emulator.exe"),
      NodePath.join(sdk, "emulator/disabled.exe"),
    );
    expect(JSON.parse((await invoke("probe")).stdout).platforms).toContainEqual({
      platform: "android",
      available: false,
      reason: expect.stringContaining("Android Emulator is missing"),
    });
    await NodeFSP.rename(
      NodePath.join(sdk, "emulator/disabled.exe"),
      NodePath.join(sdk, "emulator/emulator.exe"),
    );
    await expect(invoke("start")).rejects.toMatchObject({
      stderr: expect.stringContaining(
        "Installing expo-device-hub: exit code 23: fixture registry unavailable",
      ),
    });
    const invocations = (await NodeFSP.readFile(calls, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(invocations).toEqual([
      { node, args: ["--version"] },
      { node, args: ["--version"] },
      {
        node,
        args: [
          "install",
          "--prefix",
          expect.stringContaining(home),
          "--no-fund",
          "--no-audit",
          `expo-device-hub@${DEVICE_HUB_VERSION}`,
        ],
      },
    ]);
    await NodeFSP.writeFile(
      npm,
      "console.error('fixture npm configuration invalid'); process.exitCode = 17;",
    );
    await expect(invoke("probe")).rejects.toMatchObject({
      stderr: expect.stringContaining(
        "npm probe failed: exit code 17: fixture npm configuration invalid",
      ),
    });
    await NodeFSP.writeFile(
      npm,
      "console.log('fixture stdout-only failure'); process.exitCode = 19;",
    );
    for (const mode of ["probe", "start"] as const) {
      await expect(invoke(mode)).rejects.toMatchObject({
        stderr: expect.stringContaining("exit code 19: fixture stdout-only failure"),
      });
    }
    await expect(invoke("probe", "", "18.0.0")).rejects.toMatchObject({
      stderr: expect.stringContaining(`Found 18.0.0 at ${node}.`),
    });
    await NodeFSP.rm(npm);
    await expect(invoke("probe")).rejects.toMatchObject({
      stderr: expect.stringContaining("npm is missing:"),
    });
    const fallback = NodePath.join(home, "npm on PATH");
    const fallbackEntry = NodePath.join(fallback, "node_modules/npm/bin/npm-cli.js");
    await NodeFSP.mkdir(NodePath.dirname(fallbackEntry), { recursive: true });
    await NodeFSP.writeFile(fallbackEntry, "console.log('11.0.0');");
    expect(JSON.parse((await invoke("probe", `"${fallback}"`)).stdout).nodePath).toBe(node);
  } finally {
    await NodeFSP.rm(home, { recursive: true, force: true });
  }
});

for (const supported of [true, false]) {
  it.effect(
    `preserves a working SSH Node/npm pair and replaces an old Node: supported=${supported}`,
    () =>
      Effect.gen(function* () {
        if ((yield* HostProcessPlatform) === "win32") return;
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
              ["-c", `${remoteDeviceEnvironment(true)}\nnode; npm; adb; java`],
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
  );
}

it.effect("finds Android Studio Java for a non-interactive SSH session", () =>
  Effect.gen(function* () {
    if ((yield* HostProcessPlatform) === "win32") return;
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
    if ((yield* HostProcessPlatform) === "win32") return;
    yield* Effect.promise(async () => {
      const value = "quotes ' \" ; $(echo expanded) $HOME\nnext line";
      const result = await exec("sh", ["-c", `printf %s ${quoteRemoteArg(value)}`]);
      expect(result.stdout).toBe(value);
    });
  }),
);

describe("remote helper lifecycle", () => {
  it.effect("reuses its own healthy helpers and stops only its own runtime", () =>
    Effect.gen(function* () {
      if ((yield* HostProcessPlatform) === "win32") return;
      yield* Effect.promise(async () => {
        const home = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-remote-script-"));
        const bin = NodePath.join(home, "bin");
        await NodeFSP.mkdir(bin);
        const sdk = NodePath.join(home, "sdk");
        for (const relative of [
          "platform-tools/adb",
          "emulator/emulator",
          "cmdline-tools/latest/bin/avdmanager",
        ]) {
          const file = NodePath.join(sdk, relative);
          await NodeFSP.mkdir(NodePath.dirname(file), { recursive: true });
          await NodeFSP.writeFile(file, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
        }
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
const args=process.argv.slice(2); http.createServer((req,res)=>{res.statusCode=fs.existsSync('unhealthy-'+process.pid)?503:200;res.end('ok');}).listen(Number(args[args.indexOf('--port')+1]),'127.0.0.1');`,
        );
        await NodeFSP.writeFile(
          agent,
          `import fs from 'node:fs'; import path from 'node:path'; import http from 'node:http'; import {spawn} from 'node:child_process';
const args=process.argv.slice(2);
const state=process.env.AGENT_DEVICE_STATE_DIR || args[args.indexOf('--state-dir')+1];
const file=path.join(state,'daemon.json');
if(args[0]==='daemon') { const data=JSON.parse(fs.readFileSync(file,'utf8')); fs.writeFileSync(path.join(state,'stopped-agent'),String(data.pid)); try {process.kill(data.pid,'SIGTERM')} catch {} }
else if(args[0]==='serve') { const server=http.createServer((req,res)=>{res.statusCode=fs.existsSync(path.join(state,'unhealthy-agent-'+process.pid))?503:200;res.end('ok');}); server.listen(0,'127.0.0.1',()=>{fs.writeFileSync(file,JSON.stringify({httpPort:server.address().port,pid:process.pid,token:'test'}));process.send?.('ready');process.disconnect?.();}); }
else { const child=spawn(process.execPath,[process.argv[1],'serve'],{detached:true,stdio:['ignore','ignore','ignore','ipc'],env:process.env});await new Promise((resolve,reject)=>{child.once('message',resolve);child.once('error',reject);});child.unref(); }
`,
        );
        const nextHubVersion = DEVICE_HUB_VERSION + "-upgrade";
        const nextAgentVersion = AGENT_DEVICE_VERSION + "-upgrade";
        let invocation = 0;
        const invoke = async (
          owner: string,
          mode: "start" | "agent-start" | "stop-agent" | "stop",
          upgraded = false,
        ) => {
          const file = NodePath.join(home, `${owner}-${mode}-${invocation++}.cjs`);
          await NodeFSP.writeFile(
            file,
            `const originalKill = process.kill; process.kill = (pid, signal) => { if (signal === 'SIGTERM') require('node:fs').appendFileSync(${JSON.stringify(NodePath.join(home, "stops"))}, pid+'\\n'); return originalKill(pid, signal); };\n` +
              remoteDeviceScript(owner, mode)
                .replace(DEVICE_HUB_VERSION, upgraded ? nextHubVersion : DEVICE_HUB_VERSION)
                .replace(AGENT_DEVICE_VERSION, upgraded ? nextAgentVersion : AGENT_DEVICE_VERSION),
          );
          const result = await exec(process.execPath, [file], {
            env: {
              ...process.env,
              HOME: home,
              ANDROID_HOME: sdk,
              PATH: `${bin}:${process.env.PATH}`,
            },
          });
          return result.stdout ? JSON.parse(result.stdout) : null;
        };
        const template = NodePath.join(home, "hub-template");
        await NodeFSP.cp(hubDir, template, { recursive: true });
        await NodeFSP.rm(NodePath.join(hubDir, ".install-complete"));
        const installLock = hubDir + ".lock";
        await NodeFSP.symlink("2147483647:exited-installer", installLock);
        await NodeFSP.writeFile(
          NodePath.join(bin, "npm"),
          `#!${process.execPath}\nconst fs=require('node:fs');const args=process.argv.slice(2);fs.cpSync(${JSON.stringify(template)},args[args.indexOf('--prefix')+1],{recursive:true});`,
          { mode: 0o755 },
        );
        await NodeFSP.mkdir(NodePath.join(root, "hosts/one"), { recursive: true });
        await NodeFSP.writeFile(NodePath.join(root, "hosts/one/fail-start-once"), "");
        try {
          const [manual, concurrent] = await Promise.all([
            invoke("one", "start"),
            invoke("one", "start"),
          ]);
          expect(concurrent.hubPort).toBe(manual.hubPort);
          expect(manual.daemonPort).toBeUndefined();
          await expect(
            NodeFSP.stat(NodePath.join(root, "hosts/one/daemon.json")),
          ).rejects.toThrow();
          const [first, concurrentAgent] = await Promise.all([
            invoke("one", "agent-start"),
            invoke("one", "agent-start"),
          ]);
          expect(concurrentAgent.hubPort).toBe(first.hubPort);
          expect(concurrentAgent.daemonPort).toBe(first.daemonPort);
          const second = await invoke("two", "agent-start");
          const reused = await invoke("one", "agent-start");
          expect(reused.hubPort).toBe(first.hubPort);
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
          // Stop still uses the recorded entry when a future pinned package is not installed yet.
          const originalScript = remoteDeviceScript("one", "stop-agent");
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
