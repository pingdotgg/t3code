import {
  AntigravitySettings,
  ProviderDriverKind,
  type ProviderInstallCancelInput,
  type ProviderInstanceId,
  type ProviderInstanceConfig,
  ProviderSetupError,
  type ProviderSetupInput,
} from "@t3tools/contracts";
import { resolveCommandPath } from "@t3tools/shared/shell";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
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
import { ProviderCliInstallation } from "./ProviderCliInstallation.ts";
import {
  ProviderCliInstallError,
  isCliInstallDriver,
  type CliInstallDriver,
} from "./providerCliRelease.ts";

const ANTIGRAVITY = ProviderDriverKind.make("antigravity");
const hasBinaryPath = Schema.is(Schema.Struct({ binaryPath: Schema.String }));
const decodeAntigravitySettings = Schema.decodeUnknownEffect(AntigravitySettings);

/** Route instance setup to the environment-owned installer without owning the download. */
export const makeProviderInstallation = Effect.fn("makeProviderInstallation")(function* () {
  const installation = yield* AntigravityInstallation;
  const instances = yield* ProviderInstanceRegistry;
  const providers = yield* ProviderRegistry;
  const settings = yield* ServerSettingsService;
  const cliInstallation = yield* Effect.serviceOption(ProviderCliInstallation);
  const path = yield* Path.Path;
  const isConfig = Schema.is(Schema.Record(Schema.String, Schema.Unknown));

  const cliTarget = Effect.fn("ProviderInstallation.cliTarget")(function* (
    instanceId: ProviderInstanceId,
  ) {
    const instance = yield* instances.getInstance(instanceId);
    if (!instance || !isCliInstallDriver(instance.driverKind)) return null;
    if (Option.isNone(cliInstallation))
      return yield* new ProviderSetupError({
        instanceId,
        operation: "install",
        detail: "Update this environment to install this provider.",
      });
    return { installation: cliInstallation.value, driver: instance.driverKind };
  });

  const cliFailure = (instanceId: ProviderInstanceId, operation: string) => (cause: unknown) =>
    new ProviderSetupError({
      instanceId,
      operation,
      detail: cause instanceof Error ? cause.message : "Provider installation failed.",
    });

  const insideDirectory = (binaryPath: string, directory: string) => {
    const relative = path.relative(directory, binaryPath);
    return (
      relative !== "" &&
      !relative.startsWith(`..${path.sep}`) &&
      relative !== ".." &&
      !path.isAbsolute(relative)
    );
  };

  const configureCli = Effect.fn("ProviderInstallation.configureCli")(function* (
    instanceId: ProviderInstanceId,
    driver: CliInstallDriver,
    executable: string,
    expectedBinary: string,
  ) {
    const entries = yield* readEntries(instanceId, "install");
    const current = entries[instanceId];
    if (!current || current.driver !== driver)
      return yield* Effect.fail(
        new ProviderCliInstallError({
          detail: "This provider instance changed during installation. Try again.",
        }),
      );
    const config = isConfig(current.config) ? current.config : {};
    const binary = typeof config.binaryPath === "string" ? config.binaryPath : "";
    if (
      binary !== expectedBinary ||
      (typeof config.serverUrl === "string" && config.serverUrl.trim())
    ) {
      return yield* Effect.fail(
        new ProviderCliInstallError({
          detail:
            "Provider settings changed during installation. The downloaded runtime was not selected.",
        }),
      );
    }
    const live = yield* instances.getInstance(instanceId);
    if (live && (yield* live.adapter.listSessions()).length > 0) {
      return yield* Effect.fail(
        new ProviderCliInstallError({
          detail: "Stop this provider's sessions before changing its runtime.",
        }),
      );
    }
    // Updating the selected instance lets the existing registry rebuild every launch path,
    // including the SDK, text generation, and status probes, without a server restart.
    const changes: Record<string, ProviderInstanceConfig> = {
      [instanceId]: {
        ...current,
        config: { ...config, binaryPath: executable },
      },
    };
    const defaultCommand = driver === "claudeAgent" ? "claude" : driver;
    for (const other of yield* instances.listInstances) {
      if (other.instanceId === instanceId || other.driverKind !== driver) continue;
      const entry = entries[other.instanceId];
      if (!entry) continue;
      const otherConfig = isConfig(entry.config) ? entry.config : {};
      if (otherConfig.binaryPath && otherConfig.binaryPath !== defaultCommand) continue;
      if (otherConfig.serverUrl || (yield* other.adapter.listSessions()).length > 0) continue;
      changes[other.instanceId] = { ...entry, config: { ...otherConfig, binaryPath: executable } };
    }
    yield* settings.updateSettings({ providerInstances: changes });
  });

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
    const target = yield* cliTarget(input.instanceId);
    if (target) {
      const current = (yield* readEntries(input.instanceId, "install"))[input.instanceId];
      const config = isConfig(current?.config) ? current.config : {};
      const binary = typeof config.binaryPath === "string" ? config.binaryPath : "";
      const defaultCommand = target.driver === "claudeAgent" ? "claude" : target.driver;
      if (
        (binary &&
          binary !== defaultCommand &&
          !insideDirectory(binary, target.installation.directory(target.driver))) ||
        (typeof config.serverUrl === "string" && config.serverUrl.trim())
      ) {
        return yield* new ProviderSetupError({
          instanceId: input.instanceId,
          operation: "install",
          detail:
            "This instance uses a custom executable or server URL. Clear it before managing installation in T3 Code.",
        });
      }
      const live = yield* instances.getInstance(input.instanceId);
      if (live && (yield* live.adapter.listSessions()).length > 0) {
        return yield* new ProviderSetupError({
          instanceId: input.instanceId,
          operation: "install",
          detail: "Stop this provider's sessions before changing its runtime.",
        });
      }
      return yield* target.installation
        .start(target.driver, (executable) =>
          configureCli(input.instanceId, target.driver, executable, binary).pipe(
            Effect.mapError(cliFailure(input.instanceId, "install")),
          ),
        )
        .pipe(Effect.mapError(cliFailure(input.instanceId, "install")));
    }
    yield* requireInstance(input.instanceId, "install", true);
    return yield* installation.start.pipe(Effect.mapError(failure(input.instanceId)));
  });

  const cancel = Effect.fn("ProviderInstallation.cancel")(function* (
    input: ProviderInstallCancelInput,
  ) {
    const target = yield* cliTarget(input.instanceId);
    if (target)
      return yield* target.installation
        .cancel(target.driver, input.operationId)
        .pipe(Effect.mapError(cliFailure(input.instanceId, "cancel-install")));
    yield* requireInstance(input.instanceId, "cancel-install");
    return yield* installation
      .cancel(input.operationId)
      .pipe(Effect.mapError(failure(input.instanceId)));
  });

  const subscribe = (input: ProviderSetupInput) =>
    Stream.unwrap(
      Effect.gen(function* () {
        const target = yield* cliTarget(input.instanceId);
        if (target) return target.installation.changes(target.driver);
        yield* requireInstance(input.instanceId, "observe-install");
        return installation.changes;
      }),
    );

  const remove = Effect.fn("ProviderInstallation.remove")(function* (input: ProviderSetupInput) {
    const target = yield* cliTarget(input.instanceId);
    if (target) {
      const directory = target.installation.directory(target.driver);
      const deactivate = Effect.gen(function* () {
        const liveInstances = yield* instances.listInstances;
        if (
          liveInstances.some(
            (instance) => instance.driverKind === target.driver && instance.enabled,
          )
        ) {
          return yield* Effect.fail(
            new ProviderCliInstallError({
              detail: "Disable this provider's instances before removing the downloaded runtime.",
            }),
          );
        }
        const entries = yield* readEntries(input.instanceId, "remove-install");
        const changes: Record<string, ProviderInstanceConfig> = {};
        for (const [id, current] of Object.entries(entries)) {
          const config = isConfig(current.config) ? current.config : {};
          if (
            typeof config.binaryPath !== "string" ||
            !insideDirectory(config.binaryPath, directory)
          )
            continue;
          if (current.driver !== target.driver)
            return yield* Effect.fail(
              new ProviderCliInstallError({
                detail:
                  "Another provider uses this runtime. Clear its binary path before removing it.",
              }),
            );
          changes[id] = {
            ...current,
            config: {
              ...config,
              binaryPath: target.driver === "claudeAgent" ? "claude" : target.driver,
            },
          };
        }
        if (Object.keys(changes).length > 0)
          yield* settings.updateSettings({ providerInstances: changes });
      });
      return yield* target.installation
        .remove(
          target.driver,
          deactivate.pipe(Effect.mapError(cliFailure(input.instanceId, "remove-install"))),
        )
        .pipe(Effect.mapError(cliFailure(input.instanceId, "remove-install")));
    }
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
