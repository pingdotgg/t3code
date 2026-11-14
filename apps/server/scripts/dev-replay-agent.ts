#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalTimers:off
/**
 * A free ACP agent for dev servers. It plays recorded ACP transcripts with simulated
 * streaming, so the real adapter, orchestration, and UI run without a paid model.
 * Each scenario is a "model"; each prompt plays the next recorded turn.
 * Unlike acp-replay-agent.ts, it does not assert the client's frames.
 */
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeReadline from "node:readline";

interface LogicalFrame {
  readonly kind: "notification" | "request" | "response";
  readonly method: string;
  readonly params?: unknown;
  readonly result?: unknown;
}

interface ReplayEntry {
  readonly type: "emit_inbound" | "expect_outbound" | "runtime_exit" | "transcript_start";
  readonly frame?: LogicalFrame;
  readonly afterMs?: number;
}

interface JsonRpcMessage {
  readonly jsonrpc?: string;
  readonly id?: string | number | null;
  readonly method?: string;
  readonly params?: Record<string, unknown>;
  readonly result?: unknown;
  readonly error?: unknown;
}

export interface ReplayTurn {
  /** Frames the agent sends: session updates and agent-to-client requests. */
  readonly frames: ReadonlyArray<{ readonly frame: LogicalFrame; readonly afterMs?: number }>;
  readonly stopReason: string;
}

const FIXTURES = "../src/orchestration-v2/testkit/fixtures";

// Recorded fixtures the replay tests already pin, plus a hand-written UI showcase.
// Use acpRegistry transcripts: vendor transcripts carry state in frames this agent drops.
export const SCENARIOS = [
  { id: "showcase", name: "Showcase", file: "./dev-replay/showcase_transcript.ndjson" },
  {
    id: "todo-list",
    name: "Plan and reads",
    file: `${FIXTURES}/todo_list/registry_transcript.ndjson`,
  },
  {
    id: "approval",
    name: "Write approval",
    file: `${FIXTURES}/tool_call_read_only_on_request/registry_transcript.ndjson`,
  },
  {
    id: "question",
    name: "Question",
    file: `${FIXTURES}/acp_elicitation/registry_transcript.ndjson`,
  },
  {
    id: "multi-turn",
    name: "Multi turn",
    file: `${FIXTURES}/multi_turn/registry_transcript.ndjson`,
  },
] as const;

// Session setup and vendor state stay out: they would replace the replay agent's own models.
const REPLAYED_UPDATES = new Set([
  "agent_message_chunk",
  "agent_thought_chunk",
  "tool_call",
  "tool_call_update",
  "plan",
  "plan_update",
  "plan_removed",
  "session_info_update",
  "usage_update",
]);

// Only requests that ask the user. A replayed terminal/create would run a real command.
const REPLAYED_REQUESTS = new Set(["session/request_permission", "elicitation/create"]);

const CHUNK_DELAY_MS = 30;
const FRAME_DELAY_MS = 250;
const MAX_RECORDED_DELAY_MS = 2_000;
const WORDS_PER_CHUNK = 3;

function isReplayedFrame(frame: LogicalFrame): boolean {
  if (frame.kind === "request") return REPLAYED_REQUESTS.has(frame.method);
  if (frame.kind !== "notification" || frame.method !== "session/update") return false;
  const update = (frame.params as { update?: { sessionUpdate?: unknown } } | undefined)?.update;
  return typeof update?.sessionUpdate === "string" && REPLAYED_UPDATES.has(update.sessionUpdate);
}

/** Splits a recorded transcript into the turns that follow each `session/prompt`. */
export function parseReplayTurns(ndjson: string): ReadonlyArray<ReplayTurn> {
  const turns: Array<{ frames: Array<ReplayTurn["frames"][number]>; stopReason: string }> = [];
  // Frames after a prompt's response belong to background work, not to that turn.
  let turn: (typeof turns)[number] | undefined;
  for (const line of ndjson.split("\n")) {
    if (line.trim().length === 0) continue;
    const entry = JSON.parse(line) as ReplayEntry;
    const frame = entry.frame;
    if (frame === undefined) continue;
    if (
      entry.type === "expect_outbound" &&
      frame.kind === "request" &&
      frame.method === "session/prompt"
    ) {
      turn = { frames: [], stopReason: "end_turn" };
      turns.push(turn);
      continue;
    }
    if (entry.type !== "emit_inbound" || turn === undefined) continue;
    if (frame.kind === "response" && frame.method === "session/prompt") {
      const stopReason = (frame.result as { stopReason?: unknown } | undefined)?.stopReason;
      if (typeof stopReason === "string") turn.stopReason = stopReason;
      turn = undefined;
      continue;
    }
    if (isReplayedFrame(frame)) {
      turn.frames.push(entry.afterMs === undefined ? { frame } : { frame, afterMs: entry.afterMs });
    }
  }
  return turns;
}

/** Splits streamed text into small chunks so the client sees real deltas. */
export function streamChunks(text: string): ReadonlyArray<string> {
  const words = text.match(/\S+\s*|\s+/g) ?? [];
  const chunks: Array<string> = [];
  for (let index = 0; index < words.length; index += WORDS_PER_CHUNK) {
    chunks.push(words.slice(index, index + WORDS_PER_CHUNK).join(""));
  }
  return chunks.length === 0 ? [text] : chunks;
}

/** Fills the live session, workspace, and per-prompt tool ids, so repeated turns add rows. */
function materialize(
  value: unknown,
  live: { readonly sessionId: string; readonly workspace: string; readonly turnKey: string },
): unknown {
  if (typeof value === "string") return value.replaceAll("<workspace>", live.workspace);
  if (Array.isArray(value)) return value.map((entry) => materialize(entry, live));
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      key,
      key === "sessionId"
        ? live.sessionId
        : key === "toolCallId"
          ? `${live.turnKey}-${String(entry)}`
          : materialize(entry, live),
    ]),
  );
}

/** The tool call a permission answer rejected, if the user declined or cancelled. */
function permissionRejectedToolCallId(request: LogicalFrame, answer: unknown): string | undefined {
  if (request.method !== "session/request_permission") return undefined;
  const params = request.params as {
    toolCall?: { toolCallId?: string };
    options?: ReadonlyArray<{ optionId: string; kind: string }>;
  };
  const outcome = (answer as { outcome?: { outcome?: string; optionId?: string } } | undefined)
    ?.outcome;
  const chosen = params.options?.find((option) => option.optionId === outcome?.optionId);
  const rejected = outcome?.outcome !== "selected" || chosen?.kind.startsWith("reject") === true;
  return rejected ? params.toolCall?.toolCallId : undefined;
}

function runAgent(): void {
  const turnsByScenario = new Map<string, ReadonlyArray<ReplayTurn>>();
  const loadTurns = (scenarioId: string) => {
    const cached = turnsByScenario.get(scenarioId);
    if (cached !== undefined) return cached;
    const scenario = SCENARIOS.find((candidate) => candidate.id === scenarioId) ?? SCENARIOS[0];
    const turns = parseReplayTurns(
      NodeFS.readFileSync(new URL(scenario.file, import.meta.url), "utf8"),
    );
    turnsByScenario.set(scenarioId, turns);
    return turns;
  };

  const sessions = new Map<
    string,
    { cwd: string; model: string; promptCount: number; cancel: (() => void) | undefined }
  >();
  const pendingAgentRequests = new Map<string, (result: unknown) => void>();
  let nextAgentRequestId = 1;

  const send = (message: JsonRpcMessage) =>
    process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
  // Resolves when `promise` settles or the turn is cancelled, whichever comes first.
  const untilAbort = (promise: Promise<unknown>, signal: AbortSignal) =>
    new Promise<void>((resolve) => {
      if (signal.aborted) return resolve();
      const onAbort = () => resolve();
      signal.addEventListener("abort", onAbort, { once: true });
      void promise.then(() => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      });
    });
  const sleep = (ms: number, signal: AbortSignal) =>
    untilAbort(
      new Promise((resolve) => setTimeout(resolve, Math.min(ms, MAX_RECORDED_DELAY_MS))),
      signal,
    );

  const playTurn = async (
    sessionId: string,
    turn: ReplayTurn,
    signal: AbortSignal,
  ): Promise<"cancelled" | undefined> => {
    const session = sessions.get(sessionId)!;
    // Random, so a session loaded after a restart cannot reuse earlier tool rows.
    const live = { sessionId, workspace: session.cwd, turnKey: NodeCrypto.randomUUID() };
    for (const recorded of turn.frames) {
      const frame = materialize(recorded.frame, live) as LogicalFrame;
      if (frame.kind === "request") {
        await sleep(recorded.afterMs ?? FRAME_DELAY_MS, signal);
        if (signal.aborted) return;
        const id = nextAgentRequestId++;
        let answer: unknown;
        const response = new Promise((resolve) =>
          pendingAgentRequests.set(String(id), (result) => resolve((answer = result))),
        );
        send({ id, method: frame.method, params: frame.params as Record<string, unknown> });
        await untilAbort(response, signal);
        pendingAgentRequests.delete(String(id));
        // The client answers "cancelled" when the user stops the turn mid-request.
        const outcome = (answer as { outcome?: { outcome?: string } } | undefined)?.outcome;
        if (signal.aborted || outcome?.outcome === "cancelled") return "cancelled";
        const toolCallId = permissionRejectedToolCallId(frame, answer);
        if (toolCallId === undefined) continue;
        // The recording only has the approved path, so a rejection ends the turn here.
        send({
          method: "session/update",
          params: {
            sessionId,
            update: { sessionUpdate: "tool_call_update", toolCallId, status: "failed" },
          },
        });
        return;
      }
      const params = frame.params as { update: { sessionUpdate: string; content?: unknown } };
      const content = params.update.content as { type?: string; text?: string } | undefined;
      const text =
        (params.update.sessionUpdate === "agent_message_chunk" ||
          params.update.sessionUpdate === "agent_thought_chunk") &&
        content?.type === "text"
          ? content.text
          : undefined;
      // Live recordings hold one frame per token, so text defaults to the chunk pace.
      const firstDelay = recorded.afterMs ?? (text === undefined ? FRAME_DELAY_MS : CHUNK_DELAY_MS);
      const chunks = text === undefined ? [undefined] : streamChunks(text);
      for (const [index, chunk] of chunks.entries()) {
        await sleep(index === 0 ? firstDelay : CHUNK_DELAY_MS, signal);
        if (signal.aborted) return;
        send({
          method: frame.method,
          params:
            chunk === undefined
              ? params
              : { ...params, update: { ...params.update, content: { ...content, text: chunk } } },
        });
      }
    }
  };

  const handleRequest = async (message: JsonRpcMessage): Promise<unknown> => {
    const params = message.params ?? {};
    switch (message.method) {
      case "initialize":
        return {
          protocolVersion: 1,
          agentCapabilities: {
            loadSession: true,
            promptCapabilities: { image: false, audio: false, embeddedContext: true },
          },
          authMethods: [],
          agentInfo: { name: "t3-dev-replay", version: "1" },
        };
      case "session/new":
      case "session/load": {
        // T3 starts one agent process per thread, so ids must be unique across processes.
        // Loading after a restart keeps the thread usable; T3 already holds its history.
        const sessionId =
          message.method === "session/load" ? String(params.sessionId) : NodeCrypto.randomUUID();
        const cwd = typeof params.cwd === "string" ? params.cwd : process.cwd();
        sessions.set(sessionId, { cwd, model: SCENARIOS[0].id, promptCount: 0, cancel: undefined });
        return {
          ...(message.method === "session/new" ? { sessionId } : {}),
          models: {
            currentModelId: SCENARIOS[0].id,
            availableModels: SCENARIOS.map((scenario) => ({
              modelId: scenario.id,
              name: scenario.name,
            })),
          },
        };
      }
      case "session/set_model": {
        const session = sessions.get(String(params.sessionId));
        if (!SCENARIOS.some((scenario) => scenario.id === params.modelId)) {
          throw Object.assign(new Error(`Unknown replay scenario ${String(params.modelId)}`), {
            code: -32602,
          });
        }
        if (session !== undefined && session.model !== params.modelId) {
          session.model = String(params.modelId);
          session.promptCount = 0;
        }
        return {};
      }
      case "session/prompt": {
        const sessionId = String(params.sessionId);
        const session = sessions.get(sessionId);
        if (session === undefined) throw new Error(`Unknown session ${sessionId}`);
        const turns = loadTurns(session.model);
        const turn = turns[session.promptCount % Math.max(turns.length, 1)];
        session.promptCount += 1;
        const controller = new AbortController();
        session.cancel = () => controller.abort();
        let ended: "cancelled" | undefined;
        try {
          if (turn !== undefined) ended = await playTurn(sessionId, turn, controller.signal);
        } finally {
          session.cancel = undefined;
        }
        return {
          stopReason:
            controller.signal.aborted || ended === "cancelled"
              ? "cancelled"
              : (turn?.stopReason ?? "end_turn"),
        };
      }
      case "session/close":
        sessions.get(String(params.sessionId))?.cancel?.();
        sessions.delete(String(params.sessionId));
        return {};
      case "authenticate":
      case "session/set_mode":
        return {};
      default:
        throw Object.assign(new Error(`Method not found: ${message.method}`), { code: -32601 });
    }
  };

  const input = NodeReadline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  input.on("line", (line) => {
    if (line.trim().length === 0) return;
    let message: JsonRpcMessage;
    try {
      message = JSON.parse(line) as JsonRpcMessage;
    } catch {
      process.stderr.write(`dev replay agent ignored a line that is not JSON\n`);
      return;
    }
    if (message.method === undefined) {
      const resolve = pendingAgentRequests.get(String(message.id));
      pendingAgentRequests.delete(String(message.id));
      resolve?.(message.result);
      return;
    }
    if (message.id === undefined || message.id === null) {
      if (message.method === "session/cancel") {
        sessions.get(String(message.params?.sessionId))?.cancel?.();
      }
      return;
    }
    const id = message.id;
    handleRequest(message).then(
      (result) => send({ id, result }),
      (error: Error & { code?: number }) =>
        send({ id, error: { code: error.code ?? -32603, message: error.message } }),
    );
  });
}

if (import.meta.main) runAgent();
