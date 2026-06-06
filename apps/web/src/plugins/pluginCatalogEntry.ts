import type { PluginCatalogEntry } from "@t3tools/contracts";

export type PluginCatalogManifestEntry = Extract<
  PluginCatalogEntry,
  { readonly manifest: unknown }
>;

export function hasPluginManifest(entry: PluginCatalogEntry): entry is PluginCatalogManifestEntry {
  return "manifest" in entry;
}
