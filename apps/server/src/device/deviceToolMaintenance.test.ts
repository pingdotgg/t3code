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
import { pruneLocalDeviceTools, deviceToolMaintenanceScript } from "./deviceToolMaintenance.ts";

const exec = NodeUtil.promisify(NodeChildProcess.execFile);

describe.each([false, true])("device tool cleanup, flat=%s", (flat) => {
  it("keeps current, previous, active and incomplete installs, pruning unused completed versions", async () => {
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
  await pruneTools(root, [['${name}', '0.6.0']], ${flat});
})().catch(error => { console.error(error); process.exitCode = 1; });`;
      await exec(process.execPath, [
        "-e",
        script,
        NodePath.join(directory("0.2.0"), "active-helper.cjs"),
      ]);
      await expect(NodeFSP.stat(directory("0.1.0"))).rejects.toThrow();
      await expect(NodeFSP.stat(directory("0.3.0"))).rejects.toThrow();
      for (const version of ["0.2.0", "0.4.0", "0.5.0", "0.6.0"])
        expect((await NodeFSP.stat(directory(version))).isDirectory()).toBe(true);
    } finally {
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  });

  it("keeps every install when the process scan fails", async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-tool-scan-"));
    try {
      for (const version of ["0.1.0", "0.2.0", "0.3.0"]) {
        const dir = flat
          ? NodePath.join(root, `expo-device-hub@${version}`)
          : NodePath.join(root, "expo-device-hub", version);
        await NodeFSP.mkdir(dir, { recursive: true });
        await NodeFSP.writeFile(NodePath.join(dir, ".install-complete"), version);
      }
      await exec(process.execPath, [
        "-e",
        deviceToolMaintenanceScript +
          `
        require('node:child_process').spawnSync = () => ({ status: 1, stdout: '' });
        pruneTools(${JSON.stringify(root)}, [['expo-device-hub', '0.3.0']], ${flat}).catch(() => process.exitCode = 1);
      `,
      ]);
      const parent = flat ? root : NodePath.join(root, "expo-device-hub");
      expect((await NodeFSP.readdir(parent)).length).toBe(3);
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
    for (const [operation, run] of [["prune", pruneLocalDeviceTools]] as const) {
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

it("serializes competing maintenance processes after reclaiming a stale lock", async () => {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-tool-contention-"));
  try {
    const lock = NodePath.join(root, ".maintenance-lock");
    await NodeFSP.mkdir(lock);
    await NodeFSP.writeFile(
      NodePath.join(lock, "stale-owner.json"),
      JSON.stringify({ pid: 2147483647, identity: "dead" }),
    );
    const script =
      deviceToolMaintenanceScript +
      `
(async () => {
  const root = ${JSON.stringify(root)};
  const marker = maintenancePath.join(root, 'critical-section');
  for (let attempt = 0; attempt < 8; attempt++) await withToolMaintenance(root, () => {
    maintenanceFs.writeFileSync(marker, String(process.pid), { flag: 'wx' });
    for (let check = 0; check < 100; check++) {
      if (maintenanceFs.readFileSync(marker, 'utf8') !== String(process.pid)) throw Error('Overlapping maintenance');
    }
    maintenanceFs.unlinkSync(marker);
  });
})().catch(error => { console.error(error); process.exitCode = 1; });`;
    await Promise.all(Array.from({ length: 6 }, () => exec(process.execPath, ["-e", script])));
    await expect(NodeFSP.stat(lock)).rejects.toThrow();
    expect(await NodeFSP.readdir(root)).toEqual([]);
  } finally {
    await NodeFSP.rm(root, { recursive: true, force: true });
  }
});
