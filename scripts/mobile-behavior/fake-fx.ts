// @effect-diagnostics nodeBuiltinImport:off globalTimers:off preferSchemaOverJson:off globalConsole:off - a tiny stdio ACP agent spawned by the server; plain Node keeps it dependency-free.
/**
 * A scripted stand-in for the `fx` CLI, registered as an Fx provider instance so the
 * server streams deterministic replies with no model. A `[[eval:<script>]]` marker in
 * the prompt picks the reply; see `scriptOf`. `hold` scripts wait for a release file
 * named after the marker's key in `T3_EVAL_FX_CONTROL_DIR`.
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeReadline from "node:readline";

const MODEL = "eval/scripted";

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
interface Message {
  readonly id?: number | string;
  readonly method?: string;
  readonly params?: { [key: string]: Json };
  readonly result?: Json;
  readonly error?: Json;
}

const controlDir = process.env.T3_EVAL_FX_CONTROL_DIR ?? "";
const send = (message: object) => process.stdout.write(`${JSON.stringify(message)}\n`);
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const update = (sessionId: string, value: object) =>
  send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: value } });

const select = (id: string, category: string, currentValue: string, values: string[]) => ({
  id,
  name: id,
  category,
  type: "select",
  currentValue,
  options: values.map((value) => ({ value, name: value })),
});
// The Fx adapter needs a mode option and the modes list; it sets mode and effort per session.
const configOptions = [
  select("model", "model", MODEL, [MODEL]),
  select("mode", "mode", "full-access", ["auto", "ask", "full-access"]),
  select("effort", "thought_level", "auto", ["auto", "low", "medium", "high"]),
];
const modes = {
  currentModeId: "full-access",
  availableModes: ["auto", "ask", "full-access"].map((id) => ({ id, name: id })),
};

let nextOutgoingId = 1_000_000;
const pendingReplies = new Map<number, (message: Message) => void>();
const cancelled = new Set<string>();
let sessionCount = 0;

function request(method: string, params: object): Promise<Message> {
  const id = nextOutgoingId++;
  send({ jsonrpc: "2.0", id, method, params });
  return new Promise((resolve) => pendingReplies.set(id, resolve));
}

/** Paragraphs of plain filler with a heading every fifth paragraph, so the feed lays out like a real reply. */
export function fillerText(words: number, seed = 0): string {
  const vocabulary =
    "the agent reads the file then edits the module and runs the focused test before it writes a short summary of what changed and why the change is safe".split(
      " ",
    );
  const out: string[] = [];
  let paragraph: string[] = [];
  for (let index = 0; index < words; index++) {
    paragraph.push(vocabulary[(index * 7 + seed) % vocabulary.length]!);
    if (paragraph.length === 60 || index === words - 1) {
      const count = out.length;
      out.push(`${count % 5 === 0 ? `## Part ${count / 5 + 1}\n\n` : ""}${paragraph.join(" ")}.`);
      paragraph = [];
    }
  }
  return out.join("\n\n");
}

interface Script {
  readonly kind: "reply" | "stream" | "hold" | "question" | "subagents" | "fail";
  readonly words: number;
  readonly chunkMs: number;
  readonly key: string;
}

/** `[[eval:stream:3000:40]]` streams 3000 words in 40 ms chunks; `[[eval:hold:k]]` replies when `k` is released. */
export function scriptOf(prompt: string): Script {
  const marker = /\[\[eval:([a-z]+)(?::([^\]:]+))?(?::([^\]:]+))?\]\]/.exec(prompt);
  const kind = marker?.[1];
  if (kind === "stream")
    return {
      kind,
      words: Number(marker?.[2] ?? 3000),
      chunkMs: Number(marker?.[3] ?? 40),
      key: "",
    };
  if (kind === "hold" || kind === "subagents" || kind === "question")
    return { kind, words: 40, chunkMs: 0, key: marker?.[2] ?? kind };
  if (kind === "fail") return { kind, words: 0, chunkMs: 0, key: "" };
  return { kind: "reply", words: 40, chunkMs: 0, key: "" };
}

async function waitForRelease(sessionId: string, key: string) {
  const file = NodePath.join(controlDir, `release-${key}`);
  while (!cancelled.has(sessionId) && !NodeFS.existsSync(file)) await sleep(100);
}

async function streamText(sessionId: string, text: string, chunkMs: number, messageId: string) {
  const tokens = text.split(/(?<= )/);
  for (let index = 0; index < tokens.length; index += 4) {
    if (cancelled.has(sessionId)) return;
    update(sessionId, {
      sessionUpdate: "agent_message_chunk",
      messageId,
      content: { type: "text", text: tokens.slice(index, index + 4).join("") },
    });
    if (chunkMs > 0) await sleep(chunkMs);
  }
}

async function runPrompt(sessionId: string, prompt: string, turn: number): Promise<object> {
  const script = scriptOf(prompt);
  const messageId = `${sessionId}-m${turn}`;
  if (script.kind === "fail") throw new Error("Scripted provider failure.");
  if (script.kind === "hold") await waitForRelease(sessionId, script.key);
  if (script.kind === "question") {
    const reply = await request("elicitation/create", {
      sessionId,
      mode: "form",
      message: "Which option should I use?",
      requestedSchema: {
        type: "object",
        properties: {
          choice: {
            type: "string",
            title: "Option",
            description: "Which option should I use?",
            enum: ["First", "Second"],
          },
        },
        required: ["choice"],
      },
    });
    if (reply.error) return { stopReason: "cancelled" };
  }
  if (script.kind === "subagents") {
    for (const name of ["one", "two"]) {
      const toolCallId = `${sessionId}-sub-${name}-${turn}`;
      update(sessionId, {
        sessionUpdate: "tool_call",
        toolCallId,
        name: "subagent",
        title: `Subagent · read ${name}`,
        kind: "other",
        status: "pending",
        rawInput: { request: { action: "run", task: `Read file ${name}` } },
      });
      update(sessionId, { sessionUpdate: "tool_call_update", toolCallId, status: "in_progress" });
    }
    await waitForRelease(sessionId, script.key);
    for (const name of ["one", "two"])
      update(sessionId, {
        sessionUpdate: "tool_call_update",
        toolCallId: `${sessionId}-sub-${name}-${turn}`,
        status: "completed",
        content: [
          {
            type: "content",
            // A long reply gives the child thread something to scroll.
            content: {
              type: "text",
              text: JSON.stringify({ ok: true, result: fillerText(1500, turn) }),
            },
          },
        ],
      });
  }
  if (cancelled.has(sessionId)) return { stopReason: "cancelled" };
  await streamText(sessionId, fillerText(script.words, turn), script.chunkMs, messageId);
  return { stopReason: cancelled.has(sessionId) ? "cancelled" : "end_turn" };
}

const turns = new Map<string, number>();

async function handle(message: Message) {
  if (message.method === undefined) {
    if (typeof message.id === "number") pendingReplies.get(message.id)?.(message);
    return;
  }
  const reply = (result: object) => send({ jsonrpc: "2.0", id: message.id, result });
  const params = message.params ?? {};
  const sessionId = typeof params.sessionId === "string" ? params.sessionId : "";
  switch (message.method) {
    case "initialize":
      return reply({
        protocolVersion: 1,
        agentCapabilities: {
          loadSession: true,
          promptCapabilities: { image: true, audio: false, embeddedContext: true },
          mcpCapabilities: { http: true, sse: true, acp: true },
          sessionCapabilities: { list: {}, resume: {}, close: {}, systemPrompt: {} },
        },
        agentInfo: { name: "fx", title: "fx", version: "0.0.14" },
        authMethods: [],
      });
    case "session/new": {
      sessionCount += 1;
      const sessionId = `eval-session-${process.pid}-${sessionCount}`;
      return reply({ sessionId, configOptions, modes });
    }
    case "session/load":
    case "session/resume":
      return reply({ configOptions, modes });
    case "session/set_config_option":
      return reply({ configOptions });
    case "session/cancel":
      cancelled.add(sessionId);
      return;
    case "session/prompt": {
      cancelled.delete(sessionId);
      const turn = (turns.get(sessionId) ?? 0) + 1;
      turns.set(sessionId, turn);
      const blocks = Array.isArray(params.prompt) ? params.prompt : [];
      const text = blocks
        .map((block) =>
          block && typeof block === "object" && !Array.isArray(block) ? block.text : "",
        )
        .filter((value) => typeof value === "string")
        .join("\n");
      try {
        return reply(await runPrompt(sessionId, text, turn));
      } catch (error) {
        return send({
          jsonrpc: "2.0",
          id: message.id,
          error: { code: -32603, message: error instanceof Error ? error.message : String(error) },
        });
      }
    }
    default:
      if (message.id !== undefined) return reply({});
  }
}

function main(args: ReadonlyArray<string>) {
  const probes: Record<string, string> = {
    "--version": "fx 0.0.14",
    status: JSON.stringify({ auth: "eval", model: MODEL }),
    models: JSON.stringify({ ids: [MODEL] }),
  };
  const probe = probes[args[0] ?? ""];
  if (probe !== undefined) return console.log(probe);
  if (args[0] !== "acp") {
    console.error(`fake-fx: unsupported command ${args.join(" ")}`);
    process.exitCode = 2;
    return;
  }
  NodeReadline.createInterface({ input: process.stdin }).on("line", (line) => {
    if (line.trim()) void handle(JSON.parse(line) as Message);
  });
}

if (import.meta.main) main(process.argv.slice(2));
