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

export const getComputerHistoryStatus = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.GET_COMPUTER_HISTORY_STATUS_CHANNEL,
  payload: Schema.Undefined,
  result: ComputerHistoryStatusSchema,
  handler: Effect.fn("desktop.ipc.computerHistory.getStatus")(function* () {
    // Status is observational — do not ensureDaemon here. A poll that captured
    // enabled:true must not respawn the recorder after the user disables it.
    // Lifecycle belongs to bootstrap + patchComputerHistorySettings.
    const settings = yield* readHistorySettings();
    const environment = yield* DesktopEnvironment.DesktopEnvironment;
    const manager = yield* ComputerHistoryManager.ComputerHistoryManager;
    return yield* manager.getStatus(environment.stateDir, settings);
  }),
});

export const getComputerHistoryTimeline = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.GET_COMPUTER_HISTORY_TIMELINE_CHANNEL,
  payload: Schema.Undefined,
  result: ComputerHistoryTimelineSchema,
  handler: Effect.fn("desktop.ipc.computerHistory.getTimeline")(function* () {
    const environment = yield* DesktopEnvironment.DesktopEnvironment;
    const manager = yield* ComputerHistoryManager.ComputerHistoryManager;
    return yield* manager.getTimeline(environment.stateDir);
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
    const manager = yield* ComputerHistoryManager.ComputerHistoryManager;
    // Persistence is owned by the server settings RPC (`updateSettings` in the
    // renderer). This IPC only reconciles the recorder daemon — never rewrite
    // the full settings document (that races the server's atomic writer).
    const current = yield* readHistorySettings();
    const settings = yield* manager.mergePatchSettings(environment.stateDir, current, patch);
    yield* manager.ensureDaemon(environment.stateDir, settings);
    return yield* manager.getStatus(environment.stateDir, settings);
  }),
});

export const clearComputerHistory = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.CLEAR_COMPUTER_HISTORY_CHANNEL,
  payload: ComputerHistoryClearScope,
  result: ComputerHistoryTimelineSchema,
  handler: Effect.fn("desktop.ipc.computerHistory.clear")(function* (scope) {
    const settings = yield* readHistorySettings();
    const environment = yield* DesktopEnvironment.DesktopEnvironment;
    const manager = yield* ComputerHistoryManager.ComputerHistoryManager;
    return yield* manager.clear(environment.stateDir, scope, settings);
  }),
});

export const revealComputerHistoryMemory = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.REVEAL_COMPUTER_HISTORY_MEMORY_CHANNEL,
  payload: Schema.String,
  result: Schema.Boolean,
  handler: Effect.fn("desktop.ipc.computerHistory.reveal")(function* (path) {
    const environment = yield* DesktopEnvironment.DesktopEnvironment;
    const manager = yield* ComputerHistoryManager.ComputerHistoryManager;
    return yield* manager.revealMemory(environment.stateDir, path);
  }),
});

export const deleteComputerHistoryMemory = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.DELETE_COMPUTER_HISTORY_MEMORY_CHANNEL,
  payload: Schema.String,
  result: ComputerHistoryTimelineSchema,
  handler: Effect.fn("desktop.ipc.computerHistory.delete")(function* (path) {
    const settings = yield* readHistorySettings();
    const environment = yield* DesktopEnvironment.DesktopEnvironment;
    const manager = yield* ComputerHistoryManager.ComputerHistoryManager;
    return yield* manager.removeMemory(environment.stateDir, path, settings);
  }),
});
