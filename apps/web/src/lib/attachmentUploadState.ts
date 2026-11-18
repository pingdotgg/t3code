import type { EnvironmentId } from "@t3tools/contracts";
import { msg } from "gt-react";

import { m, type MessageResolver } from "../i18n/messages";

export type ReadyAttachmentUpload = {
  readonly status: "ready";
  readonly environmentId: EnvironmentId;
  readonly attachmentId: string;
};

export type AttachmentUploadState =
  | {
      readonly status: "uploading";
      readonly environmentId: EnvironmentId;
      readonly progress: number;
      readonly previous?: ReadyAttachmentUpload;
    }
  | ReadyAttachmentUpload
  | {
      readonly status: "failed";
      readonly environmentId: EnvironmentId;
      readonly reason: string;
      /** A server claim rejected this upload; retry must not reuse its persisted ID. */
      readonly forceReupload?: boolean;
      /** `reason` as a `msg()`, so the composer shows it in the current language. */
      readonly reasonMessage?: string;
      /** Retry/release deletes this id; never use a persisted draft attachment id. */
      readonly attachmentId?: string;
      readonly previous?: ReadyAttachmentUpload;
    };

export function attachmentUploadFailureText(
  upload: Extract<AttachmentUploadState, { status: "failed" }>,
  resolve: MessageResolver,
): string {
  return upload.reasonMessage === undefined ? upload.reason : resolve(upload.reasonMessage);
}

export function attachmentUploadBlockReason(
  input: {
    readonly imageIds: ReadonlyArray<string>;
    readonly uploadsByImageId: Readonly<Record<string, AttachmentUploadState>>;
    readonly environmentId: EnvironmentId;
  },
  resolve: MessageResolver = m,
): string | null {
  let pending = 0;

  for (const imageId of input.imageIds) {
    const upload = input.uploadsByImageId[imageId];
    // Send retries failed uploads, so they must not disable it.
    if (upload?.status === "failed" && upload.environmentId === input.environmentId) continue;
    if (upload?.status !== "ready" || upload.environmentId !== input.environmentId) {
      pending += 1;
    }
  }

  if (pending > 0) {
    return pending === 1
      ? resolve(msg("Attachment still uploading"))
      : resolve(msg("Attachments still uploading"));
  }
  return null;
}

export function formatAttachmentUploadProgress(progress: number): string {
  const bounded = Math.max(0, Math.min(1, Number.isFinite(progress) ? progress : 0));
  return `${Math.floor(bounded * 100)}%`;
}
