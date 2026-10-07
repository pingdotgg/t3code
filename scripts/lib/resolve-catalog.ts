import * as Schema from "effect/Schema";

class CatalogDependencyResolutionError extends Schema.TaggedError<CatalogDependencyResolutionError>()(
  "CatalogDependencyResolutionError",
  {
    workspacePackage: Schema.String,
    dependencyName: Schema.String,
    catalogSpec: Schema.String,
    catalogKey: Schema.String,
  },
) {
  override get message(): string {
    return `Unable to resolve '${this.catalogSpec}' for ${this.workspacePackage} dependency '${this.dependencyName}'. Expected key '${this.catalogKey}' in root workspace catalog.`;
  }
}

/**
 * Resolve `catalog:` dependency specs using the workspace catalog.
 *
 * Pure function: returns a new record with every `catalog:…` value replaced by
 * the concrete version string found in `catalog`. Throws on missing entries.
 */
export function resolveCatalogDependencies(
  dependencies: Record<string, string>,
  catalog: Record<string, string>,
  workspacePackage: string,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(dependencies).map(([name, spec]) => {
      if (typeof spec !== "string" || !spec.startsWith("catalog:")) {
        return [name, spec];
      }

      const catalogKey = spec.slice("catalog:".length).trim();
      // Overrides can include a parent selector and a version range. A bare
      // `catalog:` looks up the final package name, keeping its scope intact.
      const selector = name.split(">").at(-1) ?? name;
      const versionIndex = selector.indexOf("@", 1);
      const packageName = versionIndex === -1 ? selector : selector.slice(0, versionIndex);
      const lookupKey = catalogKey.length > 0 ? catalogKey : packageName;
      const resolved = catalog[lookupKey];

      if (typeof resolved !== "string" || resolved.length === 0) {
        throw new CatalogDependencyResolutionError({
          workspacePackage,
          dependencyName: name,
          catalogSpec: spec,
          catalogKey: lookupKey,
        });
      }

      return [name, resolved];
    }),
  );
}
