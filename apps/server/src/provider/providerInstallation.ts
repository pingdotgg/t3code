import {
  AntigravitySettings,
  CodexSettings,
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

import * as CodexInstallation from "./CodexInstallation.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as AntigravityInstallation from "./AntigravityInstallation.ts";
import { deriveProviderInstanceConfigMap } from "./ProviderInstanceRegistryHydration.ts";
import * as ProviderInstanceRegistry from "./ProviderInstanceRegistry.ts";
import * as ProviderRegistry from "./ProviderRegistry.ts";
import { mergeProviderInstanceEnvironment } from "@t3tools/provider-core/server/instanceEnvironment";

const ANTIGRAVITY = ProviderDriverKind.make("antigravity");
const hasBinaryPath = Schema.is(Schema.Struct({ binaryPath: Schema.String }));
const decodeCodexSettings = Schema.decodeUnknownEffect(CodexSettings);
const decodeAntigravitySettings = Schema.decodeUnknownEffect(AntigravitySettings);

/** Route instance setup to the environment-owned installer without owning the download. */
export const makeProviderInstallation = Effect.fn("makeProviderInstallation")(function* () {
  const antigravityInstallation = yield* AntigravityInstallation.AntigravityInstallation;
  const codexInstallation = yield* CodexInstallation.CodexInstallation;
  const instances = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
  const providers = yield* ProviderRegistry.ProviderRegistry;
  const settings = yield* ServerSettings.ServerSettingsService;

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
    const isCodex = instance?.driverKind === ProviderDriverKind.make("codex");
    if (instance?.driverKind !== ANTIGRAVITY && !isCodex) {
      return yield* new ProviderSetupError({
        instanceId,
        operation,
        detail: "Managed installation is not available for this provider instance.",
      });
    }
    const installation = isCodex ? codexInstallation : antigravityInstallation;
    const entries = yield* readEntries(instanceId, operation);
    const invalidConfig = () =>
      new ProviderSetupError({
        instanceId,
        operation,
        detail: "The provider instance configuration is invalid.",
      });
    const config = isCodex
      ? yield* decodeCodexSettings(entries[instanceId]?.config ?? {}).pipe(
          Effect.mapError(invalidConfig),
        )
      : yield* decodeAntigravitySettings(entries[instanceId]?.config ?? {}).pipe(
          Effect.mapError(invalidConfig),
        );
    if (isCodex && (!("setupMode" in config) || config.setupMode !== "managed")) {
      return yield* new ProviderSetupError({
        instanceId,
        operation,
        detail: "Choose managed setup to install Codex in T3 Code.",
      });
    }
    if (managedOnly && config.binaryPath && (!isCodex || config.binaryPath !== "codex")) {
      return yield* new ProviderSetupError({
        instanceId,
        operation,
        detail:
          "This instance uses a custom executable. Clear its binary path to manage installation in T3 Code.",
      });
    }
    return { installation, driver: instance.driverKind };
  });

  const failure =
    (instanceId: ProviderInstanceId) =>
    (
      error:
        | AntigravityInstallation.AntigravityInstallationError
        | CodexInstallation.CodexInstallationError,
    ) =>
      new ProviderSetupError({ instanceId, operation: error.operation, detail: error.detail });

  const start = Effect.fn("ProviderInstallation.start")(function* (input: ProviderSetupInput) {
    const { installation } = yield* requireInstance(input.instanceId, "install", true);
    return yield* installation.start.pipe(Effect.mapError(failure(input.instanceId)));
  });

  const cancel = Effect.fn("ProviderInstallation.cancel")(function* (
    input: ProviderInstallCancelInput,
  ) {
    const { installation } = yield* requireInstance(input.instanceId, "cancel-install");
    return yield* installation
      .cancel(input.operationId)
      .pipe(Effect.mapError(failure(input.instanceId)));
  });

  const subscribe = (input: ProviderSetupInput) =>
    Stream.unwrap(
      requireInstance(input.instanceId, "observe-install").pipe(
        Effect.map(({ installation }) => installation.changes),
      ),
    );

  const remove = Effect.fn("ProviderInstallation.remove")(function* (input: ProviderSetupInput) {
    const { installation, driver } = yield* requireInstance(
      input.instanceId,
      "remove-install",
      true,
    );
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
        Effect.orElseSucceed(() => [binaryPath]),
      );
    });
    yield* installation
      .remove(protectedPaths.flat())
      .pipe(Effect.mapError(failure(input.instanceId)));
    const allInstances = yield* instances.listInstances;
    yield* Effect.forEach(
      allInstances.filter((instance) => instance.driverKind === driver),
      (instance) => providers.refreshInstance(instance.instanceId),
      { discard: true },
    );
    return yield* installation.state;
  });

  return { start, cancel, subscribe, remove };
});
