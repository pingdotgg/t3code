export interface NativeReviewDiffFile {
  readonly id: string;
  readonly path: string;
  /** A @pierre/highlights language name. */
  readonly language: string;
  readonly additions: number;
  readonly deletions: number;
}
