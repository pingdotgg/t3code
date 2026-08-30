import { resolveAssetUrl } from "@t3tools/client-runtime/state/assets";
import {
  clampFileAttachmentUploadBytes,
  fileAttachmentTooLargeMessage,
  isAssetAttachmentNotFoundFailure,
  runAttachmentUploadCycle,
  verifyPersistedAttachmentUpload,
} from "@t3tools/client-runtime/state/attachments";
import { runAtomCommand, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type {
  ChatFileAttachment,
  EnvironmentId,
  UploadChatImageAttachment,
} from "@t3tools/contracts";
import * as Option from "effect/Option";

import { appAtomRegistry } from "../state/atom-registry";
import { assetEnvironment } from "../state/assets";
import { attachmentEnvironment } from "../state/attachments";
import { environmentSession } from "../state/session";
import { resolveOwnedComposerAttachmentFileUri } from "./composerAttachmentFiles";
import { toUploadChatImageAttachments, type DraftComposerAttachment } from "./composerImages";

/**
 * This module owns the server side of a composer attachment's lifecycle.
 * `prepareTurnAttachments` acquires pending uploads (verifying and reusing
 * persisted ones), hands the uploaded ids back to the attachment's durable
 * owner (queued outbox message or composer draft), and returns a release
 * handle for after the turn consumed the bytes. Nothing outside this module
 * mints or deletes pending uploads. The local-file side of the lifecycle is
 * owned by `removeThreadOutboxMessage` / the composer draft mutators, which
 * release files through `releaseUnusedComposerAttachmentFiles`.
 */
export type UploadedMobileAttachment = UploadChatImageAttachment | ChatFileAttachment;

export function validateDraftFileAttachments(input: {
  readonly attachments: ReadonlyArray<DraftComposerAttachment>;
  readonly serverConfig: {
    readonly environment: {
      readonly capabilities: {
        readonly attachmentUploads?: boolean;
        readonly fileAttachments?: { readonly maxUploadBytes: number };
      };
    };
  } | null;
}): string | null {
  const files = input.attachments.filter((attachment) => attachment.type === "file");
  if (files.length === 0) return null;
  if (input.serverConfig === null) return "Server attachment support is still loading.";
  const capabilities = input.serverConfig.environment.capabilities;
  if (capabilities.attachmentUploads !== true || capabilities.fileAttachments === undefined) {
    return "This server does not support file attachments.";
  }
  const maxBytes = clampFileAttachmentUploadBytes(capabilities.fileAttachments.maxUploadBytes);
  const oversized = files.find((attachment) => attachment.sizeBytes > maxBytes);
  return oversized ? fileAttachmentTooLargeMessage(oversized.name, maxBytes) : null;
}

/** Keep uploaded file ids on durable drafts so a later send can reuse their bytes. */
export function withUploadedMobileAttachmentReferences(input: {
  readonly environmentId: EnvironmentId;
  readonly attachments: ReadonlyArray<DraftComposerAttachment>;
  readonly uploadedAttachments: ReadonlyArray<UploadedMobileAttachment>;
}): ReadonlyArray<DraftComposerAttachment> {
  return input.attachments.map((attachment, index) => {
    const uploaded = input.uploadedAttachments[index];
    if (
      attachment.type !== "file" ||
      uploaded?.type !== "file" ||
      (attachment.uploadedAttachmentId === uploaded.id &&
        attachment.uploadEnvironmentId === input.environmentId)
    ) {
      return attachment;
    }
    return {
      ...attachment,
      uploadedAttachmentId: uploaded.id,
      uploadEnvironmentId: input.environmentId,
    };
  });
}

/**
 * Deletes pending uploads the client no longer references. Every delete result
 * is inspected; failed deletes are retried once and a persistent failure
 * throws, so a caller can never silently leak the outcome. (The server also
 * expires pending uploads, so a leaked id self-heals eventually.)
 */
export async function releasePendingAttachmentUploads(
  environmentId: EnvironmentId,
  attachmentIds: ReadonlyArray<string>,
): Promise<void> {
  const deleteOnce = async (attachmentId: string): Promise<boolean> => {
    const result = await runAtomCommand(
      appAtomRegistry,
      attachmentEnvironment.remove,
      { environmentId, input: { attachmentId } },
      { reportFailure: false, reportDefect: false },
    );
    return (
      result._tag === "Success" ||
      isAssetAttachmentNotFoundFailure(squashAtomCommandFailure(result))
    );
  };

  const failedAttachmentIds: string[] = [];
  for (const attachmentId of attachmentIds) {
    if (!(await deleteOnce(attachmentId)) && !(await deleteOnce(attachmentId))) {
      failedAttachmentIds.push(attachmentId);
    }
  }
  if (failedAttachmentIds.length > 0) {
    throw new Error(
      `Could not delete ${failedAttachmentIds.length} pending attachment upload(s): ${failedAttachmentIds.join(", ")}.`,
    );
  }
}

async function releaseCreatedUploadsQuietly(
  environmentId: EnvironmentId,
  attachmentIds: ReadonlyArray<string>,
): Promise<void> {
  try {
    await releasePendingAttachmentUploads(environmentId, attachmentIds);
  } catch (error) {
    // The original failure must propagate; the leaked pending uploads expire
    // on the server.
    console.warn("[attachments] could not delete abandoned pending uploads", error);
  }
}

export interface PreparedTurnAttachments {
  readonly status: "ready";
  /** Wire attachments for `startTurn`, in the original composer order. */
  readonly attachments: ReadonlyArray<UploadedMobileAttachment>;
  /** Composer attachments annotated with the uploaded pending ids. */
  readonly draftAttachments: ReadonlyArray<DraftComposerAttachment>;
  /** Every pending upload backing this turn (reused and newly minted). */
  readonly pendingAttachmentIds: ReadonlyArray<string>;
  /** Deletes all pending uploads once the delivered turn holds the bytes. */
  readonly releaseUploads: () => Promise<void>;
}

export type PrepareTurnAttachmentsResult =
  | PreparedTurnAttachments
  | { readonly status: "abandoned" };

async function uploadFileBytes(
  attachment: Extract<DraftComposerAttachment, { readonly type: "file" }>,
  url: string,
): Promise<void> {
  const { File, Paths, UploadType } = await import("expo-file-system");
  const fileUri =
    resolveOwnedComposerAttachmentFileUri(attachment.fileUri, Paths.document.uri) ??
    attachment.fileUri;
  const result = await new File(fileUri).upload(url, {
    httpMethod: "POST",
    uploadType: UploadType.BINARY_CONTENT,
    headers: { "Content-Type": attachment.mimeType },
  });
  if (result.status < 200 || result.status >= 300) {
    throw new Error(`Upload failed for '${attachment.name}' (${result.status}).`);
  }
}

/**
 * Acquires server-side uploads for one turn's attachments and persists the
 * uploaded ids into the attachments' durable owner.
 *
 * `persistUploadedReferences` runs once the bytes are on the server and only
 * when new ids appeared. It must write the annotated attachments into the
 * owner (queued message or draft) so a retry after a crash reuses the bytes.
 * Returning `"abandon"` (owner no longer wants the send) or throwing deletes
 * the pending uploads this call minted, so the owner cannot leak them.
 */
export async function prepareTurnAttachments(input: {
  readonly environmentId: EnvironmentId;
  readonly attachments: ReadonlyArray<DraftComposerAttachment>;
  readonly persistUploadedReferences?: (
    draftAttachments: ReadonlyArray<DraftComposerAttachment>,
  ) => Promise<"persisted" | "abandon">;
}): Promise<PrepareTurnAttachmentsResult> {
  const { environmentId } = input;
  const files = input.attachments.filter((attachment) => attachment.type === "file");
  const ready = (
    attachments: ReadonlyArray<UploadedMobileAttachment>,
    pendingAttachmentIds: ReadonlyArray<string>,
    draftAttachments: ReadonlyArray<DraftComposerAttachment>,
  ): PreparedTurnAttachments => ({
    status: "ready",
    attachments,
    draftAttachments,
    pendingAttachmentIds,
    releaseUploads: () => releasePendingAttachmentUploads(environmentId, pendingAttachmentIds),
  });

  if (files.length === 0) {
    return ready(
      toUploadChatImageAttachments(
        input.attachments.filter((attachment) => attachment.type === "image"),
      ),
      [],
      input.attachments,
    );
  }

  const connection = appAtomRegistry.get(
    environmentSession.preparedConnectionValueAtom(environmentId),
  );
  if (Option.isNone(connection)) {
    throw new Error("The environment is not connected.");
  }

  const uploadedAttachments: UploadedMobileAttachment[] = [];
  const pendingAttachmentIds: string[] = [];
  const createdAttachmentIds: string[] = [];
  try {
    for (const attachment of input.attachments) {
      if (attachment.type === "image") {
        uploadedAttachments.push(...toUploadChatImageAttachments([attachment]));
        continue;
      }

      // Reuse the bytes from a previous attempt when their pending upload is
      // still alive on this environment.
      if (
        attachment.uploadEnvironmentId === environmentId &&
        attachment.uploadedAttachmentId !== undefined
      ) {
        const verification = await verifyPersistedAttachmentUpload({
          registry: appAtomRegistry,
          createAssetUrl: assetEnvironment.createUrl,
          environmentId,
          attachmentId: attachment.uploadedAttachmentId,
        });
        if (verification.status === "failed") {
          throw verification.error;
        }
        if (verification.status === "verified") {
          pendingAttachmentIds.push(attachment.uploadedAttachmentId);
          uploadedAttachments.push({
            type: "file",
            id: attachment.uploadedAttachmentId,
            name: attachment.name,
            mimeType: attachment.mimeType,
            sizeBytes: attachment.sizeBytes,
          });
          continue;
        }
        // "missing": the pending upload expired, upload the bytes again.
      }

      const result = await runAttachmentUploadCycle({
        registry: appAtomRegistry,
        createUploadUrl: attachmentEnvironment.createUploadUrl,
        remove: attachmentEnvironment.remove,
        environmentId,
        upload: {
          type: "file",
          name: attachment.name,
          mimeType: attachment.mimeType,
          sizeBytes: attachment.sizeBytes,
        },
        // Read the connection at transfer time: the environment may have
        // reconnected on a new base URL since this cycle started.
        resolveUploadUrl: (relativeUrl) => {
          const currentConnection = appAtomRegistry.get(
            environmentSession.preparedConnectionValueAtom(environmentId),
          );
          return Option.isNone(currentConnection)
            ? null
            : resolveAssetUrl(currentConnection.value.httpBaseUrl, relativeUrl);
        },
        transport: (url) => ({
          done: uploadFileBytes(attachment, url),
          // expo-file-system uploads cannot abort mid-flight.
          abort: () => {},
        }),
        onMinted: (attachmentId) => {
          pendingAttachmentIds.push(attachmentId);
          createdAttachmentIds.push(attachmentId);
          return "continue";
        },
      });
      if (result.status !== "uploaded") {
        throw result.status === "failed" && result.error !== undefined
          ? result.error
          : new Error(`Upload failed for '${attachment.name}'.`);
      }
      uploadedAttachments.push({
        type: "file",
        id: result.attachmentId,
        name: attachment.name,
        mimeType: attachment.mimeType,
        sizeBytes: attachment.sizeBytes,
      });
    }

    const draftAttachments = withUploadedMobileAttachmentReferences({
      environmentId,
      attachments: input.attachments,
      uploadedAttachments,
    });
    const referencesChanged = draftAttachments.some(
      (attachment, index) => attachment !== input.attachments[index],
    );
    if (referencesChanged && input.persistUploadedReferences) {
      if ((await input.persistUploadedReferences(draftAttachments)) === "abandon") {
        await releaseCreatedUploadsQuietly(environmentId, createdAttachmentIds);
        return { status: "abandoned" };
      }
    }
    return ready(uploadedAttachments, pendingAttachmentIds, draftAttachments);
  } catch (error) {
    await releaseCreatedUploadsQuietly(environmentId, createdAttachmentIds);
    throw error;
  }
}
