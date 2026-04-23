import type { EnvironmentId } from "@forma/contracts";

import { resolveEnvironmentHttpUrl } from "./environments/runtime";

export function attachmentPreviewRoutePath(attachmentId: string): string {
  return `/attachments/${encodeURIComponent(attachmentId)}`;
}

export function resolveAttachmentPreviewUrl(input: {
  environmentId: EnvironmentId;
  attachmentId: string;
}): string {
  return resolveEnvironmentHttpUrl({
    environmentId: input.environmentId,
    pathname: attachmentPreviewRoutePath(input.attachmentId),
  });
}
