import type { ChatAttachment } from "@t3tools/contracts";

import { resolveAttachmentPath } from "./attachmentStore.ts";

const SIZE_LABEL_UNITS = ["B", "KB", "MB"] as const;

function formatSizeLabel(sizeBytes: number): string {
  let value = sizeBytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < SIZE_LABEL_UNITS.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  const rounded = unitIndex === 0 ? String(value) : value.toFixed(1);
  return `${rounded} ${SIZE_LABEL_UNITS[unitIndex]}`;
}

function sanitizePromptFileName(name: string): string {
  // eslint-disable-next-line no-control-regex
  return name.replace(/[\u0000-\u001f\u007f()[\]]+/gu, " ").trim();
}

/**
 * Non-image attachments are delivered by reference: the file already lives on
 * the server's disk, so the provider agent reads it with its own tools. Images
 * keep their native content-block path and are not mentioned here.
 */
export function appendFileAttachmentPromptText(input: {
  readonly text: string;
  readonly attachmentsDir: string;
  readonly attachments: ReadonlyArray<ChatAttachment>;
}): string {
  const lines: Array<string> = [];
  for (const attachment of input.attachments) {
    if (attachment.type !== "file") {
      continue;
    }
    const attachmentPath = resolveAttachmentPath({
      attachmentsDir: input.attachmentsDir,
      attachment,
    });
    if (!attachmentPath) {
      continue;
    }
    const name = sanitizePromptFileName(attachment.name);
    lines.push(
      `[Attached file: ${attachmentPath} (${name}, ${attachment.mimeType}, ${formatSizeLabel(attachment.sizeBytes)}). Read it from disk when needed.]`,
    );
  }
  if (lines.length === 0) {
    return input.text;
  }
  const joined = lines.join("\n");
  return input.text.trim().length > 0 ? `${input.text}\n\n${joined}` : joined;
}
