// `package.json` reading shared by the release scripts.
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

/** The `package.json` fields the release scripts read. */
export const PackageJson = Schema.Struct({
  name: Schema.String,
  version: Schema.String,
  private: Schema.optionalKey(Schema.Boolean),
});
export type PackageJson = typeof PackageJson.Type;

/** A whole `package.json`, kept as-is so it can be written back unchanged. */
const RawPackageJson = Schema.Record(Schema.String, Schema.Unknown);

export const decodePackageJson = Schema.decodeUnknownEffect(Schema.fromJsonString(PackageJson));
const decodeRaw = Schema.decodeUnknownEffect(Schema.fromJsonString(RawPackageJson));

export interface WorkspacePackage {
  /** Directory relative to the workspace root, e.g. `packages/alchemy`. */
  readonly dir: string;
  readonly manifest: PackageJson;
  /** Every field of the manifest, for checks and rewrites. */
  readonly raw: Readonly<Record<string, unknown>>;
}

/** Non-private packages directly under `directory` (relative to `root`). */
export const publishablePackages = Effect.fn(function* (root: string, directory: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const entries = (yield* fs.readDirectory(path.join(root, directory))).sort();
  const packages = yield* Effect.forEach(entries, (entry) =>
    Effect.gen(function* () {
      // Skip stray files such as `.DS_Store`.
      if ((yield* fs.stat(path.join(root, directory, entry))).type !== "Directory")
        return undefined;
      const manifestPath = path.join(root, directory, entry, "package.json");
      if (!(yield* fs.exists(manifestPath))) return undefined;
      const text = yield* fs.readFileString(manifestPath);
      return {
        dir: path.join(directory, entry),
        manifest: yield* decodePackageJson(text),
        raw: yield* decodeRaw(text),
      } satisfies WorkspacePackage;
    }),
  );
  return packages.filter(
    (pkg): pkg is WorkspacePackage => pkg !== undefined && pkg.manifest.private !== true,
  );
});

export class VersionMismatch extends Data.TaggedError("VersionMismatch")<{
  readonly message: string;
  readonly specs: ReadonlyArray<string>;
}> {}

/** The one version every package carries; they are released in lockstep. */
export const sharedVersion = Effect.fn(function* (packages: ReadonlyArray<WorkspacePackage>) {
  const versions = new Set(packages.map(({ manifest }) => manifest.version));
  if (versions.size !== 1) {
    const specs = packages.map(({ manifest }) => `${manifest.name}@${manifest.version}`);
    // Name the packages on each version, except where that is most of them.
    const groups = [...versions].map((version) => {
      const names = packages
        .filter(({ manifest }) => manifest.version === version)
        .map(({ manifest }) => manifest.name);
      return `${version}: ${names.length > 5 ? `${names.length} packages` : names.join(", ")}`;
    });
    return yield* new VersionMismatch({
      message: `Packages must share one version; found ${groups.join("; ")}`,
      specs,
    });
  }
  return [...versions][0]!;
});
