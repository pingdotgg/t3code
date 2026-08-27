import {
  isProviderSendTurnSupportedImageMimeType,
  isProviderSendTurnSupportedVideoMimeType,
  PROVIDER_SEND_TURN_MAX_VIDEO_BYTES,
} from "@t3tools/contracts";

/** The `File` fields the drop classification actually reads. */
export interface ComposerCandidateFile {
  readonly type: string;
  readonly size: number;
}

/**
 * Whether a dropped file can ride inside the message itself. Everything else —
 * CSVs, PDFs, archives, exotic or oversized media — is referenced by its path
 * so the agent opens it from disk instead of the drop being rejected.
 */
export function isInlineAttachableFile(file: ComposerCandidateFile): boolean {
  if (file.type.startsWith("video/")) {
    return (
      isProviderSendTurnSupportedVideoMimeType(file.type) &&
      file.size > 0 &&
      file.size <= PROVIDER_SEND_TURN_MAX_VIDEO_BYTES
    );
  }
  return file.type.startsWith("image/") && isProviderSendTurnSupportedImageMimeType(file.type);
}
