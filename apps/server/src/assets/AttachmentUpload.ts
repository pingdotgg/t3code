// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";

import {
  ATTACHMENT_UPLOAD_URL_TTL_MS,
  type AttachmentCreateUploadUrlInput,
  AttachmentUploadSigningKeyError,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import {
  createPendingAttachmentId,
  findAttachmentPathByUuid,
  parseAttachmentIdFromRelativePath,
  parseAttachmentUuid,
  parseThreadSegmentFromAttachmentId,
  PENDING_ATTACHMENT_THREAD_SEGMENT,
} from "../attachmentStore.ts";
import { resolveAttachmentRelativePath } from "../attachmentPaths.ts";
import {
  base64UrlDecodeUtf8,
  base64UrlEncode,
  signPayload,
  timingSafeEqualBase64Url,
} from "../auth/utils.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import { inferImageExtension } from "../imageMime.ts";

export const ATTACHMENT_UPLOAD_ROUTE_PREFIX = "/api/attachments/upload";

// Shares the asset-access secret: upload and asset claims are distinguished
// by their schema `kind`, so a token minted for one can never validate as
// the other, and one key covers both signing uses.
const SIGNING_SECRET_NAME = "asset-access-signing-key";

const UploadClaimsSchema = Schema.Struct({
  version: Schema.Literal(1),
  kind: Schema.Literal("attachment-upload"),
  attachmentId: Schema.String,
  mimeType: Schema.String,
  /** Exact byte count the client committed to at mint time. */
  sizeBytes: Schema.Number,
  expiresAt: Schema.Number,
});
export type AttachmentUploadClaims = typeof UploadClaimsSchema.Type;

const UploadClaimsJson = Schema.fromJsonString(UploadClaimsSchema);
const decodeUploadClaimsOption = Schema.decodeUnknownOption(UploadClaimsJson);
const encodeUploadClaims = Schema.encodeSync(UploadClaimsJson);

// Plain function (not Effect) so the base64/JSON failure modes stay a simple
// null, mirroring AssetAccess.decodeClaims.
function decodeUploadClaims(encodedPayload: string): AttachmentUploadClaims | null {
  try {
    return Option.getOrNull(decodeUploadClaimsOption(base64UrlDecodeUtf8(encodedPayload)));
  } catch {
    return null;
  }
}

const loadSigningSecret = Effect.gen(function* () {
  const secretStore = yield* ServerSecretStore.ServerSecretStore;
  return yield* secretStore.getOrCreateRandom(SIGNING_SECRET_NAME, 32);
});

/**
 * Mints the `pending-<uuid>` id and a signed, expiring upload URL for it.
 * Called over the authenticated ws; the returned URL itself carries
 * authorization (mirroring signed asset GET URLs), which is what lets the
 * browser POST bytes to any environment without extra credential plumbing.
 */
export const issueAttachmentUploadUrl = Effect.fn("AttachmentUpload.issueUrl")(function* (
  input: AttachmentCreateUploadUrlInput,
) {
  const secret = yield* loadSigningSecret.pipe(
    Effect.mapError((cause) => new AttachmentUploadSigningKeyError({ cause })),
  );
  const attachmentId = createPendingAttachmentId();
  const expiresAt = (yield* Clock.currentTimeMillis) + ATTACHMENT_UPLOAD_URL_TTL_MS;
  const encodedPayload = base64UrlEncode(
    encodeUploadClaims({
      version: 1,
      kind: "attachment-upload",
      attachmentId,
      mimeType: input.mimeType.toLowerCase(),
      sizeBytes: input.sizeBytes,
      expiresAt,
    }),
  );
  const token = `${encodedPayload}.${signPayload(encodedPayload, secret)}`;
  return {
    attachmentId,
    relativeUrl: `${ATTACHMENT_UPLOAD_ROUTE_PREFIX}/${token}`,
    expiresAt,
  };
});

/** Verifies signature and expiry; null means "treat as not found". */
export const validateAttachmentUploadToken = Effect.fn("AttachmentUpload.validateToken")(function* (
  token: string,
) {
  const [encodedPayload, signature] = token.split(".");
  if (!encodedPayload || !signature) return null;

  const secret = yield* loadSigningSecret.pipe(
    Effect.tapError((cause) =>
      Effect.logError("Failed to load the attachment upload signing key.", { cause }),
    ),
    Effect.orElseSucceed(() => null),
  );
  if (!secret) return null;
  if (!timingSafeEqualBase64Url(signature, signPayload(encodedPayload, secret))) return null;

  const claims = decodeUploadClaims(encodedPayload);
  if (!claims || claims.expiresAt <= (yield* Clock.currentTimeMillis)) return null;
  return claims;
});

export type StoreUploadResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly status: number; readonly detail: string };

/**
 * Persists validated upload bytes. Writes to `<id>.<ext>.part` first and
 * renames on success, so a crashed or aborted upload can never leave a file
 * that looks like a complete attachment. Re-running with the same token
 * overwrites atomically, which makes client retries safe.
 */
export const storeAttachmentUpload = Effect.fn("AttachmentUpload.store")(function* (
  claims: AttachmentUploadClaims,
  bytes: Uint8Array,
) {
  if (bytes.byteLength !== claims.sizeBytes) {
    return {
      ok: false,
      status: 400,
      detail: `Body was ${bytes.byteLength} bytes, expected ${claims.sizeBytes}.`,
    } satisfies StoreUploadResult;
  }
  const config = yield* ServerConfig.ServerConfig;
  const extension = inferImageExtension({ mimeType: claims.mimeType });
  const relativePath = `${claims.attachmentId}${extension}`;
  const finalPath = resolveAttachmentRelativePath({
    attachmentsDir: config.attachmentsDir,
    relativePath,
  });
  // Unique per request: two concurrent POSTs of the same token must not
  // interleave writes into one temp file. Both rename onto the final path
  // atomically; last one wins with identical claims-validated content.
  const partPath = resolveAttachmentRelativePath({
    attachmentsDir: config.attachmentsDir,
    relativePath: `${relativePath}.${NodeCrypto.randomUUID()}.part`,
  });
  if (!finalPath || !partPath) {
    return { ok: false, status: 500, detail: "Failed to resolve attachment path." };
  }
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const writeResult = yield* Effect.gen(function* () {
    yield* fileSystem.makeDirectory(path.dirname(finalPath), { recursive: true });
    yield* fileSystem.writeFile(partPath, bytes);
    yield* fileSystem.rename(partPath, finalPath);
  }).pipe(
    Effect.as({ ok: true } satisfies StoreUploadResult),
    Effect.tapError((cause) =>
      Effect.logError("Failed to persist attachment upload.", {
        attachmentId: claims.attachmentId,
        cause,
      }),
    ),
    Effect.orElseSucceed(
      () =>
        ({
          ok: false,
          status: 500,
          detail: "Failed to persist upload.",
        }) satisfies StoreUploadResult,
    ),
  );
  return writeResult;
});

/**
 * Deletes a never-sent upload. Idempotent, and refuses (as a silent no-op)
 * anything already claimed by a thread: those files are owned by their
 * message and only die with the thread.
 */
export const deletePendingAttachment = Effect.fn("AttachmentUpload.deletePending")(function* (
  attachmentId: string,
) {
  if (parseThreadSegmentFromAttachmentId(attachmentId) !== PENDING_ATTACHMENT_THREAD_SEGMENT) {
    return;
  }
  const uuid = parseAttachmentUuid(attachmentId);
  if (!uuid) return;
  const config = yield* ServerConfig.ServerConfig;
  const filePath = findAttachmentPathByUuid({ attachmentsDir: config.attachmentsDir, uuid });
  if (!filePath) return;
  const path = yield* Path.Path;
  const foundId = parseAttachmentIdFromRelativePath(path.basename(filePath));
  if (
    !foundId ||
    parseThreadSegmentFromAttachmentId(foundId) !== PENDING_ATTACHMENT_THREAD_SEGMENT
  ) {
    return;
  }
  const fileSystem = yield* FileSystem.FileSystem;
  yield* fileSystem.remove(filePath).pipe(
    Effect.catch(
      () =>
        // Raced with the sweep or a duplicate delete; idempotent by design.
        Effect.void,
    ),
  );
});
