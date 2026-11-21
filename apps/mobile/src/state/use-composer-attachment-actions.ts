import * as Dialog from "../components/ui/Dialog";
import { errorDisplayMessage } from "@t3tools/client-runtime/errors";
import { msg } from "gt-react-native";
import { useRef } from "react";
import { m } from "../i18n/messages";
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
  addComposerPendingMedia,
  keepPendingComposerMedia,
  removeComposerPendingMedia,
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
  const withDraftOperation = async <T>(key: string, work: (signal: AbortSignal) => Promise<T>) => {
    const operation = startComposerDraftOperation(key);
    return work(operation.signal).finally(operation.finish);
  };
  const report = (title: string, error: string | null | undefined, rejected: number) => {
    const problems = [
      ...(error ? [error] : []),
      ...(rejected
        ? [
            m(
              msg("You can attach up to {max} attachments per message.", {
                max: PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
              }),
            ),
          ]
        : []),
    ];
    if (problems.length) Dialog.alert(title, problems.join("\n\n"));
  };
  const onPickDraftMedia = async () => {
    const key = props.draftKey;
    if (!key || props.locked) return;
    const insertion = captureComposerDraftInsertion(key);
    await withDraftOperation(key, async (signal) => {
      let placeholderIds: ReadonlyArray<string> = [];
      await pickComposerMedia({
        existingCount: countComposerDraftAttachmentsAfterSelection(key, insertion),
        maxVideoBytes: capabilities?.fileAttachments?.maxUploadBytes,
        onPicked: (placeholders) => {
          placeholderIds = placeholders.map(({ id }) => id);
          addComposerPendingMedia(key, placeholders);
        },
      })
        .then(async (result) => {
          // append writes the draft before its first await, so no removal lands in between.
          report(
            m(msg("Could not attach photo or video")),
            result.error,
            await append(key, signal, keepPendingComposerMedia(key, result.attachments), insertion),
          );
        })
        .finally(() => removeComposerPendingMedia(key, placeholderIds));
    });
  };
  const onPickDraftFiles = async () => {
    const key = props.draftKey;
    if (!key || props.locked) return;
    const maxBytes = capabilities?.fileAttachments?.maxUploadBytes;
    if (maxBytes === undefined) {
      Dialog.alert(
        m(msg("Could not attach file")),
        m(msg("This server does not support file attachments.")),
      );
      return;
    }
    const insertion = captureComposerDraftInsertion(key);
    await withDraftOperation(key, async (signal) => {
      const result = await pickComposerFiles({
        existingCount: countComposerDraftAttachmentsAfterSelection(key, insertion),
        maxBytes,
      });
      report(
        m(msg("Could not attach file")),
        result.error,
        await append(key, signal, result.files, insertion),
      );
    });
  };
  const onNativePasteImages = async (uris: ReadonlyArray<string>) => {
    const key = props.draftKey;
    if (!key || props.locked || !uris.length) return false;
    const insertion = captureComposerDraftInsertion(key);
    return withDraftOperation(key, async (signal) => {
      try {
        const result = await convertPastedImagesToAttachments({ uris });
        const rejected = await append(key, signal, result.attachments, insertion);
        report(m(msg("Could not paste images")), result.error, rejected);
        if (signal.aborted) return false;
        if (result.error) return false;
        if (rejected > 0) return false;
        return result.attachments.length > 0;
      } catch (error) {
        Dialog.alert(
          m(msg("Could not paste images")),
          errorDisplayMessage(error, m) ?? m(msg("Try again.")),
        );
        return false;
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
        report(m(msg("Could not attach pasted text")), null, rejected);
      } catch (error) {
        Dialog.alert(
          m(msg("Could not attach pasted text")),
          errorDisplayMessage(error, m) ?? m(msg("Try again.")),
        );
      }
    });
  };
  return { onPickDraftMedia, onPickDraftFiles, onNativePasteImages, onNativePasteText };
}
