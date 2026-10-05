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
      // An override key can be a selector such as `@scope/parent>effect`; like
      // pnpm, a bare `catalog:` there means the catalog entry of the package
      // the selector ends in.
      const lookupKey = catalogKey.length > 0 ? catalogKey : (name.split(">").at(-1) ?? name);
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
