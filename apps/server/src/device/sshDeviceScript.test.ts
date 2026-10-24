// @effect-diagnostics nodeBuiltinImport:off globalFetchInEffect:off - verifies generated remote scripts using real shell and Node processes.
import * as Effect from "effect/Effect";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { expect, it } from "@effect/vitest";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeVM from "node:vm";
import * as NodeModule from "node:module";
import { AGENT_DEVICE_VERSION, DEVICE_HUB_VERSION } from "./DeviceToolchain.ts";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";
import { quoteRemoteArg, remoteDeviceEnvironment, remoteDeviceScript } from "./sshDeviceScript.ts";

const require = NodeModule.createRequire(import.meta.url);

const exec = NodeUtil.promisify(NodeChildProcess.execFile);

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
        const result = await exec("/bin/sh", ["-c", `${remoteDeviceEnvironment}\njava`], {
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

it.each([
  ["start", "win32", "success"],
  ["agent-start", "win32", "success"],
  ["start", "linux", "success"],
  ["start", "darwin", "success"],
  ["probe", "win32", "success"],
  ["stop", "win32", "success"],
  ["stop-agent", "win32", "success"],
  ["start", "win32", "launch failure"],
  ["start", "win32", "worker failure"],
  ["start", "win32", "worker exit"],
] as const)(
  "%s on %s: %s preserves the response and cleans up the bootstrap",
  async (mode, platform, scenario) => {
    const home = await NodeFSP.mkdtemp(
      NodePath.join(NodeOS.tmpdir(), "t3-ssh-handles-\u00e9-\u05d0-"),
    );
    const execPath = platform === "win32" ? "C:\\Users\\\u00e9-\u05d0\\node.exe" : process.execPath;
    const owner = "test-owner";
    const state = NodePath.join(home, ".t3/device/hosts", owner);
    const tools = NodePath.join(home, ".t3/device/tools");
    const messages: Array<string> = [];
    const errors: Array<string> = [];
    let launches = 0;
    let workers = 0;
    const run = (script: string, worker: boolean, directory = state): Promise<void> => {
      if (worker) workers++;
      return NodeVM.runInNewContext(script, {
        __dirname: directory,
        require: (name: string) => {
          if (name === "node:fs")
            return {
              ...NodeFS,
              symlinkSync: (target: string, file: string) =>
                NodeFS.writeFileSync(file, target, { flag: "wx" }),
              readlinkSync: (file: string) => NodeFS.readFileSync(file, "utf8"),
            };
          if (name === "node:os") return { ...NodeOS, homedir: () => home };
          if (name === "node:child_process")
            return {
              spawn: () => {
                throw Error("Unexpected service restart");
              },
              spawnSync: (command: string, args: Array<string>) => {
                if (command === "powershell.exe" && args.includes("-EncodedCommand")) {
                  const launchScript = Buffer.from(
                    args[args.indexOf("-EncodedCommand") + 1]!,
                    "base64",
                  ).toString("utf16le");
                  expect(launchScript).toContain("Win32_ProcessStartup");
                  expect(launchScript).toContain(`CurrentDirectory = '${home}'`);
                  expect([command, ...args].join(" ").length + 1).toBeLessThan(30000);
                  launches++;
                  if (scenario === "launch failure")
                    return {
                      status: 0,
                      stdout: JSON.stringify({ ReturnValue: 2, ProcessId: null }),
                    };
                  if (scenario === "worker exit")
                    return {
                      status: 0,
                      stdout: JSON.stringify({ ReturnValue: 0, ProcessId: 1234 }),
                    };
                  const directory = NodeFS.readdirSync(state).find((name) =>
                    name.startsWith(".bootstrap-"),
                  )!;
                  const file = NodePath.join(state, directory, "bootstrap.cjs");
                  expect(launchScript).toContain(`CommandLine = '"${execPath}" "${file}"'`);
                  void run(NodeFS.readFileSync(file, "utf8"), true, NodePath.dirname(file));
                  return { status: 0, stdout: JSON.stringify({ ReturnValue: 0, ProcessId: 1234 }) };
                }
                return {
                  status:
                    command === "xcrun" ||
                    (worker && scenario === "worker failure" && command === "adb")
                      ? 1
                      : 0,
                  stdout: command === "powershell.exe" ? "[]" : "",
                  stderr: "",
                };
              },
            };
          return require(name);
        },
        process: {
          platform,
          execPath,
          pid: worker ? 1234 : 5678,
          versions: process.versions,
          env: {},
          cwd: () => home,
          kill: () => {
            if (scenario === "worker exit") throw Object.assign(Error("exited"), { code: "ESRCH" });
          },
        },
        fetch: async () => ({ ok: true }),
        AbortSignal,
        Buffer,
        setTimeout: (callback: () => void) => {
          void Promise.resolve().then(callback);
        },
        console: {
          log: (value: string) => {
            messages.push(value);
          },
          error: (error: string) => {
            errors.push(error);
          },
        },
      });
    };
    try {
      await NodeFSP.mkdir(state, { recursive: true });
      for (const [name, version, entry] of [
        ["expo-device-hub", DEVICE_HUB_VERSION, "dist/server/cli.mjs"],
        ["agent-device", AGENT_DEVICE_VERSION, "bin/agent-device.mjs"],
      ] as const) {
        const directory = NodePath.join(tools, `${name}@${version}`);
        const entryPath = NodePath.join(directory, "node_modules", name, entry);
        await NodeFSP.mkdir(NodePath.dirname(entryPath), { recursive: true });
        await NodeFSP.writeFile(entryPath, "");
        await NodeFSP.writeFile(NodePath.join(directory, ".install-complete"), version);
        if (name === "expo-device-hub")
          await NodeFSP.writeFile(
            NodePath.join(state, "hub.json"),
            JSON.stringify({
              owner,
              pid: 42,
              port: 12345,
              entryPath,
              platform: platform === "darwin" ? undefined : "android",
              emulatorExtraArgs: "",
            }),
          );
        else {
          await NodeFSP.writeFile(
            NodePath.join(state, "agent.json"),
            JSON.stringify({ entryPath }),
          );
          await NodeFSP.writeFile(
            NodePath.join(state, "daemon.json"),
            JSON.stringify({ pid: 43, httpPort: 23456, token: "test-token" }),
          );
        }
      }
      await run(remoteDeviceScript(owner, mode), false);
      const isolated = platform === "win32" && (mode === "start" || mode === "agent-start");
      expect(launches).toBe(isolated ? 1 : 0);
      expect(workers).toBe(
        isolated && scenario !== "launch failure" && scenario !== "worker exit" ? 1 : 0,
      );
      if (scenario !== "success") {
        expect(messages).toEqual([]);
        expect(errors).toEqual([
          expect.stringContaining(
            scenario === "launch failure"
              ? "WMI result 2"
              : scenario === "worker exit"
                ? "exited without a response"
                : "Android SDK missing",
          ),
        ]);
      } else {
        expect(errors).toEqual([]);
        expect(messages).toHaveLength(mode === "stop" || mode === "stop-agent" ? 0 : 1);
        if (mode === "start" || mode === "agent-start")
          expect(JSON.parse(messages[0]!)).toMatchObject({
            hubPort: 12345,
            ...(mode === "agent-start" ? { daemonPort: 23456, token: "test-token" } : {}),
          });
        else if (mode === "probe")
          expect(JSON.parse(messages[0]!)).toMatchObject({ nodePath: execPath });
      }
      expect(
        (await NodeFSP.readdir(state)).filter((name) => name.startsWith(".bootstrap-")),
      ).toEqual([]);
    } finally {
      await NodeFSP.rm(home, { recursive: true, force: true });
    }
  },
);
