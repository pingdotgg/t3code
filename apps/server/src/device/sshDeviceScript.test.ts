// @effect-diagnostics nodeBuiltinImport:off globalFetchInEffect:off - verifies generated remote scripts using real shell and Node processes.
import * as Effect from "effect/Effect";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { expect, it } from "@effect/vitest";
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";
import { DEVICE_HUB_VERSION } from "./DeviceToolchain.ts";
import { quoteRemoteArg, remoteDeviceEnvironment, remoteDeviceScript } from "./sshDeviceScript.ts";

const exec = NodeUtil.promisify(NodeChildProcess.execFile);

const fakeHub = `import { createServer } from "node:http";
import { writeFileSync } from "node:fs";
writeFileSync("hub-path", process.env.PATH);
createServer((_, response) => response.end("ok")).listen(Number(process.argv[process.argv.indexOf("--port") + 1]), "127.0.0.1");
`;

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

it.effect("restarts the hub when the Android SDK appears after it started", () =>
  Effect.gen(function* () {
    if ((yield* HostProcess.Platform) === "win32") return;
    yield* Effect.promise(async () => {
      const home = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-ssh-hub-"));
      const state = NodePath.join(home, ".t3/device/hosts/owner");
      const readHub = async () =>
        JSON.parse(await NodeFSP.readFile(NodePath.join(state, "hub.json"), "utf8")) as {
          pid: number;
        };
      const tool = NodePath.join(home, `.t3/device/tools/expo-device-hub@${DEVICE_HUB_VERSION}`);
      const executable = async (file: string) => {
        await NodeFSP.mkdir(NodePath.dirname(file), { recursive: true });
        await NodeFSP.writeFile(file, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
      };
      const start = () => {
        const started = exec("/bin/sh", ["-c", `${remoteDeviceEnvironment}exec node`], {
          env: {
            HOME: home,
            PATH: `${home}/bin:${NodePath.dirname(process.execPath)}:/usr/bin:/bin`,
          },
        });
        started.child.stdin?.end(remoteDeviceScript("owner", "start"));
        return started;
      };
      try {
        await NodeFSP.mkdir(NodePath.join(tool, "node_modules/expo-device-hub/dist/server"), {
          recursive: true,
        });
        await NodeFSP.writeFile(
          NodePath.join(tool, "node_modules/expo-device-hub/dist/server/cli.mjs"),
          fakeHub,
        );
        await NodeFSP.writeFile(NodePath.join(tool, ".install-complete"), DEVICE_HUB_VERSION);
        await executable(NodePath.join(home, "bin/adb"));
        await start();
        const before = await readHub();
        await executable(NodePath.join(home, "Android/Sdk/platform-tools/adb"));
        await start();
        const after = await readHub();
        expect(after.pid).not.toBe(before.pid);
        expect(await NodeFSP.readFile(NodePath.join(state, "hub-path"), "utf8")).toContain(
          `${home}/Android/Sdk/platform-tools`,
        );
      } finally {
        await readHub()
          .then(({ pid }) => process.kill(pid, "SIGTERM"))
          .catch(() => {});
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
