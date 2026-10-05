import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import {
  PresignGetObject,
  type PresignGetObjectRequest,
} from "./PresignGetObject.ts";
import { makePresignBinding, presignR2Url } from "./PresignToken.ts";

/**
 * Implementation of {@link PresignGetObject} that signs URLs with S3
 * credentials derived from an API token. Signing is local SigV4 — no request
 * is made to R2.
 *
 * Deployed, it mints a scoped account API token with
 * `Workers R2 Storage Read` (access key id = token id, secret = SHA-256 of
 * the token value) and signs URLs for `{accountId}.r2.cloudflarestorage.com`.
 * Under `alchemy dev`, a locally-emulated bucket is signed with fixed local
 * credentials for the Worker's local S3 endpoint, and no token is created.
 *
 * @layer
 * @provides Cloudflare.R2.PresignGetObject
 * @product R2
 */
export const PresignGetObjectToken = Layer.effect(
  PresignGetObject,
  Effect.suspend(() =>
    makePresignBinding<PresignGetObjectRequest>({
      name: "Cloudflare.R2.PresignGetObject",
      access: "read",
      presign: (credentials, request) =>
        presignR2Url(credentials, {
          method: "GET",
          key: request.key,
          expiresIn: request.expiresIn,
          query: {
            ...(request.contentType !== undefined
              ? { "response-content-type": request.contentType }
              : {}),
            ...(request.contentDisposition !== undefined
              ? { "response-content-disposition": request.contentDisposition }
              : {}),
          },
        }),
    }),
  ),
);
