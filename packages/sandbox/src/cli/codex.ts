#!/usr/bin/env bun

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Console from "effect/Console";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { Command, Flag } from "effect/unstable/cli";

import {
  CodexService,
  CodexServiceLive,
  type CodexLiveEvent,
  DaytonaClientLive,
  SandboxServiceLive,
  TerminalServiceLive,
  type CodexCompletedTurn,
  type TerminalCleanupError,
} from "../index";
import { version } from "../../package.json" with { type: "json" };

class CodexCliError extends Data.TaggedError("CodexCliError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

function formatUnknownError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  if (typeof error === "object" && error !== null && "message" in error) {
    const message = error.message;
    if (typeof message === "string") {
      return message;
    }
  }

  return String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

function readArray(record: Record<string, unknown>, key: string): readonly unknown[] {
  const value = record[key];
  return Array.isArray(value) ? value : [];
}

function truncate(value: string, maxLength = 240): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength - 1)}…`;
}

function formatThreadItem(item: unknown): string {
  if (!isRecord(item)) {
    return JSON.stringify(item);
  }

  const type = readString(item, "type") ?? "unknown";

  if (type === "userMessage") {
    const content = readArray(item, "content")
      .map((entry) => {
        if (!isRecord(entry)) {
          return "";
        }

        const entryType = readString(entry, "type");
        if (entryType === "text") {
          return readString(entry, "text") ?? "";
        }

        if (entryType === "image") {
          return `[image] ${readString(entry, "image_url") ?? ""}`.trim();
        }

        if (entryType === "local_image") {
          return `[local_image] ${readString(entry, "path") ?? ""}`.trim();
        }

        return entryType ? `[${entryType}]` : "";
      })
      .filter((value) => value.length > 0)
      .join("\n");

    return content.length > 0 ? content : "[empty user message]";
  }

  if (type === "agentMessage") {
    return readString(item, "text") ?? "[empty agent message]";
  }

  if (type === "plan") {
    return readString(item, "text") ?? "[empty plan]";
  }

  if (type === "reasoning") {
    const summary = readArray(item, "summary")
      .filter((value): value is string => typeof value === "string")
      .join("\n");
    return summary.length > 0 ? summary : "[reasoning]";
  }

  if (type === "commandExecution") {
    const command = readString(item, "command") ?? "";
    const status = readString(item, "status") ?? "unknown";
    const exitCode =
      isRecord(item) && typeof item.exitCode === "number" ? ` exit=${item.exitCode}` : "";
    const output = readString(item, "aggregatedOutput");
    return [`$ ${command}`.trim(), `[status=${status}${exitCode}]`, output ?? ""]
      .filter((value) => value.length > 0)
      .join("\n");
  }

  if (type === "fileChange") {
    const status = readString(item, "status") ?? "unknown";
    return `[fileChange status=${status}]`;
  }

  return JSON.stringify(item, null, 2);
}

function formatThreadTranscript(thread: {
  readonly id: string;
  readonly name: string | null;
  readonly status?: unknown;
  readonly turns: readonly {
    readonly id: string;
    readonly status: string;
    readonly items: readonly unknown[];
  }[];
}) {
  const lines = [
    `threadId: ${thread.id}`,
    `name: ${thread.name ?? "(untitled)"}`,
    `status: ${thread.status === undefined ? "unknown" : JSON.stringify(thread.status)}`,
    `turns: ${thread.turns.length}`,
  ];

  for (const turn of thread.turns) {
    lines.push("");
    lines.push(`=== turn ${turn.id} (${turn.status}) ===`);

    if (turn.items.length === 0) {
      lines.push("[no stored items]");
      continue;
    }

    for (const item of turn.items) {
      if (isRecord(item)) {
        const type = readString(item, "type") ?? "unknown";
        lines.push(`[${type}]`);
        lines.push(formatThreadItem(item));
        continue;
      }

      lines.push("[unknown]");
      lines.push(formatThreadItem(item));
    }
  }

  return lines.join("\n");
}

function formatLiveEvent(event: CodexLiveEvent): string | null {
  if (
    event.method === "item/agentMessage/delta" ||
    event.method === "codex/event/agent_message_content_delta" ||
    event.method === "codex/event/agent_message_delta" ||
    event.method === "codex/event/item_started" ||
    event.method === "codex/event/item_completed" ||
    event.method === "codex/event/user_message" ||
    event.method === "codex/event/mcp_startup_complete"
  ) {
    return null;
  }

  const context = [
    event.turnId ? `turn=${event.turnId}` : undefined,
    event.itemId ? `item=${event.itemId}` : undefined,
    event.requestId ? `request=${event.requestId}` : undefined,
  ]
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .join(" ");

  const suffix = event.summary ? ` :: ${truncate(event.summary)}` : "";
  const details = context.length > 0 ? ` ${context}` : "";

  switch (event.method) {
    case "item/reasoning/textDelta":
      return `[reasoning]${details}${suffix}`;
    case "item/reasoning/summaryTextDelta":
      return `[reasoning summary]${details}${suffix}`;
    case "item/plan/delta":
      return `[plan delta]${details}${suffix}`;
    case "turn/plan/updated":
      return `[plan update]${details}${suffix}`;
    case "turn/diff/updated":
      return `[diff update]${details}${suffix}`;
    case "item/commandExecution/outputDelta":
      return `[command output]${details}${suffix}`;
    case "item/fileChange/outputDelta":
      return `[file change output]${details}${suffix}`;
    case "item/started":
      return `[item started]${details}${suffix}`;
    case "item/completed":
      return `[item completed]${details}${suffix}`;
    case "item/mcpToolCall/progress":
      return `[tool progress]${details}${suffix}`;
    case "item/commandExecution/requestApproval":
    case "item/fileChange/requestApproval":
      return `[pending approval]${details}${suffix}`;
    case "item/requestApproval/decision":
      return `[approval decision]${details}${suffix}`;
    case "item/tool/requestUserInput":
      return `[pending user input]${details}${suffix}`;
    case "item/tool/requestUserInput/answered":
      return `[user input answered]${details}${suffix}`;
    case "turn/started":
      return `[turn started]${details}${suffix}`;
    case "turn/completed":
      return `[turn completed]${details}${suffix}`;
    case "thread/status/changed":
      return `[thread status]${details}${suffix}`;
    case "thread/started":
      return `[thread started]${details}${suffix}`;
    case "codex/event/task_started":
      return `[task started]${details}${suffix}`;
    case "codex/event/task_complete":
      return `[task completed]${details}${suffix}`;
    case "codex/event/agent_reasoning":
      return `[reasoning activity]${details}${suffix}`;
    case "codex/event/reasoning_content_delta":
      return `[reasoning]${details}${suffix}`;
    case "account/updated":
      return `[account updated]${details}${suffix}`;
    case "protocol/error":
      return `[protocol error]${details}${suffix}`;
    default:
      return `[${event.source}] ${event.method}${details}${suffix}`;
  }
}

const sandboxIdFlag = Flag.string("sandbox-id").pipe(
  Flag.withDescription("Existing Daytona sandbox id."),
);

const worktreePathFlag = Flag.string("worktree-path").pipe(
  Flag.withDescription("Absolute worktree path inside the sandbox."),
);

const promptFlag = Flag.string("prompt").pipe(Flag.withDescription("Prompt to send to Codex."));

const threadIdFlag = Flag.string("thread-id").pipe(
  Flag.withDescription("Optional stored thread id to resume."),
  Flag.optional,
);

const requiredThreadIdFlag = Flag.string("thread-id").pipe(
  Flag.withDescription("Stored thread id to read."),
);

const runDeviceAuthProgram = (sandboxId: string, worktreePath: string) =>
  Effect.gen(function* () {
    const codex = yield* CodexService;
    const login = yield* codex.startDeviceAuth({
      sandboxId,
      worktreePath,
    });

    yield* Console.log(`loginId: ${login.loginId}`);
    yield* Console.log(`verificationUri: ${login.verificationUri ?? "pending"}`);
    yield* Console.log(`userCode: ${login.userCode ?? "pending"}`);
    yield* Console.log("Waiting for device auth completion...");

    const completed = yield* codex.awaitDeviceAuth(login.loginId);
    yield* Console.log(`Device auth status: ${completed.status}`);
  }).pipe(
    Effect.matchEffect({
      onFailure: (error) =>
        Effect.fail(
          new CodexCliError({
            message: formatUnknownError(error),
            cause: error instanceof Error && "cause" in error ? error.cause : undefined,
          }),
        ),
      onSuccess: (value) => Effect.succeed(value),
    }),
  );

const runSendTurnProgram = (
  sandboxId: string,
  worktreePath: string,
  prompt: string,
  threadIdOption: Option.Option<string>,
) =>
  Effect.gen(function* () {
    const codex = yield* CodexService;
    const session = yield* codex.startSession({
      sandboxId,
      worktreePath,
    });

    yield* Effect.addFinalizer(() =>
      codex.stopSession(session.sessionId).pipe(
        Effect.matchEffect({
          onFailure: (error: TerminalCleanupError | Error) =>
            Console.error(formatUnknownError(error)),
          onSuccess: () => Effect.void,
        }),
      ),
    );

    const account = yield* codex.readAccount(session.sessionId);
    if (account.type === "unknown" && account.requiresOpenaiAuth) {
      yield* Effect.fail(
        new CodexCliError({
          message:
            "Codex is not authenticated in this sandbox. Run `bun run --cwd packages/sandbox codex device-auth --sandbox-id ... --worktree-path ...` first.",
        }),
      );
    }

    const thread = yield* codex.openThread({
      sessionId: session.sessionId,
      threadId: Option.getOrUndefined(threadIdOption),
      cwd: worktreePath,
      approvalPolicy: "never",
      sandbox: "danger-full-access",
      persistExtendedHistory: true,
      experimentalRawEvents: true,
    });

    yield* Console.log(`threadId: ${thread.id}`);

    const startedTurn = yield* codex.sendTurn({
      sessionId: session.sessionId,
      threadId: thread.id,
      prompt,
      onAgentMessageDelta: (delta) => {
        process.stdout.write(delta);
      },
    });

    yield* Console.log(`\nturnId: ${startedTurn.turnId}`);
    const completedTurn = yield* Effect.promise<CodexCompletedTurn>(
      () =>
        new Promise<CodexCompletedTurn>((resolve, reject) => {
          const seenEventIds = new Set<string>();
          let polling = true;

          const poll = async () => {
            while (polling) {
              try {
                const snapshot = await Effect.runPromise(codex.getSession(session.sessionId));

                for (const event of snapshot.recentEvents) {
                  if (seenEventIds.has(event.eventId)) {
                    continue;
                  }

                  seenEventIds.add(event.eventId);
                  const renderedEvent = formatLiveEvent(event);
                  if (!renderedEvent) {
                    continue;
                  }

                  process.stdout.write(`\n${renderedEvent}\n`);
                }
              } catch {
                polling = false;
                return;
              }

              await new Promise((innerResolve) => setTimeout(innerResolve, 500));
            }
          };

          void poll();

          Effect.runPromise(codex.awaitTurn(session.sessionId, startedTurn.turnId)).then(
            (value) => {
              polling = false;
              resolve(value);
            },
            (error) => {
              polling = false;
              reject(error);
            },
          );
        }),
    );
    yield* Console.log(`Turn status: ${completedTurn.status}`);
  }).pipe(
    Effect.matchEffect({
      onFailure: (error) =>
        Effect.fail(
          new CodexCliError({
            message: formatUnknownError(error),
            cause: error instanceof Error && "cause" in error ? error.cause : undefined,
          }),
        ),
      onSuccess: (value) => Effect.succeed(value),
    }),
  );

const runReadThreadProgram = (sandboxId: string, worktreePath: string, threadId: string) =>
  Effect.gen(function* () {
    const codex = yield* CodexService;
    const session = yield* codex.startSession({
      sandboxId,
      worktreePath,
    });

    yield* Effect.addFinalizer(() =>
      codex.stopSession(session.sessionId).pipe(
        Effect.matchEffect({
          onFailure: (error: TerminalCleanupError | Error) =>
            Console.error(formatUnknownError(error)),
          onSuccess: () => Effect.void,
        }),
      ),
    );

    const thread = yield* codex.readStoredThread({
      sessionId: session.sessionId,
      threadId,
    });

    yield* Console.log(formatThreadTranscript(thread));
  }).pipe(
    Effect.matchEffect({
      onFailure: (error) =>
        Effect.fail(
          new CodexCliError({
            message: formatUnknownError(error),
            cause: error instanceof Error && "cause" in error ? error.cause : undefined,
          }),
        ),
      onSuccess: (value) => Effect.succeed(value),
    }),
  );

const deviceAuthCommand = Command.make("device-auth", {
  sandboxId: sandboxIdFlag,
  worktreePath: worktreePathFlag,
}).pipe(
  Command.withDescription("Run `codex login --device-auth` in an existing sandbox worktree."),
  Command.withHandler((input) =>
    Effect.scoped(runDeviceAuthProgram(input.sandboxId, input.worktreePath)),
  ),
);

const sendTurnCommand = Command.make("send-turn", {
  sandboxId: sandboxIdFlag,
  worktreePath: worktreePathFlag,
  prompt: promptFlag,
  threadId: threadIdFlag,
}).pipe(
  Command.withDescription("Start Codex app-server in a sandbox worktree and send one prompt."),
  Command.withHandler((input) =>
    Effect.scoped(
      runSendTurnProgram(input.sandboxId, input.worktreePath, input.prompt, input.threadId),
    ),
  ),
);

const readThreadCommand = Command.make("read-thread", {
  sandboxId: sandboxIdFlag,
  worktreePath: worktreePathFlag,
  threadId: requiredThreadIdFlag,
}).pipe(
  Command.withDescription("Read the stored transcript for a thread in a sandbox worktree."),
  Command.withHandler((input) =>
    Effect.scoped(runReadThreadProgram(input.sandboxId, input.worktreePath, input.threadId)),
  ),
);

const codexCommand = Command.make("codex").pipe(
  Command.withDescription("Sandbox-only Codex auth and app-server CLI."),
  Command.withSubcommands([deviceAuthCommand, sendTurnCommand, readThreadCommand]),
);

Command.run(codexCommand, { version }).pipe(
  Effect.provide(CodexServiceLive()),
  Effect.provide(TerminalServiceLive()),
  Effect.provide(SandboxServiceLive()),
  Effect.provide(DaytonaClientLive()),
  Effect.provide(NodeServices.layer),
  NodeRuntime.runMain,
);
