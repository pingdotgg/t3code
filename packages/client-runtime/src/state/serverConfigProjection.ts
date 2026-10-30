import type { ServerConfig, ServerConfigStreamEvent } from "@t3tools/contracts";
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
    let changedAt = before.length === next.length ? next.length : -1;
    let changedValue: unknown;
    if (changedAt !== -1) {
      for (let index = 0; index < next.length; index++) {
        if (!(index in next)) continue;
        const reused = reuseUnchanged(before[index], next[index]);
        if (reused !== before[index]) {
          changedAt = index;
          changedValue = reused;
          break;
        }
      }
    }
    if (changedAt === next.length) return previous as T;
    const merged = next.slice();
    for (let index = 0; index < next.length; index++) {
      if (!(index in next)) continue;
      merged[index] =
        index < changedAt
          ? before[index]
          : index === changedAt
            ? changedValue
            : reuseUnchanged(before[index], next[index]);
    }
    return merged as T;
  }
  if (Object.getPrototypeOf(next) !== Object.prototype) return next;
  const before = previous as Record<string, unknown>;
  const after = next as Record<string, unknown>;
  const keys = Object.keys(after);
  let changedAt = keys.length === Object.keys(before).length ? keys.length : -1;
  let changedValue: unknown;
  if (changedAt !== -1) {
    for (let index = 0; index < keys.length; index++) {
      const key = keys[index]!;
      const reused = reuseUnchanged(before[key], after[key]);
      if (reused !== before[key] || !(key in before)) {
        changedAt = index;
        changedValue = reused;
        break;
      }
    }
  }
  if (changedAt === keys.length) return previous as T;
  const merged: Record<string, unknown> = {};
  for (let index = 0; index < keys.length; index++) {
    const key = keys[index]!;
    merged[key] =
      index < changedAt
        ? before[key]
        : index === changedAt
          ? changedValue
          : reuseUnchanged(before[key], after[key]);
  }
  return merged as T;
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
