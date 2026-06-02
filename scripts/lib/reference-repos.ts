export interface ReferenceRepo {
  readonly id: string;
  readonly prefix: string;
  readonly repository: string;
  readonly latestRef: string;
  readonly packageJsonPath: string;
  readonly packageVersionPath: ReadonlyArray<string>;
  readonly versionTagPrefix: string;
}

export const referenceRepos: ReadonlyArray<ReferenceRepo> = [
  {
    id: "effect-smol",
    prefix: ".repos/effect-smol",
    repository: "https://github.com/Effect-TS/effect-smol.git",
    latestRef: "main",
    packageJsonPath: "package.json",
    packageVersionPath: ["workspaces", "catalog", "effect"],
    versionTagPrefix: "effect@",
  },
];
