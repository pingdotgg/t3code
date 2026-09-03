import {
  AntigravitySettings,
  ProviderDriverKind,
  type ProviderInstallCancelInput,
  type ProviderInstanceId,
  ProviderSetupError,
  type ProviderSetupInput,
} from "@t3tools/contracts";
import { resolveCommandPath } from "@t3tools/shared/shell";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { ServerSettingsService } from "../serverSettings.ts";
import {
  AntigravityInstallation,
  type AntigravityInstallationError,
} from "./AntigravityInstallation.ts";
import { deriveProviderInstanceConfigMap } from "./Layers/ProviderInstanceRegistryHydration.ts";
import { ProviderInstanceRegistry } from "./Services/ProviderInstanceRegistry.ts";
import { ProviderRegistry } from "./Services/ProviderRegistry.ts";
import { mergeProviderInstanceEnvironment } from "./ProviderInstanceEnvironment.ts";

const ANTIGRAVITY = ProviderDriverKind.make("antigravity");
const hasBinaryPath = Schema.is(Schema.Struct({ binaryPath: Schema.String }));
const decodeAntigravitySettings = Schema.decodeUnknownEffect(AntigravitySettings);

/** Route instance setup to the environment-owned installer without owning the download. */
export const makeProviderInstallation = Effect.fn("makeProviderInstallation")(function* () {
  const installation = yield* AntigravityInstallation;
  const instances = yield* ProviderInstanceRegistry;
  const providers = yield* ProviderRegistry;
  const settings = yield* ServerSettingsService;

  const readEntries = Effect.fn("ProviderInstallation.readEntries")(function* (
    instanceId: ProviderInstanceId,
    operation: string,
  ) {
    const current = yield* settings.getSettings.pipe(
      Effect.mapError(
        () =>
          new ProviderSetupError({
            instanceId,
            operation,
            detail: "Could not read provider installation settings.",
          }),
      ),
    );
    return deriveProviderInstanceConfigMap(current);
  });

  const requireInstance = Effect.fn("ProviderInstallation.requireInstance")(function* (
    instanceId: ProviderInstanceId,
    operation: string,
    managedOnly = false,
  ) {
    const instance = yield* instances.getInstance(instanceId);
    if (instance?.driverKind !== ANTIGRAVITY) {
      return yield* new ProviderSetupError({
        instanceId,
        operation,
        detail: "Managed installation is not available for this provider instance.",
      });
    }
    if (!managedOnly) return;
    const entries = yield* readEntries(instanceId, operation);
    const config = yield* decodeAntigravitySettings(entries[instanceId]?.config ?? {}).pipe(
      Effect.mapError(
        () =>
          new ProviderSetupError({
            instanceId,
            operation,
            detail: "The Antigravity instance configuration is invalid.",
          }),
      ),
    );
    if (config.binaryPath) {
      return yield* new ProviderSetupError({
        instanceId,
        operation,
        detail:
          "This instance uses a custom executable. Clear its binary path to manage installation in T3 Code.",
      });
    }
  });

  const failure = (instanceId: ProviderInstanceId) => (error: AntigravityInstallationError) =>
    new ProviderSetupError({ instanceId, operation: error.operation, detail: error.detail });

  const start = Effect.fn("ProviderInstallation.start")(function* (input: ProviderSetupInput) {
    yield* requireInstance(input.instanceId, "install", true);
    return yield* installation.start.pipe(Effect.mapError(failure(input.instanceId)));
  });

  const cancel = Effect.fn("ProviderInstallation.cancel")(function* (
    input: ProviderInstallCancelInput,
  ) {
    yield* requireInstance(input.instanceId, "cancel-install");
    return yield* installation
      .cancel(input.operationId)
      .pipe(Effect.mapError(failure(input.instanceId)));
  });

  const subscribe = (input: ProviderSetupInput) =>
    Stream.unwrap(
      requireInstance(input.instanceId, "observe-install").pipe(Effect.as(installation.changes)),
    );

  const remove = Effect.fn("ProviderInstallation.remove")(function* (input: ProviderSetupInput) {
    yield* requireInstance(input.instanceId, "remove-install", true);
    const entries = yield* readEntries(input.instanceId, "remove-install");
    const protectedPaths = yield* Effect.forEach(Object.values(entries), (entry) => {
      if (!hasBinaryPath(entry.config) || !entry.config.binaryPath.trim()) {
        return Effect.succeed([]);
      }
      const binaryPath = entry.config.binaryPath.trim();
      return resolveCommandPath(binaryPath, {
        env: mergeProviderInstanceEnvironment(entry.environment),
      }).pipe(
        Effect.map((resolved) => [binaryPath, resolved]),
        Effect.catch(() => Effect.succeed([binaryPath])),
      );
    });
    yield* installation
      .remove(protectedPaths.flat())
      .pipe(Effect.mapError(failure(input.instanceId)));
    const allInstances = yield* instances.listInstances;
    yield* Effect.forEach(
      allInstances.filter((instance) => instance.driverKind === ANTIGRAVITY),
      (instance) => providers.refreshInstance(instance.instanceId),
      { discard: true },
    );
    return yield* installation.state;
  });

  return { start, cancel, subscribe, remove };
});
