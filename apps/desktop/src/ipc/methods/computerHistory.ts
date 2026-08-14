// @effect-diagnostics preferSchemaOverJson:off
// @effect-diagnostics tryCatchInEffectGen:off
import {
  ComputerHistoryClearScope,
  ComputerHistoryStatusSchema,
  ComputerHistoryTimelineSchema,
} from "@t3tools/contracts";
import { DEFAULT_SERVER_SETTINGS, ServerSettings } from "@t3tools/contracts/settings";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";

import * as DesktopEnvironment from "../../app/DesktopEnvironment.ts";
import * as ComputerHistoryManager from "../../computerHistory/manager.ts";
import * as IpcChannels from "../channels.ts";
import * as DesktopIpc from "../DesktopIpc.ts";

const readHistorySettings = Effect.fn("desktop.computerHistory.readSettings")(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const fileSystem = yield* FileSystem.FileSystem;
  const raw = yield* fileSystem
    .readFileString(environment.serverSettingsPath)
    .pipe(Effect.orElseSucceed(() => "{}"));
  const decoded = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(ServerSettings))(
    raw,
  ).pipe(Effect.orElseSucceed(() => DEFAULT_SERVER_SETTINGS));
  return decoded.computerHistory;
});

const withStateDir = <A, E, R>(
  body: (stateDir: string) => Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R | DesktopEnvironment.DesktopEnvironment> =>
  Effect.gen(function* () {
    const environment = yield* DesktopEnvironment.DesktopEnvironment;
    return yield* body(environment.stateDir);
  });

export const getComputerHistoryStatus = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.GET_COMPUTER_HISTORY_STATUS_CHANNEL,
  payload: Schema.Undefined,
  result: ComputerHistoryStatusSchema,
  handler: Effect.fn("desktop.ipc.computerHistory.getStatus")(function* () {
    const settings = yield* readHistorySettings();
    return yield* withStateDir((stateDir) =>
      Effect.gen(function* () {
        yield* Effect.promise(() => ComputerHistoryManager.ensureDaemon(stateDir, settings));
        return yield* Effect.promise(() => ComputerHistoryManager.getStatus(stateDir, settings));
      }),
    );
  }),
});

export const getComputerHistoryTimeline = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.GET_COMPUTER_HISTORY_TIMELINE_CHANNEL,
  payload: Schema.Undefined,
  result: ComputerHistoryTimelineSchema,
  handler: Effect.fn("desktop.ipc.computerHistory.getTimeline")(function* () {
    return yield* withStateDir((stateDir) =>
      Effect.promise(() => ComputerHistoryManager.getTimeline(stateDir)),
    );
  }),
});

export const patchComputerHistorySettings = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.PATCH_COMPUTER_HISTORY_SETTINGS_CHANNEL,
  payload: Schema.Struct({
    enabled: Schema.optionalKey(Schema.Boolean),
    paused: Schema.optionalKey(Schema.Boolean),
    mirrorToCodex: Schema.optionalKey(Schema.Boolean),
    appFilterMode: Schema.optionalKey(Schema.Literals(["exclude", "includeOnly"])),
    apps: Schema.optionalKey(Schema.Array(Schema.String)),
    websiteFilterMode: Schema.optionalKey(Schema.Literals(["exclude", "includeOnly"])),
    websites: Schema.optionalKey(Schema.Array(Schema.String)),
  }),
  result: ComputerHistoryStatusSchema,
  handler: Effect.fn("desktop.ipc.computerHistory.patchSettings")(function* (patch) {
    const environment = yield* DesktopEnvironment.DesktopEnvironment;
    const fileSystem = yield* FileSystem.FileSystem;
    const raw = yield* fileSystem
      .readFileString(environment.serverSettingsPath)
      .pipe(Effect.orElseSucceed(() => "{}"));
    const current = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(ServerSettings))(
      raw,
    ).pipe(Effect.orElseSucceed(() => DEFAULT_SERVER_SETTINGS));
    const next = {
      ...current,
      computerHistory: {
        ...current.computerHistory,
        ...patch,
        ...(patch.apps === undefined ? {} : { apps: [...patch.apps] }),
        ...(patch.websites === undefined ? {} : { websites: [...patch.websites] }),
      },
    };
    const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(ServerSettings))(next);
    yield* fileSystem.writeFileString(environment.serverSettingsPath, `${encoded}\n`);
    const settings = next.computerHistory;
    yield* Effect.promise(() =>
      ComputerHistoryManager.ensureDaemon(environment.stateDir, settings),
    );
    return yield* Effect.promise(() =>
      ComputerHistoryManager.getStatus(environment.stateDir, settings),
    );
  }),
});

export const clearComputerHistory = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.CLEAR_COMPUTER_HISTORY_CHANNEL,
  payload: ComputerHistoryClearScope,
  result: ComputerHistoryTimelineSchema,
  handler: Effect.fn("desktop.ipc.computerHistory.clear")(function* (scope) {
    const settings = yield* readHistorySettings();
    return yield* withStateDir((stateDir) =>
      Effect.promise(() => ComputerHistoryManager.clear(stateDir, scope, settings)),
    );
  }),
});

export const revealComputerHistoryMemory = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.REVEAL_COMPUTER_HISTORY_MEMORY_CHANNEL,
  payload: Schema.String,
  result: Schema.Boolean,
  handler: Effect.fn("desktop.ipc.computerHistory.reveal")(function* (path) {
    return yield* Effect.promise(() => ComputerHistoryManager.revealMemory(path));
  }),
});

export const deleteComputerHistoryMemory = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.DELETE_COMPUTER_HISTORY_MEMORY_CHANNEL,
  payload: Schema.String,
  result: ComputerHistoryTimelineSchema,
  handler: Effect.fn("desktop.ipc.computerHistory.delete")(function* (path) {
    const settings = yield* readHistorySettings();
    return yield* withStateDir((stateDir) =>
      Effect.promise(() => ComputerHistoryManager.removeMemory(stateDir, path, settings)),
    );
  }),
});
