// @effect-diagnostics nodeBuiltinImport:off globalFetchInEffect:off - verifies generated remote scripts using real shell and Node processes.
import * as Effect from "effect/Effect";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { expect, it } from "@effect/vitest";
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";
import { quoteRemoteArg, remoteDeviceEnvironment, remoteDeviceScript } from "./sshDeviceScript.ts";

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
        expect((await start(exited)).stderr).toContain("Android SDK missing");
        await expect(NodeFSP.access(daemonFile)).rejects.toThrow();
      } finally {
        await NodeFSP.rm(home, { recursive: true, force: true });
      }
    });
  }),
);
