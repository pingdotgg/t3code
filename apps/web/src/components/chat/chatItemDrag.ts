import {
  type ChatAttachment,
  COMPOSER_CONTEXT_CLIPBOARD_MIME,
  EnvironmentId,
  FileContextRecord,
  ImageContextRecord,
} from "@t3tools/contracts";
import { serializeComposerFileLink } from "@t3tools/shared/composerTrigger";
import {
  formatComposerContextReference,
  sanitizeComposerContextLabel,
  toKindScopedComposerContextId,
} from "@t3tools/shared/composerContextReferences";
import { isAbsolutePath, resolveWorkspaceFilePath } from "@t3tools/shared/path";
import { Option, Schema } from "effect";
import type { DragEvent } from "react";

const NOT_DRAGGABLE = { draggable: false, onDragStartCapture: undefined };

export const CHAT_ITEM_DRAG_TYPE = "application/x-t3code-chat-item";

const ChatItemPayload = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("mention"),
    environmentId: EnvironmentId,
    path: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(32_768)),
  }),
  Schema.Struct({
    kind: Schema.Literal("attachment"),
    environmentId: EnvironmentId,
    record: Schema.Union([ImageContextRecord, FileContextRecord]),
  }),
]);
const decodePayload = Schema.decodeUnknownOption(Schema.fromJsonString(ChatItemPayload));
type ChatItemPayload = typeof ChatItemPayload.Type;
export type ChatItemDrop = ChatItemPayload & { readonly file?: File };

export function chatItemText(item: ChatItemDrop): string {
  return item.kind === "mention"
    ? serializeComposerFileLink(item.path)
    : formatComposerContextReference(item.record);
}

export function chatItemClipboardData(item: Extract<ChatItemDrop, { kind: "attachment" }>) {
  return {
    getData: (format: string) =>
      format === "text/plain"
        ? chatItemText(item)
        : format === COMPOSER_CONTEXT_CLIPBOARD_MIME
          ? JSON.stringify({
              version: 1,
              source: { environmentId: item.environmentId },
              records: [item.record],
            })
          : "",
  };
}

export function chatItemDropError(item: ChatItemDrop, environmentId: EnvironmentId): string | null {
  return item.kind === "mention" && item.environmentId !== environmentId
    ? "File references can only be copied to threads on the same server. Attach the file to transfer its contents."
    : null;
}

export function readChatItemDrop(data: {
  getData(format: string): string;
  readonly files: Iterable<File>;
}): ChatItemDrop | null {
  const raw = data.getData(CHAT_ITEM_DRAG_TYPE);
  if (raw.length > 65_536) return null;
  const decoded = Option.getOrNull(decodePayload(raw));
  if (!decoded) return null;
  if (decoded.kind === "mention") {
    return isAbsolutePath(decoded.path) || /^~[/\\]/.test(decoded.path) ? decoded : null;
  }
  const file = Array.from(data.files).find(
    (file) => file.name === decoded.record.name && file.size === decoded.record.sizeBytes,
  );
  return file ? { ...decoded, file } : decoded;
}

function dragProps(item: ChatItemPayload, file?: File) {
  return {
    draggable: true,
    onDragStartCapture: (event: DragEvent<HTMLElement>) => {
      // Claim before ProseMirror sees the drag, so it cannot move/delete the source node.
      event.stopPropagation();
      event.dataTransfer.clearData();
      event.dataTransfer.setData(CHAT_ITEM_DRAG_TYPE, JSON.stringify(item));
      event.dataTransfer.setData("text/plain", chatItemText(item));
      if (file) event.dataTransfer.items.add(file);
      event.dataTransfer.effectAllowed = "copy";
    },
  };
}

export function fileReferenceDragProps(
  environmentId: EnvironmentId | null,
  path: string,
  cwd?: string,
) {
  if (!environmentId || !path) return NOT_DRAGGABLE;
  const resolved = cwd ? resolveWorkspaceFilePath(path, cwd) : path;
  if (!isAbsolutePath(resolved) && !/^~[/\\]/.test(resolved)) return NOT_DRAGGABLE;
  return dragProps({ kind: "mention", environmentId, path: resolved });
}

type DraggableAttachment = Pick<
  ChatAttachment,
  "type" | "id" | "name" | "mimeType" | "sizeBytes"
> & {
  readonly type: "image" | "file";
  readonly file?: File | null;
  readonly uploadedAttachmentId?: string;
  readonly downloadable?: boolean;
};

export function attachmentDragProps(
  environmentId: EnvironmentId | null,
  attachment: DraggableAttachment,
  uploadedId?: string,
) {
  const attachmentId = uploadedId ?? attachment.uploadedAttachmentId;
  if (
    !environmentId ||
    attachment.downloadable === false ||
    ("file" in attachment && !attachment.file && !attachmentId)
  )
    return NOT_DRAGGABLE;
  return dragProps(
    {
      kind: "attachment",
      environmentId,
      record: {
        version: 1,
        kind: attachment.type,
        contextId: toKindScopedComposerContextId(attachment.type, attachment.id),
        label: sanitizeComposerContextLabel(attachment.name, attachment.type),
        attachmentId: attachmentId ?? attachment.id,
        name: attachment.name,
        mimeType: attachment.mimeType,
        sizeBytes: attachment.sizeBytes,
      },
    },
    attachment.file ?? undefined,
  );
}
