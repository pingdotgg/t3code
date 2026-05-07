import { ClientSettingsSchema } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as DesktopEnvironment from "../../main/DesktopEnvironment.ts";
import { readClientSettingsEffect, writeClientSettingsEffect } from "../../clientPersistence.ts";
import * as IpcChannels from "../channels.ts";
import { makeIpcMethod } from "../DesktopIpc.ts";

export const getClientSettings = makeIpcMethod({
  channel: IpcChannels.GET_CLIENT_SETTINGS_CHANNEL,
  payload: Schema.Void,
  result: Schema.NullOr(ClientSettingsSchema),
  handler: () =>
    Effect.gen(function* () {
      const environment = yield* DesktopEnvironment.DesktopEnvironment;
      return yield* readClientSettingsEffect(environment.clientSettingsPath);
    }),
});

export const setClientSettings = makeIpcMethod({
  channel: IpcChannels.SET_CLIENT_SETTINGS_CHANNEL,
  payload: ClientSettingsSchema,
  result: Schema.Void,
  handler: (settings) =>
    Effect.gen(function* () {
      const environment = yield* DesktopEnvironment.DesktopEnvironment;
      yield* writeClientSettingsEffect(environment.clientSettingsPath, settings);
    }),
});
