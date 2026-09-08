export interface ReferenceRepo {
  readonly id: string;
  readonly prefix: string;
  readonly repository: string;
  readonly latestRef: string;
  readonly versionSourcePath: string;
  readonly packageVersionPath: ReadonlyArray<string>;
  readonly versionTagPrefix: string;
}
export declare const referenceRepos: ReadonlyArray<ReferenceRepo>;
