import { requireNativeModule } from "expo";
import {
  ComposerContextId,
  type ChatAttachment,
  type OrchestrationMessageContext,
  type ComposerContextClipboardFragment,
  type ComposerContextRecord,
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  PROVIDER_SEND_TURN_MAX_INPUT_CHARS,
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
import {
  collectComposerContextReferences,
  formatComposerContextReference,
  sanitizeComposerContextLabel,
} from "@t3tools/shared/composerContextReferences";
import { threadContextsOutsideEnvironment } from "@t3tools/shared/composerContextReferences";
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
import {
  composerContextSendBlockReason,
  referencedComposerContext,
  reidentifyComposerContext,
} from "./composerContext";
import { uuidv4 } from "./uuid";
import {
  findLocalComposerClipboardAttachment,
  waitForComposerDraftsLoaded,
  type ComposerDraftContent,
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

export async function importComposerContextClipboard(
  input: NativeContextClipboard,
  existingCount: number,
  signal: AbortSignal,
  existingContextCount = 0,
  destinationEnvironmentId?: EnvironmentId,
) {
  const fragment =
    decodeComposerContextFragment(input.fragment) ?? decodeComposerContextClipboardHtml(input.html);
  if (!fragment) return null;
  const selected = referencedComposerContext(input.text, { version: 1, records: fragment.records });
  const imported = reidentifyComposerContext(input.text, selected?.records ?? [], uuidv4);
  const skippedThreads =
    destinationEnvironmentId === undefined
      ? []
      : threadContextsOutsideEnvironment({
          text: imported.text,
          records: imported.context.records,
          environmentId: destinationEnvironmentId,
        });
  const skippedIds = new Set(skippedThreads.map((record) => record.contextId));
  const retained = imported.context.records.filter((record) => !skippedIds.has(record.contextId));
  if (existingContextCount + retained.length > COMPOSER_CONTEXT_MAX_RECORDS)
    throw new Error("Remove some context items from the draft before pasting more.");
  const attachments: DraftComposerAttachment[] = [];
  const records: ComposerContextRecord[] = [];
  const failures: string[] = [];
  try {
    for (const record of retained) {
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
      skippedThreads: skippedThreads.map((record) => record.title),
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
  try {
    checkAborted(signal);
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
  } catch (error) {
    await removePersistedComposerAttachmentFile(fileUri);
    throw error;
  }
}

export function assertRewindContentFits(
  existing: {
    readonly text?: string;
    readonly attachments: ReadonlyArray<unknown>;
    readonly context?: OrchestrationMessageContext;
  },
  incoming: {
    readonly text?: string;
    readonly attachments: ReadonlyArray<unknown>;
    readonly context?: OrchestrationMessageContext;
  },
): void {
  const existingText = existing.text ?? "";
  const incomingText = incoming.text ?? "";
  const combinedLength =
    existingText === incomingText || existingText.endsWith(`\n\n${incomingText}`)
      ? existingText.length
      : existingText.length +
        incomingText.length +
        (existingText.length > 0 && incomingText.length > 0 ? 2 : 0);
  if (combinedLength > PROVIDER_SEND_TURN_MAX_INPUT_CHARS)
    throw new Error("Make room for this message's text in the composer before rewinding.");
  if (
    existing.attachments.length + incoming.attachments.length >
    PROVIDER_SEND_TURN_MAX_ATTACHMENTS
  )
    throw new Error("Make room for this message's attachments in the composer before rewinding.");
  if (
    (existing.context?.records.length ?? 0) + (incoming.context?.records.length ?? 0) >
    COMPOSER_CONTEXT_MAX_RECORDS
  )
    throw new Error("Make room for this message's context in the composer before rewinding.");
  const contextBlockReason = composerContextSendBlockReason({
    version: 1,
    records: [...(existing.context?.records ?? []), ...(incoming.context?.records ?? [])],
  });
  if (contextBlockReason) throw new Error(contextBlockReason);
}

// Clipboard paste may keep a partial import. Rewind must retain every file and context
// snapshot before changing history, since the original message is about to disappear.
export async function prepareRewindComposerContent(
  message: {
    readonly text: string;
    readonly context?: OrchestrationMessageContext;
    readonly attachments: ReadonlyArray<ChatAttachment>;
  },
  environmentId: EnvironmentId,
  existing: {
    readonly text?: string;
    readonly attachments: ReadonlyArray<unknown>;
    readonly context?: OrchestrationMessageContext;
  },
  signal: AbortSignal,
): Promise<ComposerDraftContent> {
  const selected = referencedComposerContext(message.text, message.context);
  const references = collectComposerContextReferences(message.text);
  if (
    selected?.records.some(
      (record) =>
        record.kind === "preview-annotation" &&
        "screenshotContextId" in record &&
        record.screenshotContextId &&
        !selected.records.some(
          (image) => image.kind === "image" && image.contextId === record.screenshotContextId,
        ),
    )
  )
    throw new Error("This message has an unavailable context screenshot.");
  if (
    references.some(
      (reference) =>
        !selected?.records.some(
          (record) => record.contextId === reference.contextId && record.kind === reference.kind,
        ),
    )
  )
    throw new Error("This message has unavailable context. Restore it before rewinding.");
  if (
    threadContextsOutsideEnvironment({
      text: message.text,
      records: selected?.records ?? [],
      environmentId,
    }).length > 0
  )
    throw new Error("This message contains context from another environment.");
  let text = message.text;
  const records = [...(selected?.records ?? [])];
  for (const attachment of message.attachments) {
    if (attachment.type !== "image" && attachment.type !== "file")
      throw new Error(`Cannot restore attachment: ${attachment.name}`);
    if (records.some((record) => "attachmentId" in record && record.attachmentId === attachment.id))
      continue;
    const record = {
      version: 1 as const,
      kind: attachment.type === "image" ? ("image" as const) : ("file" as const),
      contextId: ComposerContextId.make(uuidv4()),
      label: sanitizeComposerContextLabel(attachment.name, "Attachment"),
      name: attachment.name,
      mimeType: attachment.mimeType,
      sizeBytes: attachment.sizeBytes,
      attachmentId: attachment.id,
    };
    records.push(
      record.kind === "image" ? { ...record, kind: "image" } : { ...record, kind: "file" },
    );
    if (record.kind === "file")
      text += `${text.length > 0 ? "\n\n" : ""}${formatComposerContextReference(record)}`;
  }
  const imported = reidentifyComposerContext(text, records, uuidv4);
  const fileIds = new Set(
    records.flatMap((record) => ("attachmentId" in record ? [record.attachmentId] : [])),
  );
  assertRewindContentFits(existing, {
    text: imported.text,
    attachments: [...fileIds],
    context: imported.context,
  });
  const attachments: DraftComposerAttachment[] = [];
  const filesBySourceId = new Map<string, DraftComposerAttachment>();
  try {
    const rebound: ComposerContextRecord[] = [];
    for (const record of imported.context.records) {
      checkAborted(signal);
      if (!("attachmentId" in record)) {
        rebound.push(record);
        continue;
      }
      let file = filesBySourceId.get(record.attachmentId);
      if (!file) {
        file = await importAttachment(record, environmentId, signal);
        const original = message.attachments.find(
          (attachment) => attachment.id === record.attachmentId,
        );
        const source = original && "source" in original ? original.source : undefined;
        if (file.type === "file" && source && "_tag" in source) file = { ...file, source };
        else if (file.type === "image" && source && "kind" in source) file = { ...file, source };
        attachments.push(file);
        filesBySourceId.set(record.attachmentId, file);
      }
      rebound.push({ ...record, attachmentId: file.id });
    }
    return { text: imported.text, context: { version: 1, records: rebound }, attachments };
  } catch (error) {
    await Promise.all(
      attachments.map((file) =>
        file.fileUri ? removePersistedComposerAttachmentFile(file.fileUri) : Promise.resolve(),
      ),
    );
    throw error;
  }
}
