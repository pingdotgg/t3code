import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";

import { HostProcessPlatform } from "@t3tools/shared/hostProcess";

import { afterEach, describe, expect, it } from "vite-plus/test";
import { taskScopeCommand } from "./taskScope.ts";

const execFile = NodeUtil.promisify(NodeChildProcess.execFile);
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((dir) => NodeFSP.rm(dir, { recursive: true, force: true })),
  );
});

async function fixture(busExit = 0, startExit = 0) {
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-task-scope-"));
  directories.push(directory);
  const log = NodePath.join(directory, "calls");
  for (const [name, body] of Object.entries({
    timeout: 'shift; exec "$@"',
    busctl: `printf 'busctl %s\\n' "$*" >> "$CALLS"; exit ${busExit}`,
    systemctl: `printf 'systemctl %s\\n' "$*" >> "$CALLS"; exit ${startExit}`,
  })) {
    await NodeFSP.writeFile(NodePath.join(directory, name), `#!/bin/sh\n${body}\n`, {
      mode: 0o755,
    });
  }
  return { directory, log, env: { PATH: directory, CALLS: log, VALUE: "inherited value" } };
}

async function launch(f: Awaited<ReturnType<typeof fixture>>, script: string, args: string[] = []) {
  const command = taskScopeCommand("/bin/sh", ["-c", script, "workload", ...args], "linux");
  return execFile(command.command, command.args, { cwd: f.directory, env: f.env });
}

describe("taskScopeCommand", () => {
  it.each(["darwin", "win32", "freebsd"] as const)("leaves %s launches unchanged", (platform) => {
    expect(taskScopeCommand("agent", ["--arg", "a b"], platform)).toEqual({
      command: "agent",
      args: ["--arg", "a b"],
    });
  });

  it.skipIf(HostProcessPlatform.defaultValue() !== "linux")(
    "waits for scope startup before exec and preserves PID, cwd, environment and arguments",
    async () => {
      const f = await fixture();
      const args = ["a b", "$(touch should-not-exist)", "$HOME", "", "--flag"];
      const result = await launch(
        f,
        'printf "workload %s\\n" "$$" >> "$CALLS"; printf "%s\\n" "$PWD" "$VALUE" "$@"',
        args,
      );
      expect(result.stdout).toBe([f.directory, "inherited value", ...args, ""].join("\n"));
      expect(result.stderr).toBe("");
      const calls = (await NodeFSP.readFile(f.log, "utf8")).trim().split("\n");
      const pid = calls[2]?.split(" ")[1];
      const unit = calls[0]?.match(/t3code-task-[0-9a-f-]+\.scope/)?.[0];
      expect(unit).toBeDefined();
      expect(calls[0]).toBe(
        `busctl --user --timeout=2s call org.freedesktop.systemd1 /org/freedesktop/systemd1 org.freedesktop.systemd1.Manager StartTransientUnit ssa(sv)a(sa(sv)) ${unit} fail 3 PIDs au 1 ${pid} Slice s app.slice CollectMode s inactive-or-failed 0`,
      );
      expect(calls[1]).toBe(`systemctl --user --no-ask-password start ${unit}`);
      expect(await NodeFSP.readdir(f.directory)).not.toContain("should-not-exist");
    },
  );

  it.skipIf(HostProcessPlatform.defaultValue() !== "linux").each([
    [1, 0],
    [0, 1],
  ])("falls back when systemd setup fails (%s, %s)", async (busExit, startExit) => {
    const f = await fixture(busExit, startExit);
    const result = await launch(f, 'printf "ran\\n" >> "$CALLS"; printf ok');
    expect(result.stdout).toBe("ok");
    expect(result.stderr).toBe("");
    const calls = await NodeFSP.readFile(f.log, "utf8");
    expect(calls.match(/^ran$/gm)).toHaveLength(1);
    if (busExit !== 0) expect(calls).not.toContain("systemctl");
  });

  it.skipIf(HostProcessPlatform.defaultValue() !== "linux")(
    "falls back without systemd tools",
    async () => {
      const f = await fixture();
      await NodeFSP.unlink(NodePath.join(f.directory, "busctl"));
      expect((await launch(f, "printf ok")).stdout).toBe("ok");
      await NodeFSP.unlink(NodePath.join(f.directory, "timeout"));
      expect((await launch(f, "printf ok")).stdout).toBe("ok");
    },
  );

  it.skipIf(HostProcessPlatform.defaultValue() !== "linux")(
    "does not retry a failing workload and preserves its exit code and stderr",
    async () => {
      const f = await fixture();
      await expect(
        launch(f, 'printf "ran\\n" >> "$CALLS"; printf failure >&2; exit 42'),
      ).rejects.toMatchObject({ code: 42, stderr: "failure" });
      expect((await NodeFSP.readFile(f.log, "utf8")).match(/^ran$/gm)).toHaveLength(1);
    },
  );

  it.skipIf(HostProcessPlatform.defaultValue() !== "linux")("preserves stdin", async () => {
    const f = await fixture();
    const command = taskScopeCommand("/bin/cat", [], "linux");
    const child = NodeChildProcess.spawn(command.command, command.args, { env: f.env });
    const output: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => output.push(chunk));
    const closed = new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
    child.stdin.end("input\n");
    expect(await closed).toBe(0);
    expect(Buffer.concat(output).toString()).toBe("input\n");
  });
  it.skipIf(HostProcessPlatform.defaultValue() !== "linux")(
    "preserves termination signals after exec",
    async () => {
      const f = await fixture();
      const command = taskScopeCommand("/bin/sh", ["-c", "printf ready; exec /bin/cat"], "linux");
      const child = NodeChildProcess.spawn(command.command, command.args, { env: f.env });
      const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
        (resolve, reject) => {
          child.once("error", reject);
          child.once("close", (code, signal) => resolve({ code, signal }));
        },
      );
      await new Promise<void>((resolve, reject) => {
        child.once("error", reject);
        child.stdout.once("data", () => resolve());
      });
      child.kill("SIGTERM");
      expect(await closed).toEqual({ code: null, signal: "SIGTERM" });
    },
  );
  it.skipIf(HostProcessPlatform.defaultValue() !== "linux")(
    "bounds a hung user-manager setup",
    async () => {
      const f = await fixture();
      await NodeFSP.copyFile("/usr/bin/timeout", NodePath.join(f.directory, "timeout"));
      await NodeFSP.writeFile(
        NodePath.join(f.directory, "busctl"),
        "#!/bin/sh\nexec /bin/sleep 30\n",
      );
      expect((await launch(f, "printf fallback")).stdout).toBe("fallback");
    },
    6000,
  );
});
