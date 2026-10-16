import type { PreviewStreamControl } from "@t3tools/client-runtime/preview/server-browser-stream";

type Dialog = PreviewStreamControl["dialog"];

export function previewPromptText(previous: Dialog, next: Dialog, draft: string) {
  if (
    next?.type !== previous?.type ||
    next?.message !== previous?.message ||
    next?.defaultValue !== previous?.defaultValue
  ) {
    return next?.defaultValue ?? "";
  }
  return draft;
}
