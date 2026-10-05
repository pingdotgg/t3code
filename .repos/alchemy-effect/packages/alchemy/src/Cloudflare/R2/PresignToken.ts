import * as SigV4 from "@distilled.cloud/aws/SigV4";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { Worker, WorkerEnvironment } from "../Workers/Worker.ts";
import type { Bucket } from "./Bucket.ts";
import type { PresignError } from "./BucketTypes.ts";
import {
  makeS3Credentials,
  type S3CredentialsAccess,
  type S3CredentialsValue,
} from "./S3Credentials.ts";

/**
 * Shared scaffolding for the R2 presign bindings (`PresignGetObjectToken`,
 * `PresignPutObjectToken`): resolve the bucket's `S3Credentials` and
 * sign each request locally with SigV4. `makeS3Credentials` handles the
 * per-mode wiring (a scoped API token when deployed, the Worker's local S3
 * endpoint under `alchemy dev`).
 *
 * NOT exported from `index.ts`.
 */
export const makePresignBinding = <Request>(options: {
  name: string;
  access: S3CredentialsAccess;
  presign: (
    credentials: S3CredentialsValue,
    request: Request,
  ) => Effect.Effect<string, PresignError>;
}) =>
  Effect.gen(function* () {
    // Resolved once at layer construction and provided to each bind, so the
    // binding callable carries no Worker requirements.
    const host = yield* Worker;
    const env = yield* WorkerEnvironment;

    return Effect.fn(function* (bucket: Bucket) {
      const credentials = yield* makeS3Credentials(
        host,
        env,
        bucket,
        options.access,
      );
      return Effect.fn(`${options.name}(${bucket.LogicalId})`)(function* (
        request: Request,
      ) {
        return yield* options.presign(yield* credentials, request);
      });
    });
  });

export interface PresignR2UrlOptions {
  method: "GET" | "PUT";
  key: string;
  /** @default 900 */
  expiresIn?: number;
  /** Headers the consumer must send verbatim (signed into the URL). */
  headers?: Record<string, string>;
  /** Extra query parameters signed into the URL (e.g. `response-content-type`). */
  query?: Record<string, string>;
}

/**
 * Presign a path-style R2 object URL (`{endpoint}/{bucket}/{key}`) with the
 * given {@link S3CredentialsValue}. Pure SigV4 — no request is made.
 */
export const presignR2Url = (
  credentials: S3CredentialsValue,
  options: PresignR2UrlOptions,
): Effect.Effect<string, PresignError> =>
  Effect.gen(function* () {
    const key = options.key.split("/").map(encodeURIComponent).join("/");
    const url = new URL(
      `${credentials.endpoint.replace(/\/+$/, "")}/${encodeURIComponent(credentials.bucketName)}/${key}`,
    );
    for (const [name, value] of Object.entries(options.query ?? {})) {
      url.searchParams.set(name, value);
    }
    url.searchParams.set("X-Amz-Expires", String(options.expiresIn ?? 900));
    const signed = yield* SigV4.sign({
      method: options.method,
      url: url.toString(),
      headers: options.headers,
      accessKeyId: credentials.accessKeyId,
      secretAccessKey: Redacted.make(credentials.secretAccessKey),
      service: "s3",
      region: credentials.region,
      signQuery: true,
      // Pin explicitly passed headers (e.g. content-type) into the signature
      allHeaders: options.headers !== undefined,
    });
    return signed.url;
  });
