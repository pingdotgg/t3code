import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";

import { renderS6RunScript } from "./bootService.ts";

const integrationEnabled = process.env.T3_S6_OVERLAY_INTEGRATION === "1";
const fixtureDir = NodePath.resolve(import.meta.dirname, "../../test/fixtures/s6-overlay");
const image = "t3code-s6-overlay-integration:3.2.2.0";

function docker(args: ReadonlyArray<string>) {
  return NodeChildProcess.spawnSync("docker", args, {
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
  });
}

describe.runIf(integrationEnabled)("s6-overlay service integration", () => {
  it("starts t3 serve with a non-root runtime UID", async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-s6-overlay-test-"));
    const serviceDir = NodePath.join(root, "service");
    const stateDir = NodePath.join(root, "state");
    const container = `t3-s6-overlay-${process.pid}-${Date.now()}`;

    try {
      await NodeFSP.mkdir(serviceDir);
      await NodeFSP.mkdir(stateDir);
      await NodeFSP.chmod(stateDir, 0o777);
      const launcherPath = NodePath.join(stateDir, "s6-service-launcher");
      await NodeFSP.writeFile(launcherPath, '#!/bin/sh\nexec /usr/local/bin/t3-fixture "$@"\n');
      await NodeFSP.chmod(launcherPath, 0o755);
      const runPath = NodePath.join(serviceDir, "run");
      await NodeFSP.writeFile(
        runPath,
        renderS6RunScript({
          supervisor: "s6",
          serviceUser: "t3",
          serviceGroup: "t3",
          serviceLauncherPath: "/state/s6-service-launcher",
          nodePath: "/usr/local/bin/t3-fixture",
          t3EntryPath: "",
          baseDir: "/state",
          logPath: "/state/boot-service.log",
          unitPath: "/run/service/t3code/run",
        }),
      );
      await NodeFSP.chmod(runPath, 0o755);

      const build = docker(["build", "--tag", image, fixtureDir]);
      expect(build.status, build.stderr || build.stdout).toBe(0);

      const start = docker([
        "run",
        "--detach",
        "--name",
        container,
        "--volume",
        `${serviceDir}:/etc/services.d/t3code:ro`,
        "--volume",
        `${stateDir}:/state`,
        image,
      ]);
      expect(start.status, start.stderr || start.stdout).toBe(0);

      let runtimeUserId = "";
      for (let attempt = 0; attempt < 100; attempt += 1) {
        runtimeUserId = await NodeFSP.readFile(
          NodePath.join(stateDir, "runtime-uid"),
          "utf8",
        ).catch(() => "");
        if (runtimeUserId.trim() !== "") break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }

      if (runtimeUserId.trim() === "") {
        const logs = docker(["logs", container]);
        throw new Error(`s6 service did not report its UID:\n${logs.stderr}${logs.stdout}`);
      }
      expect(runtimeUserId.trim()).toBe("10001");
      expect(runtimeUserId.trim()).not.toBe("0");
      expect((await NodeFSP.stat(NodePath.join(stateDir, "boot-service.log"))).uid).toBe(10001);

      const restart = docker([
        "exec",
        "--user",
        "10001:10001",
        container,
        "/package/admin/s6/command/s6-svc",
        "-r",
        "/run/service/t3code",
      ]);
      expect(restart.status, restart.stderr || restart.stdout).toBe(0);
    } finally {
      docker(["rm", "--force", container]);
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  }, 120_000);
});
