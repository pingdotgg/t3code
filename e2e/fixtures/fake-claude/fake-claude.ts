// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off globalDate:off - stdlib-only fake CLI, outside any Effect runtime.
/**
 * Deterministic stand-in for the Claude Code CLI. The server runs the real Agent SDK,
 * which spawns this file as `claude` and speaks stream-json over stdio; frames are typed
 * against the SDK's exported message types. Prompts follow ../scenario.ts.
 */
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeReadline from "node:readline";

import type {
  SDKAssistantMessage,
  SDKControlGetUsageResponse,
  SDKControlInitializeResponse,
  SDKResultSuccess,
  SDKSystemMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";

import {
  WAITING_TEXT,
  type JsonSchema,
  flagValue,
  replyText,
  scenarioFor,
  textGenerationOutput,
  writeCommand,
  writeScenarioFile,
} from "../scenario.ts";

const VERSION = "2.1.300";
const args = process.argv.slice(2);

if (args.includes("--version")) {
  process.stdout.write(`${VERSION} (Claude Code)\n`);
} else if (args.includes("-p") || args.includes("--print")) {
  runPrint();
} else {
  runStream();
}

/** Answers `claude -p --json-schema S`, which the server uses for titles and commit messages. */
function runPrint() {
  const schema: JsonSchema = JSON.parse(flagValue(args, "--json-schema") ?? "{}");
  const prompt = NodeFS.readFileSync(0, "utf8");
  const output = textGenerationOutput(schema, prompt);
  process.stdout.write(`${JSON.stringify({ type: "result", structured_output: output })}\n`);
}

/** Serves the stream-json protocol the Agent SDK drives. */
function runStream() {
  const sessionId = flagValue(args, "--session-id") ?? flagValue(args, "--resume") ?? uuid();
  const model = flagValue(args, "--model") ?? "claude-fable-5-1";
  const permissionMode = flagValue(args, "--permission-mode") ?? "default";
  const cwd = process.cwd();
  const write = (frame: unknown) => process.stdout.write(`${JSON.stringify(frame)}\n`);
  const pendingPermissions = new Map<string, (allowed: boolean) => void>();
  let initialized = false;
  let interrupted = false;

  const succeed = (requestId: string, response: unknown = {}) =>
    write({
      type: "control_response",
      response: { subtype: "success", request_id: requestId, response },
    });

  const usage: SDKResultSuccess["usage"] = {
    input_tokens: 1,
    output_tokens: 1,
    cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 0 },
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    inference_geo: "",
    iterations: [],
    server_tool_use: { web_fetch_requests: 0, web_search_requests: 0 },
    service_tier: "standard",
    speed: "standard",
  };

  const systemInit = () =>
    ({
      type: "system",
      subtype: "init",
      apiKeySource: "user",
      claude_code_version: VERSION,
      cwd,
      tools: ["Bash"],
      mcp_servers: [],
      model,
      permissionMode: permissionMode as SDKSystemMessage["permissionMode"],
      slash_commands: [],
      output_style: "default",
      skills: [],
      plugins: [],
      uuid: uuid(),
      session_id: sessionId,
    }) satisfies SDKSystemMessage;

  const assistant = (content: SDKAssistantMessage["message"]["content"]) =>
    ({
      type: "assistant",
      message: {
        id: `msg_${uuid()}`,
        type: "message",
        role: "assistant",
        model,
        content,
        stop_reason: null,
        stop_sequence: null,
        stop_details: null,
        container: null,
        context_management: null,
        usage,
      },
      parent_tool_use_id: null,
      uuid: uuid(),
      session_id: sessionId,
    }) satisfies SDKAssistantMessage;

  const result = (text: string) =>
    ({
      type: "result",
      subtype: "success",
      is_error: false,
      duration_ms: 1,
      duration_api_ms: 1,
      num_turns: 1,
      result: text,
      stop_reason: "end_turn",
      total_cost_usd: 0,
      usage,
      modelUsage: {},
      permission_denials: [],
      uuid: uuid(),
      session_id: sessionId,
    }) satisfies SDKResultSuccess;

  const reply = (text: string) => {
    write(assistant([{ type: "text", text, citations: null }]));
    write(result(text));
  };

  const requestPermission = (toolUseId: string, command: string) =>
    new Promise<boolean>((resolve) => {
      const requestId = `perm-${uuid()}`;
      pendingPermissions.set(requestId, resolve);
      write({
        type: "control_request",
        request_id: requestId,
        request: {
          subtype: "can_use_tool",
          tool_name: "Bash",
          input: { command, description: "Write a file" },
          tool_use_id: toolUseId,
          permission_suggestions: [],
        },
      });
    });

  const runTurn = async (prompt: string) => {
    if (!initialized) {
      initialized = true;
      write(systemInit());
    }
    interrupted = false;
    const scenario = scenarioFor(prompt);
    if (scenario.kind === "wait") {
      write(assistant([{ type: "text", text: WAITING_TEXT, citations: null }]));
      return;
    }
    if (scenario.kind === "reply") {
      reply(replyText("Claude", prompt));
      return;
    }
    const { fileName } = scenario;
    const toolUseId = `toolu_${uuid()}`;
    const command = writeCommand(fileName);
    write(assistant([{ type: "tool_use", id: toolUseId, name: "Bash", input: { command } }]));
    const allowed =
      permissionMode === "bypassPermissions" || (await requestPermission(toolUseId, command));
    if (interrupted) return;
    if (allowed) writeScenarioFile(cwd, fileName);
    write({
      type: "user",
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: toolUseId,
            content: allowed ? "" : "User declined tool execution.",
            is_error: !allowed,
          },
        ],
      },
      parent_tool_use_id: null,
      session_id: sessionId,
    } satisfies SDKUserMessage);
    reply(allowed ? `Wrote ${fileName}.` : `Okay, I did not write ${fileName}.`);
  };

  NodeReadline.createInterface({ input: process.stdin }).on("line", (line) => {
    const frame = JSON.parse(line);
    if (frame.type === "control_request") {
      const subtype: string = frame.request?.subtype;
      if (subtype === "initialize") {
        succeed(frame.request_id, {
          commands: [],
          agents: [],
          output_style: "default",
          available_output_styles: ["default"],
          models: [],
          account: { email: "e2e@t3.invalid", tokenSource: "apiKey", apiProvider: "firstParty" },
        } satisfies SDKControlInitializeResponse);
      } else if (subtype === "get_usage") {
        succeed(frame.request_id, {
          session: {
            total_cost_usd: 0,
            total_api_duration_ms: 0,
            total_duration_ms: 0,
            total_lines_added: 0,
            total_lines_removed: 0,
            model_usage: {},
          },
          subscription_type: null,
          rate_limits_available: false,
          rate_limits: null,
          behaviors: { day: noBehaviors, week: noBehaviors },
        } satisfies SDKControlGetUsageResponse);
      } else if (subtype === "interrupt") {
        interrupted = true;
        for (const resolve of pendingPermissions.values()) resolve(false);
        pendingPermissions.clear();
        succeed(frame.request_id);
      } else {
        succeed(frame.request_id);
      }
      return;
    }
    if (frame.type === "control_response") {
      const requestId: string = frame.response?.request_id;
      const resolve = pendingPermissions.get(requestId);
      if (resolve === undefined) return;
      pendingPermissions.delete(requestId);
      resolve(frame.response?.response?.behavior === "allow");
      return;
    }
    if (frame.type === "user") {
      const content = frame.message?.content;
      const prompt =
        typeof content === "string"
          ? content
          : (content ?? [])
              .flatMap((part: { type?: string; text?: string }) =>
                part.type === "text" && part.text !== undefined ? [part.text] : [],
              )
              .join("\n");
      void runTurn(prompt);
    }
  });
  process.stdin.on("end", () => process.exit(0));
}

const noBehaviors = {
  request_count: 0,
  session_count: 0,
  behaviors: [],
  agents: [],
  skills: [],
  plugins: [],
  mcp_servers: [],
};

/** A fresh random UUID, the id format every Claude frame carries. */
function uuid() {
  return NodeCrypto.randomUUID();
}
