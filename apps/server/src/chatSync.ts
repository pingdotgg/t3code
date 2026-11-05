import * as NodeOS from "node:os";

import { ChatSyncError, type ChatSyncStatus } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";

import * as ProcessRunner from "./processRunner.ts";

const unit = process.env.T3_LEARN_CHAT_SYNC_UNIT ?? "t3-learn-chat-sync.service";

export function parseChatSyncStatus(
  activeState: string,
  result: string,
  journal: string,
  unitName = unit,
): ChatSyncStatus {
  const lines = journal.split(/\r?\n/);
  const start = lines.findLastIndex((line) => line.startsWith("Starting "));
  if (start < 0) return { state: "never", message: null, addedChats: null };
  const runLines = lines
    .slice(start + 1)
    .filter(
      (line) =>
        line.length > 0 &&
        !line.startsWith("Starting ") &&
        !line.startsWith("Finished ") &&
        !line.startsWith("Failed to start ") &&
        !line.startsWith(`${unitName}:`),
    );
  const message = runLines.at(-1)?.replace(/^\d{2}:\d{2}:\d{2} /, "") ?? null;
  const added = runLines
    .map((line) => /Added (\d+) chats/.exec(line)?.[1])
    .find((value) => value !== undefined);
  const addedChats =
    added === undefined
      ? runLines.some((line) => /nothing to add/i.test(line))
        ? 0
        : null
      : Number(added);
  const state =
    activeState === "activating" || activeState === "deactivating"
      ? "running"
      : result === "success"
        ? "succeeded"
        : "failed";
  return { state, message, addedChats };
}

export class ChatSync extends Context.Service<
  ChatSync,
  {
    readonly available: boolean;
    readonly start: Effect.Effect<ChatSyncStatus, ChatSyncError>;
    readonly status: Effect.Effect<ChatSyncStatus, ChatSyncError>;
  }
>()("t3/chatSync") {}

export const unavailable = ChatSync.of({
  available: false,
  start: Effect.fail(
    new ChatSyncError({ message: "T3 Code chat sync is unavailable on this server." }),
  ),
  status: Effect.succeed({
    state: "never",
    message: null,
    addedChats: null,
  } satisfies ChatSyncStatus),
});

const commandFailure = (command: string, output: ProcessRunner.ProcessRunOutput) =>
  new ChatSyncError({
    message: `${command} failed${output.stderr.trim() ? `: ${output.stderr.trim().split(/\r?\n/)[0]}` : ""}`,
  });

export const layer = Layer.effect(
  ChatSync,
  Effect.gen(function* () {
    const runner = yield* ProcessRunner.ProcessRunner;
    const fs = yield* FileSystem.FileSystem;
    const run = (input: ProcessRunner.ProcessRunInput) =>
      runner
        .run(input)
        .pipe(Effect.mapError((error) => new ChatSyncError({ message: String(error) })));
    const databasePath = `${NodeOS.homedir()}/.t3/userdata/statev2.sqlite`;
    const loadState = yield* run({
      command: "systemctl",
      args: ["--user", "show", unit, "-p", "LoadState"],
    }).pipe(Effect.orElseSucceed(() => ({ stdout: "", stderr: "", code: null }) as const));
    const available =
      loadState.code === 0 &&
      loadState.stdout.trim() === "LoadState=loaded" &&
      (yield* fs.exists(databasePath));

    const status: ChatSync["Service"]["status"] = Effect.gen(function* () {
      const [stateOutput, journalOutput] = yield* Effect.all([
        run({
          command: "systemctl",
          args: ["--user", "show", unit, "-p", "ActiveState,Result"],
        }),
        run({
          command: "journalctl",
          args: ["--user", "-u", unit, "-n", "80", "-o", "cat", "--no-pager"],
        }),
      ]);
      if (stateOutput.code !== 0) return yield* commandFailure("systemctl", stateOutput);
      if (journalOutput.code !== 0) return yield* commandFailure("journalctl", journalOutput);
      const values = Object.fromEntries(
        stateOutput.stdout.split(/\r?\n/).flatMap((line) => {
          const [key, value] = line.split("=", 2);
          return key && value ? [[key, value]] : [];
        }),
      );
      return parseChatSyncStatus(
        values.ActiveState ?? "",
        values.Result ?? "",
        journalOutput.stdout,
      );
    }).pipe(Effect.withSpan("ChatSync.status"));

    const start: ChatSync["Service"]["start"] = Effect.gen(function* () {
      if (!available)
        return yield* new ChatSyncError({
          message: "T3 Code chat sync is unavailable on this server.",
        });
      const output = yield* run({
        command: "systemctl",
        args: ["--user", "start", "--no-block", unit],
      });
      if (output.code !== 0) return yield* commandFailure("systemctl", output);
      return yield* status;
    }).pipe(Effect.withSpan("ChatSync.start"));

    return ChatSync.of({ available, start, status });
  }),
).pipe(Layer.provide(ProcessRunner.layer));
