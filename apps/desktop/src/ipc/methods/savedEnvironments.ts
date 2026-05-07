import { EnvironmentId, PersistedSavedEnvironmentRecordSchema } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  readSavedEnvironmentRegistryEffect,
  readSavedEnvironmentSecretEffect,
  removeSavedEnvironmentSecretEffect,
  writeSavedEnvironmentRegistryEffect,
  writeSavedEnvironmentSecretEffect,
} from "../../clientPersistence.ts";
import * as DesktopEnvironment from "../../main/DesktopEnvironment.ts";
import * as ElectronSafeStorage from "../../electron/ElectronSafeStorage.ts";
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
  handler: () =>
    Effect.gen(function* () {
      const environment = yield* DesktopEnvironment.DesktopEnvironment;
      return yield* readSavedEnvironmentRegistryEffect(environment.savedEnvironmentRegistryPath);
    }),
});

export const setSavedEnvironmentRegistry = makeIpcMethod({
  channel: IpcChannels.SET_SAVED_ENVIRONMENT_REGISTRY_CHANNEL,
  payload: SavedEnvironmentRegistryPayload,
  result: Schema.Void,
  handler: (records) =>
    Effect.gen(function* () {
      const environment = yield* DesktopEnvironment.DesktopEnvironment;
      yield* writeSavedEnvironmentRegistryEffect(environment.savedEnvironmentRegistryPath, records);
    }),
});

export const getSavedEnvironmentSecret = makeIpcMethod({
  channel: IpcChannels.GET_SAVED_ENVIRONMENT_SECRET_CHANNEL,
  payload: EnvironmentId,
  result: Schema.NullOr(Schema.String),
  handler: (environmentId) =>
    Effect.gen(function* () {
      const environment = yield* DesktopEnvironment.DesktopEnvironment;
      const secretStorage = yield* ElectronSafeStorage.ElectronSafeStorage;
      return yield* readSavedEnvironmentSecretEffect({
        registryPath: environment.savedEnvironmentRegistryPath,
        environmentId,
        secretStorage,
      });
    }),
});

export const setSavedEnvironmentSecret = makeIpcMethod({
  channel: IpcChannels.SET_SAVED_ENVIRONMENT_SECRET_CHANNEL,
  payload: SetSavedEnvironmentSecretInput,
  result: Schema.Boolean,
  handler: ({ environmentId, secret }) =>
    Effect.gen(function* () {
      const environment = yield* DesktopEnvironment.DesktopEnvironment;
      const secretStorage = yield* ElectronSafeStorage.ElectronSafeStorage;
      return yield* writeSavedEnvironmentSecretEffect({
        registryPath: environment.savedEnvironmentRegistryPath,
        environmentId,
        secret,
        secretStorage,
      });
    }),
});

export const removeSavedEnvironmentSecret = makeIpcMethod({
  channel: IpcChannels.REMOVE_SAVED_ENVIRONMENT_SECRET_CHANNEL,
  payload: EnvironmentId,
  result: Schema.Void,
  handler: (environmentId) =>
    Effect.gen(function* () {
      const environment = yield* DesktopEnvironment.DesktopEnvironment;
      yield* removeSavedEnvironmentSecretEffect({
        registryPath: environment.savedEnvironmentRegistryPath,
        environmentId,
      });
    }),
});
