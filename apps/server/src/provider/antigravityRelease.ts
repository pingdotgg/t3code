export interface AntigravityReleaseAsset {
  readonly version: string;
  readonly url: string;
  readonly sha256: string;
  readonly archiveBytes: number;
  readonly executable: {
    readonly name: string;
    readonly bytes: number;
  };
  readonly harness: {
    readonly name: string;
    readonly bytes: number;
  };
}
