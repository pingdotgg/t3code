import * as Effect from "effect/Effect";
import * as NodePathLayer from "@effect/platform-node/NodePath";
import * as ProcessRunner from "../processRunner.ts";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
// @effect-diagnostics nodeBuiltinImport:off - tests the same standalone script used by local and SSH hosts.
import { describe, expect, it } from "@effect/vitest";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeChildProcess from "node:child_process";
import * as NodeUtil from "node:util";
import {
  claimLocalDeviceTool,
  pruneLocalDeviceTools,
  deviceToolMaintenanceScript,
} from "./deviceToolMaintenance.ts";

const exec = NodeUtil.promisify(NodeChildProcess.execFile);

describe.each([false, true])("device tool cleanup, flat=%s", (flat) => {
  it("keeps current, previous, active, incomplete and legacy installs, pruning only unused managed versions", async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-tool-cleanup-"));
    const name = "expo-device-hub";
    const directory = (version: string) =>
      flat ? NodePath.join(root, `${name}@${version}`) : NodePath.join(root, name, version);
    try {
      for (const version of ["0.1.0", "0.2.0", "0.3.0", "0.4.0", "0.5.0", "0.6.0"]) {
        await NodeFSP.mkdir(directory(version), { recursive: true });
        if (version === "0.5.0") continue;
        const sentinel = NodePath.join(directory(version), ".install-complete");
        await NodeFSP.writeFile(sentinel, version);
        await NodeFSP.utimes(
          sentinel,
          Number(version.split(".")[1]),
          Number(version.split(".")[1]),
        );
      }
      const script =
        deviceToolMaintenanceScript +
        `
(async () => {
  const root = ${JSON.stringify(root)};
  // Simulate a dead owner whose numeric PID was reused by this live test process.
  maintenanceFs.writeFileSync(maintenancePath.join(root, '.maintenance-lock'), JSON.stringify({ pid: ${process.pid}, identity: 'previous-process-start' }));
  await claimTool(root, '${name}', '0.1.0', ${process.pid});
  maintenanceFs.writeFileSync(maintenancePath.join(root, '.users', '${name}@0.1.0', '${process.pid}'), 'previous-process-start');
  await claimTool(root, '${name}', '0.2.0', ${process.pid});
  await claimTool(root, '${name}', '0.4.0', 2147483647);
  await pruneTools(root, [['${name}', '0.6.0']], ${flat});
})().catch(error => { console.error(error); process.exitCode = 1; });`;
      await exec(process.execPath, ["-e", script]);
      await expect(NodeFSP.stat(directory("0.1.0"))).rejects.toThrow();
      for (const version of ["0.2.0", "0.3.0", "0.4.0", "0.5.0", "0.6.0"])
        expect((await NodeFSP.stat(directory(version))).isDirectory()).toBe(true);
      // Keeping the prior install does not retain dead lease files forever.
      expect(await NodeFSP.readdir(NodePath.join(root, ".users", name + "@0.4.0"))).toEqual([]);
    } finally {
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  });

  it("does not prune before the required version has completed installation", async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-tool-cleanup-"));
    try {
      const dir = flat
        ? NodePath.join(root, "expo-device-hub@0.1.0")
        : NodePath.join(root, "expo-device-hub/0.1.0");
      await NodeFSP.mkdir(dir, { recursive: true });
      await NodeFSP.writeFile(NodePath.join(dir, ".install-complete"), "0.1.0");
      await exec(process.execPath, [
        "-e",
        deviceToolMaintenanceScript +
          `pruneTools(${JSON.stringify(root)}, [['expo-device-hub','0.6.0']], ${flat}).catch(() => process.exitCode = 1);`,
      ]);
      expect((await NodeFSP.stat(dir)).isDirectory()).toBe(true);
    } finally {
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  });
});

it.effect("maintenance failures retain safe context and the original process result", () =>
  Effect.gen(function* () {
    const output = {
      code: ChildProcessSpawner.ExitCode(1),
      stdout: "",
      stderr: "private child diagnostics",
      timedOut: false,
      stdoutTruncated: false,
      stderrTruncated: false,
      stdoutInvalidUtf8: false,
      stderrInvalidUtf8: false,
    };
    for (const [operation, run] of [
      ["claim", claimLocalDeviceTool],
      ["prune", pruneLocalDeviceTools],
    ] as const) {
      const error = yield* run("/tools", process.execPath, "hub").pipe(
        Effect.provideService(ProcessRunner.ProcessRunner, { run: () => Effect.succeed(output) }),
        Effect.flip,
      );
      expect(error).toMatchObject({
        _tag: "DeviceToolMaintenanceError",
        operation,
        tool: "hub",
        exitCode: 1,
        cause: output,
      });
      expect(error.message).toBe(`Device tool ${operation} failed for hub (exit code 1).`);
      expect(error.message).not.toContain(output.stderr);
    }
  }).pipe(Effect.provide(NodePathLayer.layer)),
);
