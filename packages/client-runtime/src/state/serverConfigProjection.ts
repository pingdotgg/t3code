import {
  applyServerProviderDeltas,
  type ServerConfig,
  type ServerConfigStreamEvent,
} from "@t3tools/contracts";
import * as Equal from "effect/Equal";
import * as Option from "effect/Option";

export interface ServerConfigProjection {
  readonly config: ServerConfig;
  readonly latestEvent: ServerConfigStreamEvent;
  readonly source: "cache" | "live";
}

/**
 * Published themes and usage-limit sources are current machine state, so a
 * cache could restore a set the machine no longer reports.
 */
export function withoutEnvironmentThemes(config: ServerConfig): ServerConfig {
  if (config.environmentThemes === undefined && config.usageLimitSources === undefined) {
    return config;
  }
  const { environmentThemes: _themes, usageLimitSources: _sources, ...rest } = config;
  return rest;
}

/**
 * Provider pushes, reconnects, and settings writes resend unchanged data.
 * Reuse deep-equal objects so memoized UI can skip unchanged providers, models, and skills.
 */
export function reuseUnchanged<T>(previous: unknown, next: T): T {
  if (Object.is(previous, next)) return next;
  if (
    typeof previous !== "object" ||
    typeof next !== "object" ||
    previous === null ||
    next === null ||
    Array.isArray(previous) !== Array.isArray(next)
  ) {
    return next;
  }
  if (Array.isArray(next)) {
    const before = previous as ReadonlyArray<unknown>;
    let same = before.length === next.length;
    const merged = next.map((item, index) => {
      const reused = reuseUnchanged(before[index], item);
      if (reused !== before[index]) same = false;
      return reused;
    });
    return (same ? previous : merged) as T;
  }
  // Decoded settings carry Durations, which are fresh instances on every push.
  if (Equal.isEqual(next)) return (Equal.equals(previous, next) ? previous : next) as T;
  if (Object.getPrototypeOf(next) !== Object.prototype) return next;
  const before = previous as Record<string, unknown>;
  const after = next as Record<string, unknown>;
  const keys = Object.keys(after);
  let same = keys.length === Object.keys(before).length;
  const merged: Record<string, unknown> = {};
  for (const key of keys) {
    const reused = reuseUnchanged(before[key], after[key]);
    if (reused !== before[key] || !(key in before)) same = false;
    merged[key] = reused;
  }
  return (same ? previous : merged) as T;
}

type ServerProviders = ServerConfig["providers"];

/**
 * A provider sent with a catalog digest comes without its slash commands and skills. Keep the
 * lists this client holds, stale ones too, until it loads the lists the digest stands for.
 */
function withHeldProviderCatalogs(
  previous: ServerProviders | undefined,
  next: ServerProviders,
): ServerProviders {
  if (previous === undefined) return next;
  return next.map((provider) => {
    if (provider.catalogDigest === undefined || provider.loadedCatalogDigest !== undefined) {
      return provider;
    }
    const held = previous.find((candidate) => candidate.instanceId === provider.instanceId);
    if (held === undefined) return provider;
    return {
      ...provider,
      slashCommands: held.slashCommands,
      skills: held.skills,
      ...(held.loadedCatalogDigest === undefined
        ? {}
        : { loadedCatalogDigest: held.loadedCatalogDigest }),
    };
  });
}

export function applyServerConfigProjection(
  current: Option.Option<ServerConfigProjection>,
  event: ServerConfigStreamEvent,
): Option.Option<ServerConfigProjection> {
  switch (event.type) {
    case "snapshot": {
      // Wire snapshots never contain published themes. Keep the previous set
      // until the server sends its authoritative theme event.
      const carriedThemes = Option.isSome(current)
        ? current.value.config.environmentThemes
        : undefined;
      const carriedSources = Option.isSome(current)
        ? current.value.config.usageLimitSources
        : undefined;
      const config: ServerConfig = {
        ...event.config,
        providers: withHeldProviderCatalogs(
          Option.getOrUndefined(current)?.config.providers,
          event.config.providers,
        ),
        ...(carriedThemes === undefined ? {} : { environmentThemes: carriedThemes }),
        ...(carriedSources === undefined ? {} : { usageLimitSources: carriedSources }),
      };
      return Option.some({
        // Every reconnect re-sends the whole config, usually unchanged apart from timestamps.
        config: Option.isSome(current) ? reuseUnchanged(current.value.config, config) : config,
        latestEvent: event,
        source: "live" as const,
      });
    }
    case "keybindingsUpdated":
      return Option.map(current, (projection) => ({
        config: {
          ...projection.config,
          keybindings: event.payload.keybindings,
          issues: event.payload.issues,
        },
        latestEvent: event,
        source: "live",
      }));
    case "providerStatuses":
    case "providerStatusDeltas":
      return Option.map(current, (projection) => {
        const previous = projection.config.providers;
        const providers =
          event.type === "providerStatuses"
            ? event.payload.providers
            : applyServerProviderDeltas(previous, event.payload.providers);
        return {
          config: {
            ...projection.config,
            providers: reuseUnchanged(previous, withHeldProviderCatalogs(previous, providers)),
          },
          latestEvent: event,
          source: "live",
        };
      });
    case "settingsUpdated":
      return Option.map(current, (projection) => {
        const settings = reuseUnchanged(projection.config.settings, event.payload.settings);
        return {
          config:
            settings === projection.config.settings
              ? projection.config
              : { ...projection.config, settings },
          latestEvent: event,
          source: "live",
        };
      });
    case "environmentThemesUpdated":
      return Option.map(current, (projection) => ({
        config: {
          ...projection.config,
          // Kept when empty: undefined means the theme event has not arrived yet.
          environmentThemes: event.payload.themes,
        },
        latestEvent: event,
        source: "live",
      }));
    case "usageLimitSourcesUpdated":
      return Option.map(current, (projection) => ({
        config: {
          ...projection.config,
          usageLimitSources: event.payload.sources.length > 0 ? event.payload.sources : undefined,
        },
        latestEvent: event,
        source: "live",
      }));
  }
}
