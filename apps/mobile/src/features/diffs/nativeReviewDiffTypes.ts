export type NativeReviewDiffLanguage =
  | "bash"
  | "diff"
  | "javascript"
  | "json"
  | "jsx"
  | "tsx"
  | "typescript"
  | "yaml";

export interface NativeReviewDiffSource {
  readonly oldContents: string;
  readonly newContents: string;
}

export interface NativeReviewDiffFile {
  readonly id: string;
  readonly path: string;
  readonly language: NativeReviewDiffLanguage;
  readonly additions: number;
  readonly deletions: number;
  readonly loadContents?: (signal?: AbortSignal) => Promise<NativeReviewDiffSource | null>;
}
