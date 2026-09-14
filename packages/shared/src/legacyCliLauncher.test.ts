// @effect-diagnostics nodeBuiltinImport:off - Exercises real Node IPC and process signals.
import * as NodeChildProcess from "node:child_process";
import * as NodeEvents from "node:events";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { expect, it } from "vite-plus/test";

import { legacyCliLauncherScript } from "./legacyCliLauncher.ts";

// oxlint-disable-next-line t3code/no-global-process-runtime -- This test launches a real host executable.
const hostPlatform = NodeOS.platform();
// oxlint-disable-next-line t3code/no-global-process-runtime -- Match the real executable used by the subprocess.
const hostArch = NodeOS.arch();

// The fixture executable uses a POSIX shebang. The wrapper itself also runs on Windows.
it.skipIf(hostPlatform === "win32").each(["npm", "archive"] as const)(
  "keeps %s service IPC, arguments, and termination connected",
  async (distribution) => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-legacy-launcher-"));
    const entry = NodePath.join(root, "node_modules/t3/dist/bin.mjs");
    const executable =
      distribution === "archive"
        ? NodePath.join(root, "t3")
        : NodePath.join(root, `node_modules/@t3code/t3-${hostPlatform}-${hostArch}/t3`);
    await NodeFSP.mkdir(NodePath.dirname(entry), { recursive: true });
    await NodeFSP.mkdir(NodePath.dirname(executable), { recursive: true });
    await NodeFSP.writeFile(
      NodePath.join(NodePath.dirname(executable), "package.json"),
      '{"type":"commonjs"}',
    );
    await NodeFSP.writeFile(entry, legacyCliLauncherScript(distribution));
    await NodeFSP.writeFile(
      executable,
      `#!${process.execPath}
process.on("SIGTERM", () => process.exit(23));
process.on("message", message => process.send({ reply: message }));
process.send({ args: process.argv.slice(2) });
`,
    );
    await NodeFSP.chmod(executable, 0o755);
    const child = NodeChildProcess.fork(entry, ["serve", "a path with spaces"], { silent: true });
    try {
      expect((await NodeEvents.EventEmitter.once(child, "message"))[0]).toEqual({
        args: ["serve", "a path with spaces"],
      });
      const reply = NodeEvents.EventEmitter.once(child, "message");
      child.send({ type: "trial-accepted" });
      expect((await reply)[0]).toEqual({ reply: { type: "trial-accepted" } });
      const exit = NodeEvents.EventEmitter.once(child, "exit");
      child.kill("SIGTERM");
      expect(await exit).toEqual([23, null]);
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        const exit = NodeEvents.EventEmitter.once(child, "exit");
        child.kill("SIGTERM");
        await exit;
      }
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  },
);
