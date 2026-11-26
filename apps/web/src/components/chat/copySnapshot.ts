import {
  COMPOSER_CONTEXT_CLIPBOARD_MIME,
  encodeComposerContextClipboardHtml,
} from "@t3tools/shared/composerContextClipboard";
import { msg } from "gt-react";

import { m } from "../../i18n/messages";

import { readMediaPng } from "../media/mediaContent";

export async function copySnapshot(src: string, text: string, fragment: string): Promise<void> {
  if (!navigator.clipboard?.write || typeof ClipboardItem === "undefined") {
    throw new Error(m(msg("Snapshot copying requires a secure browser connection.")));
  }
  const formats = {
    "image/png": readMediaPng(src),
    "text/plain": new Blob([text], { type: "text/plain" }),
    "text/html": new Blob([encodeComposerContextClipboardHtml(text, fragment)], {
      type: "text/html",
    }),
  };
  // Start writing within the click gesture, before the image fetch or decode completes.
  try {
    await navigator.clipboard.write([
      new ClipboardItem({
        ...formats,
        [COMPOSER_CONTEXT_CLIPBOARD_MIME]: new Blob([fragment], {
          type: COMPOSER_CONTEXT_CLIPBOARD_MIME,
        }),
      }),
    ]);
  } catch {
    // HTML carries the same snapshot metadata when custom clipboard formats are unsupported.
    await navigator.clipboard.write([new ClipboardItem(formats)]);
  }
}
