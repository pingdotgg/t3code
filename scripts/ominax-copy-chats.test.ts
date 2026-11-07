// @effect-diagnostics nodeBuiltinImport:off - Drives the real sync script's idle gate against live processes.
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";

const script = NodePath.resolve(import.meta.dirname, "ominax-copy-chats.sh");

describe.skipIf(HostProcess.Platform.defaultValue() !== "linux")(
  "ominax-copy-chats idle gate",
  () => {
    it("counts a live agent in the unit's cgroup but not the launcher, server or monitor", async () => {
      const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "ominax-gate-"));
      for (const name of ["__service-launcher", "serve", "monitor"]) {
        await NodeFSP.writeFile(NodePath.join(dir, name), "echo ready; read -r _\n");
      }
      const children: NodeChildProcess.ChildProcess[] = [];
      // `exec -a` sets argv0 and bash runs the file named by argv1, so argv matches the real unit's.
      const spawn = async (command: string) => {
        const child = NodeChildProcess.spawn("bash", ["-c", command], {
          cwd: dir,
          stdio: ["pipe", "pipe", "ignore"],
        });
        children.push(child);
        await new Promise((resolve) => child.stdout.once("data", resolve));
        return child.pid;
      };
      const gate = async (pids: ReadonlyArray<number | undefined>) => {
        await NodeFSP.writeFile(NodePath.join(dir, "cgroup.procs"), pids.join("\n"));
        return NodeChildProcess.execFileSync(
          "bash",
          ["-c", 'source "$1"; live_agents "$2"', "gate", script, dir],
          { encoding: "utf8" },
        ).trim();
      };
      try {
        const server = [
          await spawn("exec -a /opt/t3 bash __service-launcher"),
          await spawn("exec -a /opt/t3 bash serve"),
          await spawn("exec -a /opt/resource-monitor/linux-x64/t3-resource-monitor bash monitor"),
        ];
        const agent = await spawn("exec sh -c 'echo ready; read -r _'");
        expect(await gate(server)).toBe("0");
        expect(await gate([...server, agent])).toBe("1");
      } finally {
        for (const child of children) child.kill("SIGKILL");
        await NodeFSP.rm(dir, { recursive: true, force: true });
      }
    });
  },
);
