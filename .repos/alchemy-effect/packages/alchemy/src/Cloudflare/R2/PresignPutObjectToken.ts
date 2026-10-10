import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makePresignBinding, presignR2Url } from "./PresignToken.ts";
import {
  PresignPutObject,
  type PresignPutObjectRequest,
} from "./PresignPutObject.ts";

/**
 * Implementation of {@link PresignPutObject} that signs URLs with S3
 * credentials derived from an API token. Signing is local SigV4 — no request
 * is made to R2.
 *
 * Deployed, it mints a scoped account API token with
 * `Workers R2 Storage Write` (access key id = token id, secret = SHA-256 of
 * the token value) and signs URLs for `{accountId}.r2.cloudflarestorage.com`.
 * Under `alchemy dev`, a locally-emulated bucket is signed with fixed local
 * credentials for the Worker's local S3 endpoint, and no token is created.
 *
 * @layer
 * @provides Cloudflare.R2.PresignPutObject
 * @product R2
 */
export const PresignPutObjectToken = Layer.effect(
  PresignPutObject,
  Effect.suspend(() =>
    makePresignBinding<PresignPutObjectRequest>({
      name: "Cloudflare.R2.PresignPutObject",
      access: "write",
      presign: (credentials, request) =>
        presignR2Url(credentials, {
          method: "PUT",
          key: request.key,
          expiresIn: request.expiresIn,
          headers:
            request.contentType !== undefined
              ? { "content-type": request.contentType }
              : undefined,
        }),
    }),
  ),
);
