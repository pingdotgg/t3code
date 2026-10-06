// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off - stdlib-only fake CLI, outside any Effect runtime.
/**
 * Deterministic ACP agent standing in for the Grok and Antigravity CLIs, which the server
 * drives over ACP v1 (newline-delimited JSON-RPC on stdio). Each wrapper passes its
 * persona as the first argument. Frames are typed against effect-acp's generated v1
 * schema. Prompts follow ../scenario.ts.
 *
 * - `grok`: answers `--version`, `models`, and `inspect --json` for the readiness probe,
 *   and speaks ACP for `agent ... stdio`.
 * - `antigravity`: speaks ACP for any invocation, authenticates with `oauth-personal`,
 *   and advertises the model and mode config options the server sets each turn.
 */
import * as NodeCrypto from "node:crypto";
import * as NodeReadline from "node:readline";

import type {
  AuthenticateResponse,
  InitializeResponse,
  NewSessionResponse,
  PromptRequest,
  PromptResponse,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionConfigOption,
  SessionNotification,
} from "effect-acp/schema-v1";

import {
  WAITING_TEXT,
  replyText,
  scenarioFor,
  writeCommand,
  writeScenarioFile,
} from "../scenario.ts";

type Persona = "grok" | "antigravity";

const [personaArg, ...args] = process.argv.slice(2);
if (personaArg !== "grok" && personaArg !== "antigravity") {
  throw new Error(`fake acp: unknown persona ${personaArg ?? "(none)"}`);
}
const persona: Persona = personaArg;
const displayName = persona === "grok" ? "Grok" : "Antigravity";

if (persona === "grok" && args[0] === "--version") {
  process.stdout.write("grok 1.0.41\n");
} else if (persona === "grok" && args[0] === "models") {
  process.stdout.write("You are logged in with grok.com.\n  * grok-build (default)\n");
} else if (persona === "grok" && args[0] === "inspect") {
  process.stdout.write(`${JSON.stringify({ skills: [] })}\n`);
} else {
  runAgent();
}

/** Serves ACP v1 on stdio. */
function runAgent() {
  const write = (message: unknown) => process.stdout.write(`${JSON.stringify(message)}\n`);
  const notify = (params: SessionNotification) =>
    write({ jsonrpc: "2.0", method: "session/update", params });
  const respond = (id: number | string, result: unknown) => write({ jsonrpc: "2.0", id, result });
  const sessions = new Map<string, { cwd: string; activePrompt: number | string | undefined }>();
  const pendingPermissions = new Map<number, (optionId: string | undefined) => void>();
  let nextRequestId = 0;

  const configOptions = (): ReadonlyArray<SessionConfigOption> =>
    persona === "antigravity"
      ? [
          {
            id: "model",
            name: "Model",
            category: "model",
            type: "select",
            currentValue: "gemini-3.8-flash-high",
            options: [{ value: "gemini-3.8-flash-high", name: "Gemini 3.8 Flash (High)" }],
          },
          {
            id: "mode",
            name: "Mode",
            category: "mode",
            type: "select",
            currentValue: "default",
            options: [
              { value: "default", name: "Default" },
              { value: "auto_edit", name: "Auto edit" },
              { value: "yolo", name: "YOLO" },
            ],
          },
        ]
      : [];

  const say = (sessionId: string, text: string) =>
    notify({
      sessionId,
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } },
    });

  const askPermission = (sessionId: string, toolCallId: string, command: string) =>
    new Promise<string | undefined>((resolve) => {
      const requestId = nextRequestId++;
      pendingPermissions.set(requestId, resolve);
      write({
        jsonrpc: "2.0",
        id: requestId,
        method: "session/request_permission",
        params: {
          sessionId,
          toolCall: {
            toolCallId,
            title: command,
            kind: "execute",
            status: "pending",
            rawInput: { command },
          },
          options: [
            { optionId: "allow_once", name: "Allow once", kind: "allow_once" },
            { optionId: "allow_always", name: "Allow always", kind: "allow_always" },
            { optionId: "reject_once", name: "Reject", kind: "reject_once" },
          ],
        } satisfies RequestPermissionRequest,
      });
    });

  const prompt = async (id: number | string, params: PromptRequest) => {
    const session = sessions.get(params.sessionId) ?? {
      cwd: process.cwd(),
      activePrompt: undefined,
    };
    sessions.set(params.sessionId, session);
    session.activePrompt = id;
    const finish = (stopReason: PromptResponse["stopReason"]) => {
      if (session.activePrompt !== id) return;
      session.activePrompt = undefined;
      respond(id, { stopReason } satisfies PromptResponse);
    };
    const text = params.prompt
      .flatMap((block) => (block.type === "text" ? [block.text] : []))
      .join("\n");
    // Grok wraps the user's words in <user_request>; Antigravity appends T3 context blocks
    // such as <runtime_info> after a resume. Either way the scenario reads the user's text.
    const userText =
      /<user_request>([\s\S]*?)<\/user_request>/.exec(text)?.[1]?.trim() ??
      text.replace(/<([a-z_]+)>[\s\S]*?<\/\1>/g, "").trim();
    const scenario = scenarioFor(userText);
    if (scenario.kind === "wait") {
      // The server streams assistant text a paragraph at a time, so a turn that never
      // finishes only shows text that ends in a blank line.
      say(params.sessionId, `${WAITING_TEXT}\n\n`);
      return;
    }
    if (scenario.kind === "reply") {
      say(params.sessionId, replyText(displayName, userText));
      finish("end_turn");
      return;
    }
    const { fileName } = scenario;
    const toolCallId = `call_${NodeCrypto.randomUUID()}`;
    const optionId = await askPermission(params.sessionId, toolCallId, writeCommand(fileName));
    if (session.activePrompt !== id) return;
    const allowed = optionId === "allow_once" || optionId === "allow_always";
    if (allowed) writeScenarioFile(session.cwd, fileName);
    say(params.sessionId, allowed ? `Wrote ${fileName}.` : `Okay, I did not write ${fileName}.`);
    finish("end_turn");
  };

  const cancel = (sessionId: string) => {
    for (const resolve of pendingPermissions.values()) resolve(undefined);
    pendingPermissions.clear();
    const session = sessions.get(sessionId);
    if (session?.activePrompt === undefined) return;
    const id = session.activePrompt;
    session.activePrompt = undefined;
    respond(id, { stopReason: "cancelled" } satisfies PromptResponse);
  };

  const handlers: Record<string, (params: never) => unknown> = {
    initialize: (): InitializeResponse => ({
      protocolVersion: 1,
      agentInfo: { name: persona, version: "1.0.41" },
      agentCapabilities: { loadSession: true, sessionCapabilities: { resume: {} } },
      authMethods:
        persona === "antigravity"
          ? [{ id: "oauth-personal", name: "Google account" }]
          : [{ id: "cached_token", name: "Cached token" }],
    }),
    authenticate: (): AuthenticateResponse => ({}),
    "session/new": (params: { cwd: string }): NewSessionResponse => {
      const sessionId = NodeCrypto.randomUUID();
      sessions.set(sessionId, { cwd: params.cwd, activePrompt: undefined });
      return { sessionId, configOptions: [...configOptions()] };
    },
    "session/load": (params: { sessionId: string; cwd: string }) => {
      sessions.set(params.sessionId, { cwd: params.cwd, activePrompt: undefined });
      return { configOptions: [...configOptions()] };
    },
    "session/resume": (params: { sessionId: string; cwd: string }) => {
      sessions.set(params.sessionId, { cwd: params.cwd, activePrompt: undefined });
      return { configOptions: [...configOptions()] };
    },
    "session/set_config_option": () => ({ configOptions: [...configOptions()] }),
    "session/set_mode": () => ({}),
    "session/set_model": () => ({}),
  };

  NodeReadline.createInterface({ input: process.stdin }).on("line", (line) => {
    const message: { id?: number | string; method?: string; params?: unknown; result?: unknown } =
      JSON.parse(line);
    if (message.method === undefined) {
      if (typeof message.id === "number" && pendingPermissions.has(message.id)) {
        const resolve = pendingPermissions.get(message.id);
        pendingPermissions.delete(message.id);
        const outcome = (message.result as RequestPermissionResponse | undefined)?.outcome;
        resolve?.(outcome?.outcome === "selected" ? outcome.optionId : undefined);
      }
      return;
    }
    if (message.method === "session/cancel") {
      cancel((message.params as { sessionId: string }).sessionId);
      return;
    }
    if (message.id === undefined) return;
    if (message.method === "session/prompt") {
      void prompt(message.id, message.params as PromptRequest);
      return;
    }
    const handler = handlers[message.method];
    if (handler === undefined) {
      write({
        jsonrpc: "2.0",
        id: message.id,
        error: { code: -32601, message: `fake acp: method not found: ${message.method}` },
      });
      return;
    }
    respond(message.id, handler(message.params as never));
  });
  process.stdin.on("end", () => process.exit(0));
}
