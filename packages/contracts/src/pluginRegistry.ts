import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";
import { PluginEntryPath, PluginId, PluginManifest } from "./plugins.ts";

/** Review metadata comes from the host's curated catalog, never from a plugin manifest. */
export const PluginRegistryEntry = Schema.Struct({
  manifest: PluginManifest,
  sourceDirectory: PluginEntryPath,
  sha256: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
  publisher: Schema.Struct({ id: TrimmedNonEmptyString, name: TrimmedNonEmptyString }),
  review: Schema.Struct({
    reviewer: TrimmedNonEmptyString,
    reviewedAt: TrimmedNonEmptyString,
    summary: Schema.optionalKey(Schema.String),
  }),
});
export type PluginRegistryEntry = typeof PluginRegistryEntry.Type;

export const PluginRegistrySnapshot = Schema.Struct({ entries: Schema.Array(PluginRegistryEntry) });
export type PluginRegistrySnapshot = typeof PluginRegistrySnapshot.Type;

export const PluginRegistryListInput = Schema.Struct({ query: Schema.optionalKey(Schema.String) });
export type PluginRegistryListInput = typeof PluginRegistryListInput.Type;

export const PluginRegistryInstallInput = Schema.Struct({ id: PluginId });
export type PluginRegistryInstallInput = typeof PluginRegistryInstallInput.Type;

export const PluginRegistryInstallResult = Schema.Struct({
  manifest: PluginManifest,
  directory: Schema.String,
  enabled: Schema.Literal(false),
});
export type PluginRegistryInstallResult = typeof PluginRegistryInstallResult.Type;

export class PluginRegistryError extends Schema.TaggedError<PluginRegistryError>()(
  "PluginRegistryError",
  {
    operation: Schema.Literals(["read", "fingerprint", "install"]),
    detail: Schema.String,
    id: Schema.optionalKey(PluginId),
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {
  override get message() {
    return this.detail;
  }
}
