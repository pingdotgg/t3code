export type NativeReviewDiffLanguage =
  | "bash"
  | "diff"
  | "javascript"
  | "json"
  | "jsx"
  | "tsx"
  | "typescript"
  | "yaml";

export interface NativeReviewDiffFile {
  readonly id: string;
  readonly path: string;
  readonly language: NativeReviewDiffLanguage;
  readonly additions: number;
  readonly deletions: number;
}
