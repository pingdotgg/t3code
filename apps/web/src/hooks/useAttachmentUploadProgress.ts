import {
  type AttachmentUploadState,
  formatAttachmentUploadProgress,
} from "../lib/attachmentUploadState";
import { useDelayedStatus } from "./useDelayedStatus";

export function useAttachmentUploadProgress(
  key: string,
  upload: AttachmentUploadState | undefined,
) {
  const uploading = upload?.status === "uploading";
  const shown = useDelayedStatus(
    `${key}:${upload?.environmentId ?? ""}:${uploading ? "uploading" : "idle"}`,
    uploading ? true : null,
    150,
  );
  return uploading && shown ? formatAttachmentUploadProgress(upload.progress) : null;
}
