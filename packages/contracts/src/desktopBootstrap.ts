import * as Schema from "effect/Schema";

import { PortSchema } from "./baseSchemas.ts";

export const DesktopBackendStorageRoots = Schema.Union([
  Schema.Struct({
    layout: Schema.Literal("split"),
    configDir: Schema.String,
    dataDir: Schema.String,
    stateDir: Schema.String,
    cacheDir: Schema.String,
    runtimeDir: Schema.String,
  }),
  Schema.Struct({
    layout: Schema.Literal("legacy"),
    configDir: Schema.String,
    dataDir: Schema.String,
    stateDir: Schema.String,
    cacheDir: Schema.String,
    runtimeDir: Schema.String,
    legacyBaseDir: Schema.String,
  }),
]);
export type DesktopBackendStorageRoots = typeof DesktopBackendStorageRoots.Type;

export const DesktopBackendBootstrap = Schema.Struct({
  mode: Schema.Literal("desktop"),
  noBrowser: Schema.Boolean,
  port: PortSchema,
  // Omitted when the desktop launches the backend inside WSL, since the
  // Windows-side baseDir maps to /mnt/c/... and the Linux side should use its
  // own home directory instead.
  t3Home: Schema.optional(Schema.String),
  storageRoots: Schema.optional(DesktopBackendStorageRoots),
  host: Schema.String,
  desktopBootstrapToken: Schema.String,
  tailscaleServeEnabled: Schema.Boolean,
  tailscaleServePort: PortSchema,
  otlpTracesUrl: Schema.optional(Schema.String),
  otlpMetricsUrl: Schema.optional(Schema.String),
});

export type DesktopBackendBootstrap = typeof DesktopBackendBootstrap.Type;
