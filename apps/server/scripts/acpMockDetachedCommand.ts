// @effect-diagnostics nodeBuiltinImport:off -- the fixture captures real Linux process identities.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeReadline from "node:readline";
import * as NodeURL from "node:url";

const identity = (pid: number | undefined) => {
  if (pid === undefined) throw new Error("Command did not spawn");
  const stat = NodeFS.readFileSync(`/proc/${pid}/stat`, "utf8");
  const fields = stat
    .slice(stat.lastIndexOf(")") + 2)
    .trim()
    .split(/\s+/);
  return {
    pid,
    ppid: Number(fields[1]),
    pgid: Number(fields[2]),
    sid: Number(fields[3]),
    startTime: fields[19],
  };
};

const writeReceipt = (
  pidFile: string,
  receipt: { processes: Array<ReturnType<typeof identity>> },
) => {
  NodeFS.writeFileSync(`${pidFile}.tmp`, JSON.stringify(receipt));
  NodeFS.renameSync(`${pidFile}.tmp`, pidFile);
};

if (process.argv[2] === "command") {
  const pidFile = process.argv[3];
  if (pidFile === undefined) throw new Error("Missing process receipt path");
  const sleep = NodeChildProcess.spawn("/bin/sleep", ["53"], { stdio: "ignore" });
  await new Promise<void>((resolve, reject) => {
    sleep.once("spawn", resolve);
    sleep.once("error", reject);
  });
  const receipt = {
    processes: [identity(process.ppid), identity(process.pid), identity(sleep.pid)],
  };
  writeReceipt(pidFile, receipt);
  process.stdout.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code !== "EPIPE") throw error;
  });
  process.stdout.write(JSON.stringify(receipt) + "\n");
  await new Promise<void>((resolve) => sleep.once("exit", () => resolve()));
  process.exit(0);
}

// Readiness follows the command's atomic receipt, independently of the ACP reader.
export async function startDetachedCommand(pidFile: string) {
  const shell = NodeChildProcess.spawn(
    "/bin/sh",
    [
      "-c",
      'read -r start || exit 0; "$1" "$2" command "$3" & wait',
      "fixture",
      process.execPath,
      NodeURL.fileURLToPath(import.meta.url),
      pidFile,
    ],
    { detached: true, stdio: ["pipe", "pipe", "ignore"] },
  );
  writeReceipt(pidFile, { processes: [identity(shell.pid)] });
  shell.stdin.end("start\n");
  const lines = NodeReadline.createInterface({ input: shell.stdout });
  try {
    const ready = await lines[Symbol.asyncIterator]().next();
    if (ready.done) throw new Error("Command exited before acknowledging child readiness");
  } finally {
    lines.close();
  }
}
