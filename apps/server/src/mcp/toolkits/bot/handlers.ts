import {
  type BotError,
  type BotWatchTarget,
  OrchestratorMcpFailure,
  type ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as BotService from "../../../bots/BotService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { BotToolkit } from "./tools.ts";

const botFailure = (error: BotError) =>
  new OrchestratorMcpFailure({
    code: error.reason === "not_a_bot" ? "capability_denied" : "invalid_request",
    message: error.message,
  });

const notABot = new OrchestratorMcpFailure({
  code: "capability_denied",
  message: "Only a Bot thread has Bot memory. Use Start a Bot from this thread to make one.",
});

/** The calling thread, while it is a live Bot. Checked on every call; listing only hides. */
const callerBot = Effect.gen(function* () {
  const scope = yield* McpInvocationContext.McpInvocationContext;
  const thread = scope.thread;
  if (thread === undefined || thread.subagent === true) return yield* notABot;
  const bots = yield* BotService.BotService;
  if (!(yield* bots.isBot(thread.threadId))) return yield* notABot;
  return { bots, threadId: thread.threadId };
});

const targetOf = (input: {
  readonly threadId?: ThreadId | undefined;
  readonly workflowRunId?: string | undefined;
}): Effect.Effect<BotWatchTarget, OrchestratorMcpFailure> => {
  if (input.threadId !== undefined && input.workflowRunId === undefined) {
    return Effect.succeed({ threadId: input.threadId });
  }
  if (input.workflowRunId !== undefined && input.threadId === undefined) {
    return Effect.succeed({ workflowRunId: input.workflowRunId });
  }
  return Effect.fail(
    new OrchestratorMcpFailure({
      code: "invalid_request",
      message: "Give exactly one of `threadId` or `workflowRunId`.",
    }),
  );
};

export const layer = McpToolAccess.toLayer(BotToolkit, {
  t3_bot_memory_read: McpToolAccess.readsAsCaller(() =>
    Effect.gen(function* () {
      const { bots, threadId } = yield* callerBot;
      const files = yield* bots.readFiles({ threadId }).pipe(Effect.mapError(botFailure));
      return {
        instructions: files.preferences,
        notes: files.notes,
        watches: yield* bots.watches(threadId),
        bots: yield* bots.otherBots(threadId),
      };
    }),
  ),
  t3_bot_note_read: McpToolAccess.readsAsCaller(({ slug }) =>
    Effect.gen(function* () {
      const { bots, threadId } = yield* callerBot;
      return yield* bots.readNote({ threadId, slug }).pipe(Effect.mapError(botFailure));
    }),
  ),
  t3_bot_note_write: McpToolAccess.actsAsCaller((note) =>
    Effect.gen(function* () {
      const { bots, threadId } = yield* callerBot;
      yield* bots.writeNote({ threadId, ...note }).pipe(Effect.mapError(botFailure));
      return { saved: true };
    }),
  ),
  t3_bot_note_delete: McpToolAccess.actsAsCaller(({ slug }) =>
    Effect.gen(function* () {
      const { bots, threadId } = yield* callerBot;
      yield* bots.deleteNote({ threadId, slug }).pipe(Effect.mapError(botFailure));
      return { saved: true };
    }),
  ),
  t3_bot_note_search: McpToolAccess.readsAsCaller(({ query }) =>
    Effect.gen(function* () {
      const { bots, threadId } = yield* callerBot;
      const matches = yield* bots
        .searchNotes({ threadId, query })
        .pipe(Effect.mapError(botFailure));
      return { matches };
    }),
  ),
  t3_bot_preferences_append: McpToolAccess.actsAsCaller(({ text }) =>
    Effect.gen(function* () {
      const { bots, threadId } = yield* callerBot;
      yield* bots.appendPreference({ threadId, text }).pipe(Effect.mapError(botFailure));
      return { saved: true };
    }),
  ),
  t3_bot_avatar_set: McpToolAccess.actsAsCaller((avatar) =>
    Effect.gen(function* () {
      const { bots, threadId } = yield* callerBot;
      yield* bots.setAvatar({ threadId, avatar }).pipe(Effect.mapError(botFailure));
      return { saved: true };
    }),
  ),
  t3_bot_watch_add: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const { bots, threadId } = yield* callerBot;
      const target = yield* targetOf(input);
      const watches = yield* bots
        .addWatch(threadId, { ...target, reason: "manual" })
        .pipe(Effect.mapError(botFailure));
      return { watches };
    }),
  ),
  t3_bot_watch_remove: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const { bots, threadId } = yield* callerBot;
      const target = yield* targetOf(input);
      const watches = yield* bots.removeWatch(threadId, target).pipe(Effect.mapError(botFailure));
      return { watches };
    }),
  ),
});
