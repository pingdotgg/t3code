// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off globalDate:off globalConsole:off - stdlib-only fake CLI, outside any Effect runtime.
/**
 * Deterministic stand-in for the Codex CLI, so e2e runs exercise real provider turns
 * without credentials or model calls. Every frame is typed against the generated
 * app-server protocol, so a protocol change fails `tsc` here instead of drifting.
 * Prompts follow the shared rules in ../scenario.ts.
 *
 * Requests it does not serve get JSON-RPC "method not found", so a newly required
 * method surfaces as a provider error instead of an empty success.
 */
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeReadline from "node:readline";

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

import type {
  ClientRequestParamsByMethod,
  ClientRequestResponsesByMethod,
  ServerNotificationParamsByMethod,
  ServerRequestParamsByMethod,
  ServerRequestResponsesByMethod,
  V2ItemStartedNotification,
  V2TurnStartResponse,
} from "effect-codex-app-server/schema";

type Item = V2ItemStartedNotification["item"];
type TurnSnapshot = V2TurnStartResponse["turn"];
type TurnStatus = TurnSnapshot["status"];

const VERSION = "0.200.0";
const MODEL = "gpt-6-luna";

const [command, ...rest] = process.argv.slice(2);
if (command === "--version") {
  process.stdout.write(`codex-cli ${VERSION}\n`);
} else if (command === "exec") {
  runExec(rest);
} else if (command === "app-server" && rest.includes("--help")) {
  process.stdout.write("Usage: codex app-server\n");
} else if (command === "app-server") {
  runAppServer();
} else {
  process.stderr.write(`fake codex: unsupported command ${command ?? "(none)"}\n`);
  process.exit(2);
}

/**
 * Answers `codex exec`, which the server uses for thread titles and commit messages, by
 * writing a value matching `--output-schema` to `--output-last-message`.
 */
function runExec(args: ReadonlyArray<string>) {
  const schemaPath = flagValue(args, "--output-schema");
  const outputPath = flagValue(args, "--output-last-message");
  if (schemaPath === undefined || outputPath === undefined) {
    throw new Error("fake codex exec: missing --output-schema or --output-last-message");
  }
  const schema: JsonSchema = JSON.parse(NodeFS.readFileSync(schemaPath, "utf8"));
  const prompt = NodeFS.readFileSync(0, "utf8");
  NodeFS.writeFileSync(outputPath, JSON.stringify(textGenerationOutput(schema, prompt)));
}

interface Turn {
  readonly id: string;
  readonly threadId: string;
  readonly cwd: string;
  readonly startedAt: number;
  readonly commandItemId: string;
  done: boolean;
}

/** Serves the JSON-RPC app-server protocol on stdio. */
function runAppServer() {
  const write = (message: unknown) => process.stdout.write(`${JSON.stringify(message)}\n`);
  const notify = <M extends keyof ServerNotificationParamsByMethod>(
    method: M,
    params: ServerNotificationParamsByMethod[M],
  ) => write({ method, params });
  const now = () => Math.floor(Date.now() / 1000);
  const id = () => NodeCrypto.randomUUID();
  const threads = new Map<string, { cwd: string; activeTurn?: Turn }>();
  const pendingApprovals = new Map<number, { turn: Turn; fileName: string }>();
  let nextServerRequestId = 0;

  const request = <M extends keyof ServerRequestParamsByMethod>(
    method: M,
    params: ServerRequestParamsByMethod[M],
  ) => {
    const requestId = nextServerRequestId++;
    write({ id: requestId, method, params });
    return requestId;
  };

  const threadSession = (threadId: string, cwd: string) =>
    ({
      thread: {
        id: threadId,
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
        model: MODEL,
        reasoningEffort: null,
        createdAt: now(),
        updatedAt: now(),
        recencyAt: now(),
        status: { type: "idle" },
        path: null,
        cwd,
        cliVersion: VERSION,
        originator: "t3code_desktop",
        source: "vscode",
        threadSource: null,
        agentNickname: null,
        agentRole: null,
        gitInfo: null,
        name: null,
        turns: [],
      },
      model: MODEL,
      modelProvider: "openai",
      serviceTier: null,
      disabledPluginIds: [],
      cwd,
      instructionSources: [],
      approvalPolicy: "on-request",
      approvalsReviewer: "user",
      sandbox: { type: "dangerFullAccess" },
      reasoningEffort: null,
    }) satisfies ClientRequestResponsesByMethod["thread/start"] &
      ClientRequestResponsesByMethod["thread/resume"];

  const turnSnapshot = (
    turn: Turn,
    status: TurnStatus,
    items: TurnSnapshot["items"] = [],
  ): TurnSnapshot => ({
    id: turn.id,
    items,
    itemsView: items.length === 0 ? "notLoaded" : "summary",
    status,
    error: null,
    startedAt: turn.startedAt,
    completedAt: status === "inProgress" ? null : now(),
    durationMs: null,
  });

  const setStatus = (turn: Turn, active: boolean, waitingOnApproval = false) =>
    notify("thread/status/changed", {
      threadId: turn.threadId,
      status: active
        ? { type: "active", activeFlags: waitingOnApproval ? ["waitingOnApproval"] : [] }
        : { type: "idle" },
    });

  const itemStarted = (turn: Turn, item: Item) =>
    notify("item/started", {
      item,
      threadId: turn.threadId,
      turnId: turn.id,
      startedAtMs: Date.now(),
    });

  const itemCompleted = (turn: Turn, item: Item) =>
    notify("item/completed", {
      item,
      threadId: turn.threadId,
      turnId: turn.id,
      completedAtMs: Date.now(),
    });

  const agentMessage = (turn: Turn, text: string) => {
    const itemId = `msg_${id()}`;
    const item = (body: string): Item => ({
      type: "agentMessage",
      id: itemId,
      text: body,
      phase: "final_answer",
      memoryCitation: null,
      delivery: null,
      questions: null,
    });
    itemStarted(turn, item(""));
    for (const delta of text.match(/\S+\s*/g) ?? []) {
      notify("item/agentMessage/delta", {
        threadId: turn.threadId,
        turnId: turn.id,
        itemId,
        delta,
      });
    }
    const completed = item(text);
    itemCompleted(turn, completed);
    return completed;
  };

  const completeTurn = (turn: Turn, status: TurnStatus, items: TurnSnapshot["items"] = []) => {
    if (turn.done) return;
    turn.done = true;
    setStatus(turn, false);
    notify("turn/completed", { threadId: turn.threadId, turn: turnSnapshot(turn, status, items) });
  };

  const commandItem = (
    turn: Turn,
    fileName: string,
    status: "inProgress" | "completed" | "declined",
  ): Item => ({
    type: "commandExecution",
    id: turn.commandItemId,
    pluginId: null,
    scriptPath: null,
    command: `/bin/sh -c "${writeCommand(fileName)}"`,
    cwd: turn.cwd,
    processId: null,
    source: "agent",
    status,
    commandActions: [{ type: "unknown", command: writeCommand(fileName) }],
    aggregatedOutput: status === "completed" ? "" : null,
    exitCode: status === "completed" ? 0 : null,
    durationMs: status === "inProgress" ? null : 1,
  });

  const runWrite = (turn: Turn, fileName: string) => {
    writeScenarioFile(turn.cwd, fileName);
    itemCompleted(turn, commandItem(turn, fileName, "completed"));
    completeTurn(turn, "completed", [agentMessage(turn, `Wrote ${fileName}.`)]);
  };

  /** Answers `turn/start`, then plays the turn's notifications right after the response. */
  const startTurn = (
    params: ClientRequestParamsByMethod["turn/start"],
  ): ClientRequestResponsesByMethod["turn/start"] => {
    const prompt = params.input
      .flatMap((part) => (part.type === "text" ? [part.text] : []))
      .join("\n");
    const thread = threads.get(params.threadId) ?? { cwd: params.cwd ?? process.cwd() };
    threads.set(params.threadId, thread);
    const turn: Turn = {
      id: id(),
      threadId: params.threadId,
      cwd: params.cwd ?? thread.cwd,
      startedAt: now(),
      commandItemId: `exec-${id()}`,
      done: false,
    };
    thread.activeTurn = turn;
    const response = { turn: turnSnapshot(turn, "inProgress") };

    queueMicrotask(() => {
      setStatus(turn, true);
      notify("turn/started", { threadId: turn.threadId, turn: turnSnapshot(turn, "inProgress") });
      const userItem: Item = {
        type: "userMessage",
        id: id(),
        clientId: null,
        content: [{ type: "text", text: prompt, text_elements: [] }],
      };
      itemStarted(turn, userItem);
      itemCompleted(turn, userItem);

      const scenario = scenarioFor(prompt);
      if (scenario.kind === "wait") {
        agentMessage(turn, WAITING_TEXT);
        return;
      }
      if (scenario.kind === "reply") {
        completeTurn(turn, "completed", [agentMessage(turn, replyText("Codex", prompt))]);
        return;
      }
      const { fileName } = scenario;
      itemStarted(turn, commandItem(turn, fileName, "inProgress"));
      if (params.approvalPolicy === "never") {
        runWrite(turn, fileName);
        return;
      }
      setStatus(turn, true, true);
      const pending = commandItem(turn, fileName, "inProgress");
      const approvalId = request("item/commandExecution/requestApproval", {
        kind: "command",
        threadId: turn.threadId,
        turnId: turn.id,
        itemId: turn.commandItemId,
        startedAtMs: Date.now(),
        environmentId: "local",
        reason: `May I write ${fileName}?`,
        command: pending.type === "commandExecution" ? pending.command : null,
        cwd: turn.cwd,
        commandActions: [{ type: "unknown", command: writeCommand(fileName) }],
      });
      pendingApprovals.set(approvalId, { turn, fileName });
    });
    return response;
  };

  const resolveApproval = (
    approvalId: number,
    result: ServerRequestResponsesByMethod["item/commandExecution/requestApproval"],
  ) => {
    const pending = pendingApprovals.get(approvalId);
    if (pending === undefined) return;
    pendingApprovals.delete(approvalId);
    const { turn, fileName } = pending;
    notify("serverRequest/resolved", { threadId: turn.threadId, requestId: approvalId });
    setStatus(turn, true);
    const decision = result.decision;
    if (decision === "accept" || decision === "acceptForSession" || typeof decision === "object") {
      runWrite(turn, fileName);
      return;
    }
    itemCompleted(turn, commandItem(turn, fileName, "declined"));
    completeTurn(turn, "completed", [agentMessage(turn, `Okay, I did not write ${fileName}.`)]);
  };

  const handlers: {
    readonly [M in keyof ClientRequestResponsesByMethod]?: (
      params: ClientRequestParamsByMethod[M],
    ) => ClientRequestResponsesByMethod[M];
  } = {
    initialize: () => ({
      userAgent: `codex_cli_rs/${VERSION} (fake) e2e`,
      codexHome: NodePath.join(NodeOS.homedir(), ".codex"),
      platformFamily: "unix",
      platformOs: NodeOS.type() === "Darwin" ? "macos" : "linux",
    }),
    "account/read": () => ({ account: { type: "apiKey" }, requiresOpenaiAuth: false }),
    "model/list": () => ({
      data: [
        {
          id: MODEL,
          model: MODEL,
          displayName: "GPT-6 Luna",
          description: "Fake model served by the e2e suite.",
          hidden: false,
          isDefault: true,
          defaultReasoningEffort: "medium",
          supportedReasoningEfforts: [
            { reasoningEffort: "low", description: "Fast" },
            { reasoningEffort: "medium", description: "Balanced" },
          ],
        },
      ],
      nextCursor: null,
    }),
    "skills/list": () => ({ data: [] }),
    "thread/start": (params) => {
      const threadId = id();
      const cwd = params.cwd ?? process.cwd();
      threads.set(threadId, { cwd });
      return threadSession(threadId, cwd);
    },
    "thread/resume": (params) => {
      const cwd = params.cwd ?? threads.get(params.threadId)?.cwd ?? process.cwd();
      threads.set(params.threadId, { cwd });
      return threadSession(params.threadId, cwd);
    },
    "thread/unsubscribe": () => ({ status: "unsubscribed" }),
    "turn/start": startTurn,
    "turn/interrupt": (params) => {
      const turn = threads.get(params.threadId)?.activeTurn;
      if (turn) queueMicrotask(() => completeTurn(turn, "interrupted"));
      return {};
    },
  };

  NodeReadline.createInterface({ input: process.stdin }).on("line", (line) => {
    const message: { id?: number; method?: string; params?: unknown; result?: unknown } =
      JSON.parse(line);
    if (message.method === undefined) {
      if (message.id !== undefined) {
        resolveApproval(
          message.id,
          message.result as ServerRequestResponsesByMethod["item/commandExecution/requestApproval"],
        );
      }
      return;
    }
    if (message.id === undefined) return;
    const handler = handlers[message.method as keyof ClientRequestResponsesByMethod] as
      | ((params: unknown) => unknown)
      | undefined;
    if (handler === undefined) {
      write({
        id: message.id,
        error: { code: -32601, message: `fake codex: method not found: ${message.method}` },
      });
      return;
    }
    write({ id: message.id, result: handler(message.params ?? {}) });
  });
}
