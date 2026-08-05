// Minimal codex app-server stand-in for runtime-level collab tests.
// Speaks just enough of the protocol for CodexSessionRuntime to start a
// session, using REAL captured responses (codexMultiAgentWire.json), then
// replays a scripted multi-agent notification sequence read from the
// T3_CODEX_COLLAB_SCRIPT env var (a JSON file path) when the first turn
// starts. Runs as a plain Node process — stdlib only.
import * as fs from "node:fs";
import * as readline from "node:readline";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(fs.readFileSync(path.join(here, "codexMultiAgentWire.json"), "utf8"));
const script = JSON.parse(fs.readFileSync(process.env.T3_CODEX_COLLAB_SCRIPT, "utf8"));

const write = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  const { id, method } = message;
  if (method === "initialize") {
    write({
      id,
      result: {
        userAgent: "t3-collab-mock/0.0.0",
        codexHome: "/tmp",
        platformFamily: "unix",
        platformOs: "linux",
      },
    });
    return;
  }
  if (method === "thread/start" || method === "thread/resume") {
    write({ id, result: fixture.responses.threadStart });
    return;
  }
  if (method === "turn/start") {
    write({ id, result: fixture.responses.turnStart });
    const rootThreadId = script.rootThreadId;
    const turn = fixture.responses.turnStart.turn;
    write({
      jsonrpc: "2.0",
      method: "turn/started",
      params: { threadId: rootThreadId, turn },
    });
    for (const notification of script.notifications) {
      write({ jsonrpc: "2.0", method: notification.method, params: notification.params });
    }
    write({
      jsonrpc: "2.0",
      method: "turn/completed",
      params: {
        threadId: rootThreadId,
        turn: { ...turn, status: "completed" },
      },
    });
    return;
  }
  if (id !== undefined) {
    write({ id, result: {} });
  }
});
