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
  bot_group_list: McpToolAccess.reads(() =>
    Effect.gen(function* () {
      const bots = yield* BotService.BotService;
      return yield* bots.listGroups().pipe(Effect.mapError(mapBotError));
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
