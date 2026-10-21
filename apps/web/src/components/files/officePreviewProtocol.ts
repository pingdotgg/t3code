import type { OfficePreviewKind } from "@t3tools/shared/filePreview";
import type { SlideDisplayList } from "@betteroffice/pptx";

export const OFFICE_PREVIEW_MAX_BYTES = 50 * 1024 * 1024;
export const OFFICE_PREVIEW_MAX_ROWS = 250_000;
export const OFFICE_PREVIEW_MAX_COLUMNS = 1024;

export type OfficeWorkerRequest =
  | { readonly type: "open"; readonly kind: OfficePreviewKind; readonly bytes: ArrayBuffer }
  | { readonly type: "slide"; readonly index: number }
  | { readonly type: "sheet-page"; readonly sheet: number; readonly index: number };

export type NotebookCell = {
  readonly kind: "markdown" | "code" | "raw";
  readonly source: string;
  readonly outputs: { readonly kind: "text" | "image" | "html"; readonly text: string }[];
};

export type OfficeWorkerResult =
  | {
      readonly type: "document";
      readonly navigation: "page" | "slide" | "chapter";
      readonly pages: { title: string; html: string }[];
    }
  | { readonly type: "notebook"; readonly language: string; readonly cells: NotebookCell[] }
  | { readonly type: "error"; readonly message: string }
  | {
      readonly type: "docx";
      readonly bytes: ArrayBuffer;
      readonly documents: string[];
      readonly truncated: boolean;
    }
  | {
      readonly type: "xlsx";
      readonly sheets: {
        name: string;
        rows: string[][];
        truncated: boolean;
        rowCount: number;
        columns: number;
      }[];
    }
  | {
      readonly type: "sheet-page";
      readonly sheet: number;
      readonly index: number;
      readonly rows: string[][];
    }
  | { readonly type: "pptx"; readonly count: number; readonly font: ArrayBuffer }
  | {
      readonly type: "slide";
      readonly index: number;
      readonly frame: SlideDisplayList;
      readonly images: { id: string; bytes: Uint8Array<ArrayBuffer> }[];
      readonly text: string;
    };
