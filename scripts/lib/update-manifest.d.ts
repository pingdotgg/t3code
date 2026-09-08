export interface UpdateManifestFile {
  readonly url: string;
  readonly sha512: string;
  readonly size: number;
}
export type UpdateManifestScalar = string | number | boolean;
export interface UpdateManifest {
  readonly version: string;
  readonly releaseDate: string;
  readonly files: ReadonlyArray<UpdateManifestFile>;
  readonly extras: Readonly<Record<string, UpdateManifestScalar>>;
}
export declare function parseUpdateManifest(
  raw: string,
  sourcePath: string,
  platformLabel: string,
): UpdateManifest;
export declare function mergeUpdateManifests(
  primary: UpdateManifest,
  secondary: UpdateManifest,
  platformLabel: string,
): UpdateManifest;
export declare function serializeUpdateManifest(
  manifest: UpdateManifest,
  options: {
    readonly platformLabel: string;
  },
): string;
