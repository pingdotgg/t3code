import * as Schema from "effect/Schema";

import { PortSchema, PositiveInt, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const DesktopBackendBootstrap = Schema.Struct({
  mode: Schema.Literal("desktop"),
  noBrowser: Schema.Boolean,
  port: PortSchema,
  // Omitted when the desktop launches the backend inside WSL, since the
  // Windows-side baseDir maps to /mnt/c/... and the Linux side should use its
  // own home directory instead.
  t3Home: Schema.optional(Schema.String),
  host: Schema.String,
  desktopBootstrapToken: Schema.String,
  tailscaleServeEnabled: Schema.Boolean,
  tailscaleServePort: PortSchema,
  otlpTracesUrl: Schema.optional(Schema.String),
  otlpMetricsUrl: Schema.optional(Schema.String),
  otlpLogsUrl: Schema.optional(Schema.String),
  desktopTelemetryFd: Schema.optionalKey(PositiveInt),
  desktopTelemetryControlFd: Schema.optionalKey(PositiveInt),
  resourceMonitorPath: Schema.optionalKey(TrimmedNonEmptyString),
});

export type DesktopBackendBootstrap = typeof DesktopBackendBootstrap.Type;

/** Written to `<t3Home>/runtime` just before the desktop app stops its
    backend to install an update. The updated app starts a new backend right
    away, so a backend that sees a fresh marker at shutdown keeps its managed
    tunnel. */
export const DESKTOP_UPDATE_RESTART_MARKER_FILE = "desktop-update-restart";
