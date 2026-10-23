import type { ZipPreviewEntry } from "@t3tools/client-runtime/zip-preview";

import { writeGeneratedAttachmentFile } from "../../lib/attachmentDownload";
import {
  createComposerFileAttachment,
  removePersistedComposerAttachmentFile,
} from "../../lib/composerImages";
import { appAtomRegistry } from "../../state/atom-registry";
import {
  changeQuestionAttachmentPreparation,
  questionAttachmentCapacity,
  questionAttachmentPreparationAtom,
} from "../../state/question-attachments";
import {
  appendComposerDraftAttachments,
  composerDraftsAtom,
} from "../../state/use-composer-drafts";

interface ZipEntrySource {
  readonly readFileForSave: (entry: ZipPreviewEntry, signal: AbortSignal) => Promise<Uint8Array>;
}

export async function withExtractedZipEntry(
  archive: ZipEntrySource,
  entry: ZipPreviewEntry,
  signal: AbortSignal,
  use: (file: { readonly uri: string; readonly share: () => Promise<void> }) => Promise<void>,
): Promise<void> {
  const bytes = await archive.readFileForSave(entry, signal);
  signal.throwIfAborted();
  const file = await writeGeneratedAttachmentFile({
    bytes,
    attachment: { name: entry.name, mimeType: entry.mimeType ?? "application/octet-stream" },
  });
  try {
    signal.throwIfAborted();
    await use({ uri: file.uri, share: () => file.share(signal) });
  } finally {
    file.dispose();
  }
}

export async function addZipEntryToDraft(input: {
  readonly archive: ZipEntrySource;
  readonly entry: ZipPreviewEntry;
  readonly draftKey: string;
  readonly questionPrefix: string | null;
  readonly maxBytes: number;
  readonly signal: AbortSignal;
}): Promise<void> {
  const { entry, signal, draftKey, questionPrefix } = input;
  if (questionPrefix !== null) changeQuestionAttachmentPreparation(draftKey, 1);
  try {
    await withExtractedZipEntry(input.archive, entry, signal, async (file) => {
      const attachment = await createComposerFileAttachment({
        uri: file.uri,
        name: entry.name,
        mimeType: entry.mimeType ?? "application/octet-stream",
        sizeBytes: entry.sizeBytes,
        maxBytes: input.maxBytes,
      });
      const resolved =
        questionPrefix !== null &&
        (appAtomRegistry.get(questionAttachmentPreparationAtom)[draftKey] ?? 0) === 0;
      if (signal.aborted || resolved) {
        await removePersistedComposerAttachmentFile(attachment.fileUri);
        signal.throwIfAborted();
        throw new Error("This question was already answered.");
      }
      const rejected = appendComposerDraftAttachments(
        draftKey,
        [attachment],
        questionPrefix === null
          ? { appendReference: true }
          : {
              maxAttachments: questionAttachmentCapacity(
                appAtomRegistry.get(composerDraftsAtom),
                questionPrefix,
                draftKey,
              ),
            },
      );
      if (rejected) {
        throw new Error("This message already has as many attachments as it can hold.");
      }
    });
  } finally {
    if (questionPrefix !== null) changeQuestionAttachmentPreparation(draftKey, -1);
  }
}
