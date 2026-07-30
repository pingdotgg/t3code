import {
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import type { ResolvedSharePayload, SharePayload } from "expo-sharing";

import { DraftComposerImageAttachmentSchema } from "../../lib/composer-image-schema";
import type { DraftComposerImageAttachment } from "../../lib/composerImages";
import { estimateBase64ByteSize } from "../../lib/base64";

export interface IncomingShareDraft {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly createdAt: string;
  readonly destination?: IncomingShareDestination;
  readonly text: string;
  readonly attachments: ReadonlyArray<DraftComposerImageAttachment>;
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
  attachments: Schema.Array(DraftComposerImageAttachmentSchema),
  warnings: Schema.Array(Schema.String),
});

const decodeIncomingShareDraftSync = Schema.decodeUnknownSync(IncomingShareDraftSchema);

export function decodeIncomingShareDraft(value: unknown): IncomingShareDraft {
  return decodeIncomingShareDraftSync(value);
}

export interface IncomingShareFileReader {
  readonly readBase64: (uri: string) => Promise<string>;
  readonly removeOwnedFile: (uri: string) => Promise<void> | void;
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
    } catch {
      // Temporary-file cleanup is best-effort and must never discard content
      // that was successfully converted into a durable composer attachment.
    }
  }
}

function fallbackName(uri: string, index: number, mimeType: string): string {
  try {
    const pathName = new URL(uri).pathname.split("/").findLast((segment) => segment.length > 0);
    if (pathName) {
      return decodeURIComponent(pathName);
    }
  } catch {
    // Fall through to a deterministic attachment name.
  }
  const extension = mimeType.split("/")[1]?.replace(/[^a-z0-9.+-]/gi, "") || "png";
  return `shared-image-${index + 1}.${extension}`;
}

export async function buildIncomingShareDraft(input: {
  readonly payloads: ReadonlyArray<SharePayload>;
  readonly resolvedPayloads: ReadonlyArray<ResolvedSharePayload>;
  readonly fileReader: IncomingShareFileReader;
  readonly id: string;
  readonly createdAt: string;
}): Promise<IncomingShareDraft> {
  const attachments: DraftComposerImageAttachment[] = [];
  const warnings: string[] = [];
  const consumedResolvedPayloadIndexes = new Set<number>();
  let warnedAttachmentLimit = false;

  for (const [index, payload] of input.payloads.entries()) {
    if (payload.shareType !== "image") {
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
          `Only the first ${PROVIDER_SEND_TURN_MAX_ATTACHMENTS} shared images were attached.`,
        );
        warnedAttachmentLimit = true;
      }
      await releaseOwnedFiles(input.fileReader, [uri, payload.value]);
      continue;
    }

    const mimeType = (resolved?.contentMimeType ?? payload.mimeType ?? "image/png").toLowerCase();
    if (!uri || !mimeType.startsWith("image/")) {
      warnings.push("One shared item was not a supported image.");
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
      const base64 = await input.fileReader.readBase64(uri);
      const sizeBytes = resolved?.contentSize ?? estimateBase64ByteSize(base64);
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
        // The share provider's file is temporary. A data-backed preview keeps
        // the composer valid after its source file and App Group entry are gone.
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
