import {
  PluginManagementError,
  type PluginCatalogResult,
  type PluginCheckUpdatesResult,
  type PluginInstallBeginInput,
  type PluginInstallConfirmResult,
  type PluginInstallStaged,
  type PluginSetEnabledInput,
  type PluginSource,
  type PluginSourcesAddInput,
  type PluginSourcesAddResult,
  type PluginSourcesListResult,
  type PluginSourcesRemoveInput,
  type PluginUninstallInput,
  type PluginUpgradeBeginInput,
  type PluginUpgradeConfirmResult,
} from "@t3tools/contracts/plugin";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import { PluginInstaller } from "./PluginInstaller.ts";
import { PluginLockfileStore } from "./PluginLockfileStore.ts";
import { PluginMarketplace, sourceIdForUrl } from "./PluginMarketplace.ts";

const managementError = (code: PluginManagementError["code"], message: string, data?: unknown) =>
  new PluginManagementError({
    code,
    message,
    ...(data === undefined ? {} : { data }),
  });

const lockfileError = (cause: unknown) =>
  managementError(
    "lockfile",
    cause instanceof Error ? cause.message : "Plugin lockfile update failed.",
    {
      cause,
    },
  );
const isPluginManagementError = Schema.is(PluginManagementError);
const toManagementError = (cause: unknown) =>
  isPluginManagementError(cause) ? cause : lockfileError(cause);

export class PluginManagementRpcHandlers extends Context.Service<
  PluginManagementRpcHandlers,
  {
    readonly listSources: Effect.Effect<PluginSourcesListResult, PluginManagementError>;
    readonly addSource: (
      input: PluginSourcesAddInput,
    ) => Effect.Effect<PluginSourcesAddResult, PluginManagementError>;
    readonly removeSource: (
      input: PluginSourcesRemoveInput,
    ) => Effect.Effect<void, PluginManagementError>;
    readonly catalog: (input: {
      readonly sourceId?: string;
    }) => Effect.Effect<PluginCatalogResult, PluginManagementError>;
    readonly beginInstall: (
      input: PluginInstallBeginInput,
    ) => Effect.Effect<PluginInstallStaged, PluginManagementError>;
    readonly confirmInstall: (
      stageToken: string,
    ) => Effect.Effect<PluginInstallConfirmResult, PluginManagementError>;
    readonly abortInstall: (stageToken: string) => Effect.Effect<void, PluginManagementError>;
    readonly setEnabled: (
      input: PluginSetEnabledInput,
    ) => Effect.Effect<void, PluginManagementError>;
    readonly uninstall: (input: PluginUninstallInput) => Effect.Effect<void, PluginManagementError>;
    readonly beginUpgrade: (
      input: PluginUpgradeBeginInput,
    ) => Effect.Effect<PluginInstallStaged, PluginManagementError>;
    readonly confirmUpgrade: (
      stageToken: string,
    ) => Effect.Effect<PluginUpgradeConfirmResult, PluginManagementError>;
    readonly checkUpdates: Effect.Effect<PluginCheckUpdatesResult, PluginManagementError>;
  }
>()("t3/plugins/PluginManagementRpcHandlers") {}

export const make = Effect.fn("PluginManagementRpcHandlers.make")(function* () {
  const store = yield* PluginLockfileStore;
  const marketplace = yield* PluginMarketplace;
  const installer = yield* PluginInstaller;

  const listSources = store.readLockfile.pipe(
    Effect.map((lockfile) => ({ sources: Array.from(lockfile.sources) })),
    Effect.mapError(lockfileError),
  );

  const addSource: PluginManagementRpcHandlers["Service"]["addSource"] = (input) =>
    Effect.gen(function* () {
      const normalized = yield* marketplace.normalizeSourceUrl(input.url);
      const id = sourceIdForUrl(normalized);
      const now = DateTime.formatIso(yield* DateTime.now);
      const source = yield* store
        .updateSources((sources) => {
          const existing = sources.find((candidate) => candidate.url === normalized);
          if (existing) return Effect.succeed(sources);
          return Effect.succeed([...sources, { id, url: normalized, addedAt: now }]);
        })
        .pipe(Effect.mapError(toManagementError));
      const entry = source.sources.find((candidate) => candidate.url === normalized);
      if (!entry) {
        return yield* managementError("invalid-source", "Failed to add plugin source.", {
          url: normalized,
        });
      }
      return { source: entry };
    });

  const removeSource: PluginManagementRpcHandlers["Service"]["removeSource"] = (input) =>
    Effect.gen(function* () {
      const lockfile = yield* store.readLockfile.pipe(Effect.mapError(lockfileError));
      if (!lockfile.sources.some((source) => source.id === input.sourceId)) {
        return yield* managementError("source-not-found", "Plugin source was not found.", {
          sourceId: input.sourceId,
        });
      }
      const usedBy = Object.entries(lockfile.plugins).find(
        ([, plugin]) => plugin.sourceId === input.sourceId,
      )?.[0];
      if (usedBy) {
        return yield* managementError(
          "invalid-source",
          "Plugin source is still used by an installed plugin.",
          {
            sourceId: input.sourceId,
            pluginId: usedBy,
          },
        );
      }
      yield* store
        .updateSources((sources) =>
          Effect.succeed(sources.filter((source) => source.id !== input.sourceId)),
        )
        .pipe(Effect.asVoid, Effect.mapError(toManagementError));
    });

  const catalog: PluginManagementRpcHandlers["Service"]["catalog"] = (input) =>
    Effect.gen(function* () {
      const lockfile = yield* store.readLockfile.pipe(Effect.mapError(lockfileError));
      return yield* marketplace.catalog(
        lockfile.sources as ReadonlyArray<PluginSource>,
        input.sourceId,
      );
    });

  return PluginManagementRpcHandlers.of({
    listSources,
    addSource,
    removeSource,
    catalog,
    beginInstall: installer.beginInstall,
    confirmInstall: installer.confirmInstall,
    abortInstall: installer.abortInstall,
    setEnabled: installer.setEnabled,
    uninstall: installer.uninstall,
    beginUpgrade: installer.beginUpgrade,
    confirmUpgrade: installer.confirmUpgrade,
    checkUpdates: installer.checkUpdates,
  });
});

export const layer = Layer.effect(PluginManagementRpcHandlers, make());
