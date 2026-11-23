import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as BotService from "../../../bots/BotService.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { BotsToolkit } from "./tools.ts";

const mapBotError = (error: { readonly message: string }) =>
  new OrchestratorMcpFailure({ code: "invalid_request", message: error.message });

export const layer = McpToolAccess.toLayer(BotsToolkit, {
  bot_list: McpToolAccess.reads(() =>
    Effect.gen(function* () {
      const bots = yield* BotService.BotService;
      return yield* bots.list().pipe(Effect.mapError(mapBotError));
    }),
  ),
  bot_get: McpToolAccess.reads(({ botId }) =>
    Effect.gen(function* () {
      const bots = yield* BotService.BotService;
      return yield* bots.get({ botId }).pipe(Effect.mapError(mapBotError));
    }),
  ),
  bot_create: McpToolAccess.writesEnvironment((input) =>
    Effect.gen(function* () {
      const bots = yield* BotService.BotService;
      return yield* bots.create(input).pipe(Effect.mapError(mapBotError));
    }),
  ),
  bot_update: McpToolAccess.writesEnvironment((input) =>
    Effect.gen(function* () {
      const bots = yield* BotService.BotService;
      return yield* bots.update(input).pipe(Effect.mapError(mapBotError));
    }),
  ),
  bot_delete: McpToolAccess.writesEnvironment((input) =>
    Effect.gen(function* () {
      const bots = yield* BotService.BotService;
      return yield* bots.delete(input).pipe(Effect.mapError(mapBotError));
    }),
  ),
  bot_import_folder: McpToolAccess.writesEnvironment((input) =>
    Effect.gen(function* () {
      const bots = yield* BotService.BotService;
      return yield* bots.importFolder(input).pipe(Effect.mapError(mapBotError));
    }),
  ),
  bot_file_list: McpToolAccess.reads(({ botId }) =>
    Effect.gen(function* () {
      const bots = yield* BotService.BotService;
      return yield* bots.listFiles({ botId }).pipe(Effect.mapError(mapBotError));
    }),
  ),
  bot_file_read: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      const bots = yield* BotService.BotService;
      return yield* bots.readFile(input).pipe(Effect.mapError(mapBotError));
    }),
  ),
  bot_file_write: McpToolAccess.writesEnvironment((input) =>
    Effect.gen(function* () {
      const bots = yield* BotService.BotService;
      return yield* bots.writeFile(input).pipe(Effect.mapError(mapBotError));
    }),
  ),
  bot_routine_list: McpToolAccess.reads(({ botId }) =>
    Effect.gen(function* () {
      const bots = yield* BotService.BotService;
      return yield* bots.listRoutines({ botId }).pipe(Effect.mapError(mapBotError));
    }),
  ),
  bot_routine_upsert: McpToolAccess.writesEnvironment((input) =>
    Effect.gen(function* () {
      const bots = yield* BotService.BotService;
      return yield* bots.upsertRoutine(input).pipe(Effect.mapError(mapBotError));
    }),
  ),
  bot_routine_delete: McpToolAccess.writesEnvironment(({ routineId }) =>
    Effect.gen(function* () {
      const bots = yield* BotService.BotService;
      return yield* bots.deleteRoutine({ routineId }).pipe(Effect.mapError(mapBotError));
    }),
  ),
  bot_routine_run: McpToolAccess.writesEnvironment((input) =>
    Effect.gen(function* () {
      const bots = yield* BotService.BotService;
      return yield* bots.runRoutineNow(input).pipe(Effect.mapError(mapBotError));
    }),
  ),
  bot_handoff: McpToolAccess.startsThreads(
    () => ({}),
    (input, modes) =>
      Effect.gen(function* () {
        const bots = yield* BotService.BotService;
        return yield* bots
          .handoff(input, {
            runtimeMode: modes.runtimeMode,
            interactionMode: modes.interactionMode,
          })
          .pipe(Effect.mapError(mapBotError));
      }),
    { refused: "bot handoffs run only on the local environment" },
  ),
  bot_item_list: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      const bots = yield* BotService.BotService;
      return yield* bots.listItems(input).pipe(Effect.mapError(mapBotError));
    }),
  ),
  bot_item_create: McpToolAccess.writesEnvironment((input) =>
    Effect.gen(function* () {
      const bots = yield* BotService.BotService;
      return yield* bots.createItem(input).pipe(Effect.mapError(mapBotError));
    }),
  ),
  bot_item_update: McpToolAccess.writesEnvironment((input) =>
    Effect.gen(function* () {
      const bots = yield* BotService.BotService;
      return yield* bots.updateItem(input).pipe(Effect.mapError(mapBotError));
    }),
  ),
  bot_item_delete: McpToolAccess.writesEnvironment(({ itemId }) =>
    Effect.gen(function* () {
      const bots = yield* BotService.BotService;
      return yield* bots.deleteItem({ itemId }).pipe(Effect.mapError(mapBotError));
    }),
  ),
  bot_group_list: McpToolAccess.reads(() =>
    Effect.gen(function* () {
      const bots = yield* BotService.BotService;
      return yield* bots.listGroups().pipe(Effect.mapError(mapBotError));
    }),
  ),
  bot_group_create: McpToolAccess.writesEnvironment((input) =>
    Effect.gen(function* () {
      const bots = yield* BotService.BotService;
      return yield* bots.createGroup(input).pipe(Effect.mapError(mapBotError));
    }),
  ),
  bot_group_update: McpToolAccess.writesEnvironment((input) =>
    Effect.gen(function* () {
      const bots = yield* BotService.BotService;
      return yield* bots.updateGroup(input).pipe(Effect.mapError(mapBotError));
    }),
  ),
  bot_group_delete: McpToolAccess.writesEnvironment(({ groupId }) =>
    Effect.gen(function* () {
      const bots = yield* BotService.BotService;
      return yield* bots.deleteGroup({ groupId }).pipe(Effect.mapError(mapBotError));
    }),
  ),
  bot_group_messages: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      const bots = yield* BotService.BotService;
      return yield* bots.listGroupMessages(input).pipe(Effect.mapError(mapBotError));
    }),
  ),
  bot_group_send: McpToolAccess.startsThreads(
    () => ({}),
    (input, modes) =>
      Effect.gen(function* () {
        const bots = yield* BotService.BotService;
        return yield* bots
          .sendGroupMessage(input, {
            runtimeMode: modes.runtimeMode,
            interactionMode: modes.interactionMode,
          })
          .pipe(Effect.mapError(mapBotError));
      }),
    { refused: "bot group messages run only on the local environment" },
  ),
});
