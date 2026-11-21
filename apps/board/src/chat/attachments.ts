import {
  type AttachmentCreateUploadUrlInput,
  type ChatAttachment,
  getProviderAttachmentLimitError,
  type OrchestrationV2ThreadProjection,
  PROVIDER_SEND_TURN_MAX_FILE_BYTES,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
  PROVIDER_SEND_TURN_SUPPORTED_IMAGE_MIME_TYPES,
} from "@t3tools/contracts";
import { fileAttachmentTooLargeMessage } from "@t3tools/client-runtime/state/attachments";

export type AttachmentInputs =
  | { readonly inputs: ReadonlyArray<AttachmentCreateUploadUrlInput> }
  | { readonly error: string };

/**
 * The upload requests for dropped files, as T3 web sends them: a supported image type goes as an
 * image and anything else as a file. Resolves to T3's own message for the first limit a file or
 * the whole message breaks.
 */
export function attachmentInputs(
  files: ReadonlyArray<Pick<File, "name" | "type" | "size">>,
): AttachmentInputs {
  const inputs: AttachmentCreateUploadUrlInput[] = [];
  for (const { name, type, size } of files) {
    const imageType = PROVIDER_SEND_TURN_SUPPORTED_IMAGE_MIME_TYPES.find(
      (supported) => supported === type.toLowerCase(),
    );
    if (imageType !== undefined) {
      if (size > PROVIDER_SEND_TURN_MAX_IMAGE_BYTES) {
        return { error: fileAttachmentTooLargeMessage(name, PROVIDER_SEND_TURN_MAX_IMAGE_BYTES) };
      }
      inputs.push({ type: "image", name, mimeType: imageType, sizeBytes: size });
    } else {
      if (size > PROVIDER_SEND_TURN_MAX_FILE_BYTES) {
        return { error: fileAttachmentTooLargeMessage(name, PROVIDER_SEND_TURN_MAX_FILE_BYTES) };
      }
      inputs.push({
        type: "file",
        name,
        mimeType: type === "" ? "application/octet-stream" : type,
        sizeBytes: size,
      });
    }
  }
  const error = getProviderAttachmentLimitError(
    inputs.map((input) => ({ ...input, type: input.type ?? "image" })),
  );
  return error === undefined ? { inputs } : { error };
}

/** The message's attachment once T3 holds the bytes under `attachmentId`. */
export const sentAttachment = (
  input: AttachmentCreateUploadUrlInput,
  attachmentId: string,
): ChatAttachment => ({
  type: input.type ?? "image",
  id: attachmentId,
  name: input.name,
  mimeType: input.mimeType,
  sizeBytes: input.sizeBytes,
});

/** The board's docs: every file the user attached in the orchestrator's thread. */
export const boardDocs = (
  projection: OrchestrationV2ThreadProjection | null,
): ReadonlyArray<ChatAttachment> =>
  (projection?.messages ?? [])
    .filter((message) => message.role === "user")
    .flatMap((message) => message.attachments);
