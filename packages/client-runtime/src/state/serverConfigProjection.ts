import type { ServerConfig, ServerConfigStreamEvent } from "@t3tools/contracts";
import * as Option from "effect/Option";

export interface ServerConfigProjection {
  readonly config: ServerConfig;
  readonly latestEvent: ServerConfigStreamEvent;
  readonly source: "cache" | "live";
}

/**
 * Cached config keeps the provider and model catalog available across reconnects.
 * Published themes are current machine state, so a cache could restore themes
 * that the machine no longer publishes. Replay sends themes as a separate event.
 */
export function withoutEnvironmentThemes(config: ServerConfig): ServerConfig {
  if (config.environmentThemes === undefined) return config;
  const { environmentThemes: _ephemeral, ...rest } = config;
  return rest;
}

export function applyServerConfigProjection(
  current: Option.Option<ServerConfigProjection>,
  event: ServerConfigStreamEvent,
): Option.Option<ServerConfigProjection> {
  switch (event.type) {
    case "snapshot": {
      // Wire snapshots never contain published themes. Keep the previous set
      // until a capable server sends its authoritative theme event. A legacy
      // server cannot send a later removal, so a downgrade must clear the set.
      const carried =
        event.config.environment.capabilities.environmentThemes === true && Option.isSome(current)
          ? current.value.config.environmentThemes
          : undefined;
      return Option.some({
        config:
          carried === undefined ? event.config : { ...event.config, environmentThemes: carried },
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
          providers: event.payload.providers,
        },
        latestEvent: event,
        source: "live",
      }));
    case "settingsUpdated":
      return Option.map(current, (projection) => {
        const settings = event.payload.settings;
        // Prefer the server-provided remoteAccess (includes the dialable key after
        // announce). Older servers omit it; fall back to syncing enabled from the
        // settings patch only when this environment already reported P2P support.
        const remoteAccess =
          event.payload.remoteAccess ??
          (projection.config.remoteAccess === undefined
            ? undefined
            : {
                p2p: {
                  enabled: settings.remoteAccess.p2pEnabled,
                  ...(settings.remoteAccess.p2pEnabled &&
                  projection.config.remoteAccess.p2p?.publicKeyZ32 !== undefined
                    ? { publicKeyZ32: projection.config.remoteAccess.p2p.publicKeyZ32 }
                    : {}),
                  ...(settings.remoteAccess.p2pEnabled &&
                  projection.config.remoteAccess.p2p?.error !== undefined
                    ? { error: projection.config.remoteAccess.p2p.error }
                    : {}),
                },
              });
        return {
          config: {
            ...projection.config,
            settings,
            ...(remoteAccess === undefined ? {} : { remoteAccess }),
          },
          latestEvent: event,
          source: "live" as const,
        };
      });
    case "environmentThemesUpdated":
      return Option.map(current, (projection) => ({
        config: {
          ...projection.config,
          environmentThemes: event.payload.themes.length > 0 ? event.payload.themes : undefined,
        },
        latestEvent: event,
        source: "live",
      }));
  }
}
