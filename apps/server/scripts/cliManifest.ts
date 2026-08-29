import { resolveCatalogDependencies } from "../../../scripts/lib/resolve-catalog.ts";

export interface ServerCliPublishPackageJson {
  readonly name: string;
  readonly repository: {
    readonly type: string;
    readonly url: string;
    readonly directory: string;
  };
  readonly bin: Readonly<Record<string, string>>;
  readonly type: string;
  readonly version: string;
  readonly engines: Readonly<Record<string, string>>;
  readonly files: ReadonlyArray<string>;
  readonly dependencies: Readonly<Record<string, string>>;
  readonly overrides: Readonly<Record<string, string>>;
  readonly publishConfig: {
    readonly executableFiles: ReadonlyArray<string>;
  };
}

type ServerCliPackageSource = Omit<ServerCliPublishPackageJson, "version" | "overrides">;

export function createServerCliPublishPackageJson(input: {
  readonly source: ServerCliPackageSource;
  readonly version: string;
  readonly workspaceCatalog: Record<string, string>;
  readonly workspaceOverrides: Record<string, string>;
}): ServerCliPublishPackageJson {
  return {
    name: input.source.name,
    repository: input.source.repository,
    bin: input.source.bin,
    type: input.source.type,
    version: input.version,
    engines: input.source.engines,
    files: input.source.files,
    dependencies: resolveCatalogDependencies(
      input.source.dependencies,
      input.workspaceCatalog,
      "apps/server",
    ),
    overrides: resolveCatalogDependencies(
      input.workspaceOverrides,
      input.workspaceCatalog,
      "apps/server",
    ),
    publishConfig: input.source.publishConfig,
  };
}
