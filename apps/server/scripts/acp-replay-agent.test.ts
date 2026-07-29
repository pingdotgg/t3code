// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { expect, it } from "vite-plus/test";

const replayAgentPath = NodeURL.fileURLToPath(new URL("./acp-replay-agent.ts", import.meta.url));

async function runRuntimeExit(status: "success" | "error" | "cancelled") {
  const scratch = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-acp-replay-agent-"));
  const statusPath = NodePath.join(scratch, "status.json");
  const transcript = {
    scenario: `${status}-runtime-exit`,
    entries: [{ type: "runtime_exit", status }],
  };
  const child = NodeChildProcess.spawn(process.execPath, [replayAgentPath], {
    env: {
      ...process.env,
      T3_ACP_REPLAY_STATUS_PATH: statusPath,
      T3_ACP_REPLAY_TRANSCRIPT: Buffer.from(JSON.stringify(transcript), "utf8").toString("base64"),
      T3_ACP_REPLAY_WORKSPACE: scratch,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  child.stdin.end();

  try {
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", resolve);
    });
    return {
      code,
      status: JSON.parse(NodeFS.readFileSync(statusPath, "utf8")) as unknown,
      stderr,
      transcript,
    };
  } finally {
    NodeFS.rmSync(scratch, { recursive: true, force: true });
  }
}

it("accepts a recorded cancelled runtime exit", async () => {
  const result = await runRuntimeExit("cancelled");
  expect(result.code, result.stderr).toBe(0);
  expect(result.status).toEqual({
    scenario: result.transcript.scenario,
    cursor: 1,
    total: 1,
  });
});

it("still rejects a recorded error runtime exit", async () => {
  const result = await runRuntimeExit("error");
  expect(result.code).toBe(1);
  expect(result.status).toMatchObject({
    scenario: result.transcript.scenario,
    cursor: 0,
    total: 1,
    failure: {
      detail: "Recorded runtime exit was error",
      cursor: 0,
    },
  });
});
