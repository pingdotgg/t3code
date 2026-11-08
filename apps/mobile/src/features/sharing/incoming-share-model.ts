import {
  clampFileAttachmentUploadBytes,
  fileAttachmentTooLargeMessage,
} from "@t3tools/client-runtime/state/attachments";
import {
  isProviderSendTurnSupportedImageMimeType,
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  PROVIDER_SEND_TURN_MAX_FILE_BYTES,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import type { ResolvedSharePayload, SharePayload } from "expo-sharing";

import { DraftComposerAttachmentSchema } from "../../lib/composer-image-schema";
import { fitComposerImage } from "../../lib/composerImageFit";
import type { DraftComposerAttachment } from "../../lib/composerImages";
import { estimateBase64ByteSize } from "../../lib/base64";

export interface IncomingShareDraft {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly createdAt: string;
  readonly destination?: IncomingShareDestination;
  readonly text: string;
  readonly attachments: ReadonlyArray<DraftComposerAttachment>;
  readonly warnings: ReadonlyArray<string>;
}

export interface IncomingShareDestination {
  readonly environmentId: string;
  readonly projectId: string;
}

const IncomingShareDestinationSchema = Schema.Struct({
  environmentId: Schema.String,
  projectId: Schema.String,
});

export const IncomingShareDraftSchema = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  id: Schema.String,
  createdAt: Schema.String,
  destination: Schema.optional(IncomingShareDestinationSchema),
  text: Schema.String,
  attachments: Schema.Array(DraftComposerAttachmentSchema),
  warnings: Schema.Array(Schema.String),
});

const decodeIncomingShareDraftSync = Schema.decodeUnknownSync(IncomingShareDraftSchema);

export function decodeIncomingShareDraft(value: unknown): IncomingShareDraft {
  return decodeIncomingShareDraftSync(value);
}

/** Strip iOS /private so /var and /private/var paths compare equally. */
function normalizedFileUriPath(uri: string): string | null {
  try {
    const url = new URL(uri);
    if (url.protocol !== "file:") {
      return null;
    }
    const path = decodeURIComponent(url.pathname);
    // URL parsing leaves encoded separators; reject decoded .. segments before lexical containment checks.
    if (path.split("/").includes("..")) {
      return null;
    }
    return path.startsWith("/private/var/") ? path.slice("/private".length) : path;
  } catch {
    return null;
  }
}

/** Delete only inside app-owned roots; iOS shares may reference the sender's original. */
export function isShareFileUriUnderOwnedRoots(
  uri: string,
  ownedRootUris: ReadonlyArray<string>,
): boolean {
  const path = normalizedFileUriPath(uri);
  if (path === null) {
    return false;
  }
  return ownedRootUris.some((rootUri) => {
    const rootPath = normalizedFileUriPath(rootUri);
    if (rootPath === null) {
      return false;
    }
    const root = rootPath.endsWith("/") ? rootPath : `${rootPath}/`;
    return path.startsWith(root) && path.length > root.length;
  });
}

export interface IncomingShareFileReader {
  readonly readBase64: (uri: string) => Promise<string>;
  readonly removeOwnedFile: (uri: string) => Promise<void> | void;
  readonly persistFile?: (uri: string, name: string) => Promise<string>;
  readonly readSize?: (uri: string) => Promise<number | null>;
}

export function selectIncomingShareAttachments(input: {
  readonly attachments: ReadonlyArray<DraftComposerAttachment>;
  readonly maxFileAttachmentBytes: number | null;
}): {
  readonly attachments: ReadonlyArray<DraftComposerAttachment>;
  readonly warnings: ReadonlyArray<string>;
} {
  const attachments: DraftComposerAttachment[] = [];
  const warnings: string[] = [];

  for (const attachment of input.attachments) {
    if (attachment.type === "image") {
      attachments.push(attachment);
      continue;
    }
    if (input.maxFileAttachmentBytes === null) {
      warnings.push(`'${attachment.name}' was skipped because this server does not support files.`);
      continue;
    }
    const maxFileAttachmentBytes = clampFileAttachmentUploadBytes(input.maxFileAttachmentBytes);
    if (attachment.sizeBytes > maxFileAttachmentBytes) {
      warnings.push(fileAttachmentTooLargeMessage(attachment.name, maxFileAttachmentBytes));
      continue;
    }
    attachments.push(attachment);
  }

  return { attachments, warnings };
}

export function selectIncomingShareAttachmentsForServer(input: {
  readonly attachments: ReadonlyArray<DraftComposerAttachment>;
  readonly serverConfig: {
    readonly environment: {
      readonly capabilities: {
        readonly fileAttachments?: { readonly maxUploadBytes: number };
      };
    };
  } | null;
}):
  | { readonly status: "pending" }
  | {
      readonly status: "ready";
      readonly attachments: ReadonlyArray<DraftComposerAttachment>;
      readonly warnings: ReadonlyArray<string>;
    } {
  const hasFiles = input.attachments.some((attachment) => attachment.type === "file");
  if (hasFiles && input.serverConfig === null) {
    return { status: "pending" };
  }
  const capabilities = input.serverConfig?.environment.capabilities;
  const maxFileAttachmentBytes = capabilities?.fileAttachments?.maxUploadBytes ?? null;
  return {
    status: "ready",
    ...selectIncomingShareAttachments({
      attachments: input.attachments,
      maxFileAttachmentBytes,
    }),
  };
}

function sharedText(payloads: ReadonlyArray<SharePayload>): string {
  const seen = new Set<string>();
  const values: string[] = [];
  for (const payload of payloads) {
    if (payload.shareType !== "text" && payload.shareType !== "url") {
      continue;
    }
    const value = payload.value.trim();
    if (!value || seen.has(value)) {
      continue;
    }
    seen.add(value);
    values.push(value);
  }
  return values.join("\n\n");
}

function resolvedImageFor(
  payload: SharePayload,
  index: number,
  resolvedPayloads: ReadonlyArray<ResolvedSharePayload>,
  consumedIndexes: Set<number>,
): ResolvedSharePayload | undefined {
  const sameIndex = resolvedPayloads[index];
  if (
    !consumedIndexes.has(index) &&
    sameIndex?.shareType === payload.shareType &&
    sameIndex.value === payload.value
  ) {
    consumedIndexes.add(index);
    return sameIndex;
  }
  const matchingIndex = resolvedPayloads.findIndex(
    (candidate, candidateIndex) =>
      !consumedIndexes.has(candidateIndex) &&
      candidate.shareType === payload.shareType &&
      candidate.value === payload.value,
  );
  if (matchingIndex < 0) {
    return undefined;
  }
  consumedIndexes.add(matchingIndex);
  return resolvedPayloads[matchingIndex];
}

async function releaseOwnedFiles(
  fileReader: IncomingShareFileReader,
  uris: ReadonlyArray<string | undefined>,
): Promise<void> {
  for (const uri of new Set(uris.filter((candidate): candidate is string => Boolean(candidate)))) {
    try {
      await fileReader.removeOwnedFile(uri);
    } catch {}
  }
}

function fallbackName(uri: string, index: number, mimeType: string): string {
  try {
    const pathName = new URL(uri).pathname.split("/").findLast((segment) => segment.length > 0);
    if (pathName) {
      return decodeURIComponent(pathName);
    }
  } catch {}
  const family = mimeType.split("/")[0]?.toLowerCase();
  const kind = family === "image" || family === "audio" || family === "video" ? family : "file";
  const extension =
    mimeType.split("/")[1]?.replace(/[^a-z0-9.+-]/gi, "") || (kind === "image" ? "png" : "bin");
  return `shared-${kind}-${index + 1}.${extension}`;
}

export async function buildIncomingShareDraft(input: {
  readonly payloads: ReadonlyArray<SharePayload>;
  readonly resolvedPayloads: ReadonlyArray<ResolvedSharePayload>;
  readonly fileReader: IncomingShareFileReader;
  readonly id: string;
  readonly createdAt: string;
}): Promise<IncomingShareDraft> {
  const attachments: DraftComposerAttachment[] = [];
  const warnings: string[] = [];
  const consumedResolvedPayloadIndexes = new Set<number>();
  let warnedAttachmentLimit = false;

  for (const [index, payload] of input.payloads.entries()) {
    if (
      payload.shareType !== "image" &&
      payload.shareType !== "file" &&
      payload.shareType !== "audio" &&
      payload.shareType !== "video"
    ) {
      continue;
    }
    const resolved = resolvedImageFor(
      payload,
      index,
      input.resolvedPayloads,
      consumedResolvedPayloadIndexes,
    );
    const uri = resolved?.contentUri ?? payload.value;
    if (attachments.length >= PROVIDER_SEND_TURN_MAX_ATTACHMENTS) {
      if (!warnedAttachmentLimit) {
        warnings.push(
          `Only the first ${PROVIDER_SEND_TURN_MAX_ATTACHMENTS} shared ${payload.shareType === "image" ? "images" : "files"} were attached.`,
        );
        warnedAttachmentLimit = true;
      }
      await releaseOwnedFiles(input.fileReader, [uri, payload.value]);
      continue;
    }

    const mimeType = (
      resolved?.contentMimeType ??
      payload.mimeType ??
      (payload.shareType === "image" ? "image/png" : "application/octet-stream")
    ).toLowerCase();
    if (payload.shareType !== "image") {
      const sharedFileName =
        typeof payload.originalName === "string" && payload.originalName.trim().length > 0
          ? payload.originalName
          : undefined;
      const name = resolved?.originalName ?? sharedFileName ?? fallbackName(uri, index, mimeType);
      if (!uri) {
        warnings.push("One shared file could not be read.");
        continue;
      }
      let persistedFileUri: string | undefined;
      let retainedFileUri: string | undefined;
      try {
        let sizeBytes = resolved?.contentSize ?? (await input.fileReader.readSize?.(uri)) ?? null;
        if (
          (sizeBytes === null || (sizeBytes === 0 && uri.startsWith("content:"))) &&
          input.fileReader.persistFile
        ) {
          persistedFileUri = await input.fileReader.persistFile(uri, name);
          sizeBytes = (await input.fileReader.readSize?.(persistedFileUri)) ?? null;
        }
        if (sizeBytes === null) {
          warnings.push(`The size of '${name}' could not be determined.`);
          if (persistedFileUri) {
            await releaseOwnedFiles(input.fileReader, [persistedFileUri]);
          }
          continue;
        }
        if (sizeBytes <= 0) {
          warnings.push(`'${name}' is empty or could not be read.`);
          if (persistedFileUri) {
            await releaseOwnedFiles(input.fileReader, [persistedFileUri]);
          }
          continue;
        }
        if (sizeBytes > PROVIDER_SEND_TURN_MAX_FILE_BYTES) {
          warnings.push(fileAttachmentTooLargeMessage(name, PROVIDER_SEND_TURN_MAX_FILE_BYTES));
          if (persistedFileUri) {
            await releaseOwnedFiles(input.fileReader, [persistedFileUri]);
          }
          continue;
        }
        if (persistedFileUri === undefined && input.fileReader.persistFile) {
          persistedFileUri = await input.fileReader.persistFile(uri, name);
          // Android content sources can misreport size; record the stored copy's measured size.
          const storedSize = (await input.fileReader.readSize?.(persistedFileUri)) ?? null;
          if (storedSize !== null) {
            sizeBytes = storedSize;
          }
          if (sizeBytes <= 0) {
            warnings.push(`'${name}' is empty or could not be read.`);
            await releaseOwnedFiles(input.fileReader, [persistedFileUri]);
            continue;
          }
          if (sizeBytes > PROVIDER_SEND_TURN_MAX_FILE_BYTES) {
            warnings.push(fileAttachmentTooLargeMessage(name, PROVIDER_SEND_TURN_MAX_FILE_BYTES));
            await releaseOwnedFiles(input.fileReader, [persistedFileUri]);
            continue;
          }
        }
        attachments.push({
          id: `${input.id}:file:${index}`,
          type: "file",
          name,
          mimeType,
          sizeBytes,
          fileUri: persistedFileUri ?? uri,
        });
        retainedFileUri = persistedFileUri ?? uri;
      } catch (error) {
        warnings.push(error instanceof Error ? error.message : `Could not read '${name}'.`);
        if (persistedFileUri !== undefined) {
          await releaseOwnedFiles(input.fileReader, [persistedFileUri]);
        }
      } finally {
        await releaseOwnedFiles(
          input.fileReader,
          [uri, payload.value].filter((candidate) => candidate !== retainedFileUri),
        );
      }
      continue;
    }
    if (!uri || !mimeType.startsWith("image/")) {
      warnings.push("One shared item was not a supported image.");
      await releaseOwnedFiles(input.fileReader, [uri, payload.value]);
      continue;
    }
    if (!isProviderSendTurnSupportedImageMimeType(mimeType)) {
      warnings.push(
        `'${resolved?.originalName ?? fallbackName(uri, index, mimeType)}' is not a supported image type.`,
      );
      await releaseOwnedFiles(input.fileReader, [uri, payload.value]);
      continue;
    }
    if (
      resolved?.contentSize !== null &&
      resolved?.contentSize !== undefined &&
      resolved.contentSize > PROVIDER_SEND_TURN_MAX_IMAGE_BYTES
    ) {
      warnings.push(
        `'${resolved.originalName ?? fallbackName(uri, index, mimeType)}' exceeds the 10 MB attachment limit.`,
      );
      await releaseOwnedFiles(input.fileReader, [uri, payload.value]);
      continue;
    }

    try {
      const sharedBase64 = await input.fileReader.readBase64(uri);
      // Use already-read bytes because native image loaders may not read the provider's file.
      const fitted = await fitComposerImage({
        uri: `data:${mimeType};base64,${sharedBase64}`,
        mimeType,
        base64: sharedBase64,
      });
      const base64 = fitted?.base64 ?? sharedBase64;
      const sizeBytes = fitted
        ? estimateBase64ByteSize(base64)
        : (resolved?.contentSize ?? estimateBase64ByteSize(base64));
      if (sizeBytes <= 0 || sizeBytes > PROVIDER_SEND_TURN_MAX_IMAGE_BYTES) {
        warnings.push(
          `'${resolved?.originalName ?? fallbackName(uri, index, mimeType)}' exceeds the 10 MB attachment limit.`,
        );
        continue;
      }
      const dataUrl = `data:${mimeType};base64,${base64}`;
      attachments.push({
        id: `${input.id}:image:${index}`,
        type: "image",
        name: resolved?.originalName ?? fallbackName(uri, index, mimeType),
        mimeType,
        sizeBytes,
        dataUrl,
        // Data-backed previews outlive temporary share files and App Group entries.
        previewUri: dataUrl,
      });
    } catch {
      warnings.push(`Could not read '${fallbackName(uri, index, mimeType)}'.`);
    } finally {
      await releaseOwnedFiles(input.fileReader, [uri, payload.value]);
    }
  }

  return {
    schemaVersion: 1,
    id: input.id,
    createdAt: input.createdAt,
    text: sharedText(input.payloads),
    attachments,
    warnings,
  };
}

export function hasIncomingShareContent(draft: IncomingShareDraft): boolean {
  return draft.text.trim().length > 0 || draft.attachments.length > 0;
}
