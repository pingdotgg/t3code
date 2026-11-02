#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalDate:off - A standalone stdio peer with no Effect runtime.

/**
 * A scripted `codex app-server`, so showcase fixtures get real runs from the real server: each
 * turn plays the SHOWCASE_LIVE_THREADS steps whose prompt matches. Frame shapes follow the
 * recorded transcripts in apps/server/src/orchestration-v2/testkit/fixtures.
 */

import * as NodeCrypto from "node:crypto";
import * as NodeReadline from "node:readline";

import { SHOWCASE_LIVE_THREADS, type ShowcaseLiveStep } from "./mobile-showcase-environment.ts";

const VERSION = "0.157.0";
const MODELS = [
  { id: "gpt-5.4", displayName: "GPT-5.4", description: "Flagship model for complex coding work." },
  {
    id: "gpt-5.4-mini",
    displayName: "GPT-5.4 Mini",
    description: "Fast model for everyday edits.",
  },
  {
    id: "gpt-5.3-codex",
    displayName: "GPT-5.3 Codex",
    description: "Tuned for long agentic runs.",
  },
] as const;

type Json =
  | null
  | boolean
  | number
  | string
  | ReadonlyArray<Json>
  | { readonly [key: string]: Json };
type Frame = { readonly [key: string]: Json };

const write = (frame: Frame) => process.stdout.write(`${JSON.stringify(frame)}\n`);
const notify = (method: string, params: Frame) => write({ method, params });
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const nowSeconds = () => Math.floor(Date.now() / 1000);
const newId = (prefix: string) => `${prefix}-${NodeCrypto.randomUUID()}`;

let nextServerRequestId = 0;
let nextProcessId = 4_100;
const pendingServerRequests = new Map<number, (result: Frame) => void>();
const threadCwds = new Map<string, string>();
/** Background commands still running, by process id, so terminate can finish them. */
const backgroundCommands = new Map<string, { threadId: string; turnId: string; item: Frame }>();
const interruptedTurns = new Set<string>();

/** Sends a request to the server and resolves with its id and the server's answer. */
function serverRequest(method: string, params: Frame): Promise<{ id: number; result: Frame }> {
  const id = nextServerRequestId++;
  write({ method, id, params });
  return new Promise((resolve) =>
    pendingServerRequests.set(id, (result) => resolve({ id, result })),
  );
}

function threadPayload(threadId: string, cwd: string, model: string): Frame {
  const now = nowSeconds();
  return {
    id: threadId,
    environments: [{ environmentId: "local", cwd, runtimeWorkspaceRoots: [cwd] }],
    extra: null,
    sessionId: threadId,
    forkedFromId: null,
    parentThreadId: null,
    preview: "",
    ephemeral: false,
    section: null,
    sectionEnteredAt: null,
    projectId: null,
    historyMode: "paginated",
    modelProvider: "openai",
    model,
    reasoningEffort: null,
    createdAt: now,
    updatedAt: now,
    recencyAt: now,
    status: { type: "idle" },
    path: null,
    cwd,
    cliVersion: VERSION,
    originator: "t3code_desktop",
    source: "vscode",
    canAcceptDirectInput: true,
    threadSource: null,
    agentNickname: null,
    agentRole: null,
    gitInfo: null,
    name: null,
    daybreakEnabled: null,
    turns: [],
  };
}

function turnPayload(turnId: string, status: string, startedAt: number | null): Frame {
  return {
    id: turnId,
    items: [],
    itemsView: status === "inProgress" ? "notLoaded" : "summary",
    status,
    error: null,
    startedAt,
    completedAt: status === "inProgress" ? null : nowSeconds(),
    durationMs: null,
  };
}

function commandItem(
  id: string,
  command: string,
  cwd: string,
  options: { readonly processId: string | null; readonly background: boolean },
) {
  return {
    type: "commandExecution",
    id,
    pluginId: null,
    scriptPath: null,
    command: `/bin/zsh -lc ${JSON.stringify(command)}`,
    cwd,
    processId: options.processId,
    source: options.background ? "unifiedExecStartup" : "agent",
    status: "inProgress",
    commandActions: [{ type: "unknown", command }],
    aggregatedOutput: null,
    exitCode: null,
    durationMs: null,
  };
}

/** Plays one scripted turn. Returns when the turn completes, or never for a held stream. */
async function playTurn(threadId: string, turnId: string, prompt: string, cwd: string) {
  const startedAt = nowSeconds();
  const turn = { threadId, turnId };
  const stopped = () => interruptedTurns.has(turnId);
  notify("thread/status/changed", { threadId, status: { type: "active", activeFlags: [] } });
  notify("turn/started", { threadId, turn: turnPayload(turnId, "inProgress", startedAt) });
  const userItem = {
    type: "userMessage",
    id: newId("user"),
    clientId: null,
    content: [{ type: "text", text: prompt, text_elements: [] }],
  };
  notify("item/started", { ...turn, item: userItem, startedAtMs: Date.now() });
  notify("item/completed", { ...turn, item: userItem, completedAtMs: Date.now() });

  const script = SHOWCASE_LIVE_THREADS.find((thread) => thread.prompt === prompt.trim())?.steps ?? [
    { type: "message", text: "On it. I will report back here when the change is ready." } as const,
  ];
  for (const step of script) {
    if (stopped()) return;
    await playStep(step, turn, cwd);
  }
  if (stopped()) return;
  notify("thread/status/changed", { threadId, status: { type: "idle" } });
  notify("turn/completed", { threadId, turn: turnPayload(turnId, "completed", startedAt) });
}

async function playStep(
  step: ShowcaseLiveStep,
  turn: { readonly threadId: string; readonly turnId: string },
  cwd: string,
) {
  switch (step.type) {
    case "message": {
      const item = {
        type: "agentMessage",
        id: newId("msg"),
        text: "",
        phase: step.phase ?? "final_answer",
        memoryCitation: null,
        delivery: null,
        questions: null,
      };
      notify("item/started", { ...turn, item, startedAtMs: Date.now() });
      // Whole lines keep markdown blocks intact while the text streams.
      const chunks = step.text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
      const shown = step.hold ? chunks.slice(0, Math.ceil(chunks.length * 0.6)) : chunks;
      for (const delta of shown) {
        notify("item/agentMessage/delta", { ...turn, itemId: item.id, delta });
        await sleep(25);
      }
      // A held message keeps streaming until the turn is interrupted.
      if (step.hold) await new Promise(() => undefined);
      notify("item/completed", {
        ...turn,
        item: { ...item, text: step.text },
        completedAtMs: Date.now(),
      });
      return;
    }
    case "command": {
      const processId = step.background ? String(nextProcessId++) : null;
      const item = commandItem(newId("exec"), step.command, cwd, {
        processId,
        background: step.background === true,
      });
      notify("item/started", { ...turn, item, startedAtMs: Date.now() });
      notify("item/commandExecution/outputDelta", { ...turn, itemId: item.id, delta: step.output });
      if (step.background && processId) {
        backgroundCommands.set(processId, {
          ...turn,
          item: { ...item, aggregatedOutput: step.output },
        });
        return;
      }
      // Real time, capped, so "Worked for" reads like a real run without slowing fixtures down.
      await sleep(Math.min(step.durationMs ?? 1_200, 2_500));
      notify("item/completed", {
        ...turn,
        item: {
          ...item,
          status: "completed",
          aggregatedOutput: step.output,
          exitCode: step.exitCode ?? 0,
          durationMs: step.durationMs ?? 1_200,
        },
        completedAtMs: Date.now(),
      });
      return;
    }
    case "fileChange": {
      const item = {
        type: "fileChange",
        id: newId("patch"),
        changes: step.changes.map((change) => ({
          path: `${cwd}/${change.path}`,
          kind: change.kind === "add" ? { type: "add" } : { type: "update", move_path: null },
          diff: change.diff,
        })),
        status: "inProgress",
      };
      notify("item/started", { ...turn, item, startedAtMs: Date.now() });
      await sleep(40);
      notify("item/completed", {
        ...turn,
        item: { ...item, status: "completed" },
        completedAtMs: Date.now(),
      });
      return;
    }
    case "approval": {
      const item = commandItem(newId("exec"), step.command, cwd, {
        processId: null,
        background: false,
      });
      notify("item/started", { ...turn, item, startedAtMs: Date.now() });
      const { id: requestId, result } = await serverRequest(
        "item/commandExecution/requestApproval",
        {
          kind: "command",
          ...turn,
          itemId: item.id,
          startedAtMs: Date.now(),
          environmentId: "local",
          reason: step.reason,
          command: item.command,
          cwd,
          commandActions: item.commandActions,
          proposedExecpolicyAmendment: null,
          availableDecisions: ["accept", "acceptForSession", "decline"],
        },
      );
      notify("serverRequest/resolved", { threadId: turn.threadId, requestId });
      const accepted = result.decision === "accept" || result.decision === "acceptForSession";
      notify("item/completed", {
        ...turn,
        item: accepted
          ? {
              ...item,
              status: "completed",
              aggregatedOutput: step.output,
              exitCode: 0,
              durationMs: 900,
            }
          : { ...item, status: "declined" },
        completedAtMs: Date.now(),
      });
      return;
    }
    case "question": {
      const { id: requestId } = await serverRequest("item/tool/requestUserInput", {
        ...turn,
        itemId: newId("call"),
        questions: step.questions.map((question) => ({
          ...question,
          isOther: false,
          isSecret: false,
        })),
        isBlocking: true,
        autoResolutionMs: null,
      });
      notify("serverRequest/resolved", { threadId: turn.threadId, requestId });
      return;
    }
  }
}

function respond(id: Json, result: Json) {
  write({ id, result });
}

function handleRequest(id: Json, method: string, params: Frame) {
  switch (method) {
    case "initialize":
      return respond(id, {
        userAgent: `T3 Showcase/${VERSION} (Mac OS 26.0.0; arm64)`,
        codexHome: process.env.CODEX_HOME ?? process.cwd(),
        platformFamily: "unix",
        platformOs: "macos",
      });
    case "account/read":
      return respond(id, { account: { type: "apiKey" }, requiresOpenaiAuth: false });
    case "model/list":
      return respond(id, {
        data: MODELS.map((model, index) => ({
          ...model,
          model: model.id,
          hidden: false,
          isDefault: index === 0,
          defaultReasoningEffort: "medium",
          supportedReasoningEfforts: ["low", "medium", "high", "xhigh"].map((effort) => ({
            reasoningEffort: effort,
            description: `${effort[0]?.toUpperCase()}${effort.slice(1)} reasoning`,
          })),
          inputModalities: ["text", "image"],
        })),
        nextCursor: null,
      });
    case "skills/list":
      return respond(id, { data: [] });
    case "config/read":
      return respond(id, { config: {}, origins: {} });
    case "thread/start":
    case "thread/resume": {
      const threadId = typeof params.threadId === "string" ? params.threadId : newId("thread");
      const cwd = typeof params.cwd === "string" ? params.cwd : process.cwd();
      const model = typeof params.model === "string" ? params.model : MODELS[0].id;
      threadCwds.set(threadId, cwd);
      const thread = threadPayload(threadId, cwd, model);
      respond(id, {
        thread,
        model,
        modelProvider: "openai",
        serviceTier: null,
        disabledPluginIds: [],
        cwd,
        runtimeWorkspaceRoots: [cwd],
        instructionSources: [],
        approvalPolicy: "on-request",
        approvalsReviewer: "user",
        sandbox: {
          type: "workspaceWrite",
          writableRoots: [],
          networkAccess: false,
          excludeTmpdirEnvVar: false,
          excludeSlashTmp: false,
        },
        activePermissionProfile: { id: ":workspace", extends: null },
        reasoningEffort: null,
        multiAgentMode: "explicitRequestOnly",
      });
      return notify("thread/started", { thread });
    }
    case "turn/start": {
      const threadId = String(params.threadId);
      const turnId = newId("turn");
      const input = Array.isArray(params.input) ? params.input : [];
      const prompt = input
        .map((entry) =>
          entry && typeof entry === "object" && "text" in entry ? String(entry.text) : "",
        )
        .join("\n");
      respond(id, { turn: turnPayload(turnId, "inProgress", null) });
      void playTurn(threadId, turnId, prompt, threadCwds.get(threadId) ?? process.cwd());
      return;
    }
    case "turn/interrupt": {
      const threadId = String(params.threadId);
      const turnId = String(params.turnId);
      interruptedTurns.add(turnId);
      respond(id, {});
      notify("thread/status/changed", { threadId, status: { type: "idle" } });
      return notify("turn/completed", { threadId, turn: turnPayload(turnId, "interrupted", null) });
    }
    case "thread/backgroundTerminals/list":
      return respond(id, {
        data: [...backgroundCommands.keys()].map((processId) => ({ processId })),
        nextCursor: null,
      });
    case "thread/backgroundTerminals/terminate": {
      const processId = String(params.processId);
      const running = backgroundCommands.get(processId);
      backgroundCommands.delete(processId);
      respond(id, { terminated: true });
      if (running) {
        notify("item/completed", {
          threadId: running.threadId,
          turnId: running.turnId,
          item: { ...running.item, status: "completed", exitCode: 143, durationMs: 60_000 },
          completedAtMs: Date.now(),
        });
      }
      return;
    }
    default:
      return write({ id, error: { code: -32601, message: `${method} is not scripted.` } });
  }
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes("--version")) {
    process.stdout.write(`codex-cli ${VERSION}\n`);
    return;
  }
  if (args[0] !== "app-server" || args.includes("--help"))
    process.exit(args.includes("--help") ? 0 : 1);
  const lines = NodeReadline.createInterface({ input: process.stdin });
  lines.on("line", (line) => {
    if (!line.trim()) return;
    const frame = JSON.parse(line) as Frame;
    const { id, method } = frame;
    if (typeof method === "string") {
      if (id !== undefined) handleRequest(id, method, (frame.params ?? {}) as Frame);
      return;
    }
    // A response to one of this peer's requests.
    if (typeof id === "number") {
      pendingServerRequests.get(id)?.((frame.result ?? {}) as Frame);
      pendingServerRequests.delete(id);
    }
  });
  lines.on("close", () => process.exit(0));
}

main();
