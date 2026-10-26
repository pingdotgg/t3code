import type { OfficePreviewKind } from "@t3tools/shared/filePreview";
export const OFFICE_PREVIEW_MAX_BYTES = 50 * 1024 * 1024;
export const OFFICE_PREVIEW_MAX_ROWS = 500;
export const OFFICE_PREVIEW_MAX_COLUMNS = 50;
export type OfficeWorkerRequest = {
  readonly type: "open";
  readonly kind: OfficePreviewKind;
  readonly bytes: ArrayBuffer;
};
export type OfficeWorkerResult =
  | { readonly type: "error"; readonly message: string }
  | {
      readonly type: OfficePreviewKind;
      readonly bytes: ArrayBuffer;
      readonly truncated: boolean;
    };
