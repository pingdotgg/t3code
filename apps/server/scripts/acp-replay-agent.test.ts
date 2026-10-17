// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { assert, it } from "@effect/vitest";

it("persists complete replay status before publishing its final response", () => {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-acp-status-"));
  try {
    const statusPath = NodePath.join(directory, "status.json");
    const observedPath = NodePath.join(directory, "observed.json");
    const preloadPath = NodePath.join(directory, "observe.mjs");
    NodeFS.writeFileSync(
      preloadPath,
      `import * as fs from "node:fs";
const write = process.stdout.write.bind(process.stdout);
process.stdout.write = (chunk, ...args) => {
  fs.writeFileSync(process.env.T3_ACP_REPLAY_OBSERVED_PATH, fs.readFileSync(process.env.T3_ACP_REPLAY_STATUS_PATH));
  return write(chunk, ...args);
};
`,
    );
    const transcript = {
      scenario: "final-response-status",
      entries: [
        {
          type: "expect_outbound",
          frame: { kind: "request", method: "initialize", params: {} },
        },
        {
          type: "emit_inbound",
          frame: { kind: "response", method: "initialize", result: { protocolVersion: 1 } },
        },
      ],
    };
    const child = NodeChildProcess.spawnSync(
      process.execPath,
      [
        "--import",
        preloadPath,
        "--experimental-strip-types",
        NodeURL.fileURLToPath(new URL("./acp-replay-agent.ts", import.meta.url)),
      ],
      {
        cwd: directory,
        env: {
          ...process.env,
          T3_ACP_REPLAY_TRANSCRIPT: Buffer.from(JSON.stringify(transcript)).toString("base64"),
          T3_ACP_REPLAY_STATUS_PATH: statusPath,
          T3_ACP_REPLAY_OBSERVED_PATH: observedPath,
        },
        input: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }) + "\n",
        encoding: "utf8",
      },
    );
    assert.equal(child.status, 0, child.stderr);
    const response: unknown = JSON.parse(child.stdout);
    assert.deepEqual(response, { jsonrpc: "2.0", id: 1, result: { protocolVersion: 1 } });
    const publishedStatus: unknown = JSON.parse(NodeFS.readFileSync(observedPath, "utf8"));
    assert.deepEqual(publishedStatus, {
      scenario: transcript.scenario,
      cursor: transcript.entries.length,
      total: transcript.entries.length,
    });
  } finally {
    NodeFS.rmSync(directory, { recursive: true, force: true });
  }
});
