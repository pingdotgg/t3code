import { useAtomValue } from "@effect/atom-react";
import { videoMimeType } from "@t3tools/shared/video";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as Hash from "effect/Hash";
import * as Option from "effect/Option";
import { Atom, AsyncResult } from "effect/reactivity";

import type { FileBackedComposerAttachment } from "./composerImages";
import { resolveOwnedComposerAttachmentFileUri } from "./composerAttachmentFiles";
import { shareLocalAttachment, type AttachmentPreviewFile } from "./attachmentDownload";
import { retainComposerAttachmentFileForPreview } from "./composerAttachmentPreviewRetention";

export async function loadLocalAttachmentPreview(
  attachment: FileBackedComposerAttachment,
  signal: AbortSignal,
): Promise<AttachmentPreviewFile | null> {
  if (signal.aborted) return null;
  const release = retainComposerAttachmentFileForPreview(attachment);
  try {
    const { File, Paths } = await import("expo-file-system");
    if (signal.aborted) {
      release();
      return null;
    }
    const uri =
      resolveOwnedComposerAttachmentFileUri(attachment.fileUri, Paths.document.uri) ??
      attachment.fileUri;
    const file = new File(uri);
    if (!file.exists) {
      throw new Error("The local attachment file is missing.");
    }
    let disposed = false;
    return {
      uri: file.uri,
      dispose: () => {
        if (disposed) return;
        disposed = true;
        release();
      },
      share: async (shareSignal, sourceIdentifier) => {
        if (disposed || shareSignal.aborted) return;
        const releaseShare = retainComposerAttachmentFileForPreview(attachment);
        try {
          await shareLocalAttachment({
            uri: file.uri,
            attachment: {
              name: attachment.name,
              mimeType:
                attachment.type === "file"
                  ? (videoMimeType(attachment) ?? attachment.mimeType)
                  : attachment.mimeType,
            },
            signal: shareSignal,
            sourceIdentifier,
          });
        } finally {
          releaseShare();
        }
      },
    };
  } catch (cause) {
    release();
    if (signal.aborted) return null;
    throw new Error("This attachment is no longer available. Attach the file again.", { cause });
  }
}

/**
 * Keyed by file identity only: a metadata update on the same draft must not
 * dispose the lease of a file a viewer is still showing.
 */
class LocalAttachmentPreviewKey implements Equal.Equal {
  constructor(readonly attachment: FileBackedComposerAttachment) {}
  [Equal.symbol](that: unknown): boolean {
    return (
      that instanceof LocalAttachmentPreviewKey &&
      that.attachment.id === this.attachment.id &&
      that.attachment.fileUri === this.attachment.fileUri
    );
  }
  [Hash.symbol](): number {
    return Hash.string(`${this.attachment.id}\u0000${this.attachment.fileUri}`);
  }
}

const localAttachmentPreviewFamily = Atom.family((key: LocalAttachmentPreviewKey) =>
  Atom.make(
    // The lease lives as long as the atom: unmounting the last reader (or a
    // refresh) closes the scope and releases the file.
    Effect.acquireRelease(
      Effect.tryPromise({
        try: (signal) => loadLocalAttachmentPreview(key.attachment, signal),
        catch: (cause) =>
          cause instanceof Error ? cause : new Error("The local file is unavailable."),
      }).pipe(Effect.flatMap((file) => (file === null ? Effect.interrupt : Effect.succeed(file)))),
      (file) => Effect.sync(file.dispose),
    ),
  ).pipe(Atom.withLabel(`local-attachment-preview:${key.attachment.id}`)),
);

const noLocalAttachmentPreview = Atom.make(
  AsyncResult.initial<AttachmentPreviewFile, Error>(),
).pipe(Atom.withLabel("local-attachment-preview:none"));

export function localAttachmentPreviewAtom(
  attachment: FileBackedComposerAttachment | null,
): Atom.Atom<AsyncResult.AsyncResult<AttachmentPreviewFile, Error>> {
  return attachment === null
    ? noLocalAttachmentPreview
    : localAttachmentPreviewFamily(new LocalAttachmentPreviewKey(attachment));
}

export interface LocalAttachmentPreviewState {
  readonly uri: string | null;
  readonly error: Error | null;
}

export function localAttachmentPreviewState(
  result: AsyncResult.AsyncResult<AttachmentPreviewFile, Error>,
): LocalAttachmentPreviewState {
  return {
    // A refresh has already released the previous lease while it reacquires.
    uri: result._tag === "Success" && !result.waiting ? result.value.uri : null,
    error: result._tag === "Failure" ? Option.getOrNull(AsyncResult.error(result)) : null,
  };
}

export function useLocalAttachmentPreview(
  attachment: FileBackedComposerAttachment | null,
): LocalAttachmentPreviewState {
  return localAttachmentPreviewState(useAtomValue(localAttachmentPreviewAtom(attachment)));
}
