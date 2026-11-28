import type { PreviewPassword, PreviewUnlock } from "./previewUnlock";
import type { OfficePreviewKind } from "@t3tools/shared/filePreview";
import type { PreviewFailure } from "./previewFailure";

export const OFFICE_PREVIEW_MAX_BYTES = 50 * 1024 * 1024;
export const OFFICE_PREVIEW_MAX_ROWS = 250_000;
export const OFFICE_PREVIEW_MAX_COLUMNS = 1024;

/** Workbook settings used by the preview worker. */
export type WorkbookView = {
  /** The default cell style's widest digit, in CSS pixels. */
  readonly digitWidth: number;
  /** The theme's heading and body fonts, which chart text names as `+mj-lt` and `+mn-lt`. */
  readonly themeFonts: { readonly major: string; readonly minor: string };
};

export type OfficeWorkerRequest =
  | PreviewUnlock
  | { readonly type: "open"; readonly kind: OfficePreviewKind; readonly bytes: ArrayBuffer }
  | { readonly type: "epub-page"; readonly index: number }
  | { readonly type: "sheet-page"; readonly sheet: number; readonly index: number };

export type NotebookCell = {
  readonly kind: "markdown" | "code" | "raw";
  readonly source: string;
  readonly outputs: { readonly kind: "text" | "image" | "html"; readonly text: string }[];
};

export type EpubLocation = { readonly index: number; readonly anchor?: string };
export type EpubNarrationCue = {
  readonly src: string;
  readonly begin: number;
  readonly end?: number;
  readonly anchor?: string;
};
export type EpubPage = {
  readonly html: string;
  readonly title?: string | undefined;
  readonly styles?: readonly { css: string; media: string }[];
  readonly htmlAttrs?: string | undefined;
  readonly bodyAttrs?: string | undefined;
  readonly fixed?: { width: number; height: number } | undefined;
  readonly imagePage?: boolean;
  readonly narration?: readonly EpubNarrationCue[];
};

export type OfficeWorkerResult =
  | PreviewPassword
  | {
      readonly type: "epub";
      readonly first: number;
      readonly rtl: boolean;
      readonly chapters: readonly { title: string | undefined; linear: boolean }[];
      readonly contents: readonly (EpubLocation & { title: string })[];
    }
  | {
      readonly type: "epub-page";
      readonly index: number;
      readonly result: EpubPage | PreviewFailure;
    }
  | {
      readonly type: "document";
      readonly navigation: "page" | "slide";
      readonly pages: { title: string | undefined; html: string }[];
    }
  | { readonly type: "notebook"; readonly language: string; readonly cells: NotebookCell[] }
  | ({ readonly type: "error" } & PreviewFailure)
  | {
      readonly type: "docx" | "xlsx" | "pptx";
      readonly bytes: ArrayBuffer;
      readonly truncated: boolean;
      /** For a workbook; undefined for other files. */
      readonly view: WorkbookView | undefined;
    }
  | {
      readonly type: "ods";
      readonly sheets: {
        name: string | undefined;
        rows: string[][];
        truncated: boolean;
        rowCount: number;
        columns: number;
        /** Zero-based sheet positions of the rows and columns shown, when some are hidden. */
        rowIndexes: number[] | undefined;
        columnIndexes: number[] | undefined;
      }[];
    }
  | {
      readonly type: "sheet-page";
      readonly sheet: number;
      readonly index: number;
      readonly rows: string[][];
    };
