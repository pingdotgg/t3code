import type {
  PluginCatalogEntry,
  PluginCommandName,
  PluginId,
  PluginManifest,
  PluginStatus,
  PluginSubscriptionEvent,
  PluginUiPlacementId,
} from "@t3tools/contracts";
import { PluginRpcError } from "@t3tools/contracts";
import type { LoadedServerPlugin, PluginPackageDescriptor } from "@t3tools/plugin-api/package";
import type { PluginCommandRegistration } from "@t3tools/plugin-api/server";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { pluginClientAssetUrl } from "./PluginAssets.ts";

type CommandKey = `${PluginId}:${PluginCommandName}`;
type BadgeKey = `${PluginId}:${PluginUiPlacementId}`;

const CATALOG_BADGE_PROVIDER_CONCURRENCY = 4;

interface StoredCommandRegistration {
  readonly invoke: (input: unknown) => Effect.Effect<unknown, PluginRpcError>;
}

interface PluginRecord {
  readonly manifest: PluginManifest;
  readonly descriptor: PluginPackageDescriptor;
  readonly status: PluginStatus["status"];
  readonly diagnostics: ReadonlyArray<string>;
}

function commandKey(pluginId: PluginId, command: PluginCommandName): CommandKey {
  return `${pluginId}:${command}` as CommandKey;
}

function badgeKey(pluginId: PluginId, placementId: PluginUiPlacementId): BadgeKey {
  return `${pluginId}:${placementId}` as BadgeKey;
}

function normalizeBadgeCount(count: number): number {
  return Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0;
}

export interface PluginRegistryShape {
  readonly registerActivePlugin: (plugin: LoadedServerPlugin) => Effect.Effect<void>;
  readonly registerFailedPlugin: (
    plugin: LoadedServerPlugin,
    diagnostic: string,
  ) => Effect.Effect<void>;
  readonly registerCommand: <I, O>(
    pluginId: PluginId,
    command: PluginCommandName,
    registration: PluginCommandRegistration<I, O>,
  ) => Effect.Effect<void>;
  readonly setPlacementBadgeProvider: (
    pluginId: PluginId,
    placementId: PluginUiPlacementId,
    provider: () => Effect.Effect<number, Error>,
  ) => Effect.Effect<void>;
  readonly clearPluginContributions: (pluginId: PluginId) => Effect.Effect<void>;
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
  const commandByKey = new Map<CommandKey, StoredCommandRegistration>();
  const placementBadgeProviderByKey = new Map<BadgeKey, () => Effect.Effect<number, Error>>();
  const events = yield* PubSub.unbounded<PluginSubscriptionEvent>();

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

  const placementCatalogContributionFor = (
    record: PluginRecord,
    placement: PluginManifest["ui"]["placements"][number],
  ) =>
    Effect.gen(function* () {
      const provider = placementBadgeProviderByKey.get(badgeKey(record.manifest.id, placement.id));
      const badgeCount =
        provider === undefined
          ? (placement.badgeCount ?? 0)
          : yield* provider().pipe(
              Effect.map(normalizeBadgeCount),
              Effect.catch(() => Effect.succeed(placement.badgeCount ?? 0)),
            );

      return {
        ...placement,
        ...(badgeCount > 0 ? { badgeCount } : {}),
      };
    });

  const catalogEntryFor = (record: PluginRecord): Effect.Effect<PluginCatalogEntry> =>
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

  return PluginRegistry.of({
    registerActivePlugin: (plugin) =>
      Effect.sync(() => {
        pluginById.set(plugin.manifest.id, {
          manifest: plugin.manifest,
          descriptor: plugin.descriptor,
          status: "active",
          diagnostics: [],
        });
      }),

    registerFailedPlugin: (plugin, diagnostic) =>
      Effect.sync(() => {
        pluginById.set(plugin.manifest.id, {
          manifest: plugin.manifest,
          descriptor: plugin.descriptor,
          status: "failed",
          diagnostics: [diagnostic],
        });
      }),

    registerCommand: <I, O>(
      pluginId: PluginId,
      command: PluginCommandName,
      registration: PluginCommandRegistration<I, O>,
    ) =>
      Effect.sync(() => {
        const decodeInput = Schema.decodeUnknownEffect(registration.input);
        const decodeOutput = Schema.decodeUnknownEffect(registration.output);
        commandByKey.set(commandKey(pluginId, command), {
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
            ),
        });
      }),

    setPlacementBadgeProvider: (pluginId, placementId, provider) =>
      Effect.sync(() => {
        placementBadgeProviderByKey.set(badgeKey(pluginId, placementId), provider);
      }),

    clearPluginContributions: (pluginId) =>
      Effect.sync(() => {
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
      }),

    listCatalog: Effect.gen(function* () {
      const records = Array.from(pluginById.values());
      return yield* Effect.forEach(records, catalogEntryFor, {
        concurrency: CATALOG_BADGE_PROVIDER_CONCURRENCY,
      });
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
          plugin
            ? Effect.succeed(plugin.descriptor.clientEntryPath)
            : Effect.fail(
                toRpcError({
                  message: `Plugin ${pluginId} was not found.`,
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
