import { ClientSettingsSchema } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { readClientSettingsEffect, writeClientSettingsEffect } from "../../clientPersistence.ts";
import { DesktopEnvironment } from "../../desktopEnvironment.ts";
import { GET_CLIENT_SETTINGS_CHANNEL, SET_CLIENT_SETTINGS_CHANNEL } from "../channels.ts";
import { makeIpcMethod } from "../DesktopIpc.ts";

export const getClientSettings = makeIpcMethod({
  channel: GET_CLIENT_SETTINGS_CHANNEL,
  payload: Schema.Void,
  result: Schema.NullOr(ClientSettingsSchema),
  handler: () =>
    Effect.gen(function* () {
      const environment = yield* DesktopEnvironment;
      return yield* readClientSettingsEffect(environment.clientSettingsPath);
    }),
});

export const setClientSettings = makeIpcMethod({
  channel: SET_CLIENT_SETTINGS_CHANNEL,
  payload: ClientSettingsSchema,
  result: Schema.Void,
  handler: (settings) =>
    Effect.gen(function* () {
      const environment = yield* DesktopEnvironment;
      yield* writeClientSettingsEffect(environment.clientSettingsPath, settings);
    }),
});
