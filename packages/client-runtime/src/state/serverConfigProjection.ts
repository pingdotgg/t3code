import type { ServerConfig, ServerConfigStreamEvent } from "@t3tools/contracts";
import * as Option from "effect/Option";

export interface ServerConfigProjection {
  readonly config: ServerConfig;
  readonly latestEvent: ServerConfigStreamEvent;
  readonly source: "cache" | "live";
}

/**
 * Published themes, usage-limit sources and memory pressure are current machine
 * state, so a cache could restore a set the machine no longer reports.
 */
export function withoutEnvironmentThemes(config: ServerConfig): ServerConfig {
  if (
    config.environmentThemes === undefined &&
    config.usageLimitSources === undefined &&
    config.memoryPressure === undefined &&
    config.quietRuns === undefined
  ) {
    return config;
  }
  const {
    environmentThemes: _themes,
    usageLimitSources: _sources,
    memoryPressure: _pressure,
    quietRuns: _quietRuns,
    ...rest
  } = config;
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
      // A server without the event would never clear carried pressure or quiet runs.
      const capabilities = event.config.environment.capabilities;
      const carriedPressure =
        Option.isSome(current) && capabilities.memoryPressure === true
          ? current.value.config.memoryPressure
          : undefined;
      const carriedQuietRuns =
        Option.isSome(current) && capabilities.quietRuns === true
          ? current.value.config.quietRuns
          : undefined;
      const config: ServerConfig = {
        ...event.config,
        ...(carriedQuietRuns === undefined ? {} : { quietRuns: carriedQuietRuns }),
        ...(carriedThemes === undefined ? {} : { environmentThemes: carriedThemes }),
        ...(carriedSources === undefined ? {} : { usageLimitSources: carriedSources }),
        ...(carriedPressure === undefined ? {} : { memoryPressure: carriedPressure }),
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
      return Option.map(current, (projection) => ({
        config: {
          ...projection.config,
          providers: reuseUnchanged(projection.config.providers, event.payload.providers),
        },
        latestEvent: event,
        source: "live",
      }));
    case "settingsUpdated":
      return Option.map(current, (projection) => ({
        config: {
          ...projection.config,
          settings: reuseUnchanged(projection.config.settings, event.payload.settings),
        },
        latestEvent: event,
        source: "live",
      }));
    case "environmentThemesUpdated":
      return Option.map(current, (projection) => ({
        config: {
          ...projection.config,
          environmentThemes: event.payload.themes.length > 0 ? event.payload.themes : undefined,
        },
        latestEvent: event,
        source: "live",
      }));
    case "memoryPressureUpdated":
      return Option.flatMap(current, (projection) => {
        const { memoryPressure: _previous, ...config } = projection.config;
        // Keeps config identity, so screens reading it do not re-render.
        if (event.payload.level === "none" && projection.config.memoryPressure === undefined)
          return Option.none();
        return Option.some({
          config:
            event.payload.level === "none"
              ? config
              : {
                  ...config,
                  memoryPressure: reuseUnchanged(projection.config.memoryPressure, event.payload),
                },
          latestEvent: event,
          source: "live",
        });
      });
    case "quietRunsUpdated":
      return Option.map(current, (projection) => {
        const { quietRuns: _previous, ...config } = projection.config;
        return {
          config:
            event.payload.runs.length === 0 ? config : { ...config, quietRuns: event.payload.runs },
          latestEvent: event,
          source: "live",
        };
      });
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
