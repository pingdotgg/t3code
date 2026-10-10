import * as iamcredentials from "@distilled.cloud/gcp/iamcredentials_v1";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import { createHash } from "node:crypto";
import { bindGcpHost, HOST_SERVICE_ACCOUNT } from "../Host.ts";
import { grantFor } from "../HttpBinding.ts";
import type { Bucket } from "./Bucket.ts";
import {
  SignedUrlFailed,
  SignGetObjectUrl,
  type SignGetObjectUrlRequest,
} from "./SignGetObjectUrl.ts";

const EMAIL_ENDPOINT =
  "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/email";
const STORAGE_HOST = "storage.googleapis.com";
const DEFAULT_EXPIRES_IN = 900;
const MAX_EXPIRES_IN = 604_800;

/** RFC 3986 encoding, as V4 signing requires. */
const encode = (value: string) =>
  encodeURIComponent(value).replace(
    /[!'()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );

const sha256Hex = (value: string) =>
  createHash("sha256").update(value, "utf8").digest("hex");

/** `20260102T030405Z` and `20260102` for a Unix time in millis. */
const timestamps = (millis: number) => {
  const iso = new Date(millis).toISOString().replace(/[-:]/g, "");
  const datetime = `${iso.slice(0, 15)}Z`;
  return { datetime, date: datetime.slice(0, 8) };
};

/**
 * HTTP implementation of {@link SignGetObjectUrl}: V4 signing where the
 * signature comes from IAM Credentials `signBlob` as the runtime's own
 * service account (read from the metadata server).
 *
 * @layer
 * @provides GCP.Storage.SignGetObjectUrl
 * @category Storage
 */
export const SignGetObjectUrlHttp = Layer.effect(
  SignGetObjectUrl,
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient;
    const signBlob = yield* iamcredentials.signBlobProjectsServiceAccounts;
    let ownEmail: string | undefined;

    const serviceAccountEmail = Effect.gen(function* () {
      if (ownEmail !== undefined) return ownEmail;
      const response = yield* http.execute(
        HttpClientRequest.get(EMAIL_ENDPOINT).pipe(
          HttpClientRequest.setHeader("Metadata-Flavor", "Google"),
        ),
      );
      const text = (yield* response.text).trim();
      if (response.status !== 200 || !text.includes("@")) {
        return yield* new SignedUrlFailed({
          message: `GCE metadata email endpoint returned HTTP ${response.status}`,
        });
      }
      ownEmail = text;
      return text;
    }).pipe(
      Effect.mapError((cause) =>
        cause instanceof SignedUrlFailed
          ? cause
          : new SignedUrlFailed({
              message: `GCE metadata email endpoint is unreachable: ${String(cause)}`,
              cause,
            }),
      ),
    );

    return Effect.fn(function* (bucket: Bucket) {
      yield* bindGcpHost({
        tag: "GCP.Storage.SignGetObjectUrl",
        resource: bucket,
        iam: [
          // A signed URL carries the signer's own object permissions.
          grantFor(
            { role: "roles/storage.objectViewer", on: "storage.bucket" },
            bucket.bucketName,
          ),
          // signBlob as itself, and on no other account.
          {
            role: "roles/iam.serviceAccountTokenCreator",
            resource: {
              kind: "iam.serviceAccount",
              name: HOST_SERVICE_ACCOUNT,
            },
          },
        ],
      });
      const bucketName = yield* bucket.bucketName;
      return Effect.fn(`GCP.Storage.SignGetObjectUrl(${bucket.LogicalId})`)(
        function* (request: SignGetObjectUrlRequest) {
          const email = yield* serviceAccountEmail;
          const name = yield* bucketName;
          const now = yield* Clock.currentTimeMillis;
          const { datetime, date } = timestamps(now);
          const scope = `${date}/auto/storage/goog4_request`;
          const expiresIn = Math.min(
            Math.max(Math.floor(request.expiresIn ?? DEFAULT_EXPIRES_IN), 1),
            MAX_EXPIRES_IN,
          );
          const params: Record<string, string> = {
            "X-Goog-Algorithm": "GOOG4-RSA-SHA256",
            "X-Goog-Credential": `${email}/${scope}`,
            "X-Goog-Date": datetime,
            "X-Goog-Expires": String(expiresIn),
            "X-Goog-SignedHeaders": "host",
            ...(request.generation !== undefined
              ? { generation: request.generation }
              : {}),
            ...(request.contentType !== undefined
              ? { "response-content-type": request.contentType }
              : {}),
          };
          const query = Object.keys(params)
            .sort()
            .map((key) => `${encode(key)}=${encode(params[key]!)}`)
            .join("&");
          const path = `/${name}/${request.object
            .split("/")
            .map(encode)
            .join("/")}`;
          const canonicalRequest = [
            "GET",
            path,
            query,
            `host:${STORAGE_HOST}`,
            "",
            "host",
            "UNSIGNED-PAYLOAD",
          ].join("\n");
          const stringToSign = [
            "GOOG4-RSA-SHA256",
            datetime,
            scope,
            yield* Effect.sync(() => sha256Hex(canonicalRequest)),
          ].join("\n");
          const signed = yield* signBlob({
            name: `projects/-/serviceAccounts/${email}`,
            body: {
              payload: yield* Effect.sync(() =>
                Buffer.from(stringToSign, "utf8").toString("base64"),
              ),
            },
          });
          if (signed.signedBlob === undefined) {
            return yield* new SignedUrlFailed({
              message: "IAM Credentials signBlob returned no signature",
            });
          }
          const signature = yield* Effect.sync(() =>
            Buffer.from(signed.signedBlob!, "base64").toString("hex"),
          );
          return `https://${STORAGE_HOST}${path}?${query}&X-Goog-Signature=${signature}`;
        },
      );
    });
  }),
);
