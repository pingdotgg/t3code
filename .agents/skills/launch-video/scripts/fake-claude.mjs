#!/usr/bin/env node
// A stand-in `claude` CLI for staged launch videos: T3's real Claude provider runs it, and it
// plays the scripted turns in FAKE_CLAUDE_SCRIPT over the Agent SDK's stream-json protocol.
// Script format: see the launch-video SKILL.md. FAKE_CLAUDE_LOG records every line.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeReadline from "node:readline";

const VERSION = "2.1.329";
if (process.argv.includes("--version") || process.argv.includes("-v")) {
  console.log(`${VERSION} (Claude Code)`);
  process.exit(0);
}

const log = (direction, value) => {
  if (!process.env.FAKE_CLAUDE_LOG) return;
  NodeFS.appendFileSync(
    process.env.FAKE_CLAUDE_LOG,
    `${direction} ${JSON.stringify(value).slice(0, 4000)}\n`,
  );
};
log("argv", process.argv.slice(2));

const readJson = (file, fallback) => {
  try {
    return JSON.parse(NodeFS.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
};
const script = readJson(process.env.FAKE_CLAUDE_SCRIPT ?? "", []);
const played = new Set();
const fill = (value) => {
  const vars = readJson(process.env.FAKE_CLAUDE_VARS ?? "", {});
  const walk = (v) =>
    typeof v === "string"
      ? v.replace(/<var:([\w-]+)>/g, (m, name) => vars[name] ?? m)
      : Array.isArray(v)
        ? v.map(walk)
        : v && typeof v === "object"
          ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]))
          : v;
  return walk(value);
};

const argValue = (name) => {
  const i = process.argv.indexOf(name);
  return i === -1 ? undefined : process.argv[i + 1];
};
const sessionId = argValue("--session-id") ?? argValue("--resume") ?? NodeCrypto.randomUUID();
let model = argValue("--model") ?? "claude-opus-5-5";
const cwd = process.cwd();
const mcpServers = {};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const uuid = () => NodeCrypto.randomUUID();

const send = (message) => {
  log("out", message);
  process.stdout.write(`${JSON.stringify(message)}\n`);
};
const usage = {
  input_tokens: 1,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
  output_tokens: 1,
  service_tier: "standard",
};
const assistant = (content, id = `msg_${uuid().replaceAll("-", "").slice(0, 24)}`) =>
  send({
    type: "assistant",
    message: {
      model,
      id,
      type: "message",
      role: "assistant",
      content,
      stop_reason: null,
      stop_sequence: null,
      usage,
    },
    parent_tool_use_id: null,
    session_id: sessionId,
    uuid: uuid(),
  });
const toolResult = (toolUseId, content, extra = {}) =>
  send({
    type: "user",
    message: {
      role: "user",
      content: [{ tool_use_id: toolUseId, type: "tool_result", content, is_error: false }],
    },
    parent_tool_use_id: null,
    session_id: sessionId,
    uuid: uuid(),
    timestamp: new Date().toISOString(),
    ...extra,
  });

// Streams text the way the CLI does with partial messages on: deltas, then the whole block.
const streamText = async (text, type = "text") => {
  const id = `msg_${uuid().replaceAll("-", "").slice(0, 24)}`;
  const delta = type === "text" ? "text_delta" : "thinking_delta";
  const field = type === "text" ? "text" : "thinking";
  send({
    type: "stream_event",
    event: {
      type: "message_start",
      message: { id, type: "message", role: "assistant", model, content: [], usage },
    },
    parent_tool_use_id: null,
    session_id: sessionId,
    uuid: uuid(),
  });
  send({
    type: "stream_event",
    event: {
      type: "content_block_start",
      index: 0,
      content_block:
        type === "text"
          ? { type: "text", text: "" }
          : { type: "thinking", thinking: "", signature: "" },
    },
    parent_tool_use_id: null,
    session_id: sessionId,
    uuid: uuid(),
  });
  const words = text.match(/\S+\s*|\s+/g) ?? [text];
  for (let i = 0; i < words.length; i += 3) {
    await sleep(35);
    send({
      type: "stream_event",
      event: {
        type: "content_block_delta",
        index: 0,
        delta: { type: delta, [field]: words.slice(i, i + 3).join("") },
      },
      parent_tool_use_id: null,
      session_id: sessionId,
      uuid: uuid(),
    });
  }
  send({
    type: "stream_event",
    event: { type: "content_block_stop", index: 0 },
    parent_tool_use_id: null,
    session_id: sessionId,
    uuid: uuid(),
  });
  assistant(
    [
      type === "text"
        ? { type: "text", text }
        : { type: "thinking", thinking: text, signature: "" },
    ],
    id,
  );
  send({
    type: "stream_event",
    event: { type: "message_stop" },
    parent_tool_use_id: null,
    session_id: sessionId,
    uuid: uuid(),
  });
};

// One MCP tools/call over streamable HTTP against the server T3 registered.
async function callTool(name, args) {
  const [serverName, server] = Object.entries(mcpServers).find(([, s]) => s.url) ?? [];
  if (!server) return { serverName: "t3-code", text: `No MCP server for ${name}` };
  let session;
  const post = async (body) => {
    const response = await fetch(server.url, {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        ...server.headers,
        ...(session && { "mcp-session-id": session }),
      },
      body: JSON.stringify({ jsonrpc: "2.0", ...body }),
    });
    session = response.headers.get("mcp-session-id") ?? session;
    const text = await response.text();
    const data = text.split("\n").find((line) => line.startsWith("data:"));
    return text ? JSON.parse(data ? data.slice(5) : text) : undefined;
  };
  await post({
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "fake-claude", version: VERSION },
    },
  });
  await post({ method: "notifications/initialized" });
  const result = await post({ id: 2, method: "tools/call", params: { name, arguments: args } });
  log("mcp", result);
  const text =
    (result?.result?.content ?? []).map((c) => c.text ?? "").join("\n") ||
    JSON.stringify(result?.error ?? result);
  return { serverName, text };
}

async function playTurn(prompt) {
  let index = script.findIndex(
    (turn, i) => !played.has(i) && turn.match && new RegExp(turn.match, "i").test(prompt),
  );
  if (index === -1) index = script.findIndex((turn, i) => !played.has(i) && !turn.match);
  const turn = index === -1 ? { steps: [{ text: "Done." }] } : script[index];
  if (index !== -1 && !turn.repeat) played.add(index);
  send({
    type: "system",
    subtype: "init",
    apiKeySource: "none",
    claude_code_version: VERSION,
    cwd,
    tools: ["Bash", "Read", "Edit"],
    mcp_servers: Object.keys(mcpServers).map((name) => ({ name, status: "connected" })),
    model,
    permissionMode: "bypassPermissions",
    slash_commands: [],
    output_style: "default",
    skills: [],
    plugins: [],
    agents: [],
    uuid: uuid(),
    session_id: sessionId,
  });
  let last = "";
  for (const step of fill(turn.steps)) {
    if (step.wait) await sleep(step.wait);
    if (step.think) await streamText(step.think, "thinking");
    if (step.text) {
      await streamText(step.text);
      last = step.text;
    }
    if (step.bash) {
      const id = `toolu_${uuid().replaceAll("-", "").slice(0, 24)}`;
      assistant([
        {
          type: "tool_use",
          id,
          name: "Bash",
          input: { command: step.bash, description: step.description ?? step.bash },
        },
      ]);
      await sleep(step.ms ?? 1200);
      toolResult(id, step.output ?? "", {
        tool_use_result: {
          stdout: step.output ?? "",
          stderr: "",
          interrupted: false,
          isImage: false,
        },
      });
    }
    if (step.tool) {
      const id = `toolu_${uuid().replaceAll("-", "").slice(0, 24)}`;
      const serverName = Object.keys(mcpServers)[0] ?? "t3-code";
      assistant([
        { type: "tool_use", id, name: `mcp__${serverName}__${step.tool}`, input: step.input ?? {} },
      ]);
      const { text } = await callTool(step.tool, step.input ?? {}).catch((error) => ({
        text: String(error),
      }));
      toolResult(id, [{ type: "text", text }]);
    }
  }
  send({
    type: "result",
    subtype: "success",
    is_error: false,
    duration_ms: 4000,
    duration_api_ms: 3500,
    num_turns: 1,
    result: last,
    stop_reason: "end_turn",
    session_id: sessionId,
    total_cost_usd: 0,
    usage,
    modelUsage: {},
    permission_denials: [],
    uuid: uuid(),
  });
}

const controlResponse = (request) => {
  switch (request.subtype) {
    case "initialize":
      return {
        commands: [],
        output_style: "default",
        available_output_styles: ["default"],
        models: [],
        account: { email: "demo@example.com", subscriptionType: "max", tokenSource: "claude.ai" },
      };
    case "mcp_set_servers":
      for (const [name, config] of Object.entries(request.servers ?? {})) mcpServers[name] = config;
      return { added: Object.keys(request.servers ?? {}), removed: [], errors: {} };
    case "set_model":
      model = request.model ?? model;
      return {};
    case "get_usage":
      return { rate_limits_available: false, rate_limits: [] };
    default:
      return {};
  }
};

let queue = Promise.resolve();
const input = NodeReadline.createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on("line", (line) => {
  if (!line.trim()) return;
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  log("in", message);
  if (message.type === "control_request") {
    send({
      type: "control_response",
      response: {
        subtype: "success",
        request_id: message.request_id,
        response: controlResponse(message.request ?? {}),
      },
    });
    return;
  }
  if (message.type === "user") {
    const content = message.message?.content;
    const prompt =
      typeof content === "string" ? content : (content ?? []).map((c) => c.text ?? "").join("\n");
    queue = queue.then(() => playTurn(prompt)).catch((error) => log("error", String(error)));
  }
});
input.on("close", () => queue.then(() => process.exit(0)));
