import { EnvironmentId, type ServerConfig } from "@t3tools/contracts";
import type * as Effect from "effect/Effect";
import { clampFileAttachmentUploadBytes } from "@t3tools/client-runtime/state/attachments";
import {
  createAttachmentUploadRegistry,
  type AttachmentUploadError,
  type AttachmentUploadStatus,
} from "@t3tools/client-runtime/state/attachment-uploads";

import { parseLegacyNewTaskDraftKey } from "../state/new-task-draft-key";
import type { DraftComposerAttachment } from "./composerImages";

export interface ComposerAttachmentUploadRequest {
  readonly environmentId: EnvironmentId;
  readonly attachment: DraftComposerAttachment;
}

export type ComposerAttachmentUploadState = AttachmentUploadStatus;

export function composerAttachmentUploadKey(
  environmentId: EnvironmentId,
  attachmentId: string,
): string {
  return `${environmentId}:${attachmentId}`;
}

/** Environment and thread ids may both contain colons, so a thread draft key resolves to the longest known environment it starts with. */
export function composerDraftEnvironmentId(
  draftKey: string,
  environmentIds: Iterable<EnvironmentId>,
  queuedMessages: ReadonlyArray<{
    readonly messageId: string;
    readonly environmentId: EnvironmentId;
  }>,
  draft?: { readonly project?: { readonly environmentId: EnvironmentId } },
): EnvironmentId | null {
  if (draftKey.startsWith("pending-task:")) {
    return (
      queuedMessages.find((message) => `pending-task:${message.messageId}` === draftKey)
        ?.environmentId ?? null
    );
  }
  if (draftKey.startsWith("new-task:")) {
    if (draft?.project) {
      return draft.project.environmentId;
    }
    const legacy = parseLegacyNewTaskDraftKey(draftKey);
    return legacy === null ? null : EnvironmentId.make(legacy.environmentId);
  }
  let match: EnvironmentId | null = null;
  for (const environmentId of environmentIds) {
    if (
      draftKey.startsWith(`${environmentId}:`) &&
      (match === null || environmentId.length > match.length)
    ) {
      match = environmentId;
    }
  }
  return match;
}

type UploadServerConfig = {
  readonly environment: {
    readonly capabilities: Pick<ServerConfig["environment"]["capabilities"], "fileAttachments">;
  };
};

export function canUploadComposerAttachment(
  attachment: DraftComposerAttachment,
  config: UploadServerConfig | null | undefined,
): boolean {
  const capabilities = config?.environment.capabilities;
  return (
    capabilities !== undefined &&
    (attachment.type === "image" ||
      (capabilities.fileAttachments !== undefined &&
        attachment.sizeBytes <=
          clampFileAttachmentUploadBytes(capabilities.fileAttachments.maxUploadBytes)))
  );
}

export function composerAttachmentUploadBlockReason(input: {
  readonly environmentId: EnvironmentId;
  readonly attachments: ReadonlyArray<DraftComposerAttachment>;
  readonly connected: boolean;
  readonly serverConfig: UploadServerConfig | null;
  readonly states: Readonly<Record<string, ComposerAttachmentUploadState>>;
}): string | null {
  if (!input.connected) return null;
  for (const attachment of input.attachments) {
    if (!canUploadComposerAttachment(attachment, input.serverConfig)) continue;
    const state = input.states[composerAttachmentUploadKey(input.environmentId, attachment.id)];
    if (state?.status === "failed") return "Retry or remove the failed attachment";
  }
  return null;
}

export function composerAttachmentsStillUploading(input: {
  readonly environmentId: EnvironmentId;
  readonly attachments: ReadonlyArray<DraftComposerAttachment>;
  readonly serverConfig: UploadServerConfig | null;
  readonly states: Readonly<Record<string, ComposerAttachmentUploadState>>;
}): boolean {
  return input.attachments.some((attachment) => {
    if (!canUploadComposerAttachment(attachment, input.serverConfig)) return false;
    const state = input.states[composerAttachmentUploadKey(input.environmentId, attachment.id)];
    return state?.status !== "ready" && state?.status !== "failed";
  });
}

/**
 * The composer's uploads, on the shared registry: keyed by environment and attachment, three at
 * a time per environment.
 */
export function createComposerAttachmentUploadQueue(options: {
  /** Uploads one attachment; interrupting it must abort the transfer and wait for it to settle. */
  readonly upload: (
    request: ComposerAttachmentUploadRequest,
    reportProgress: (progress: number) => void,
  ) => Effect.Effect<string, AttachmentUploadError>;
  /** Saves a finished upload's id; the upload is ready once this succeeds. */
  readonly onUploaded?: (
    request: ComposerAttachmentUploadRequest,
    uploadedId: string,
  ) => Effect.Effect<void, AttachmentUploadError>;
  readonly onChange: (states: Readonly<Record<string, ComposerAttachmentUploadState>>) => void;
}) {
  const registry = createAttachmentUploadRegistry<ComposerAttachmentUploadRequest>({
    key: (request) => composerAttachmentUploadKey(request.environmentId, request.attachment.id),
    environmentId: (request) => request.environmentId,
    concurrencyPerEnvironment: 3,
    upload: options.upload,
    ...(options.onUploaded ? { onUploaded: options.onUploaded } : {}),
    onChange: options.onChange,
  });
  return {
    sync: registry.sync,
    upload: registry.upload,
    retry: (environmentId: EnvironmentId, attachmentId: string) =>
      registry.retry(composerAttachmentUploadKey(environmentId, attachmentId)),
    settled: registry.settled,
    dispose: registry.dispose,
  };
}
