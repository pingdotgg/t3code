// @effect-diagnostics nodeBuiltinImport:off
import { assert, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeReadline from "node:readline";
import * as NodeURL from "node:url";

const scriptPath = NodeURL.fileURLToPath(new URL("./acp-replay-agent.ts", import.meta.url));

const sessionUpdate = (text: string) => ({
  kind: "notification",
  method: "session/update",
  params: { sessionId: "session-1", update: { sessionUpdate: "agent_message_chunk", text } },
});

/**
 * Starts the replay agent on `entries` in a fresh directory. With
 * `statusIsFifo`, every status write blocks until the test reads it.
 */
function startAgent(entries: ReadonlyArray<unknown>, options: { statusIsFifo?: boolean } = {}) {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "acp-replay-agent-"));
  const transcriptPath = NodePath.join(directory, "transcript.json");
  const statusPath = NodePath.join(directory, "status.json");
  NodeFS.writeFileSync(transcriptPath, JSON.stringify({ scenario: "replay-agent", entries }));
  if (options.statusIsFifo === true) NodeChildProcess.execFileSync("mkfifo", [statusPath]);
  const agent = NodeChildProcess.spawn(
    process.execPath,
    ["--experimental-strip-types", scriptPath],
    {
      env: {
        ...process.env,
        T3_ACP_REPLAY_TRANSCRIPT_PATH: transcriptPath,
        T3_ACP_REPLAY_STATUS_PATH: statusPath,
      },
      stdio: ["pipe", "pipe", "inherit"],
    },
  );
  const lines = NodeReadline.createInterface({ input: agent.stdout })[Symbol.asyncIterator]();
  const exited = new Promise<number | null>((resolve) => agent.once("exit", resolve));
  const readStatus = async () => JSON.parse(await NodeFS.promises.readFile(statusPath, "utf8"));
  const nextFrame = async () => {
    const line = await lines.next();
    return line.done === true ? undefined : JSON.parse(line.value);
  };
  const stop = async () => {
    if (agent.exitCode === null && agent.signalCode === null) agent.kill();
    await exited;
    NodeFS.rmSync(directory, { recursive: true, force: true });
  };
  return { exited, readStatus, nextFrame, stop };
}

// T3 may stop the agent as soon as it has the last frame, and the completeness
// check then reads the status, so the status must count a frame before the
// frame is visible.
it.skipIf(HostProcess.Platform.defaultValue() === "win32")(
  "records its status before it sends the frames the status counts",
  async () => {
    const agent = startAgent([{ type: "emit_inbound", frame: sessionUpdate("ready") }], {
      statusIsFifo: true,
    });
    try {
      assert.deepEqual(await agent.readStatus(), { scenario: "replay-agent", cursor: 1, total: 1 });
      assert.deepEqual(await agent.nextFrame(), {
        jsonrpc: "2.0",
        method: "session/update",
        params: sessionUpdate("ready").params,
      });
    } finally {
      await agent.stop();
    }
  },
);

it("sends every frame before a recorded crash and then exits with an error", async () => {
  const agent = startAgent([
    { type: "emit_inbound", frame: sessionUpdate("first") },
    { type: "emit_inbound", frame: sessionUpdate("second") },
    { type: "runtime_exit", status: "error" },
  ]);
  try {
    const first = await agent.nextFrame();
    const second = await agent.nextFrame();
    assert.deepEqual(
      [first?.params, second?.params, await agent.nextFrame()],
      [sessionUpdate("first").params, sessionUpdate("second").params, undefined],
    );
    assert.strictEqual(await agent.exited, 1);
    assert.deepEqual(await agent.readStatus(), { scenario: "replay-agent", cursor: 3, total: 3 });
  } finally {
    await agent.stop();
  }
});
