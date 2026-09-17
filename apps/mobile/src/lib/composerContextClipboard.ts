import { requireNativeModule } from "expo";
import {
  type ComposerContextClipboardFragment,
  type ComposerContextRecord,
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  PROVIDER_SEND_TURN_MAX_FILE_BYTES,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
  COMPOSER_CONTEXT_MAX_RECORDS,
  type EnvironmentId,
} from "@t3tools/contracts";
import {
  decodeComposerContextClipboardHtml,
  decodeComposerContextFragment,
  encodeComposerContextFragment,
} from "@t3tools/shared/composerContextClipboard";
import { executeAtomQuery, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { resolveAssetUrl } from "@t3tools/client-runtime/state/assets";
import * as Option from "effect/Option";
import { appAtomRegistry } from "../state/atom-registry";
import { assetEnvironment } from "../state/assets";
import { environmentSession } from "../state/session";
import { downloadAttachmentForPreview } from "./attachmentDownload";
import {
  persistComposerAttachmentFile,
  removePersistedComposerAttachmentFile,
  type DraftComposerAttachment,
} from "./composerImages";
import { referencedComposerContext, reidentifyComposerContext } from "./composerContext";
import { uuidv4 } from "./uuid";
import {
  findLocalComposerClipboardAttachment,
  waitForComposerDraftsLoaded,
} from "../state/use-composer-drafts";
import { loadLocalAttachmentPreview } from "./localAttachmentPreview";

export interface NativeContextClipboard {
  readonly text: string;
  readonly fragment: string;
  readonly html: string;
}

function checkAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new Error("Context import cancelled");
}

const nativeClipboard = () =>
  requireNativeModule<{
    writeContextClipboard: (text: string, fragment: string) => Promise<void>;
  }>("T3ComposerEditor");

export function writeComposerContextClipboard(
  text: string,
  fragment: ComposerContextClipboardFragment,
): Promise<void> {
  const encoded = encodeComposerContextFragment(fragment);
  if (!encoded)
    return Promise.reject(
      new Error("This context selection is too large to copy. Select fewer items."),
    );
  return nativeClipboard().writeContextClipboard(text, encoded);
}

/** Copies signed source assets into owned local files; the usual upload queue handles the destination. */
export async function importComposerContextClipboard(
  input: NativeContextClipboard,
  existingCount: number,
  signal: AbortSignal,
  existingContextCount = 0,
) {
  const fragment =
    decodeComposerContextFragment(input.fragment) ?? decodeComposerContextClipboardHtml(input.html);
  if (!fragment) return null;
  const selected = referencedComposerContext(input.text, { version: 1, records: fragment.records });
  if (existingContextCount + (selected?.records.length ?? 0) > COMPOSER_CONTEXT_MAX_RECORDS)
    throw new Error("Remove some context items from the draft before pasting more.");
  const imported = reidentifyComposerContext(input.text, selected?.records ?? [], uuidv4);
  const attachments: DraftComposerAttachment[] = [];
  const records: ComposerContextRecord[] = [];
  const failures: string[] = [];
  try {
    for (const record of imported.context.records) {
      checkAborted(signal);
      if (!("attachmentId" in record)) {
        records.push(record);
        continue;
      }
      try {
        if (existingCount + attachments.length >= PROVIDER_SEND_TURN_MAX_ATTACHMENTS)
          throw new Error("Attachment limit reached");
        const file = await importAttachment(record, fragment.source.environmentId, signal);
        attachments.push(file);
        records.push({ ...record, attachmentId: file.id });
      } catch (error) {
        if (signal.aborted) throw error;
        failures.push(record.name);
      }
    }
    return {
      text: imported.text,
      context: { version: 1 as const, records },
      attachments,
      failures,
    };
  } catch (error) {
    await Promise.all(
      attachments.map((attachment) =>
        attachment.fileUri
          ? removePersistedComposerAttachmentFile(attachment.fileUri)
          : Promise.resolve(),
      ),
    );
    throw error;
  }
}

async function importAttachment(
  record: Extract<ComposerContextRecord, { attachmentId: string }>,
  environmentId: EnvironmentId,
  signal: AbortSignal,
): Promise<DraftComposerAttachment> {
  await waitForComposerDraftsLoaded();
  checkAborted(signal);
  const local = findLocalComposerClipboardAttachment(environmentId, record.attachmentId);
  if (local) {
    if (!local.fileUri && local.type === "image" && local.dataUrl)
      return {
        ...local,
        id: uuidv4(),
        uploadedAttachmentId: undefined,
        uploadEnvironmentId: undefined,
      };
    if (local.fileUri) {
      const preview = await loadLocalAttachmentPreview(
        { ...local, fileUri: local.fileUri },
        signal,
      );
      if (!preview) throw new Error("Context import cancelled");
      try {
        return await persistImportedAttachment(record, preview.uri, signal);
      } finally {
        preview.dispose();
      }
    }
  }
  const connection = appAtomRegistry.get(
    environmentSession.preparedConnectionValueAtom(environmentId),
  );
  if (Option.isNone(connection)) throw new Error("Reconnect to the source environment");
  const result = await executeAtomQuery(
    appAtomRegistry,
    assetEnvironment.createUrl({
      environmentId,
      input: {
        resource: { _tag: "attachment", attachmentId: record.attachmentId, fileName: record.name },
      },
    }),
    { refresh: true, reportFailure: false },
  );
  if (result._tag === "Failure") throw squashAtomCommandFailure(result);
  checkAborted(signal);
  const url = resolveAssetUrl(connection.value.httpBaseUrl, result.value.relativeUrl);
  if (!url) throw new Error("Attachment URL unavailable");
  const temporary = await downloadAttachmentForPreview({
    attachment: { name: record.name, mimeType: record.mimeType },
    url,
    signal,
  });
  if (!temporary) throw new Error("Attachment import cancelled");
  try {
    return await persistImportedAttachment(record, temporary.uri, signal);
  } finally {
    temporary.dispose();
  }
}

async function persistImportedAttachment(
  record: Extract<ComposerContextRecord, { attachmentId: string }>,
  uri: string,
  signal: AbortSignal,
): Promise<DraftComposerAttachment> {
  const fileUri = await persistComposerAttachmentFile(
    uri,
    record.name,
    record.kind === "image"
      ? PROVIDER_SEND_TURN_MAX_IMAGE_BYTES
      : PROVIDER_SEND_TURN_MAX_FILE_BYTES,
  );
  if (signal.aborted) {
    await removePersistedComposerAttachmentFile(fileUri);
    checkAborted(signal);
  }
  const { File } = await import("expo-file-system");
  const common = {
    id: uuidv4(),
    fileUri,
    name: record.name,
    mimeType: record.mimeType,
    sizeBytes: new File(fileUri).size,
  };
  return record.kind === "image"
    ? { ...common, type: "image", previewUri: fileUri }
    : { ...common, type: "file" };
}
