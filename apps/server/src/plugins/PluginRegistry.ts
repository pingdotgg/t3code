import type {
  PluginCatalogEntry,
  PluginCommandName,
  PluginDiscoveryFailure,
  PluginId,
  PluginManifest,
  PluginManifestCatalogEntry,
  PluginStatus,
  PluginSubscriptionEvent,
  PluginUiPlacementId,
} from "@t3tools/contracts";
import { PluginRpcError } from "@t3tools/contracts";
import type {
  FailedPluginDiscovery,
  FailedServerPlugin,
  LoadedServerPlugin,
  PluginPackageDescriptor,
} from "@t3tools/plugin-api/package";
import type { PluginCommandRegistration } from "@t3tools/plugin-api/server";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import { pluginClientAssetUrl } from "./PluginAssets.ts";

type CommandKey = `${PluginId}:${PluginCommandName}`;
type BadgeKey = `${PluginId}:${PluginUiPlacementId}`;
type PluginActivationId = string & { readonly __brand: "PluginActivationId" };

const CATALOG_BADGE_PROVIDER_CONCURRENCY = 4;

interface StoredCommandRegistration {
  readonly invoke: (input: unknown) => Effect.Effect<unknown, PluginRpcError>;
}

interface StoredPlacementBadgeProvider {
  readonly invoke: () => Effect.Effect<number, Error>;
}

interface PluginRecord {
  readonly manifest: PluginManifest;
  readonly descriptor: PluginPackageDescriptor;
  readonly status: PluginStatus["status"];
  readonly diagnostics: ReadonlyArray<string>;
}

interface DiscoveryFailureRecord {
  readonly discovery: PluginDiscoveryFailure;
  readonly diagnostics: ReadonlyArray<string>;
}

interface ActivationRecord {
  readonly id: PluginActivationId;
  readonly manifest: PluginManifest;
  readonly scope: Scope.Scope;
  readonly commands: Map<PluginCommandName, StoredCommandRegistration>;
  readonly placementBadgeProviders: Map<PluginUiPlacementId, StoredPlacementBadgeProvider>;
}

export interface PluginActivationRegistration {
  readonly pluginId: PluginId;
  readonly registerCommand: <I, O>(
    command: PluginCommandName,
    registration: PluginCommandRegistration<I, O>,
  ) => Effect.Effect<void, PluginRpcError>;
  readonly setPlacementBadgeProvider: (
    placementId: PluginUiPlacementId,
    provider: () => Effect.Effect<number, Error>,
  ) => Effect.Effect<void, PluginRpcError>;
  readonly commitActive: Effect.Effect<ReadonlyArray<PluginId>, PluginRpcError>;
  readonly commitFailed: (
    diagnostic: string,
  ) => Effect.Effect<ReadonlyArray<PluginId>, PluginRpcError>;
  readonly cancel: Effect.Effect<void>;
}

function commandKey(pluginId: PluginId, command: PluginCommandName): CommandKey {
  return `${pluginId}:${command}` as CommandKey;
}

function badgeKey(pluginId: PluginId, placementId: PluginUiPlacementId): BadgeKey {
  return `${pluginId}:${placementId}` as BadgeKey;
}

function discoveryFailureKey(discovery: PluginDiscoveryFailure): string {
  return discoveryFailureKeyForPackageRoot(discovery.packageRoot);
}

function discoveryFailureKeyForPackageRoot(packageRoot: string): string {
  return `package:${packageRoot}`;
}

function normalizeBadgeCount(count: number): number {
  return Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0;
}

function isServerManifestCommand(manifest: PluginManifest, command: PluginCommandName): boolean {
  return manifest.commands.some(
    (manifestCommand) => manifestCommand.target === "server" && manifestCommand.name === command,
  );
}

export interface PluginRegistryShape {
  readonly beginActivation: (
    plugin: LoadedServerPlugin,
    scope: Scope.Scope,
  ) => Effect.Effect<PluginActivationRegistration>;
  readonly registerFailedPlugin: (
    plugin: LoadedServerPlugin | FailedServerPlugin,
    diagnostic: string,
  ) => Effect.Effect<ReadonlyArray<PluginId>>;
  readonly registerFailedDiscovery: (
    plugin: FailedPluginDiscovery,
    diagnostic: string,
  ) => Effect.Effect<ReadonlyArray<PluginId>>;
  readonly listCatalog: Effect.Effect<ReadonlyArray<PluginCatalogEntry>, PluginRpcError>;
  readonly invoke: (
    pluginId: PluginId,
    command: PluginCommandName,
    input: unknown,
  ) => Effect.Effect<unknown, PluginRpcError>;
  readonly getClientAssetPath: (pluginId: PluginId) => Effect.Effect<string, PluginRpcError>;
  readonly publish: (
    pluginId: PluginId,
    event: Omit<PluginSubscriptionEvent, "pluginId" | "createdAt">,
  ) => Effect.Effect<void>;
  readonly subscribe: (pluginId?: PluginId) => Stream.Stream<PluginSubscriptionEvent, never, never>;
}

export class PluginRegistry extends Context.Service<PluginRegistry, PluginRegistryShape>()(
  "t3/plugins/PluginRegistry",
) {}

const makePluginRegistry = Effect.gen(function* () {
  const pluginById = new Map<PluginId, PluginRecord>();
  const pluginIdByPackageRoot = new Map<string, PluginId>();
  const discoveryFailureByKey = new Map<string, DiscoveryFailureRecord>();
  const activationById = new Map<PluginId, ActivationRecord>();
  const commandByKey = new Map<CommandKey, StoredCommandRegistration>();
  const placementBadgeProviderByKey = new Map<BadgeKey, StoredPlacementBadgeProvider>();
  const events = yield* PubSub.unbounded<PluginSubscriptionEvent>();
  let activationSequence = 0;

  const toRpcError = (input: {
    readonly message: string;
    readonly pluginId?: PluginId;
    readonly command?: PluginCommandName;
    readonly cause?: unknown;
  }) =>
    new PluginRpcError({
      message: input.message,
      ...(input.pluginId !== undefined ? { pluginId: input.pluginId } : {}),
      ...(input.command !== undefined ? { command: input.command } : {}),
      ...(input.cause !== undefined ? { cause: input.cause } : {}),
    });

  const nextActivationId = () => {
    activationSequence += 1;
    return `activation-${activationSequence}` as PluginActivationId;
  };

  const requireActivation = (pluginId: PluginId, activationId: PluginActivationId) => {
    const activation = activationById.get(pluginId);
    return activation?.id === activationId ? activation : null;
  };

  const registerCommandForActivation = <I, O>(
    pluginId: PluginId,
    activationId: PluginActivationId,
    command: PluginCommandName,
    registration: PluginCommandRegistration<I, O>,
  ) =>
    Effect.gen(function* () {
      const activation = requireActivation(pluginId, activationId);
      if (!activation || !isServerManifestCommand(activation.manifest, command)) {
        return yield* toRpcError({
          message: `Plugin command ${command} is not declared as a server command.`,
          pluginId,
          command,
        });
      }
      const decodeInput = Schema.decodeUnknownEffect(registration.input);
      const decodeOutput = Schema.decodeUnknownEffect(registration.output);
      activation.commands.set(command, {
        invoke: (value) =>
          decodeInput(value).pipe(
            Effect.mapError((cause) =>
              toRpcError({
                message: `Invalid input for plugin command ${command}.`,
                pluginId,
                command,
                cause,
              }),
            ),
            Effect.flatMap((decodedInput) =>
              registration.handler(decodedInput).pipe(
                Effect.mapError((cause) =>
                  toRpcError({
                    message: `Plugin command ${command} failed.`,
                    pluginId,
                    command,
                    cause,
                  }),
                ),
              ),
            ),
            Effect.flatMap((output) =>
              decodeOutput(output).pipe(
                Effect.mapError((cause) =>
                  toRpcError({
                    message: `Invalid output for plugin command ${command}.`,
                    pluginId,
                    command,
                    cause,
                  }),
                ),
              ),
            ),
            (effect) =>
              Effect.acquireUseRelease(
                effect.pipe(Effect.forkIn(activation.scope)),
                Fiber.join,
                (fiber) => Fiber.interrupt(fiber).pipe(Effect.asVoid),
              ),
          ),
      });
    });

  const setPlacementBadgeProviderForActivation = (
    pluginId: PluginId,
    activationId: PluginActivationId,
    placementId: PluginUiPlacementId,
    provider: () => Effect.Effect<number, Error>,
  ) =>
    Effect.gen(function* () {
      const activation = requireActivation(pluginId, activationId);
      if (!activation) {
        return yield* toRpcError({
          message: `Plugin ${pluginId} is not activating.`,
          pluginId,
        });
      }
      const declaredPlacement = activation.manifest.ui.placements.some(
        (placement) => placement.id === placementId,
      );
      if (!declaredPlacement) {
        return yield* toRpcError({
          message: `Plugin placement ${placementId} is not declared in the manifest.`,
          pluginId,
        });
      }
      activation.placementBadgeProviders.set(placementId, {
        invoke: () =>
          Effect.acquireUseRelease(
            Effect.suspend(provider).pipe(Effect.forkIn(activation.scope)),
            Fiber.join,
            (fiber) => Fiber.interrupt(fiber).pipe(Effect.asVoid),
          ),
      });
    });

  const placementCatalogContributionFor = (
    record: PluginRecord,
    placement: PluginManifest["ui"]["placements"][number],
  ) =>
    Effect.gen(function* () {
      const provider = placementBadgeProviderByKey.get(badgeKey(record.manifest.id, placement.id));
      const badgeCount =
        provider === undefined
          ? (placement.badgeCount ?? 0)
          : yield* provider.invoke().pipe(
              Effect.map(normalizeBadgeCount),
              Effect.catch(() => Effect.succeed(placement.badgeCount ?? 0)),
            );

      return {
        ...placement,
        ...(badgeCount > 0 ? { badgeCount } : {}),
      };
    });

  const catalogEntryFor = (record: PluginRecord): Effect.Effect<PluginManifestCatalogEntry> =>
    Effect.gen(function* () {
      const placements = yield* Effect.forEach(
        record.manifest.ui.placements,
        (placement) => placementCatalogContributionFor(record, placement),
        { concurrency: CATALOG_BADGE_PROVIDER_CONCURRENCY },
      );
      return {
        manifest: {
          ...record.manifest,
          ui: {
            ...record.manifest.ui,
            placements,
          },
        },
        status: {
          pluginId: record.manifest.id,
          status: record.status,
          ...(record.diagnostics.length > 0 ? { diagnostics: [...record.diagnostics] } : {}),
        },
        assets: {
          client: pluginClientAssetUrl(record.manifest.id),
        },
      };
    });

  const discoveryFailureCatalogEntryFor = (record: DiscoveryFailureRecord): PluginCatalogEntry => ({
    discovery: record.discovery,
    status: {
      ...(record.discovery.pluginId !== undefined ? { pluginId: record.discovery.pluginId } : {}),
      status: "failed",
      ...(record.diagnostics.length > 0 ? { diagnostics: [...record.diagnostics] } : {}),
    },
  });

  const clearPluginContributionsSync = (pluginId: PluginId) => {
    const prefix = `${pluginId}:`;
    for (const key of commandByKey.keys()) {
      if (key.startsWith(prefix)) {
        commandByKey.delete(key);
      }
    }
    for (const key of placementBadgeProviderByKey.keys()) {
      if (key.startsWith(prefix)) {
        placementBadgeProviderByKey.delete(key);
      }
    }
  };

  const clearPluginRecordSync = (pluginId: PluginId): ReadonlyArray<PluginId> => {
    const record = pluginById.get(pluginId);
    activationById.delete(pluginId);
    pluginById.delete(pluginId);
    clearPluginContributionsSync(pluginId);
    if (record === undefined) {
      return [];
    }
    pluginIdByPackageRoot.delete(record.descriptor.packageRoot);
    return [pluginId];
  };

  const clearPluginRecordForPackageRootSync = (
    packageRoot: string,
    exceptPluginId?: PluginId,
  ): ReadonlyArray<PluginId> => {
    const pluginId = pluginIdByPackageRoot.get(packageRoot);
    return pluginId === undefined || pluginId === exceptPluginId
      ? []
      : clearPluginRecordSync(pluginId);
  };

  const clearDiscoveryFailuresForPackageRoot = (packageRoot: string) => {
    discoveryFailureByKey.delete(discoveryFailureKeyForPackageRoot(packageRoot));
  };

  const clearDiscoveryFailuresForPluginId = (pluginId: PluginId) => {
    for (const [key, record] of discoveryFailureByKey) {
      if (record.discovery.pluginId === pluginId) {
        discoveryFailureByKey.delete(key);
      }
    }
  };

  const commitActivationContributionsSync = (pluginId: PluginId, activation: ActivationRecord) => {
    for (const [command, registration] of activation.commands) {
      commandByKey.set(commandKey(pluginId, command), registration);
    }
    for (const [placementId, provider] of activation.placementBadgeProviders) {
      placementBadgeProviderByKey.set(badgeKey(pluginId, placementId), provider);
    }
  };

  const commitActiveActivation = (plugin: LoadedServerPlugin, activationId: PluginActivationId) =>
    Effect.gen(function* () {
      const activation = requireActivation(plugin.manifest.id, activationId);
      if (!activation) {
        return yield* toRpcError({
          message: `Plugin ${plugin.manifest.id} activation is not active.`,
          pluginId: plugin.manifest.id,
        });
      }

      return yield* Effect.sync(() => {
        const displacedPluginIds = clearPluginRecordForPackageRootSync(
          plugin.descriptor.packageRoot,
          plugin.manifest.id,
        );
        activationById.delete(plugin.manifest.id);
        const previousRecord = pluginById.get(plugin.manifest.id);
        if (
          previousRecord !== undefined &&
          previousRecord.descriptor.packageRoot !== plugin.descriptor.packageRoot
        ) {
          pluginIdByPackageRoot.delete(previousRecord.descriptor.packageRoot);
        }
        clearPluginContributionsSync(plugin.manifest.id);
        clearDiscoveryFailuresForPackageRoot(plugin.descriptor.packageRoot);
        clearDiscoveryFailuresForPluginId(plugin.manifest.id);
        pluginById.set(plugin.manifest.id, {
          manifest: plugin.manifest,
          descriptor: plugin.descriptor,
          status: "active",
          diagnostics: [],
        });
        pluginIdByPackageRoot.set(plugin.descriptor.packageRoot, plugin.manifest.id);
        commitActivationContributionsSync(plugin.manifest.id, activation);
        return displacedPluginIds;
      });
    });

  const commitFailedActivation = (
    plugin: LoadedServerPlugin,
    activationId: PluginActivationId,
    diagnostic: string,
  ) =>
    Effect.gen(function* () {
      const activation = requireActivation(plugin.manifest.id, activationId);
      if (!activation) {
        return yield* toRpcError({
          message: `Plugin ${plugin.manifest.id} activation is not active.`,
          pluginId: plugin.manifest.id,
        });
      }
      return yield* registerFailedPluginRecord(plugin, diagnostic);
    });

  const cancelActivation = (pluginId: PluginId, activationId: PluginActivationId) =>
    Effect.sync(() => {
      const activation = activationById.get(pluginId);
      if (activation?.id === activationId) {
        activationById.delete(pluginId);
      }
    });

  const registerFailedPluginRecord = (
    plugin: LoadedServerPlugin | FailedServerPlugin,
    diagnostic: string,
  ) =>
    Effect.sync(() => {
      const displacedPluginIds = clearPluginRecordForPackageRootSync(
        plugin.descriptor.packageRoot,
        plugin.manifest.id,
      );
      const previousRecord = pluginById.get(plugin.manifest.id);
      if (
        previousRecord !== undefined &&
        previousRecord.descriptor.packageRoot !== plugin.descriptor.packageRoot
      ) {
        pluginIdByPackageRoot.delete(previousRecord.descriptor.packageRoot);
      }
      clearPluginContributionsSync(plugin.manifest.id);
      activationById.delete(plugin.manifest.id);
      clearDiscoveryFailuresForPackageRoot(plugin.descriptor.packageRoot);
      clearDiscoveryFailuresForPluginId(plugin.manifest.id);
      pluginById.set(plugin.manifest.id, {
        manifest: plugin.manifest,
        descriptor: plugin.descriptor,
        status: "failed",
        diagnostics: [diagnostic],
      });
      pluginIdByPackageRoot.set(plugin.descriptor.packageRoot, plugin.manifest.id);
      return displacedPluginIds;
    });

  return PluginRegistry.of({
    beginActivation: (plugin, scope) =>
      Effect.sync(() => {
        const activationId = nextActivationId();
        const pluginId = plugin.manifest.id;
        activationById.set(pluginId, {
          id: activationId,
          manifest: plugin.manifest,
          scope,
          commands: new Map(),
          placementBadgeProviders: new Map(),
        });
        return {
          pluginId,
          registerCommand: (command, registration) =>
            registerCommandForActivation(pluginId, activationId, command, registration),
          setPlacementBadgeProvider: (placementId, provider) =>
            setPlacementBadgeProviderForActivation(pluginId, activationId, placementId, provider),
          commitActive: commitActiveActivation(plugin, activationId),
          commitFailed: (diagnostic) => commitFailedActivation(plugin, activationId, diagnostic),
          cancel: cancelActivation(pluginId, activationId),
        } satisfies PluginActivationRegistration;
      }),

    registerFailedPlugin: registerFailedPluginRecord,

    registerFailedDiscovery: (plugin, diagnostic) =>
      Effect.sync(() => {
        const displacedPluginIds = new Set<PluginId>(
          clearPluginRecordForPackageRootSync(
            plugin.discovery.packageRoot,
            plugin.discovery.pluginId,
          ),
        );
        const pluginId = plugin.discovery.pluginId;
        if (pluginId !== undefined) {
          for (const displacedPluginId of clearPluginRecordSync(pluginId)) {
            displacedPluginIds.add(displacedPluginId);
          }
          discoveryFailureByKey.delete(
            discoveryFailureKeyForPackageRoot(plugin.discovery.packageRoot),
          );
        }
        discoveryFailureByKey.set(discoveryFailureKey(plugin.discovery), {
          discovery: plugin.discovery,
          diagnostics: [diagnostic],
        });
        return [...displacedPluginIds];
      }),

    listCatalog: Effect.gen(function* () {
      const records = Array.from(pluginById.values());
      const manifestEntries = yield* Effect.forEach(records, catalogEntryFor, {
        concurrency: CATALOG_BADGE_PROVIDER_CONCURRENCY,
      });
      const discoveryEntries = Array.from(discoveryFailureByKey.values()).map(
        discoveryFailureCatalogEntryFor,
      );
      return [...manifestEntries, ...discoveryEntries];
    }).pipe(Effect.mapError((cause) => toRpcError({ message: "Failed to list plugins.", cause }))),

    invoke: (pluginId, command, input) =>
      Effect.gen(function* () {
        const plugin = pluginById.get(pluginId);
        if (!plugin || plugin.status !== "active") {
          return yield* toRpcError({
            message: `Plugin ${pluginId} is not active.`,
            pluginId,
            command,
          });
        }

        if (!isServerManifestCommand(plugin.manifest, command)) {
          return yield* toRpcError({
            message: `Plugin command ${command} is not declared as a server command.`,
            pluginId,
            command,
          });
        }

        const registration = commandByKey.get(commandKey(pluginId, command));
        if (!registration) {
          return yield* toRpcError({
            message: `Plugin command ${command} is not registered.`,
            pluginId,
            command,
          });
        }

        return yield* registration.invoke(input);
      }),

    getClientAssetPath: (pluginId) =>
      Effect.sync(() => pluginById.get(pluginId)).pipe(
        Effect.flatMap((plugin) =>
          plugin?.status === "active"
            ? Effect.succeed(plugin.descriptor.clientEntryPath)
            : Effect.fail(
                toRpcError({
                  message: `Plugin ${pluginId} is not active.`,
                  pluginId,
                }),
              ),
        ),
      ),

    publish: (pluginId, event) =>
      DateTime.now.pipe(
        Effect.flatMap((now) =>
          PubSub.publish(events, {
            ...event,
            pluginId,
            createdAt: DateTime.formatIso(now),
          }),
        ),
      ),

    subscribe: (pluginId) =>
      Stream.fromPubSub(events).pipe(
        Stream.filter((event) => pluginId === undefined || event.pluginId === pluginId),
      ),
  });
});

export const PluginRegistryLive = Layer.effect(PluginRegistry, makePluginRegistry);
