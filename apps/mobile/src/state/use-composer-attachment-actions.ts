import * as Dialog from "../components/ui/Dialog";
import { useRef } from "react";
import { PROVIDER_SEND_TURN_MAX_ATTACHMENTS, type ServerConfig } from "@t3tools/contracts";
import { clampFileAttachmentUploadBytes } from "@t3tools/client-runtime/state/attachments";
import { nextPastedTextFileName } from "@t3tools/client-runtime/text-paste";
import type { ComposerTextPaste } from "../components/ComposerEditor";
import {
  convertPastedImagesToAttachments,
  createPastedTextComposerAttachment,
  pickComposerFiles,
  pickComposerMedia,
  removePersistedComposerAttachmentFile,
  type DraftComposerAttachment,
} from "../lib/composerImages";
import {
  appendComposerDraftAttachments,
  captureComposerDraftInsertion,
  countComposerDraftAttachmentsAfterSelection,
  getComposerDraftSnapshot,
  type ComposerDraftInsertion,
} from "./use-composer-drafts";
import { startComposerDraftOperation } from "./composerDraftOperations";

export function useComposerAttachmentActions(props: {
  readonly draftKey: string | null;
  readonly serverConfig: ServerConfig | null | undefined;
  readonly locked?: boolean;
}) {
  const reservedNames = useRef(new Map<string, Set<string>>());
  const capabilities = props.serverConfig?.environment.capabilities;
  const append = async (
    key: string,
    signal: AbortSignal,
    attachments: ReadonlyArray<DraftComposerAttachment>,
    insertion: ComposerDraftInsertion,
  ) => {
    if (signal.aborted) {
      await Promise.all(
        attachments.flatMap((item) =>
          item.fileUri ? [removePersistedComposerAttachmentFile(item.fileUri)] : [],
        ),
      );
      return 0;
    }
    return appendComposerDraftAttachments(key, attachments, { appendReference: true, insertion });
  };
  // A picker may finish after its draft was discarded or the composer moved off it.
  const withDraftOperation = async (key: string, work: (signal: AbortSignal) => Promise<void>) => {
    const operation = startComposerDraftOperation(key);
    await work(operation.signal).finally(operation.finish);
  };
  const report = (title: string, error: string | null | undefined, rejected: number) => {
    const problems = [
      ...(error ? [error] : []),
      ...(rejected
        ? [`You can attach up to ${PROVIDER_SEND_TURN_MAX_ATTACHMENTS} attachments per message.`]
        : []),
    ];
    if (problems.length) Dialog.alert(title, problems.join("\n\n"));
  };
  const onPickDraftMedia = async () => {
    const key = props.draftKey;
    if (!key || props.locked) return;
    const insertion = captureComposerDraftInsertion(key);
    await withDraftOperation(key, async (signal) => {
      const result = await pickComposerMedia({
        existingCount: countComposerDraftAttachmentsAfterSelection(key, insertion),
        maxVideoBytes: capabilities?.fileAttachments?.maxUploadBytes,
      });
      report(
        "Could not attach photo or video",
        result.error,
        await append(key, signal, result.attachments, insertion),
      );
    });
  };
  const onPickDraftFiles = async () => {
    const key = props.draftKey;
    if (!key || props.locked) return;
    const maxBytes = capabilities?.fileAttachments?.maxUploadBytes;
    if (maxBytes === undefined) {
      Dialog.alert("Could not attach file", "This server does not support file attachments.");
      return;
    }
    const insertion = captureComposerDraftInsertion(key);
    await withDraftOperation(key, async (signal) => {
      const result = await pickComposerFiles({
        existingCount: countComposerDraftAttachmentsAfterSelection(key, insertion),
        maxBytes,
      });
      report(
        "Could not attach file",
        result.error,
        await append(key, signal, result.files, insertion),
      );
    });
  };
  const onNativePasteImages = async (uris: ReadonlyArray<string>) => {
    const key = props.draftKey;
    if (!key || props.locked || !uris.length) return;
    const insertion = captureComposerDraftInsertion(key);
    await withDraftOperation(key, async (signal) => {
      try {
        const images = await convertPastedImagesToAttachments({
          uris,
          existingCount: countComposerDraftAttachmentsAfterSelection(key, insertion),
        });
        report("Could not paste images", null, await append(key, signal, images, insertion));
      } catch (error) {
        Dialog.alert(
          "Could not paste images",
          error instanceof Error ? error.message : "Try again.",
        );
      }
    });
  };
  const onNativePasteText = async (paste: ComposerTextPaste) => {
    const key = props.draftKey;
    if (!key || props.locked) return;
    const maxBytes = capabilities?.fileAttachments?.maxUploadBytes;
    if (maxBytes === undefined) return;
    const names = reservedNames.current.get(key) ?? new Set<string>();
    reservedNames.current.set(key, names);
    for (const attachment of getComposerDraftSnapshot(key).attachments) names.add(attachment.name);
    const name = nextPastedTextFileName([...names]);
    names.add(name);
    await withDraftOperation(key, async (signal) => {
      try {
        const attachment = await createPastedTextComposerAttachment({
          text: paste.text,
          name,
          maxBytes: clampFileAttachmentUploadBytes(maxBytes),
        });
        const rejected = await append(key, signal, [attachment], {
          text: paste.value,
          ...paste.selection,
        });
        if (rejected) await removePersistedComposerAttachmentFile(attachment.fileUri);
        report("Could not attach pasted text", null, rejected);
      } catch (error) {
        Dialog.alert(
          "Could not attach pasted text",
          error instanceof Error ? error.message : "Try again.",
        );
      }
    });
  };
  return { onPickDraftMedia, onPickDraftFiles, onNativePasteImages, onNativePasteText };
}
