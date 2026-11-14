export interface NativeReviewDiffSource {
  readonly oldContents: string;
  readonly newContents: string;
}

export interface NativeReviewDiffFile {
  readonly id: string;
  readonly path: string;
  /** A @pierre/highlights language name. */
  readonly language: string;
  readonly additions: number;
  readonly deletions: number;
  readonly loadContents?: (signal?: AbortSignal) => Promise<NativeReviewDiffSource | null>;
}
