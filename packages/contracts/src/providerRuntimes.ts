import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

/**
 * Keeps provider CLIs current. `auto` points an outdated Claude Code or Codex at a runtime
 * Continuum downloads from the vendor's official channel, keeping the same config folder so
 * sign-ins and sessions carry over. Installations the user manages are updated in place only
 * when `updateUserInstalls` is on.
 */
export const ProviderRuntimeUpdateMode = Schema.Literals(["auto", "notify", "off"]);
export type ProviderRuntimeUpdateMode = typeof ProviderRuntimeUpdateMode.Type;

export const ProviderRuntimeSettings = Schema.Struct({
  mode: ProviderRuntimeUpdateMode.pipe(
    Schema.withDecodingDefault(Effect.succeed<ProviderRuntimeUpdateMode>("auto")),
  ),
  updateUserInstalls: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
});
export type ProviderRuntimeSettings = typeof ProviderRuntimeSettings.Type;

export const ManagedProviderRuntime = Schema.Struct({
  instanceId: Schema.String,
  driver: Schema.String,
  version: Schema.String,
  executablePath: Schema.String,
  /** The binary path the instance used before; restored when the user opts out. */
  previousBinaryPath: Schema.String,
  updatedAt: Schema.String,
});
export type ManagedProviderRuntime = typeof ManagedProviderRuntime.Type;

export const ProviderRuntimeLogEntry = Schema.Struct({
  at: Schema.String,
  instanceId: Schema.String,
  action: Schema.Literals([
    "managed-install",
    "managed-update",
    "in-place-update",
    "restore",
    "skipped",
  ]),
  ok: Schema.Boolean,
  message: Schema.String,
});
export type ProviderRuntimeLogEntry = typeof ProviderRuntimeLogEntry.Type;

export const ProviderRuntimeStatus = Schema.Struct({
  settings: ProviderRuntimeSettings,
  managed: Schema.Array(ManagedProviderRuntime),
  log: Schema.Array(ProviderRuntimeLogEntry),
  lastCheckedAt: Schema.NullOr(Schema.String),
  checking: Schema.Boolean,
});
export type ProviderRuntimeStatus = typeof ProviderRuntimeStatus.Type;

export const ProviderRuntimeSettingsPatch = Schema.Struct({
  mode: Schema.optionalKey(ProviderRuntimeUpdateMode),
  updateUserInstalls: Schema.optionalKey(Schema.Boolean),
});
export type ProviderRuntimeSettingsPatch = typeof ProviderRuntimeSettingsPatch.Type;

export const ProviderRuntimeRestoreInput = Schema.Struct({ instanceId: Schema.String });

export class ProviderRuntimeError extends Schema.TaggedError<ProviderRuntimeError>()(
  "ProviderRuntimeError",
  { message: Schema.String },
) {}
