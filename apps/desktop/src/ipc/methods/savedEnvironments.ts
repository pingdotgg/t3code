import { EnvironmentId, PersistedSavedEnvironmentRecordSchema } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as DesktopSavedEnvironments from "../../settings/DesktopSavedEnvironments.ts";
import * as IpcChannels from "../channels.ts";
import { makeIpcMethod } from "../DesktopIpc.ts";

const SavedEnvironmentRegistryPayload = Schema.Array(PersistedSavedEnvironmentRecordSchema);
const NonBlankString = Schema.String.check(
  Schema.makeFilter((value) =>
    value.trim().length > 0 ? undefined : "Expected a non-empty string",
  ),
);

const SetSavedEnvironmentSecretInput = Schema.Struct({
  environmentId: EnvironmentId,
  secret: NonBlankString,
});

export const getSavedEnvironmentRegistry = makeIpcMethod({
  channel: IpcChannels.GET_SAVED_ENVIRONMENT_REGISTRY_CHANNEL,
  payload: Schema.Void,
  result: SavedEnvironmentRegistryPayload,
  handler: Effect.fn("desktop.ipc.savedEnvironments.getRegistry")(function* () {
    const savedEnvironments = yield* DesktopSavedEnvironments.DesktopSavedEnvironments;
    return yield* savedEnvironments.getRegistry;
  }),
});

export const setSavedEnvironmentRegistry = makeIpcMethod({
  channel: IpcChannels.SET_SAVED_ENVIRONMENT_REGISTRY_CHANNEL,
  payload: SavedEnvironmentRegistryPayload,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.savedEnvironments.setRegistry")(function* (records) {
    const savedEnvironments = yield* DesktopSavedEnvironments.DesktopSavedEnvironments;
    yield* savedEnvironments.setRegistry(records);
  }),
});

export const getSavedEnvironmentSecret = makeIpcMethod({
  channel: IpcChannels.GET_SAVED_ENVIRONMENT_SECRET_CHANNEL,
  payload: EnvironmentId,
  result: Schema.NullOr(Schema.String),
  handler: Effect.fn("desktop.ipc.savedEnvironments.getSecret")(function* (environmentId) {
    const savedEnvironments = yield* DesktopSavedEnvironments.DesktopSavedEnvironments;
    return Option.getOrNull(yield* savedEnvironments.getSecret(environmentId));
  }),
});

export const setSavedEnvironmentSecret = makeIpcMethod({
  channel: IpcChannels.SET_SAVED_ENVIRONMENT_SECRET_CHANNEL,
  payload: SetSavedEnvironmentSecretInput,
  result: Schema.Boolean,
  handler: Effect.fn("desktop.ipc.savedEnvironments.setSecret")(function* ({
    environmentId,
    secret,
  }) {
    const savedEnvironments = yield* DesktopSavedEnvironments.DesktopSavedEnvironments;
    return yield* savedEnvironments.setSecret({
      environmentId,
      secret,
    });
  }),
});

export const removeSavedEnvironmentSecret = makeIpcMethod({
  channel: IpcChannels.REMOVE_SAVED_ENVIRONMENT_SECRET_CHANNEL,
  payload: EnvironmentId,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.savedEnvironments.removeSecret")(function* (environmentId) {
    const savedEnvironments = yield* DesktopSavedEnvironments.DesktopSavedEnvironments;
    yield* savedEnvironments.removeSecret(environmentId);
  }),
});
