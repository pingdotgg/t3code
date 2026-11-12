import * as Schema from "effect/Schema";

/**
 * An npm package name, scoped or unscoped, under the rules npm applies to
 * new packages: lowercase, URL-safe, at most 214 characters. Names end up
 * in R2 keys, install URLs, and the markdown of comments and check runs,
 * so nothing outside this set is ever accepted from a client.
 */
export const PackageName = Schema.String.pipe(
  Schema.check(
    Schema.isPattern(/^(?:@[a-z0-9-*~][a-z0-9-*._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/),
    Schema.isMaxLength(214),
  ),
);

/** A display group label for the install comment: `Alchemy`, `@alchemy.run`. */
export const GroupName = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^[@A-Za-z0-9][A-Za-z0-9 ._@/-]{0,63}$/)),
);

/**
 * One packed workspace package inside a `pkg pack` artifact.
 *
 * Everything here is data the CLI observed while packing. The registry never
 * derives a tag from it: every tag comes from the GitHub Actions run that
 * vouched for the manifest, and R2 verifies uploaded tarball bytes against
 * the hash they are stored under.
 */
export const ManifestPackage = Schema.Struct({
  name: PackageName,
  /** Version from the package manifest at pack time. */
  version: Schema.String,
  /** Package directory relative to the workspace root, POSIX separators. */
  dir: Schema.String,
  group: GroupName,
  /** Tarball file name inside the artifact directory. */
  file: Schema.String,
  /** Lowercase hex SHA-256 of the tarball bytes. */
  sha256: Schema.String,
  /** Tarball size in bytes. */
  size: Schema.Number,
});
export type ManifestPackage = typeof ManifestPackage.Type;

/** A display group in the install comment, in the order `pkg pack` listed it. */
export const ManifestGroup = Schema.Struct({
  name: GroupName,
  /** Render the group collapsed in the install comment. */
  collapsed: Schema.Boolean,
});
export type ManifestGroup = typeof ManifestGroup.Type;

/**
 * The `pkg-manifest.json` written next to the tarballs by `pkg pack` and read
 * back by `pkg publish`.
 */
export const Manifest = Schema.Struct({
  version: Schema.Literal(1),
  groups: Schema.Array(ManifestGroup),
  /** Registry origin the tarball dependencies were rewritten against. */
  registry: Schema.String,
  /**
   * HEAD commit of the root repository at pack time. The registry requires
   * it to be the head of the run that publishes, since that is the commit
   * every tag names.
   */
  head: Schema.String,
  packages: Schema.Array(ManifestPackage),
});
export type Manifest = typeof Manifest.Type;

export const ManifestJson = Schema.fromJsonString(Manifest);

export const MANIFEST_FILE = "pkg-manifest.json";
