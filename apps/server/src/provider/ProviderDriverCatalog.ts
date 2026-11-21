import { builtinServiceLayer } from "../plugins/PluginKernel.ts";
import { ProviderDriverKind } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import { BUILT_IN_PROVIDER_PLUGIN_DEFINITIONS, type BuiltInDriversEnv } from "./builtInDrivers.ts";
import type { AnyProviderDriver } from "@t3tools/provider-core/server/driver";

export interface ProviderDriverContribution<R = BuiltInDriversEnv> {
  readonly driver: AnyProviderDriver<R>;
  /** Keeps the owning plugin generation alive for each materialized instance. */
  readonly retain?: Effect.Effect<Effect.Effect<void>>;
}

export interface ProviderDriverContributionEntry<
  R = BuiltInDriversEnv,
> extends ProviderDriverContribution<R> {
  readonly pluginId: string;
  readonly revision: number;
}

export interface ProviderDriverCatalogShape {
  readonly list: Effect.Effect<readonly ProviderDriverContributionEntry[]>;
  readonly setEnabled: (enabled: boolean) => Effect.Effect<void>;
  /** Commit a fully staged generation. Its disposer cannot unregister a later replacement. */
  readonly register: (
    pluginId: string,
    contributions: readonly ProviderDriverContribution[],
  ) => Effect.Effect<Effect.Effect<void>>;
  readonly streamChanges: Stream.Stream<void>;
  readonly subscribeChanges: Effect.Effect<PubSub.Subscription<void>, never, Scope.Scope>;
}

export class ProviderDriverCatalog extends Context.Service<
  ProviderDriverCatalog,
  ProviderDriverCatalogShape
>()("t3/provider/ProviderDriverCatalog") {}

const isProviderDriverKind = Schema.is(ProviderDriverKind);

/** Validate while a plugin generation is staged, before publishing any factories. */
export function validateProviderDriverContributions<R>(
  staged: readonly ProviderDriverContribution<R>[],
): void {
  const seen = new Set<string>();
  for (const { driver } of staged) {
    if (
      typeof driver !== "object" ||
      driver === null ||
      !isProviderDriverKind(driver.driverKind) ||
      typeof driver.metadata?.displayName !== "string" ||
      driver.metadata.displayName.trim().length === 0 ||
      (driver.metadata.supportsMultipleInstances !== undefined &&
        typeof driver.metadata.supportsMultipleInstances !== "boolean") ||
      typeof driver.create !== "function" ||
      typeof driver.defaultConfig !== "function" ||
      !Schema.isSchema(driver.configSchema) ||
      seen.has(driver.driverKind)
    ) {
      throw new Error("Invalid or duplicate provider driver contribution.");
    }
    seen.add(driver.driverKind);
  }
}

// The host keeps contribution records while provider admission is disabled.
export const ProviderDriverCatalogLive = builtinServiceLayer("t3.server")(
  ProviderDriverCatalog,
  Effect.gen(function* () {
    const contributions = new Map<string, readonly ProviderDriverContributionEntry[]>();
    const builtinIds = new Set<string>(
      BUILT_IN_PROVIDER_PLUGIN_DEFINITIONS.map((plugin) => plugin.id),
    );
    const changes = yield* PubSub.unbounded<void>();
    yield* Effect.addFinalizer(() => PubSub.shutdown(changes));
    let revision = 0;
    let enabled = true;
    const register: ProviderDriverCatalogShape["register"] = Effect.fn(
      "ProviderDriverCatalog.register",
    )(function* (pluginId, staged) {
      const prepared = yield* Effect.sync(() => {
        validateProviderDriverContributions(staged);
        const nextRevision = ++revision;
        const entries = Object.freeze(
          staged.map((entry) =>
            Object.freeze({
              ...entry,
              pluginId,
              revision: nextRevision,
            }),
          ),
        );
        contributions.delete(pluginId);
        contributions.set(pluginId, entries);
        return entries;
      });
      yield* PubSub.publish(changes, undefined);
      return Effect.gen(function* () {
        if (contributions.get(pluginId) !== prepared) return;
        contributions.delete(pluginId);
        yield* PubSub.publish(changes, undefined);
      });
    });
    for (const builtin of BUILT_IN_PROVIDER_PLUGIN_DEFINITIONS) {
      const unregister = yield* register(builtin.id, [{ driver: builtin.driver }]);
      yield* Effect.addFinalizer(() => unregister);
    }
    return ProviderDriverCatalog.of({
      list: Effect.sync(() => {
        if (!enabled) return [];
        const resolved = new Map<ProviderDriverKind, ProviderDriverContributionEntry>();
        // Local overrides keep precedence when a bundled provider is re-enabled.
        for (const builtin of [true, false]) {
          for (const [pluginId, entries] of contributions) {
            if (builtinIds.has(pluginId) !== builtin) continue;
            for (const entry of entries) resolved.set(entry.driver.driverKind, entry);
          }
        }
        return [...resolved.values()];
      }),
      setEnabled: Effect.fn("ProviderDriverCatalog.setEnabled")(function* (next: boolean) {
        if (enabled === next) return;
        enabled = next;
        yield* PubSub.publish(changes, undefined);
      }),
      register,
      get streamChanges() {
        return Stream.fromPubSub(changes);
      },
      get subscribeChanges() {
        return PubSub.subscribe(changes);
      },
    });
  }),
);
