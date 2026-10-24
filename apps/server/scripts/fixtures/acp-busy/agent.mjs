// Synthetic ACP v1 provider for running-server busy lifecycle verification.
import * as NodeFS from "node:fs";
import * as NodeReadline from "node:readline";
import * as NodeCrypto from "node:crypto";
const [mode, directory] = process.argv.slice(2);
const sessionId = `synthetic-${NodeCrypto.randomUUID()}`;
const busy =
  "Agent is already processing. Use steer() or followUp() to queue messages, or wait for completion.";
let confirmations = 0;
let held;
let oldSent = false;
function record(direction, frame) {
  // session/new contains app-owned MCP credentials; only its shape is recorded.
  const safe =
    frame.method === "session/new"
      ? {
          ...frame,
          params: { ...frame.params, mcpServers: "[redacted app-owned MCP configuration]" },
        }
      : frame;
  NodeFS.appendFileSync(
    `${directory}/wire.ndjson`,
    JSON.stringify({
      at: new Date().toISOString(),
      mono: process.hrtime.bigint().toString(),
      pid: process.pid,
      mode,
      direction,
      frame: safe,
    }) + "\n",
  );
}
function send(frame) {
  record("agent-to-server", frame);
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...frame }) + "\n");
}
function result(id, value) {
  send({ id, result: value });
}
function reject(id, message = busy) {
  send({ id, error: { code: -32603, message } });
}
function update(text, thought = false) {
  send({
    method: "session/update",
    params: {
      sessionId,
      update: {
        sessionUpdate: thought ? "agent_thought_chunk" : "agent_message_chunk",
        content: { type: "text", text },
      },
    },
  });
}
function accept(id, text) {
  update(text);
  result(id, { stopReason: "end_turn" });
}
function gates() {
  if (
    mode === "old-output" &&
    confirmations > 0 &&
    NodeFS.existsSync(`${directory}/old`) &&
    !oldSent
  ) {
    oldSent = true;
    update("Previous background work is still running.", true);
  }
  if (
    held !== undefined &&
    mode !== "in-flight-stop" &&
    NodeFS.existsSync(`${directory}/release`)
  ) {
    const id = held;
    held = undefined;
    accept(id, "Received your confirmation.");
  }
}
NodeFS.watch(directory, gates);
NodeReadline.createInterface({ input: process.stdin })
  .on("close", () => process.exit(0))
  .on("line", (line) => {
    const frame = JSON.parse(line);
    record("server-to-agent", frame);
    const { id, method, params } = frame;
    if (method === "initialize")
      return result(id, {
        protocolVersion: 1,
        agentInfo: { name: "t3-synthetic-busy-lifecycle", version: "1.0.0" },
        agentCapabilities: {},
        authMethods: [],
      });
    if (method === "session/new") return result(id, { sessionId });
    if (method === "session/cancel") {
      if (held !== undefined) {
        const pending = held;
        held = undefined;
        reject(pending);
      }
      return;
    }
    if (method === "session/prompt") {
      const text = JSON.stringify(params.prompt);
      if (!text.includes("нажал"))
        return accept(
          id,
          text.includes("FRESH")
            ? "Fresh turn works."
            : "Press the key once more, waiting up to 4 minutes.",
        );
      confirmations++;
      if (mode === "unrelated-error") return reject(id, "Another internal error");
      if (mode === "queued-stop" || confirmations <= (mode === "long-busy" ? 12 : 1))
        return reject(id);
      if (mode === "long-busy") return accept(id, "Received your confirmation.");
      held = id;
      gates();
      return;
    }
    if (id !== undefined) result(id, {});
  });
