import {
  defaultInstanceIdForDriver,
  isProviderWorkspaceSnapshotCurrent,
  ProviderDriverKind,
  type ProviderInstanceId,
  type ServerProvider,
  type ServerProviderUpdateState,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as Semaphore from "effect/Semaphore";

import * as ProviderLatestVersions from "@t3tools/provider-core/server/ProviderLatestVersions";
import * as ModelManifest from "./ModelManifest.ts";
import { applyProviderCompatibility } from "./providerCompatibility.ts";
import * as ServerConfig from "../config.ts";
import * as ProviderInstanceRegistry from "./ProviderInstanceRegistry.ts";
import * as ProviderInstanceRegistryMutator from "./ProviderInstanceRegistryMutator.ts";
import {
  hydrateCachedProvider,
  isCachedProviderCorrelated,
  orderProviderSnapshots,
  readProviderStatusCache,
  resolveProviderStatusCachePath,
  writeProviderStatusCache,
} from "./providerStatusCache.ts";
import type {
  ProviderInstance,
  ProviderWorkspaceSnapshot,
} from "@t3tools/provider-core/server/driver";
import {
  makeManualOnlyProviderMaintenanceCapabilities,
  type ProviderMaintenanceCapabilities,
  latestProviderVersionCacheKeys,
} from "@t3tools/provider-core/server/maintenanceResolver";
import type { ProviderSnapshotSource } from "./builtInProviderCatalog.ts";
import { buildSnapshotSource, correlateSnapshotWithSource, dropProviderWorkspaceSnapshot, haveProvidersChanged, loadProviders, makeManualProviderMaintenanceCapabilities, mergeProviderSnapshot, snapshotInstanceKey, upsertProviderWorkspaceSnapshot } from "./ProviderRegistry-part2.ts";

export type ProviderMaintenanceActionKind = "update";

export class ProviderRegistry extends Context.Service<
  ProviderRegistry,
  {
    readonly getProviders: Effect.Effect<ReadonlyArray<ServerProvider>>;

    readonly refresh: (
      provider?: ProviderDriverKind,
    ) => Effect.Effect<ReadonlyArray<ServerProvider>>;

    /** Unknown instance ids return the cached list without error. */
    readonly refreshInstance: (
      instanceId: ProviderInstanceId,
    ) => Effect.Effect<ReadonlyArray<ServerProvider>>;

    /** Re-reads secret-backed environments first, so a fixed secret applies without a restart. */
    readonly reloadSecretsAndRefresh: (
      instanceId?: ProviderInstanceId,
    ) => Effect.Effect<ReadonlyArray<ServerProvider>>;

    /** Only refreshed instances can verify an update; the published list still includes every row. */
    readonly refreshAfterUpdate: (
      provider: ProviderDriverKind,
      selectedInstanceId: ProviderInstanceId,
    ) => Effect.Effect<ReadonlyArray<ServerProvider>>;

    readonly refreshWorkspaceSnapshot: (input: {
      readonly instanceId: ProviderInstanceId;
      readonly cwd: string;
      readonly fresh?: boolean;
    }) => Effect.Effect<ReadonlyArray<ServerProvider>>;

    /**
     * Drop T3-owned model caches before an explicit model refresh. Pass the
     * target of the refresh that follows. Background and ordinary refreshes
     * keep their cache timers and must not call this.
     */
    readonly invalidateModelCaches: (input: {
      readonly instanceId?: ProviderInstanceId | undefined;
      readonly cwd?: string | undefined;
      readonly fresh?: boolean | undefined;
    }) => Effect.Effect<void>;

    readonly getProviderMaintenanceCapabilitiesForInstance: (
      instanceId: ProviderInstanceId,
      provider: ProviderDriverKind,
      options?: { readonly fresh?: boolean },
    ) => Effect.Effect<ProviderMaintenanceCapabilities>;

    readonly setProviderMaintenanceActionState: (input: {
      readonly instanceId: ProviderInstanceId;
      readonly action: ProviderMaintenanceActionKind;
      readonly state: ServerProviderUpdateState | null;
    }) => Effect.Effect<ReadonlyArray<ServerProvider>>;

    readonly streamChanges: Stream.Stream<ReadonlyArray<ServerProvider>>;
  }
>()("t3/provider/ProviderRegistry") {}

import { makeProviderRegistryShape } from "./ProviderRegistryParts.ts";

export const layer: Layer.Layer<
  ProviderRegistry,
  never,
  | ProviderInstanceRegistry.ProviderInstanceRegistry
  | ProviderInstanceRegistryMutator.ProviderInstanceRegistryMutator
  | ModelManifest.ModelManifest
  | ProviderLatestVersions.ProviderLatestVersions
  | ServerConfig.ServerConfig
  | FileSystem.FileSystem
  | Path.Path
> = Layer.effect(
  ProviderRegistry,
  Effect.gen(function* () {
    return ProviderRegistry.of(yield* makeProviderRegistryShape);
  }),
);
export * from "./ProviderRegistry-part2.ts";
export * from "./ProviderRegistryParts.ts";
