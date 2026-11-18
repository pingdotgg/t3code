import * as Schema from "effect/Schema";

import { PortSchema, PositiveInt, TrimmedNonEmptyString } from "./baseSchemas.ts";

// A supervisor must not restart a server refused by the state-directory owner.
export const SERVER_EXIT_CODE_STATE_DIR_OWNED = 78;
// Nor one that refused its database's migration history: every restart is refused again.
export const SERVER_EXIT_CODE_DATABASE_REFUSED = 65;
// A server the managed policy refused, so the desktop app blames the policy rather than the release.
export const SERVER_EXIT_CODE_MANAGED_POLICY = 77;

export const DesktopBackendBootstrap = Schema.Struct({
  mode: Schema.Literal("desktop"),
  noBrowser: Schema.Boolean,
  port: PortSchema,
  // Omit in WSL to use the Linux home instead of the mapped Windows directory.
  t3Home: Schema.optional(Schema.String),
  host: Schema.String,
  desktopBootstrapToken: Schema.String,
  // Derives rotating tokens instead of trusting desktopBootstrapToken indefinitely; see @t3tools/shared/desktopBootstrapToken.
  desktopBootstrapSecret: Schema.optionalKey(Schema.String),
  // Absent means the backend must hydrate PATH, as WSL and older desktops require.
  shellEnvironmentPrepared: Schema.optionalKey(Schema.Boolean),
  tailscaleServeEnabled: Schema.Boolean,
  tailscaleServePort: PortSchema,
  otlpTracesUrl: Schema.optional(Schema.String),
  otlpMetricsUrl: Schema.optional(Schema.String),
  otlpLogsUrl: Schema.optional(Schema.String),
  desktopTelemetryFd: Schema.optionalKey(PositiveInt),
  desktopTelemetryControlFd: Schema.optionalKey(PositiveInt),
  // Whether the spawning desktop app can install updates when the server requests one.
  desktopAppUpdate: Schema.optionalKey(Schema.Boolean),
  desktopBrowserFd: Schema.optionalKey(PositiveInt),
  desktopBrowserControlFd: Schema.optionalKey(PositiveInt),
  resourceMonitorPath: Schema.optionalKey(TrimmedNonEmptyString),
  // The desktop app hosts this computer itself; absent means the server may offer it in process.
  computerLocalHost: Schema.optionalKey(Schema.Boolean),
});

export type DesktopBackendBootstrap = typeof DesktopBackendBootstrap.Type;

export const DESKTOP_UPDATE_IN_PROGRESS_MARKER_FILE = "desktop-update-in-progress";
export const DESKTOP_UPDATE_IN_PROGRESS_TTL_MS = 60_000;
