export interface NativeReviewDiffFile {
  readonly id: string;
  readonly path: string;
  readonly language: string;
  readonly additions: number;
  readonly deletions: number;
}
